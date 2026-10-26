import { readdirSync, readFileSync } from 'node:fs';
import { userAgent } from '../config.js';
import { HttpError, NetworkError } from '../crawler/errors.js';
import { type FetchLike, HttpClient } from '../crawler/http.js';
import type { Database } from '../storage/database.js';

/**
 * Pushes the local database to a Supabase (Postgres) project through its REST
 * API (PostgREST). The local SQLite file stays the source of truth; Supabase
 * is a shared copy, e.g. for a website or a team.
 */

const MIGRATIONS = new URL('../../supabase/migrations/', import.meta.url);
const BATCH_SIZE = 1000;

export interface SupabaseConfig {
  url: string;
  key: string;
}

/** Reads SUPABASE_URL and SUPABASE_SECRET_KEY (or the legacy SUPABASE_SERVICE_ROLE_KEY). */
export function supabaseConfig(): SupabaseConfig | null {
  const url = process.env.SUPABASE_URL?.trim().replace(/\/+$/, '');
  const key = (process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY)?.trim();
  return url && key ? { url, key } : null;
}

/** The whole schema: every migration, oldest first. Each one is safe to run again. */
export function schemaSql(): string {
  const files = readdirSync(MIGRATIONS)
    .filter((name) => name.endsWith('.sql'))
    .sort();
  const parts = files.map((name) => readFileSync(new URL(name, MIGRATIONS), 'utf-8').trimEnd());
  return `${parts.join('\n\n')}\n`;
}

function authHeaders(config: SupabaseConfig): Record<string, string> {
  // New keys (sb_secret_…) go in `apikey` only; legacy JWT keys also as a bearer token.
  return config.key.startsWith('sb_')
    ? { apikey: config.key }
    : { apikey: config.key, Authorization: `Bearer ${config.key}` };
}

function client(fetch?: FetchLike): HttpClient {
  return new HttpClient({
    userAgent: userAgent(),
    respectRobots: false,
    requestsPerSecond: 10,
    timeoutMs: 60_000,
    ...(fetch ? { fetch } : {}),
  });
}

export interface Diagnosis {
  ok: boolean;
  message: string;
  hints: string[];
}

/** The `role` claim of a legacy JWT key ("anon" or "service_role"), if the key is one. */
function jwtRole(key: string): string | null {
  const payload = key.split('.')[1];
  if (!payload) return null;
  try {
    const { role } = JSON.parse(Buffer.from(payload, 'base64url').toString('utf-8')) as {
      role?: unknown;
    };
    return typeof role === 'string' ? role : null;
  } catch {
    return null;
  }
}

/** Catches the usual mix-up: a public key, which cannot write, instead of the secret key. */
export function keyProblem(key: string): Diagnosis | null {
  const kind = key.startsWith('sb_publishable_')
    ? 'a publishable key (sb_publishable_…)'
    : jwtRole(key) === 'anon'
      ? 'the anon key'
      : null;
  if (!kind) return null;
  return {
    ok: false,
    message: `your Supabase key is ${kind}, which cannot write data`,
    hints: [
      'Use the secret key instead: Project Settings -> API Keys -> Secret keys (it starts with sb_secret_).',
    ],
  };
}

/** The fields of a PostgREST / Supabase error body: {"code", "message", "hint"}. */
function postgrestError(body: string): { code: string; message: string; hint: string } {
  try {
    const parsed = JSON.parse(body) as Record<string, unknown> | null;
    const text = (value: unknown) => (typeof value === 'string' ? value : '');
    return { code: text(parsed?.code), message: text(parsed?.message), hint: text(parsed?.hint) };
  } catch {
    return { code: '', message: '', hint: '' };
  }
}

/** Reading the newest columns also tells whether the tables are up to date. */
const PROBE_COLUMNS = 'id,brand_source,brand_key';

/** The command that gets the schema, straight onto the clipboard where the system can. */
export function schemaCommand(platform: NodeJS.Platform = process.platform): string {
  const command = 'swiss-grocery sync --print-schema';
  if (platform === 'darwin') return `Copy the SQL with: ${command} | pbcopy`;
  if (platform === 'win32') return `Copy the SQL with: ${command} | clip`;
  return `Print the SQL with: ${command}`;
}

const SCHEMA_HINTS = [
  schemaCommand(),
  'Run it in Supabase: SQL Editor -> New query -> paste -> Run (safe to run again, it keeps your data).',
];

export function explainSupabaseError(error: unknown): Diagnosis {
  if (error instanceof HttpError) {
    const { code, message: detail, hint } = postgrestError(error.bodySnippet);
    if (code === '42501') {
      return {
        ok: false,
        message: `your key has no access to the swiss-grocery tables (${detail || 'permission denied'})`,
        hints: [
          'Supabase stopped giving its API access to new tables automatically in 2026; the schema now includes the missing permissions.',
          ...SCHEMA_HINTS,
        ],
      };
    }
    if (
      code === 'PGRST205' ||
      code === '42P01' ||
      (error.status === 404 && /relation|table/i.test(detail))
    ) {
      return {
        ok: false,
        message: 'the swiss-grocery tables do not exist in this project yet',
        hints: SCHEMA_HINTS,
      };
    }
    if (code === '42703' || code === 'PGRST204') {
      return {
        ok: false,
        message: `your Supabase tables are from an older version of swiss-grocery (${detail || 'a column is missing'})`,
        hints: ['The new columns are in the schema; adding them keeps your data.', ...SCHEMA_HINTS],
      };
    }
    if (code === 'PGRST106') {
      return {
        ok: false,
        message: 'the Supabase Data API does not offer the public schema',
        hints: [
          'Supabase dashboard -> Project Settings -> Data API: turn it on and add "public" to the exposed schemas.',
        ],
      };
    }
    if (error.status === 401 || error.status === 403) {
      return {
        ok: false,
        message: `Supabase rejected the key${detail ? ` (${detail})` : ''}`,
        hints: [
          'Copy the secret key again: Project Settings -> API Keys -> Secret keys (it starts with sb_secret_).',
          'Check that SUPABASE_URL is the project the key belongs to.',
        ],
      };
    }
    if (code === '23503') {
      return {
        ok: false,
        message: 'some prices refer to products that are missing in Supabase',
        hints: ['Send everything again with: swiss-grocery sync --full'],
      };
    }
    return {
      ok: false,
      message: `Supabase answered HTTP ${error.status}${detail ? `: ${detail}` : ''}${code ? ` (${code})` : ''}`,
      hints: hint ? [hint] : [],
    };
  }
  if (error instanceof NetworkError) {
    return {
      ok: false,
      message: error.message,
      hints: ['Check SUPABASE_URL, e.g. https://<project>.supabase.co'],
    };
  }
  return { ok: false, message: error instanceof Error ? error.message : String(error), hints: [] };
}

export async function checkSupabase(config: SupabaseConfig, fetch?: FetchLike): Promise<Diagnosis> {
  const problem = keyProblem(config.key);
  if (problem) return problem;
  try {
    await client(fetch).request(`${config.url}/rest/v1/products?select=${PROBE_COLUMNS}&limit=1`, {
      headers: authHeaders(config),
    });
    return { ok: true, message: 'connected, tables found', hints: [] };
  } catch (error) {
    return explainSupabaseError(error);
  }
}

export interface SyncCounts {
  products: number;
  prices: number;
  history: number;
}

export interface SyncResult extends SyncCounts {
  since: string | null;
  requests: number;
  dryRun: boolean;
}

/**
 * Sends what changed since the last sync (or everything with `full`).
 * The new watermark is the start time, so rows changed during a sync are sent next time.
 */
export async function syncToSupabase(
  db: Database,
  config: SupabaseConfig,
  options: {
    full?: boolean;
    dryRun?: boolean;
    onProgress?: (text: string) => void;
    fetch?: FetchLike;
  } = {},
): Promise<SyncResult> {
  const http = client(options.fetch);
  // Always check the connection first: it validates the key and the tables even
  // when nothing changed, and an empty remote copy (new or recreated tables) gets everything.
  options.onProgress?.('Connecting to Supabase…');
  const probe = await http.request(
    `${config.url}/rest/v1/products?select=${PROBE_COLUMNS}&limit=1`,
    {
      headers: authHeaders(config),
    },
  );
  const remoteEmpty = (JSON.parse(probe.body) as unknown[]).length === 0;
  const since =
    options.full || remoteEmpty
      ? null
      : (db.get<{ synced_at: string }>('SELECT synced_at FROM sync_state WHERE target = $target', {
          target: config.url,
        })?.synced_at ?? null);
  const startedAt = new Date().toISOString();

  const products = db
    .all<Record<string, unknown> & { labels: string; details: string | null }>(
      `SELECT id, store, store_product_id, name, brand, brand_source, brand_key, category_path,
         size_text, quantity_amount,
         quantity_unit, pack_count, labels, url, image_url, gtin, details, details_fetched_at,
         first_seen_at, last_seen_at, removed_at, updated_at
       FROM products WHERE $since IS NULL OR updated_at > $since`,
      { since },
    )
    .map((row) => ({
      ...row,
      labels: JSON.parse(row.labels),
      details: row.details ? JSON.parse(row.details) : null,
    }));
  const prices = db.all<Record<string, unknown>>(
    `SELECT product_id, price, regular_price, loyalty_price, promo_label, valid_from, valid_until,
       unit_price, unit_price_basis, currency, observed_at
     FROM prices WHERE $since IS NULL OR observed_at > $since`,
    { since },
  );
  const history = db.all<Record<string, unknown>>(
    `SELECT product_id, price, regular_price, loyalty_price, promo_label, valid_until, first_seen_at, last_seen_at
     FROM price_history WHERE $since IS NULL OR last_seen_at > $since`,
    { since },
  );

  const result: SyncResult = {
    products: products.length,
    prices: prices.length,
    history: history.length,
    since,
    requests: 0,
    dryRun: options.dryRun === true,
  };
  if (options.dryRun) return result;

  const upsert = async (table: string, rows: unknown[], conflict: string) => {
    for (let i = 0; i < rows.length; i += BATCH_SIZE) {
      options.onProgress?.(
        `Sending ${table}: ${Math.min(i + BATCH_SIZE, rows.length)}/${rows.length}`,
      );
      await http.request(`${config.url}/rest/v1/${table}?on_conflict=${conflict}`, {
        method: 'POST',
        body: JSON.stringify(rows.slice(i, i + BATCH_SIZE)),
        headers: {
          ...authHeaders(config),
          'Content-Type': 'application/json',
          Prefer: 'resolution=merge-duplicates,return=minimal',
        },
      });
    }
  };
  // Products first: prices and history reference them.
  await upsert('products', products, 'id');
  await upsert('prices', prices, 'product_id');
  await upsert('price_history', history, 'product_id,first_seen_at');
  result.requests = http.stats.requests;

  db.run(
    `INSERT INTO sync_state (target, synced_at) VALUES ($target, $at)
     ON CONFLICT (target) DO UPDATE SET synced_at = excluded.synced_at`,
    { target: config.url, at: startedAt },
  );
  return result;
}
