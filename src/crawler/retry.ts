import { setTimeout as delay } from 'node:timers/promises';

export interface RetryPolicy {
  /** Total attempts including the first one. */
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
  /** Give up instead of waiting when a server asks us to wait longer than this. */
  maxRetryAfterMs: number;
}

export const DEFAULT_RETRY_POLICY: RetryPolicy = {
  maxAttempts: 5,
  baseDelayMs: 1_000,
  maxDelayMs: 60_000,
  maxRetryAfterMs: 5 * 60_000,
};

export type Sleep = (ms: number, signal?: AbortSignal) => Promise<void>;

export const sleep: Sleep = async (ms, signal) => {
  if (ms > 0) await delay(ms, undefined, { signal });
};

/**
 * Exponential backoff with "equal jitter": half of the exponential delay is fixed,
 * the other half random. Retries are spread out but never fire immediately.
 * attempt 1 -> 0.5-1 s, 2 -> 1-2 s, 3 -> 2-4 s ... capped at maxDelayMs.
 */
export function backoffDelay(
  attempt: number,
  policy: RetryPolicy,
  random: () => number = Math.random,
): number {
  const ceiling = Math.min(policy.maxDelayMs, policy.baseDelayMs * 2 ** (attempt - 1));
  return Math.round(ceiling / 2 + random() * (ceiling / 2));
}

/** Parses a Retry-After header (seconds or HTTP date) into milliseconds. */
export function parseRetryAfter(value: string | null, now: number = Date.now()): number | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (/^\d+(\.\d+)?$/.test(trimmed)) return Math.round(Number(trimmed) * 1000);
  const date = Date.parse(trimmed);
  return Number.isNaN(date) ? null : Math.max(0, date - now);
}

export class RetryAfterTooLongError extends Error {
  constructor(
    readonly waitMs: number,
    override readonly cause: unknown,
  ) {
    super(`The server asked to wait ${Math.ceil(waitMs / 60_000)} minutes before trying again`);
    this.name = 'RetryAfterTooLongError';
  }
}

export interface RetryOptions {
  policy: RetryPolicy;
  shouldRetry: (error: unknown) => boolean;
  /** Server-provided wait hint (Retry-After) for an error, if any. */
  retryAfterMs?: (error: unknown) => number | null;
  onRetry?: (info: { attempt: number; delayMs: number; error: unknown }) => void;
  sleep?: Sleep;
  random?: () => number;
  signal?: AbortSignal;
}

export async function withRetry<T>(
  operation: (attempt: number) => Promise<T>,
  options: RetryOptions,
): Promise<T> {
  const wait = options.sleep ?? sleep;
  for (let attempt = 1; ; attempt++) {
    try {
      return await operation(attempt);
    } catch (error) {
      if (
        options.signal?.aborted ||
        attempt >= options.policy.maxAttempts ||
        !options.shouldRetry(error)
      ) {
        throw error;
      }
      const hinted = options.retryAfterMs?.(error) ?? null;
      if (hinted != null && hinted > options.policy.maxRetryAfterMs) {
        throw new RetryAfterTooLongError(hinted, error);
      }
      const delayMs = Math.max(hinted ?? 0, backoffDelay(attempt, options.policy, options.random));
      options.onRetry?.({ attempt, delayMs, error });
      await wait(delayMs, options.signal);
    }
  }
}
