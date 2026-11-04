import { sleep as defaultSleep } from './retry.js';
const MAX_INTERVAL_MS = 30_000;
/**
 * Per-host request pacing (GCRA / virtual scheduling).
 *
 * Each `acquire()` reserves the next free time slot synchronously, so concurrent
 * callers are served in FIFO order without polling. `burst` allows that many
 * requests back-to-back after an idle period; the long-run rate never exceeds
 * `requestsPerSecond`.
 */
export class RateLimiter {
    burst;
    clock;
    sleep;
    intervalMs;
    theoreticalArrival = 0;
    constructor(requestsPerSecond, burst = 1, clock = Date.now, sleep = defaultSleep) {
        this.burst = burst;
        this.clock = clock;
        this.sleep = sleep;
        if (!(requestsPerSecond > 0))
            throw new Error('requestsPerSecond must be > 0');
        this.intervalMs = 1000 / requestsPerSecond;
    }
    get requestsPerSecond() {
        return 1000 / this.intervalMs;
    }
    async acquire(signal) {
        const now = this.clock();
        const tat = Math.max(this.theoreticalArrival, now);
        const allowedAt = tat - (Math.max(1, this.burst) - 1) * this.intervalMs;
        this.theoreticalArrival = tat + this.intervalMs;
        const waitMs = allowedAt - now;
        if (waitMs > 0)
            await this.sleep(waitMs, signal);
    }
    /** Halves the rate, e.g. after the server answered 429 Too Many Requests. */
    slowDown() {
        this.intervalMs = Math.min(this.intervalMs * 2, MAX_INTERVAL_MS);
    }
    /** Never exceed this rate from now on (e.g. a robots.txt Crawl-delay). */
    capRate(requestsPerSecond) {
        this.intervalMs = Math.max(this.intervalMs, 1000 / requestsPerSecond);
    }
}
