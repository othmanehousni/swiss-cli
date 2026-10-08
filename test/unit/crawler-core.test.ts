import { describe, expect, it } from 'vitest';
import {
  BlockedError,
  HttpError,
  NetworkError,
  RobotsDisallowedError,
  RobotsUnavailableError,
  UnexpectedResponseError,
} from '../../src/crawler/errors.js';
import { HttpClient, type HttpEvent } from '../../src/crawler/http.js';
import { nextOffset, paginate } from '../../src/crawler/pagination.js';
import { RateLimiter } from '../../src/crawler/rate-limiter.js';
import {
  backoffDelay,
  DEFAULT_RETRY_POLICY,
  parseRetryAfter,
  RetryAfterTooLongError,
  withRetry,
} from '../../src/crawler/retry.js';
import { createFakeFetch, createVirtualTime } from '../helpers/fake-fetch.js';

const policy = { ...DEFAULT_RETRY_POLICY, maxAttempts: 4 };

describe('backoff', () => {
  it('uses exponential delays with equal jitter', () => {
    expect(backoffDelay(1, policy, () => 0)).toBe(500);
    expect(backoffDelay(1, policy, () => 1)).toBe(1000);
    expect(backoffDelay(3, policy, () => 0)).toBe(2000);
    expect(backoffDelay(3, policy, () => 1)).toBe(4000);
    expect(backoffDelay(20, policy, () => 1)).toBe(policy.maxDelayMs);
  });

  it('parses Retry-After seconds and dates', () => {
    expect(parseRetryAfter('120')).toBe(120_000);
    expect(
      parseRetryAfter('Wed, 07 Oct 2026 12:00:30 GMT', Date.parse('2026-10-07T12:00:00Z')),
    ).toBe(30_000);
    expect(parseRetryAfter('soon')).toBeNull();
    expect(parseRetryAfter(null)).toBeNull();
  });
});

describe('withRetry', () => {
  const time = () => createVirtualTime();

  it('retries retryable errors until success', async () => {
    const t = time();
    let calls = 0;
    const result = await withRetry(
      async () => {
        calls++;
        if (calls < 3) throw new Error('flaky');
        return 'ok';
      },
      { policy, shouldRetry: () => true, sleep: t.sleep, random: () => 0 },
    );
    expect(result).toBe('ok');
    expect(t.sleeps).toEqual([500, 1000]);
  });

  it('stops after maxAttempts and rethrows the last error', async () => {
    const t = time();
    let calls = 0;
    await expect(
      withRetry(
        async () => {
          calls++;
          throw new Error(`fail ${calls}`);
        },
        { policy, shouldRetry: () => true, sleep: t.sleep },
      ),
    ).rejects.toThrow('fail 4');
    expect(calls).toBe(4);
  });

  it('does not retry non-retryable errors', async () => {
    let calls = 0;
    await expect(
      withRetry(
        async () => {
          calls++;
          throw new Error('fatal');
        },
        { policy, shouldRetry: () => false },
      ),
    ).rejects.toThrow('fatal');
    expect(calls).toBe(1);
  });

  it('waits at least as long as the server asks', async () => {
    const t = time();
    let calls = 0;
    await withRetry(
      async () => {
        if (++calls === 1) throw new Error('slow down');
        return 1;
      },
      {
        policy,
        shouldRetry: () => true,
        retryAfterMs: () => 7_000,
        sleep: t.sleep,
        random: () => 0,
      },
    );
    expect(t.sleeps).toEqual([7_000]);
  });

  it('gives up when asked to wait too long', async () => {
    await expect(
      withRetry(
        async () => {
          throw new Error('busy');
        },
        { policy, shouldRetry: () => true, retryAfterMs: () => 3_600_000 },
      ),
    ).rejects.toBeInstanceOf(RetryAfterTooLongError);
  });
});

describe('RateLimiter', () => {
  async function firingTimes(limiter: RateLimiter, clock: () => number, count: number) {
    const times: number[] = [];
    for (let i = 0; i < count; i++) {
      await limiter.acquire();
      times.push(clock());
    }
    return times;
  }

  it('spaces requests evenly at the configured rate', async () => {
    const t = createVirtualTime();
    const limiter = new RateLimiter(2, 1, t.clock, t.sleep);
    expect(await firingTimes(limiter, t.clock, 4)).toEqual([0, 500, 1000, 1500]);
  });

  it('allows a burst after being idle, then keeps the rate', async () => {
    const t = createVirtualTime();
    const limiter = new RateLimiter(2, 2, t.clock, t.sleep);
    expect(await firingTimes(limiter, t.clock, 4)).toEqual([0, 0, 500, 1000]);
  });

  it('reserves slots synchronously so concurrent callers queue up', async () => {
    const waits: number[] = [];
    const limiter = new RateLimiter(
      2,
      1,
      () => 0,
      async (ms) => {
        waits.push(ms);
      },
    );
    await Promise.all([limiter.acquire(), limiter.acquire(), limiter.acquire()]);
    expect(waits).toEqual([500, 1000]);
  });

  it('halves the rate when slowed down and respects caps', () => {
    const limiter = new RateLimiter(4);
    limiter.slowDown();
    expect(limiter.requestsPerSecond).toBe(2);
    limiter.capRate(0.5);
    expect(limiter.requestsPerSecond).toBe(0.5);
    limiter.capRate(10);
    expect(limiter.requestsPerSecond).toBe(0.5);
  });
});

describe('paginate', () => {
  it('walks pages until the last one', async () => {
    const pages: number[][] = [];
    for await (const page of paginate(async (cursor: number | null) => {
      const offset = cursor ?? 0;
      const items = [offset, offset + 1].filter((n) => n < 5);
      return { items, next: nextOffset(offset, items.length, 5) };
    })) {
      pages.push(page.items);
    }
    expect(pages).toEqual([[0, 1], [2, 3], [4]]);
  });

  it('resumes from a saved cursor and honours maxPages', async () => {
    const cursors: (number | null)[] = [];
    for await (const page of paginate(
      async (cursor: number | null) => ({ items: [1], next: (cursor ?? 0) + 1 }),
      { start: 10, maxPages: 2 },
    )) {
      cursors.push(page.cursor);
    }
    expect(cursors).toEqual([10, 11]);
  });

  it('detects a store returning the same cursor forever', async () => {
    const run = async () => {
      for await (const _ of paginate(async (_cursor: string | null) => ({
        items: [1],
        next: 'same',
      }))) {
        // consume
      }
    };
    await expect(run()).rejects.toThrow('Pagination loop detected');
  });

  it('stops on an empty page when told how to count items', async () => {
    const calls: (number | null)[] = [];
    for await (const _ of paginate(
      async (cursor: number | null) => {
        calls.push(cursor);
        return { items: cursor === null ? [1] : [], next: (cursor ?? 0) + 1 };
      },
      { count: (page) => page.items.length },
    )) {
      // consume
    }
    expect(calls).toEqual([null, 1]);
  });

  it('computes the next offset', () => {
    expect(nextOffset(0, 60, 130)).toBe(60);
    expect(nextOffset(120, 10, 130)).toBeNull();
    expect(nextOffset(0, 0, null)).toBeNull();
    expect(nextOffset(0, 60, null)).toBe(60);
  });
});

describe('HttpClient', () => {
  function client(
    handler: Parameters<typeof createFakeFetch>[0],
    extra: Record<string, unknown> = {},
  ) {
    const fake = createFakeFetch(handler);
    const t = createVirtualTime();
    const events: HttpEvent[] = [];
    const http = new HttpClient({
      userAgent: 'test-agent',
      requestsPerSecond: 1000,
      fetch: fake.fetch,
      sleep: t.sleep,
      clock: t.clock,
      random: () => 0,
      retry: policy,
      onEvent: (e) => events.push(e),
      ...extra,
    });
    return { http, fake, t, events };
  }

  it('sends an identifying User-Agent and parses JSON', async () => {
    const { http, fake } = client(() => ({ body: { hello: 'world' } }));
    await expect(http.getJson('https://api.example.ch/x')).resolves.toEqual({ hello: 'world' });
    expect(fake.requests()[0]?.headers['User-Agent']).toBe('test-agent');
  });

  it('retries 503 responses and succeeds', async () => {
    let n = 0;
    const { http, events } = client((url) =>
      url.endsWith('/robots.txt') ? { status: 404 } : ++n < 3 ? { status: 503 } : { body: [1] },
    );
    await expect(http.getJson('https://api.example.ch/x')).resolves.toEqual([1]);
    expect(http.stats.retries).toBe(2);
    expect(events.filter((e) => e.type === 'retry')).toHaveLength(2);
  });

  it('gives up after the retry budget with an HttpError', async () => {
    const { http, fake } = client((url) =>
      url.endsWith('/robots.txt') ? { status: 404 } : { status: 500 },
    );
    await expect(http.getJson('https://api.example.ch/x')).rejects.toBeInstanceOf(HttpError);
    expect(fake.requests()).toHaveLength(policy.maxAttempts);
  });

  it('does not retry a 404', async () => {
    const { http, fake } = client(() => ({ status: 404 }));
    await expect(http.getJson('https://api.example.ch/x')).rejects.toMatchObject({ status: 404 });
    expect(fake.requests()).toHaveLength(1);
  });

  it('slows down and honours Retry-After on 429', async () => {
    let n = 0;
    const { http, t, events } = client((url) =>
      url.endsWith('/robots.txt')
        ? { status: 404 }
        : ++n === 1
          ? { status: 429, headers: { 'retry-after': '9' } }
          : { body: {} },
    );
    await http.getJson('https://api.example.ch/x');
    expect(t.sleeps).toContain(9000);
    expect(events.some((e) => e.type === 'throttled')).toBe(true);
  });

  it('recognises DataDome and fails fast without retrying', async () => {
    const { http, fake } = client(() => ({
      status: 403,
      headers: { 'x-datadome': 'protected', server: 'DataDome' },
      body: '<html>captcha-delivery.com</html>',
    }));
    const error = await http.getJson('https://www.coop.ch/x').then(
      () => null,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(BlockedError);
    expect((error as BlockedError).protection).toBe('DataDome');
    expect(fake.requests()).toHaveLength(1);
  });

  it('recognises Cloudflare and Akamai blocks', async () => {
    const cf = client(() => ({
      status: 403,
      headers: { server: 'cloudflare' },
      body: '<html>maintenance</html>',
    }));
    await expect(cf.http.getJson('https://www.migros.ch/x')).rejects.toMatchObject({
      protection: 'Cloudflare',
    });
    const ak = client(() => ({
      status: 403,
      headers: { server: 'AkamaiGHost' },
      body: 'Access Denied',
    }));
    await expect(ak.http.getJson('https://www.aldi-suisse.ch/x')).rejects.toMatchObject({
      protection: 'Akamai',
    });
  });

  it('treats a JSON error from an API behind Cloudflare as a normal HTTP error', async () => {
    // Supabase sits behind Cloudflare and answers "permission denied" with a JSON 403.
    const { http, fake } = client(() => ({
      status: 403,
      headers: { server: 'cloudflare', 'cf-ray': '1-ZRH', 'content-type': 'application/json' },
      body: { code: '42501', message: 'permission denied for table products' },
    }));
    const error = await http.getJson('https://x.supabase.co/rest/v1/products?limit=1').then(
      () => null,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(HttpError);
    expect((error as HttpError).message).toBe(
      'x.supabase.co answered HTTP 403 for /rest/v1/products?limit=1 (permission denied for table products)',
    );
    expect(fake.requests()).toHaveLength(1);
  });

  it('still recognises Cloudflare challenges and DataDome JSON blocks', async () => {
    const challenge = client(() => ({
      status: 403,
      headers: { 'cf-mitigated': 'challenge', 'content-type': 'text/html' },
      body: '<html>Just a moment...</html>',
    }));
    await expect(challenge.http.getJson('https://www.migros.ch/x')).rejects.toMatchObject({
      protection: 'Cloudflare',
    });
    const datadome = client(() => ({
      status: 403,
      headers: { 'content-type': 'application/json' },
      body: { url: 'https://geo.captcha-delivery.com/captcha/?initialCid=x' },
    }));
    await expect(datadome.http.getJson('https://www.coop.ch/x')).rejects.toMatchObject({
      protection: 'DataDome',
    });
  });

  it('does not mistake a 404 from a DataDome-protected site for a block', async () => {
    const { http } = client(() => ({
      status: 404,
      headers: { 'x-datadome': 'protected' },
      body: '<html>Not found</html>',
    }));
    await expect(http.getJson('https://www.coop.ch/p/1')).rejects.toBeInstanceOf(HttpError);
  });

  it('respects robots.txt disallow rules', async () => {
    const { http, fake } = client((url) =>
      url.endsWith('/robots.txt') ? { body: 'User-agent: *\nDisallow: /private' } : { body: {} },
    );
    await expect(http.getJson('https://shop.example.ch/private/data')).rejects.toBeInstanceOf(
      RobotsDisallowedError,
    );
    await expect(http.getJson('https://shop.example.ch/public')).resolves.toEqual({});
    expect(fake.requests().map((c) => c.url)).toEqual(['https://shop.example.ch/public']);
    expect(fake.calls.filter((c) => c.url.endsWith('/robots.txt'))).toHaveLength(1);
  });

  it('honours a robots.txt Crawl-delay', async () => {
    const { http, t } = client((url) =>
      url.endsWith('/robots.txt') ? { body: 'User-agent: *\nCrawl-delay: 5' } : { body: {} },
    );
    await http.getJson('https://slow.example.ch/a');
    await http.getJson('https://slow.example.ch/b');
    expect(t.sleeps.some((ms) => ms >= 4999)).toBe(true);
  });

  it('pauses a store whose robots.txt is unavailable (5xx)', async () => {
    const { http } = client((url) =>
      url.endsWith('/robots.txt') ? { status: 500 } : { body: {} },
    );
    await expect(http.getJson('https://down.example.ch/a')).rejects.toBeInstanceOf(
      RobotsUnavailableError,
    );
  });

  it('retries network errors', async () => {
    let n = 0;
    const { http } = client((url) =>
      url.endsWith('/robots.txt')
        ? { status: 404 }
        : ++n === 1
          ? new TypeError('fetch failed')
          : { body: 1 },
    );
    await expect(http.getJson('https://api.example.ch/x')).resolves.toBe(1);
  });

  it('reports network failures in plain words', async () => {
    const { http } = client((url) =>
      url.endsWith('/robots.txt')
        ? { status: 404 }
        : Object.assign(new TypeError('fetch failed'), { cause: { code: 'ENOTFOUND' } }),
    );
    await expect(http.getJson('https://api.example.ch/x')).rejects.toThrow(NetworkError);
  });

  it('explains when a store returns HTML instead of JSON', async () => {
    const { http } = client(() => ({ body: '<html>hi</html>' }));
    await expect(http.getJson('https://api.example.ch/x')).rejects.toBeInstanceOf(
      UnexpectedResponseError,
    );
  });

  it('can skip robots.txt entirely', async () => {
    const { http, fake } = client(() => ({ body: {} }), { respectRobots: false });
    await http.getJson('https://api.example.ch/x');
    expect(fake.calls.map((c) => c.url)).toEqual(['https://api.example.ch/x']);
  });
});
