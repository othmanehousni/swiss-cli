export function emptyStats() {
    return {
        pages: 0,
        products: 0,
        inserted: 0,
        updated: 0,
        unchanged: 0,
        priceChanges: 0,
        skipped: 0,
        rejected: 0,
        details: 0,
        detailsFailed: 0,
        removed: 0,
        stillListed: 0,
        requests: 0,
        retries: 0,
    };
}
function toRun(row) {
    return {
        id: row.id,
        store: row.store,
        kind: row.kind,
        scopeKey: row.scope_key,
        fullScope: row.full_scope === 1,
        details: row.details === 1,
        status: row.status,
        startedAt: row.started_at,
        heartbeatAt: row.heartbeat_at,
        stats: { ...emptyStats(), ...JSON.parse(row.stats) },
    };
}
/** A run whose heartbeat is younger than this is considered alive. */
export const HEARTBEAT_TIMEOUT_MS = 2 * 60_000;
/**
 * Persistent crawl progress: one run per crawl, one task per listing source,
 * each task remembering the cursor of the next page to fetch.
 */
export class Checkpoints {
    db;
    constructor(db) {
        this.db = db;
    }
    /** The latest unfinished run for this store and scope, if any. */
    findUnfinished(store, kind, scopeKey) {
        const row = this.db.get(`SELECT * FROM crawl_runs WHERE store = $store ORDER BY id DESC LIMIT 1`, { store });
        if (!row || row.kind !== kind || row.scope_key !== scopeKey)
            return null;
        return ['running', 'interrupted', 'failed'].includes(row.status) ? toRun(row) : null;
    }
    /** A run of this store that is still alive (heartbeat recent), e.g. in another terminal. */
    findActive(store, now) {
        const row = this.db.get(`SELECT * FROM crawl_runs WHERE store = $store AND status = 'running' ORDER BY id DESC LIMIT 1`, { store });
        if (!row)
            return null;
        return Date.parse(now) - Date.parse(row.heartbeat_at) < HEARTBEAT_TIMEOUT_MS
            ? toRun(row)
            : null;
    }
    start(store, kind, scopeKey, fullScope, details, sources, now) {
        return this.db.transaction(() => {
            this.db.run(`INSERT INTO crawl_runs (store, kind, scope_key, full_scope, details, status, started_at, heartbeat_at)
         VALUES ($store, $kind, $scope, $full, $details, 'running', $now, $now)`, { store, kind, scope: scopeKey, full: fullScope, details, now });
            const id = this.db.get('SELECT last_insert_rowid() AS id')?.id;
            for (const source of sources) {
                this.db.run(`INSERT INTO crawl_tasks (run_id, key, label, params, status, updated_at)
           VALUES ($run, $key, $label, $params, 'pending', $now)`, {
                    run: id,
                    key: source.key,
                    label: source.label,
                    params: JSON.stringify(source.params),
                    now,
                });
            }
            return this.get(id);
        });
    }
    get(runId) {
        const row = this.db.get('SELECT * FROM crawl_runs WHERE id = $id', { id: runId });
        if (!row)
            throw new Error(`crawl run ${runId} not found`);
        return toRun(row);
    }
    /** Marks a run as running again (when resuming it). */
    resume(runId, now) {
        this.db.run(`UPDATE crawl_runs SET status = 'running', heartbeat_at = $now, error = NULL WHERE id = $id`, { id: runId, now });
        this.db.run(`UPDATE crawl_tasks SET status = 'pending', error = NULL WHERE run_id = $id AND status = 'failed'`, {
            id: runId,
        });
    }
    abandon(runId, now) {
        this.db.run(`UPDATE crawl_runs SET status = 'abandoned', finished_at = $now WHERE id = $id`, {
            id: runId,
            now,
        });
    }
    tasks(runId) {
        return this.db
            .all('SELECT * FROM crawl_tasks WHERE run_id = $id ORDER BY rowid', { id: runId })
            .map((row) => ({
            key: row.key,
            label: row.label,
            params: JSON.parse(row.params),
            cursor: row.cursor === null ? null : JSON.parse(row.cursor),
            status: row.status,
            pages: row.pages,
            products: row.products,
            total: row.total,
            error: row.error,
        }));
    }
    /** Records a fetched page. Call inside the transaction that saves its products. */
    savePage(runId, key, page, stats, now) {
        this.db.run(`UPDATE crawl_tasks SET cursor = $cursor, status = $status, pages = pages + 1,
         products = products + $products, total = COALESCE($total, total), updated_at = $now
       WHERE run_id = $run AND key = $key`, {
            run: runId,
            key,
            cursor: page.next === null ? null : JSON.stringify(page.next),
            status: page.next === null ? 'done' : 'pending',
            products: page.products,
            total: page.total,
            now,
        });
        this.saveStats(runId, stats, now);
    }
    failTask(runId, key, error, now) {
        this.db.run(`UPDATE crawl_tasks SET status = 'failed', error = $error, updated_at = $now WHERE run_id = $run AND key = $key`, { run: runId, key, error, now });
    }
    saveStats(runId, stats, now) {
        this.db.run('UPDATE crawl_runs SET stats = $stats, heartbeat_at = $now WHERE id = $id', {
            id: runId,
            stats: JSON.stringify(stats),
            now,
        });
    }
    finish(runId, status, stats, now, error = null) {
        this.db.run(`UPDATE crawl_runs SET status = $status, stats = $stats, finished_at = $now, heartbeat_at = $now,
         error = $error WHERE id = $id`, { id: runId, status, stats: JSON.stringify(stats), now, error });
    }
}
