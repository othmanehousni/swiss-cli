import { createRequire } from 'node:module';

type SqliteModule = typeof import('node:sqlite');

let cached: SqliteModule | undefined;

/**
 * Loads Node's built-in SQLite (no native add-on to compile).
 * Node 22 prints "SQLite is an experimental feature" on first load; that one
 * warning is hidden because it means nothing to end users. Others still show.
 */
export function loadSqlite(): SqliteModule {
  if (cached) return cached;
  const original = process.emitWarning;
  process.emitWarning = ((warning: string | Error, ...rest: unknown[]) => {
    const type =
      typeof rest[0] === 'string' ? rest[0] : (rest[0] as { type?: string } | undefined)?.type;
    if (type === 'ExperimentalWarning' && String(warning).includes('SQLite')) return;
    return (original as (...args: unknown[]) => void).call(process, warning, ...rest);
  }) as typeof process.emitWarning;
  try {
    cached = createRequire(import.meta.url)('node:sqlite') as SqliteModule;
    return cached;
  } finally {
    process.emitWarning = original;
  }
}
