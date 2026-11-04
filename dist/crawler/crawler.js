import { checkProduct } from '../normalization/validate.js';
import { countActiveProducts, countSeenSince, countUnseenSince, markRemoved, markSeen, markUnseenAsRemoved, productsNeedingDetails, saveDetails, saveProducts, unseenSince, } from '../storage/products.js';
import { Checkpoints } from './checkpoint.js';
import { BlockedError, RobotsDisallowedError, RobotsUnavailableError } from './errors.js';
import { paginate } from './pagination.js';
import { runPool } from './pool.js';
import { RetryAfterTooLongError } from './retry.js';
/** Another process is crawling this store right now. */
export class StoreBusyError extends Error {
    constructor(store, since) {
        super(`Another swiss-grocery process is already fetching ${store} (active since ${since}). ` +
            'Wait for it to finish, then try again.');
        this.name = 'StoreBusyError';
    }
}
/** Errors after which further requests to the same store are pointless. */
export function isStoreFatal(error) {
    return (error instanceof BlockedError ||
        error instanceof RobotsDisallowedError ||
        error instanceof RobotsUnavailableError ||
        error instanceof RetryAfterTooLongError);
}
/** Stable catalogs never lose this share of their products in one crawl; more means trouble. */
const REMOVAL_GUARD = 0.3;
function message(error) {
    return error instanceof Error ? error.message : String(error);
}
/**
 * Crawls one store: category sources -> pages -> products (-> details),
 * saving progress after every page so an interrupted crawl can resume.
 */
export async function crawlStore(options) {
    const { db, provider, ctx } = options;
    const store = provider.info.id;
    const now = options.now ?? (() => new Date().toISOString());
    const startedMs = Date.now();
    const checkpoints = new Checkpoints(db);
    const sample = options.limit != null;
    const fullScope = options.categoryIds === null && !sample;
    const scopeKey = options.categoryIds ? [...options.categoryIds].sort().join(',') : 'all';
    const busy = checkpoints.findActive(store, now());
    if (busy)
        throw new StoreBusyError(provider.info.name, busy.heartbeatAt);
    let run = sample ? null : checkpoints.findUnfinished(store, options.kind, scopeKey);
    if (run && options.fresh) {
        checkpoints.abandon(run.id, now());
        run = null;
    }
    const resumed = run !== null;
    if (run) {
        checkpoints.resume(run.id, now());
    }
    else {
        const sources = provider.sources(options.categories, options.categoryIds);
        run = checkpoints.start(store, options.kind, scopeKey, fullScope, options.details !== false, sources, now());
    }
    const runId = run.id;
    const runStartedAt = run.startedAt;
    const stats = run.stats;
    const http = { requests: ctx.http.stats.requests, retries: ctx.http.stats.retries };
    const base = { requests: stats.requests, retries: stats.retries };
    const syncHttp = () => {
        stats.requests = base.requests + ctx.http.stats.requests - http.requests;
        stats.retries = base.retries + ctx.http.stats.retries - http.retries;
    };
    const tasks = checkpoints.tasks(runId);
    const pending = tasks.filter((t) => t.status !== 'done');
    let sourcesDone = tasks.length - pending.length;
    const failures = [];
    // A product listed twice within one section means the listing shifted while it
    // was being paged through (some products were then skipped).
    const seenPerSource = new Map();
    let repeated = 0;
    let fatal = null;
    const interrupted = () => fatal !== null || options.signal?.aborted === true;
    const limitReached = () => options.limit != null && stats.products >= options.limit;
    const report = (phase, source, detailsDone = 0, detailsTotal = 0) => options.onProgress?.({
        phase,
        resumed,
        sourcesDone,
        sourcesTotal: tasks.length,
        source,
        stats,
        detailsDone,
        detailsTotal,
    });
    // 1. Listing: page through every source, saving products and the cursor atomically.
    report('listing', null);
    await runPool(pending, options.concurrency ?? 2, async (task) => {
        if (interrupted() || limitReached())
            return;
        const source = { key: task.key, label: task.label, params: task.params };
        try {
            const pages = paginate((cursor) => provider.fetchPage(ctx, source, cursor), {
                start: task.cursor,
                count: (page) => page.products.length + page.skipped,
            });
            for await (const page of pages) {
                const valid = [];
                const seen = seenPerSource.get(task.key) ?? new Set();
                seenPerSource.set(task.key, seen);
                for (const product of page.products) {
                    if (seen.has(product.storeProductId))
                        repeated++;
                    seen.add(product.storeProductId);
                    const checked = checkProduct(product);
                    if (checked.ok)
                        valid.push(checked.product);
                    else
                        stats.rejected++;
                }
                const at = now();
                db.transaction(() => {
                    const saved = saveProducts(db, valid, at, runStartedAt);
                    stats.pages++;
                    stats.products += valid.length;
                    stats.inserted += saved.inserted;
                    stats.updated += saved.updated;
                    stats.unchanged += saved.unchanged;
                    stats.priceChanges += saved.priceChanges;
                    stats.skipped += page.skipped;
                    syncHttp();
                    checkpoints.savePage(runId, task.key, { next: page.next, products: valid.length, total: page.total ?? null }, stats, at);
                });
                report('listing', task.label);
                // Stopping here is safe: the saved cursor lets the next run continue from this page.
                if (interrupted() || limitReached())
                    return;
            }
            sourcesDone++;
            report('listing', task.label);
        }
        catch (error) {
            if (options.signal?.aborted)
                return;
            if (isStoreFatal(error)) {
                fatal ??= error;
                return;
            }
            failures.push({ source: task.label, error: message(error) });
            checkpoints.failTask(runId, task.key, message(error), now());
        }
    });
    // 2. Removed products: only a complete, failure-free crawl of the whole catalog can tell.
    let removalSkipped = null;
    const listingComplete = !interrupted() &&
        failures.length === 0 &&
        checkpoints.tasks(runId).every((t) => t.status === 'done');
    if (fullScope && listingComplete) {
        const unseen = countUnseenSince(db, store, runStartedAt);
        const active = countActiveProducts(db, store);
        const shifted = repeated > Math.max(5, stats.products * 0.002);
        if (!provider.info.rotating && unseen > Math.max(25, active * REMOVAL_GUARD)) {
            removalSkipped = { reason: 'too-many', unseen, active, repeated };
        }
        else if (unseen > 0 && provider.isStillListed) {
            // Ask the store about each missing product; only confirmed ones are removed.
            const isStillListed = provider.isStillListed;
            const candidates = unseenSince(db, store, runStartedAt);
            const gone = [];
            let checked = 0;
            report('confirming', null, 0, candidates.length);
            await runPool(candidates, options.concurrency ?? 2, async (row) => {
                if (interrupted())
                    return;
                try {
                    const request = {
                        storeProductId: row.store_product_id,
                        sourceRef: JSON.parse(row.source_ref),
                        url: row.url,
                    };
                    if (await isStillListed(ctx, request)) {
                        markSeen(db, row.id, now());
                        stats.stillListed++;
                    }
                    else {
                        gone.push(row.id);
                    }
                }
                catch (error) {
                    // When in doubt, keep the product: a wrong "removed" is worse than a late one.
                    if (isStoreFatal(error))
                        fatal ??= error;
                    else
                        ctx.debug(`could not check ${row.id}: ${message(error)}`);
                }
                report('confirming', row.id, ++checked, candidates.length);
            });
            stats.removed += markRemoved(db, gone, now());
        }
        else if (unseen > 0 && shifted) {
            removalSkipped = { reason: 'listing-shifted', unseen, active, repeated };
        }
        else {
            stats.removed += markUnseenAsRemoved(db, store, runStartedAt, now());
        }
    }
    // 3. Details (ingredients, nutrition, ...): one request per product, so only when asked.
    if (options.details && provider.fetchDetails && !interrupted()) {
        const fetchDetails = provider.fetchDetails;
        const todo = productsNeedingDetails(db, store, options.details === 'new' ? { firstSeenSince: runStartedAt } : { seenSince: runStartedAt });
        let done = 0;
        report('details', null, 0, todo.length);
        await runPool(todo, options.concurrency ?? 2, async (row) => {
            if (interrupted())
                return;
            try {
                const details = await fetchDetails(ctx, {
                    storeProductId: row.store_product_id,
                    sourceRef: JSON.parse(row.source_ref),
                    url: row.url,
                });
                saveDetails(db, row.id, details ?? {}, now());
                stats.details++;
            }
            catch (error) {
                if (options.signal?.aborted)
                    return;
                if (isStoreFatal(error)) {
                    fatal ??= error;
                    return;
                }
                stats.detailsFailed++;
                ctx.debug(`details for ${row.id} failed: ${message(error)}`);
            }
            done++;
            syncHttp();
            if (done % 10 === 0)
                checkpoints.saveStats(runId, stats, now());
            report('details', row.id, done, todo.length);
        });
    }
    syncHttp();
    const status = options.signal?.aborted
        ? 'interrupted'
        : fatal !== null || failures.length > 0
            ? 'failed'
            : 'completed';
    checkpoints.finish(runId, status, stats, now(), fatal !== null ? message(fatal) : null);
    if (fatal !== null)
        throw fatal;
    return {
        runId,
        status,
        resumed,
        sample,
        stats,
        uniqueProducts: countSeenSince(db, store, runStartedAt),
        failures,
        removalSkipped,
        durationMs: Date.now() - startedMs,
    };
}
