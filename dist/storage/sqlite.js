import { createRequire } from 'node:module';
let cached;
/**
 * Loads Node's built-in SQLite (no native add-on to compile).
 * Node 22 prints "SQLite is an experimental feature" on first load; that one
 * warning is hidden because it means nothing to end users. Others still show.
 */
export function loadSqlite() {
    if (cached)
        return cached;
    const original = process.emitWarning;
    process.emitWarning = ((warning, ...rest) => {
        const type = typeof rest[0] === 'string' ? rest[0] : rest[0]?.type;
        if (type === 'ExperimentalWarning' && String(warning).includes('SQLite'))
            return;
        return original.call(process, warning, ...rest);
    });
    try {
        cached = createRequire(import.meta.url)('node:sqlite');
        return cached;
    }
    finally {
        process.emitWarning = original;
    }
}
