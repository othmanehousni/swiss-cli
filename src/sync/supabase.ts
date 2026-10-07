import { readFileSync } from 'node:fs';
import { userAgent } from '../config.js';
import { HttpError, NetworkError } from '../crawler/errors.js';
import { type FetchLike, HttpClient } from '../crawler/http.js';
import type { Database } from '../storage/database.js';

/**
 * Pushes the local database to a Supabase (Postgres) project through its REST
 * API (PostgREST). The local SQLite file stays the source of truth; Supabase
 * is a shared copy, e.g. for a website or a team.
 */

export const SCHEMA_FILE = new URL(
  '../../supabase/migrations/20261007000000_init.sql',
  import.meta.url,
);
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

export function schemaSql(): string {
  return readFileSync(SCHEMA_FILE, 'utf-8');
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

export function explainSupabaseError(error: unknown): Diagnosis {
  if (error instanceof HttpError) {
    let code = '';
    let detail = '';
    try {
      const body = JSON.parse(error.bodySnippet) as { code?: string; message?: string };
      code = body.code ?? '';
      detail = body.message ?? '';
    } catch {
      // not JSON
    }
    if (
      code === 'PGRST205' ||
      code === '42P01' ||
      (error.status === 404 && /relation|table/i.test(detail))
    ) {
      return {
        ok: false,
        message: 'the swiss-grocery tables do not exist in this project yet',
        hints: [
          'Create them once: Supabase dashboard -> SQL Editor -> New query -> paste and run the schema.',
          'Print the schema with: swiss-grocery sync --print-schema',
        ],
      };
    }
    if (error.status === 401 || error.status === 403) {
      return {
        ok: false,
        message: 'the key was rejected',
        hints: [
          'Use the secret key (sb_secret_…) or the legacy service_role key: Project Settings -> API Keys.',
          'The publishable/anon key cannot write data.',
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
      message: `Supabase answered HTTP ${error.status}${detail ? `: ${detail}` : ''}`,
      hints: [],
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
  try {
    await client(fetch).request(`${config.url}/rest/v1/products?select=id&limit=1`, {
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
  const probe = await http.request(`${config.url}/rest/v1/products?select=id&limit=1`, {
    headers: authHeaders(config),
  });
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
      `SELECT id, store, store_product_id, name, brand, category_path, size_text, quantity_amount,
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
