import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { DatabaseSync, StatementSync } from 'node:sqlite';
import { MIGRATIONS } from './schema.js';
import { loadSqlite } from './sqlite.js';

export type SqlValue = string | number | bigint | null | Uint8Array;
export type SqlParams = Record<string, SqlValue | boolean | undefined>;

function bind(params: SqlParams | undefined): Record<string, SqlValue> {
  const out: Record<string, SqlValue> = {};
  if (!params) return out;
  for (const [key, value] of Object.entries(params)) {
    out[key] = value === undefined ? null : typeof value === 'boolean' ? Number(value) : value;
  }
  return out;
}

/** Thin wrapper around node:sqlite with cached statements, named params and transactions. */
export class Database {
  private readonly statements = new Map<string, StatementSync>();
  private depth = 0;
  /** The schema version an older database had before `open` upgraded it, else null. */
  upgradedFrom: number | null = null;

  private constructor(
    private readonly db: DatabaseSync,
    readonly path: string,
  ) {}

  static open(path: string): Database {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
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

  private migrate(): void {
    const version = this.get<{ user_version: number }>('PRAGMA user_version')?.user_version ?? 0;
    if (version > MIGRATIONS.length) {
      throw new Error(
        `The database at ${this.path} was created by a newer version of swiss-grocery. ` +
          'Please update the tool (npm install -g swiss-grocery@latest).',
      );
    }
    if (version > 0 && version < MIGRATIONS.length) this.upgradedFrom = version;
    for (let i = version; i < MIGRATIONS.length; i++) {
      this.transaction(() => {
        this.db.exec(MIGRATIONS[i] as string);
        this.db.exec(`PRAGMA user_version = ${i + 1}`);
      });
    }
  }

  private statement(sql: string): StatementSync {
    let statement = this.statements.get(sql);
    if (!statement) {
      statement = this.db.prepare(sql);
      this.statements.set(sql, statement);
    }
    return statement;
  }

  run(sql: string, params?: SqlParams): number {
    return Number(this.statement(sql).run(bind(params)).changes);
  }

  get<T>(sql: string, params?: SqlParams): T | undefined {
    return this.statement(sql).get(bind(params)) as T | undefined;
  }

  all<T>(sql: string, params?: SqlParams): T[] {
    return this.statement(sql).all(bind(params)) as T[];
  }

  /** Streams rows one by one (for large exports). Uses its own statement. */
  *iterate<T>(sql: string, params?: SqlParams): Generator<T> {
    yield* this.db.prepare(sql).iterate(bind(params)) as Iterable<T>;
  }

  exec(sql: string): void {
    this.db.exec(sql);
  }

  /** Runs `fn` atomically. Nested calls join the outer transaction. */
  transaction<T>(fn: () => T): T {
    if (this.depth > 0) return fn();
    this.db.exec('BEGIN IMMEDIATE');
    this.depth++;
    try {
      const result = fn();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    } finally {
      this.depth--;
    }
  }

  close(): void {
    this.statements.clear();
    this.db.close();
  }
}
