import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { MIGRATIONS } from './schema.js';
import { loadSqlite } from './sqlite.js';
function bind(params) {
    const out = {};
    if (!params)
        return out;
    for (const [key, value] of Object.entries(params)) {
        out[key] = value === undefined ? null : typeof value === 'boolean' ? Number(value) : value;
    }
    return out;
}
/** Thin wrapper around node:sqlite with cached statements, named params and transactions. */
export class Database {
    db;
    path;
    statements = new Map();
    depth = 0;
    /** The schema version an older database had before `open` upgraded it, else null. */
    upgradedFrom = null;
    constructor(db, path) {
        this.db = db;
        this.path = path;
    }
    static open(path) {
        if (path !== ':memory:')
            mkdirSync(dirname(path), { recursive: true });
        const { DatabaseSync } = loadSqlite();
        const raw = new DatabaseSync(path);
        raw.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;
      PRAGMA foreign_keys = ON;
      PRAGMA busy_timeout = 5000;
    `);
        const database = new Database(raw, path);
        database.migrate();
        return database;
    }
    migrate() {
        const version = this.get('PRAGMA user_version')?.user_version ?? 0;
        if (version > MIGRATIONS.length) {
            throw new Error(`The database at ${this.path} was created by a newer version of swiss-grocery. ` +
                'Please update the tool (npm install -g swiss-grocery@latest).');
        }
        if (version > 0 && version < MIGRATIONS.length)
            this.upgradedFrom = version;
        for (let i = version; i < MIGRATIONS.length; i++) {
            this.transaction(() => {
                this.db.exec(MIGRATIONS[i]);
                this.db.exec(`PRAGMA user_version = ${i + 1}`);
            });
        }
    }
    statement(sql) {
        let statement = this.statements.get(sql);
        if (!statement) {
            statement = this.db.prepare(sql);
            this.statements.set(sql, statement);
        }
        return statement;
    }
    run(sql, params) {
        return Number(this.statement(sql).run(bind(params)).changes);
    }
    get(sql, params) {
        return this.statement(sql).get(bind(params));
    }
    all(sql, params) {
        return this.statement(sql).all(bind(params));
    }
    /** Streams rows one by one (for large exports). Uses its own statement. */
    *iterate(sql, params) {
        yield* this.db.prepare(sql).iterate(bind(params));
    }
    exec(sql) {
        this.db.exec(sql);
    }
    /** Runs `fn` atomically. Nested calls join the outer transaction. */
    transaction(fn) {
        if (this.depth > 0)
            return fn();
        this.db.exec('BEGIN IMMEDIATE');
        this.depth++;
        try {
            const result = fn();
            this.db.exec('COMMIT');
            return result;
        }
        catch (error) {
            this.db.exec('ROLLBACK');
            throw error;
        }
        finally {
            this.depth--;
        }
    }
    close() {
        this.statements.clear();
        this.db.close();
    }
}
