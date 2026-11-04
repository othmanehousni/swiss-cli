/**
 * Returns what `load` produced less than `maxAgeMs` ago, or loads it again.
 * When loading fails and an older copy exists, that copy is returned (marked stale),
 * so lookups keep working offline. Values are stored as JSON.
 */
export async function cached(db, key, maxAgeMs, load, now = Date.now()) {
    const row = db.get('SELECT body, fetched_at FROM cache WHERE key = $key', { key });
    if (row && now - Date.parse(row.fetched_at) < maxAgeMs) {
        return {
            value: JSON.parse(row.body),
            fetchedAt: row.fetched_at,
            fromCache: true,
            stale: false,
        };
    }
    let value;
    try {
        value = await load();
    }
    catch (error) {
        if (!row)
            throw error;
        return {
            value: JSON.parse(row.body),
            fetchedAt: row.fetched_at,
            fromCache: true,
            stale: true,
        };
    }
    const fetchedAt = new Date(now).toISOString();
    db.run(`INSERT INTO cache (key, body, fetched_at) VALUES ($key, $body, $at)
     ON CONFLICT (key) DO UPDATE SET body = excluded.body, fetched_at = excluded.fetched_at`, { key, body: JSON.stringify(value), at: fetchedAt });
    return { value, fetchedAt, fromCache: false, stale: false };
}
/** Drops cached answers whose key starts with `prefix` (e.g. older weather runs). */
export function dropCached(db, prefix, keep) {
    db.run('DELETE FROM cache WHERE key LIKE $prefix AND ($keep IS NULL OR key <> $keep)', {
        prefix: `${prefix.replace(/[%_]/g, '')}%`,
        keep: keep ?? null,
    });
}
export function datasetInfo(db, name) {
    const row = db.get('SELECT name, version, rows, fetched_at FROM datasets WHERE name = $name', { name });
    return row
        ? { name: row.name, version: row.version, rows: row.rows, fetchedAt: row.fetched_at }
        : null;
}
export function listDatasets(db, prefix = '') {
    return db
        .all('SELECT name, version, rows, fetched_at FROM datasets WHERE name LIKE $prefix ORDER BY name', { prefix: `${prefix}%` })
        .map((row) => ({
        name: row.name,
        version: row.version,
        rows: row.rows,
        fetchedAt: row.fetched_at,
    }));
}
export function recordDataset(db, name, rows, version, now = new Date().toISOString()) {
    db.run(`INSERT INTO datasets (name, version, rows, fetched_at) VALUES ($name, $version, $rows, $now)
     ON CONFLICT (name) DO UPDATE SET version = excluded.version, rows = excluded.rows,
       fetched_at = excluded.fetched_at`, { name, version, rows, now });
}
/** True when the dataset is missing or older than `maxAgeMs`. */
export function needsRefresh(db, name, maxAgeMs, now = Date.now()) {
    const info = datasetInfo(db, name);
    return !info || now - Date.parse(info.fetchedAt) >= maxAgeMs;
}
/** Answers that only matter for minutes or hours: forgotten after a day. */
const SHORT_LIVED = [
    'transport:',
    'sharing:',
    'charging:status',
    'meteoswiss:now:',
    'quakes:',
    'hydro:',
    'slf:snow:',
    'slf:bulletin:',
    'priminfo:https:',
];
/**
 * Forgets old answers so the cache does not grow forever: short-lived ones after a
 * day, the rest (lists of places, stations, regions) after 60 days.
 */
export function pruneCache(db, now = Date.now()) {
    const day = new Date(now - 24 * 3600 * 1000).toISOString();
    const months = new Date(now - 60 * 24 * 3600 * 1000).toISOString();
    let removed = 0;
    for (const prefix of SHORT_LIVED) {
        removed += db.run('DELETE FROM cache WHERE key LIKE $prefix AND fetched_at < $before', {
            prefix: `${prefix}%`,
            before: day,
        });
    }
    removed += db.run('DELETE FROM cache WHERE fetched_at < $before', { before: months });
    return removed;
}
/** What the cache holds, by source. */
export function cacheSummary(db) {
    return db
        .all(`SELECT substr(key, 1, instr(key, ':') - 1) AS source, COUNT(*) AS answers,
         SUM(length(body)) AS bytes, MAX(fetched_at) AS newest
       FROM cache GROUP BY source ORDER BY bytes DESC`)
        .map((r) => ({ source: r.source, answers: r.answers, bytes: r.bytes, newest: r.newest }));
}
