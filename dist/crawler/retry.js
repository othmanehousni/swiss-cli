import { setTimeout as delay } from 'node:timers/promises';
export const DEFAULT_RETRY_POLICY = {
    maxAttempts: 5,
    baseDelayMs: 1_000,
    maxDelayMs: 60_000,
    maxRetryAfterMs: 5 * 60_000,
};
export const sleep = async (ms, signal) => {
    if (ms > 0)
        await delay(ms, undefined, { signal });
};
/**
 * Exponential backoff with "equal jitter": half of the exponential delay is fixed,
 * the other half random. Retries are spread out but never fire immediately.
 * attempt 1 -> 0.5-1 s, 2 -> 1-2 s, 3 -> 2-4 s ... capped at maxDelayMs.
 */
export function backoffDelay(attempt, policy, random = Math.random) {
    const ceiling = Math.min(policy.maxDelayMs, policy.baseDelayMs * 2 ** (attempt - 1));
    return Math.round(ceiling / 2 + random() * (ceiling / 2));
}
/** Parses a Retry-After header (seconds or HTTP date) into milliseconds. */
export function parseRetryAfter(value, now = Date.now()) {
    if (!value)
        return null;
    const trimmed = value.trim();
    if (/^\d+(\.\d+)?$/.test(trimmed))
        return Math.round(Number(trimmed) * 1000);
    const date = Date.parse(trimmed);
    return Number.isNaN(date) ? null : Math.max(0, date - now);
}
export class RetryAfterTooLongError extends Error {
    waitMs;
    cause;
    constructor(waitMs, cause) {
        super(`The server asked to wait ${Math.ceil(waitMs / 60_000)} minutes before trying again`);
        this.waitMs = waitMs;
        this.cause = cause;
        this.name = 'RetryAfterTooLongError';
    }
}
export async function withRetry(operation, options) {
    const wait = options.sleep ?? sleep;
    for (let attempt = 1;; attempt++) {
        try {
            return await operation(attempt);
        }
        catch (error) {
            if (options.signal?.aborted ||
                attempt >= options.policy.maxAttempts ||
                !options.shouldRetry(error)) {
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
