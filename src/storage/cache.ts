import type { Database } from './database.js';

export interface Cached<T> {
  value: T;
  fetchedAt: string;
  /** Served from the cache instead of the source. */
  fromCache: boolean;
  /** The source could not be reached, so an expired copy was used. */
  stale: boolean;
}

/**
 * Returns what `load` produced less than `maxAgeMs` ago, or loads it again.
 * When loading fails and an older copy exists, that copy is returned (marked stale),
 * so lookups keep working offline. Values are stored as JSON.
 */
export async function cached<T>(
  db: Database,
  key: string,
  maxAgeMs: number,
  load: () => Promise<T>,
  now: number = Date.now(),
): Promise<Cached<T>> {
  const row = db.get<{ body: string; fetched_at: string }>(
    'SELECT body, fetched_at FROM cache WHERE key = $key',
    { key },
  );
  if (row && now - Date.parse(row.fetched_at) < maxAgeMs) {
    return {
      value: JSON.parse(row.body) as T,
      fetchedAt: row.fetched_at,
      fromCache: true,
      stale: false,
    };
  }
  let value: T;
  try {
    value = await load();
  } catch (error) {
    if (!row) throw error;
    return {
      value: JSON.parse(row.body) as T,
      fetchedAt: row.fetched_at,
      fromCache: true,
      stale: true,
    };
  }
  const fetchedAt = new Date(now).toISOString();
  db.run(
    `INSERT INTO cache (key, body, fetched_at) VALUES ($key, $body, $at)
     ON CONFLICT (key) DO UPDATE SET body = excluded.body, fetched_at = excluded.fetched_at`,
    { key, body: JSON.stringify(value), at: fetchedAt },
  );
  return { value, fetchedAt, fromCache: false, stale: false };
}

/** Drops cached answers whose key starts with `prefix` (e.g. older weather runs). */
export function dropCached(db: Database, prefix: string, keep?: string): void {
  db.run('DELETE FROM cache WHERE key LIKE $prefix AND ($keep IS NULL OR key <> $keep)', {
    prefix: `${prefix.replace(/[%_]/g, '')}%`,
    keep: keep ?? null,
  });
}

export interface DatasetInfo {
  name: string;
  version: string | null;
  rows: number;
  fetchedAt: string;
}

export function datasetInfo(db: Database, name: string): DatasetInfo | null {
  const row = db.get<{ name: string; version: string | null; rows: number; fetched_at: string }>(
    'SELECT name, version, rows, fetched_at FROM datasets WHERE name = $name',
    { name },
  );
  return row
    ? { name: row.name, version: row.version, rows: row.rows, fetchedAt: row.fetched_at }
    : null;
}

export function listDatasets(db: Database, prefix = ''): DatasetInfo[] {
  return db
    .all<{ name: string; version: string | null; rows: number; fetched_at: string }>(
      'SELECT name, version, rows, fetched_at FROM datasets WHERE name LIKE $prefix ORDER BY name',
      { prefix: `${prefix}%` },
    )
    .map((row) => ({
      name: row.name,
      version: row.version,
      rows: row.rows,
      fetchedAt: row.fetched_at,
    }));
}

export function recordDataset(
  db: Database,
  name: string,
  rows: number,
  version: string | null,
  now: string = new Date().toISOString(),
): void {
  db.run(
    `INSERT INTO datasets (name, version, rows, fetched_at) VALUES ($name, $version, $rows, $now)
     ON CONFLICT (name) DO UPDATE SET version = excluded.version, rows = excluded.rows,
       fetched_at = excluded.fetched_at`,
    { name, version, rows, now },
  );
}

/** True when the dataset is missing or older than `maxAgeMs`. */
export function needsRefresh(
  db: Database,
  name: string,
  maxAgeMs: number,
  now = Date.now(),
): boolean {
  const info = datasetInfo(db, name);
  return !info || now - Date.parse(info.fetchedAt) >= maxAgeMs;
}
