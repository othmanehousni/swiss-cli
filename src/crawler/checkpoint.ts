import type { StoreId } from '../normalization/types.js';
import type { Cursor, ListingSource } from '../providers/types.js';
import type { Database } from '../storage/database.js';

export type RunKind = 'fetch' | 'update';
export type RunStatus = 'running' | 'completed' | 'failed' | 'interrupted' | 'abandoned';

export interface RunStats {
  pages: number;
  products: number;
  inserted: number;
  updated: number;
  unchanged: number;
  priceChanges: number;
  /** Items the store returned that could not be read. */
  skipped: number;
  /** Items that failed the data-quality checks. */
  rejected: number;
  details: number;
  detailsFailed: number;
  removed: number;
  /** Products missing from the listing that the store confirmed still exist. */
  stillListed: number;
  requests: number;
  retries: number;
}

export function emptyStats(): RunStats {
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

export interface RunRecord {
  id: number;
  store: StoreId;
  kind: RunKind;
  scopeKey: string;
  fullScope: boolean;
  details: boolean;
  status: RunStatus;
  startedAt: string;
  heartbeatAt: string;
  stats: RunStats;
}

export interface TaskRecord {
  key: string;
  label: string;
  params: Record<string, string>;
  cursor: Cursor;
  status: 'pending' | 'done' | 'failed';
  pages: number;
  products: number;
  total: number | null;
  error: string | null;
}

interface RunRow {
  id: number;
  store: StoreId;
  kind: RunKind;
  scope_key: string;
  full_scope: number;
  details: number;
  status: RunStatus;
  started_at: string;
  heartbeat_at: string;
  stats: string;
}

function toRun(row: RunRow): RunRecord {
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
    stats: { ...emptyStats(), ...(JSON.parse(row.stats) as Partial<RunStats>) },
  };
}

/** A run whose heartbeat is younger than this is considered alive. */
export const HEARTBEAT_TIMEOUT_MS = 2 * 60_000;

/**
 * Persistent crawl progress: one run per crawl, one task per listing source,
 * each task remembering the cursor of the next page to fetch.
 */
export class Checkpoints {
  constructor(private readonly db: Database) {}

  /** The latest unfinished run for this store and scope, if any. */
  findUnfinished(store: StoreId, kind: RunKind, scopeKey: string): RunRecord | null {
    const row = this.db.get<RunRow>(
      `SELECT * FROM crawl_runs WHERE store = $store ORDER BY id DESC LIMIT 1`,
      { store },
    );
    if (!row || row.kind !== kind || row.scope_key !== scopeKey) return null;
    return ['running', 'interrupted', 'failed'].includes(row.status) ? toRun(row) : null;
  }

  /** A run of this store that is still alive (heartbeat recent), e.g. in another terminal. */
  findActive(store: StoreId, now: string): RunRecord | null {
    const row = this.db.get<RunRow>(
      `SELECT * FROM crawl_runs WHERE store = $store AND status = 'running' ORDER BY id DESC LIMIT 1`,
      { store },
    );
    if (!row) return null;
    return Date.parse(now) - Date.parse(row.heartbeat_at) < HEARTBEAT_TIMEOUT_MS
      ? toRun(row)
      : null;
  }

  start(
    store: StoreId,
    kind: RunKind,
    scopeKey: string,
    fullScope: boolean,
    details: boolean,
    sources: ListingSource[],
    now: string,
  ): RunRecord {
    return this.db.transaction(() => {
      this.db.run(
        `INSERT INTO crawl_runs (store, kind, scope_key, full_scope, details, status, started_at, heartbeat_at)
         VALUES ($store, $kind, $scope, $full, $details, 'running', $now, $now)`,
        { store, kind, scope: scopeKey, full: fullScope, details, now },
      );
      const id = this.db.get<{ id: number }>('SELECT last_insert_rowid() AS id')?.id as number;
      for (const source of sources) {
        this.db.run(
          `INSERT INTO crawl_tasks (run_id, key, label, params, status, updated_at)
           VALUES ($run, $key, $label, $params, 'pending', $now)`,
          {
            run: id,
            key: source.key,
            label: source.label,
            params: JSON.stringify(source.params),
            now,
          },
        );
      }
      return this.get(id);
    });
  }

  get(runId: number): RunRecord {
    const row = this.db.get<RunRow>('SELECT * FROM crawl_runs WHERE id = $id', { id: runId });
    if (!row) throw new Error(`crawl run ${runId} not found`);
    return toRun(row);
  }

  /** Marks a run as running again (when resuming it). */
  resume(runId: number, now: string): void {
    this.db.run(
      `UPDATE crawl_runs SET status = 'running', heartbeat_at = $now, error = NULL WHERE id = $id`,
      { id: runId, now },
    );
    this.db.run(
      `UPDATE crawl_tasks SET status = 'pending', error = NULL WHERE run_id = $id AND status = 'failed'`,
      {
        id: runId,
      },
    );
  }

  abandon(runId: number, now: string): void {
    this.db.run(`UPDATE crawl_runs SET status = 'abandoned', finished_at = $now WHERE id = $id`, {
      id: runId,
      now,
    });
  }

  tasks(runId: number): TaskRecord[] {
    return this.db
      .all<{
        key: string;
        label: string;
        params: string;
        cursor: string | null;
        status: TaskRecord['status'];
        pages: number;
        products: number;
        total: number | null;
        error: string | null;
      }>('SELECT * FROM crawl_tasks WHERE run_id = $id ORDER BY rowid', { id: runId })
      .map((row) => ({
        key: row.key,
        label: row.label,
        params: JSON.parse(row.params) as Record<string, string>,
        cursor: row.cursor === null ? null : (JSON.parse(row.cursor) as Cursor),
        status: row.status,
        pages: row.pages,
        products: row.products,
        total: row.total,
        error: row.error,
      }));
  }

  /** Records a fetched page. Call inside the transaction that saves its products. */
  savePage(
    runId: number,
    key: string,
    page: { next: Cursor; products: number; total: number | null },
    stats: RunStats,
    now: string,
  ): void {
    this.db.run(
      `UPDATE crawl_tasks SET cursor = $cursor, status = $status, pages = pages + 1,
         products = products + $products, total = COALESCE($total, total), updated_at = $now
       WHERE run_id = $run AND key = $key`,
      {
        run: runId,
        key,
        cursor: page.next === null ? null : JSON.stringify(page.next),
        status: page.next === null ? 'done' : 'pending',
        products: page.products,
        total: page.total,
        now,
      },
    );
    this.saveStats(runId, stats, now);
  }

  failTask(runId: number, key: string, error: string, now: string): void {
    this.db.run(
      `UPDATE crawl_tasks SET status = 'failed', error = $error, updated_at = $now WHERE run_id = $run AND key = $key`,
      { run: runId, key, error, now },
    );
  }

  saveStats(runId: number, stats: RunStats, now: string): void {
    this.db.run('UPDATE crawl_runs SET stats = $stats, heartbeat_at = $now WHERE id = $id', {
      id: runId,
      stats: JSON.stringify(stats),
      now,
    });
  }

  finish(
    runId: number,
    status: RunStatus,
    stats: RunStats,
    now: string,
    error: string | null = null,
  ): void {
    this.db.run(
      `UPDATE crawl_runs SET status = $status, stats = $stats, finished_at = $now, heartbeat_at = $now,
         error = $error WHERE id = $id`,
      { id: runId, status, stats: JSON.stringify(stats), now, error },
    );
  }
}
