import robotsParserModule from 'robots-parser';
import { Agent, type Dispatcher, EnvHttpProxyAgent, fetch as undiciFetch } from 'undici';
import {
  BlockedError,
  HttpError,
  NetworkError,
  RobotsDisallowedError,
  RobotsUnavailableError,
  UnexpectedResponseError,
} from './errors.js';
import { RateLimiter } from './rate-limiter.js';
import {
  DEFAULT_RETRY_POLICY,
  parseRetryAfter,
  type RetryPolicy,
  type Sleep,
  withRetry,
} from './retry.js';

/** The product token we look for in robots.txt groups. */
export const ROBOTS_AGENT = 'swiss-grocery';

export interface FetchResponse {
  status: number;
  headers: { get(name: string): string | null; has(name: string): boolean };
  text(): Promise<string>;
}

export type FetchLike = (
  url: string,
  init: { method: string; headers: Record<string, string>; body?: string; signal: AbortSignal },
) => Promise<FetchResponse>;

export interface HttpResponse {
  url: string;
  status: number;
  headers: FetchResponse['headers'];
  body: string;
}

export type HttpEvent =
  | { type: 'request'; url: string; attempt: number }
  | { type: 'retry'; url: string; attempt: number; delayMs: number; reason: string }
  | { type: 'throttled'; host: string; requestsPerSecond: number };

export interface HttpClientOptions {
  userAgent: string;
  acceptLanguage?: string;
  /** Maximum request rate per host. */
  requestsPerSecond?: number;
  burst?: number;
  timeoutMs?: number;
  retry?: RetryPolicy;
  respectRobots?: boolean;
  signal?: AbortSignal;
  onEvent?: (event: HttpEvent) => void;
  /** Injection points for tests. */
  fetch?: FetchLike;
  sleep?: Sleep;
  random?: () => number;
  clock?: () => number;
}

export interface RequestOptions {
  method?: 'GET' | 'POST';
  headers?: Record<string, string>;
  body?: string;
  skipRobots?: boolean;
}

interface Robot {
  isAllowed(url: string, ua?: string): boolean | undefined;
  getCrawlDelay(ua?: string): number | undefined;
}

// robots-parser is CommonJS (`module.exports = function`); its bundled typings
// describe an ES default export, which TypeScript misreads under NodeNext.
const robotsParser = robotsParserModule as unknown as (url: string, contents: string) => Robot;

let sharedDispatcher: Dispatcher | undefined;

/** Keep-alive connection pool; honours HTTPS_PROXY / HTTP_PROXY / NO_PROXY when set. */
function dispatcher(): Dispatcher {
  if (!sharedDispatcher) {
    const env = process.env;
    const proxied = env.HTTPS_PROXY || env.https_proxy || env.HTTP_PROXY || env.http_proxy;
    sharedDispatcher = proxied
      ? new EnvHttpProxyAgent()
      : new Agent({ keepAliveTimeout: 10_000, connections: 8 });
  }
  return sharedDispatcher;
}

const defaultFetch: FetchLike = (url, init) =>
  undiciFetch(url, { ...init, dispatcher: dispatcher() });

function isJson(headers: FetchResponse['headers'], body: string): boolean {
  return (headers.get('content-type') ?? '').includes('json') || /^\s*[{[]/.test(body);
}

/**
 * Recognises the block pages of the bot protections used by Swiss retailers.
 * An API's own JSON error is not a block page, even when the API sits behind
 * Cloudflare: Supabase, for example, answers "permission denied" with a JSON 403.
 */
export function detectBotProtection(
  status: number,
  headers: FetchResponse['headers'],
  body: string,
): string | null {
  if (status === 429) return null; // plain rate limiting: back off and retry
  if (body.includes('captcha-delivery.com')) return 'DataDome'; // its block page or JSON
  if (status !== 403 && status !== 503) return null;
  if (headers.get('cf-mitigated') === 'challenge') return 'Cloudflare';
  if (isJson(headers, body)) return null;
  const server = (headers.get('server') ?? '').toLowerCase();
  if (headers.has('x-datadome') || server.includes('datadome')) return 'DataDome';
  if (server.includes('cloudflare') || headers.has('cf-ray')) {
    if (status === 403 || /just a moment|cf-chl|challenge-platform/i.test(body))
      return 'Cloudflare';
  }
  if (server.includes('akamaighost') && status === 403) return 'Akamai';
  if (/_Incapsula_Resource|incapsula/i.test(body)) return 'Imperva';
  return null;
}

function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || (status >= 500 && status <= 504);
}

function describe(error: unknown): string {
  if (error instanceof HttpError) return `HTTP ${error.status}`;
  if (error instanceof Error) return error.message;
  return String(error);
}

/**
 * HTTP client used by every store provider:
 * robots.txt check -> per-host rate limit -> request with timeout -> retry with backoff.
 */
export class HttpClient {
  readonly stats = { requests: 0, retries: 0, bytes: 0 };
  private readonly limiters = new Map<string, RateLimiter>();
  private readonly robots = new Map<string, Promise<Robot | null>>();
  private readonly doFetch: FetchLike;

  constructor(private readonly options: HttpClientOptions) {
    this.doFetch = options.fetch ?? defaultFetch;
  }

  async getJson<T = unknown>(url: string, options: RequestOptions = {}): Promise<T> {
    return parseJson<T>(await this.request(url, options));
  }

  async postJson<T = unknown>(
    url: string,
    body: unknown,
    options: RequestOptions = {},
  ): Promise<T> {
    const response = await this.request(url, {
      ...options,
      method: 'POST',
      body: JSON.stringify(body),
      headers: { 'Content-Type': 'application/json', ...options.headers },
    });
    return parseJson<T>(response);
  }

  async getText(url: string, options: RequestOptions = {}): Promise<string> {
    return (await this.request(url, { ...options, headers: { Accept: '*/*', ...options.headers } }))
      .body;
  }

  async request(url: string, options: RequestOptions = {}): Promise<HttpResponse> {
    if (!options.skipRobots && this.options.respectRobots !== false) await this.assertAllowed(url);
    const host = new URL(url).host;
    const headers: Record<string, string> = {
      'User-Agent': this.options.userAgent,
      Accept: 'application/json, text/plain, */*',
      'Accept-Language': this.options.acceptLanguage ?? 'de-CH,de;q=0.9',
      ...options.headers,
    };

    return withRetry(
      async (attempt) => {
        await this.limiter(host).acquire(this.options.signal);
        this.stats.requests++;
        this.options.onEvent?.({ type: 'request', url, attempt });

        const timeout = AbortSignal.timeout(this.options.timeoutMs ?? 30_000);
        const signal = this.options.signal
          ? AbortSignal.any([this.options.signal, timeout])
          : timeout;
        let response: FetchResponse;
        let body: string;
        try {
          response = await this.doFetch(url, {
            method: options.method ?? 'GET',
            headers,
            ...(options.body === undefined ? {} : { body: options.body }),
            signal,
          });
          body = await response.text();
        } catch (error) {
          if (this.options.signal?.aborted) throw error;
          throw new NetworkError(url, error);
        }
        this.stats.bytes += body.length;

        if (response.status >= 200 && response.status < 300) {
          return { url, status: response.status, headers: response.headers, body };
        }
        const protection = detectBotProtection(response.status, response.headers, body);
        if (protection) throw new BlockedError(url, protection, response.status);
        if (response.status === 429) {
          const limiter = this.limiter(host);
          limiter.slowDown();
          this.options.onEvent?.({
            type: 'throttled',
            host,
            requestsPerSecond: limiter.requestsPerSecond,
          });
        }
        throw new HttpError(
          url,
          response.status,
          isRetryableStatus(response.status),
          parseRetryAfter(response.headers.get('retry-after')),
          body.slice(0, 1000),
        );
      },
      {
        policy: this.options.retry ?? DEFAULT_RETRY_POLICY,
        shouldRetry: (error) =>
          error instanceof NetworkError || (error instanceof HttpError && error.retryable),
        retryAfterMs: (error) => (error instanceof HttpError ? error.retryAfterMs : null),
        onRetry: ({ attempt, delayMs, error }) => {
          this.stats.retries++;
          this.options.onEvent?.({ type: 'retry', url, attempt, delayMs, reason: describe(error) });
        },
        ...(this.options.signal ? { signal: this.options.signal } : {}),
        ...(this.options.sleep ? { sleep: this.options.sleep } : {}),
        ...(this.options.random ? { random: this.options.random } : {}),
      },
    );
  }

  private limiter(host: string): RateLimiter {
    let limiter = this.limiters.get(host);
    if (!limiter) {
      limiter = new RateLimiter(
        this.options.requestsPerSecond ?? 2,
        this.options.burst ?? 1,
        this.options.clock,
        this.options.sleep,
      );
      this.limiters.set(host, limiter);
    }
    return limiter;
  }

  private async assertAllowed(url: string): Promise<void> {
    const origin = new URL(url).origin;
    let robot = this.robots.get(origin);
    if (!robot) {
      robot = this.loadRobots(origin);
      this.robots.set(origin, robot);
    }
    const rules = await robot;
    if (rules && rules.isAllowed(url, ROBOTS_AGENT) === false) throw new RobotsDisallowedError(url);
  }

  private async loadRobots(origin: string): Promise<Robot | null> {
    const robotsUrl = `${origin}/robots.txt`;
    try {
      const response = await this.request(robotsUrl, {
        skipRobots: true,
        headers: { Accept: 'text/plain' },
      });
      const rules = robotsParser(robotsUrl, response.body);
      const crawlDelay = rules.getCrawlDelay(ROBOTS_AGENT);
      if (crawlDelay && crawlDelay > 0) this.limiter(new URL(origin).host).capRate(1 / crawlDelay);
      return rules;
    } catch (error) {
      // RFC 9309: a missing robots.txt (4xx) means everything is allowed. If the
      // store's bot protection blocks robots.txt itself, the real request will report it.
      if (error instanceof HttpError && error.status >= 400 && error.status < 500) return null;
      if (error instanceof BlockedError) return null;
      if (this.options.signal?.aborted) throw error;
      throw new RobotsUnavailableError(origin, error);
    }
  }
}

function parseJson<T>(response: HttpResponse): T {
  try {
    return JSON.parse(response.body) as T;
  } catch {
    const kind = /^\s*</.test(response.body) ? 'an HTML page' : 'non-JSON data';
    throw new UnexpectedResponseError(response.url, `expected JSON but received ${kind}`);
  }
}
