import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { HttpError } from '../../src/crawler/errors.js';
import { Database } from '../../src/storage/database.js';
import { saveProducts } from '../../src/storage/products.js';
import {
  checkSupabase,
  explainSupabaseError,
  keyProblem,
  schemaCommand,
  schemaSql,
  syncToSupabase,
} from '../../src/sync/supabase.js';
import { createFakeFetch } from '../helpers/fake-fetch.js';
import { makeProduct } from '../helpers/products.js';

let db: Database;
beforeEach(() => {
  db = Database.open(':memory:');
  saveProducts(
    db,
    [makeProduct(), makeProduct({ storeProductId: '2', name: 'Milch', brand: 'Emmi' })],
    '2026-10-01T08:00:00.000Z',
  );
});
afterEach(() => db.close());

const config = { url: 'https://project.supabase.co', key: 'sb_secret_abc' };

function remote(rows: unknown[] = [{ id: 'aldi:1' }]) {
  return createFakeFetch((_url, call) =>
    call.method === 'GET' ? { body: rows } : { status: 201, body: '' },
  );
}

describe('syncToSupabase', () => {
  it('upserts products, prices and history with the right keys and headers', async () => {
    const fake = remote();
    const result = await syncToSupabase(db, config, { fetch: fake.fetch });
    expect(result).toMatchObject({ products: 2, prices: 2, history: 2, since: null });
    const posts = fake.calls.filter((c) => c.method === 'POST');
    expect(posts.map((c) => c.url)).toEqual([
      'https://project.supabase.co/rest/v1/products?on_conflict=id',
      'https://project.supabase.co/rest/v1/prices?on_conflict=product_id',
      'https://project.supabase.co/rest/v1/price_history?on_conflict=product_id,first_seen_at',
    ]);
    const headers = posts[0]?.headers ?? {};
    expect(headers.apikey).toBe('sb_secret_abc');
    expect(headers.Authorization).toBeUndefined(); // new-style keys are not JWTs
    expect(headers.Prefer).toBe('resolution=merge-duplicates,return=minimal');
    const [butter, milk] = JSON.parse(posts[0]?.body ?? '[]');
    expect(butter).toMatchObject({ id: 'aldi:288415', labels: [], details: null, brand: null });
    expect(milk).toMatchObject({ brand: 'Emmi', brand_source: 'store', brand_key: 'emmi' });
    // Reading the newest columns first tells whether the tables are up to date.
    expect(fake.calls[0]?.url).toBe(
      'https://project.supabase.co/rest/v1/products?select=id,brand_source,brand_key&limit=1',
    );
  });

  it('sends a legacy service_role key as a bearer token too', async () => {
    const fake = remote();
    await syncToSupabase(db, { ...config, key: 'eyJhbGciOi.legacy.jwt' }, { fetch: fake.fetch });
    expect(fake.calls[0]?.headers.Authorization).toBe('Bearer eyJhbGciOi.legacy.jwt');
  });

  it('only sends what changed since the last sync, but always checks the connection', async () => {
    await syncToSupabase(db, config, { fetch: remote().fetch });
    const fake = remote();
    const second = await syncToSupabase(db, config, { fetch: fake.fetch });
    expect(second).toMatchObject({ products: 0, prices: 0, history: 0 });
    expect(fake.calls.map((c) => c.method)).toEqual(['GET']);
  });

  it('sends everything again when the remote tables are empty', async () => {
    await syncToSupabase(db, config, { fetch: remote().fetch });
    const result = await syncToSupabase(db, config, { fetch: remote([]).fetch });
    expect(result).toMatchObject({ products: 2, since: null });
  });

  it('counts without sending in a dry run', async () => {
    const fake = remote();
    const result = await syncToSupabase(db, config, { dryRun: true, fetch: fake.fetch });
    expect(result).toMatchObject({ dryRun: true, products: 2 });
    expect(fake.calls.filter((c) => c.method === 'POST')).toHaveLength(0);
  });
});

describe('explainSupabaseError', () => {
  const error = (status: number, body: object) =>
    new HttpError('https://x.supabase.co', status, false, null, JSON.stringify(body));
  it('recognises missing tables, a rejected key and missing products', () => {
    expect(
      explainSupabaseError(
        error(404, { code: 'PGRST205', message: "Could not find the table 'public.products'" }),
      ).message,
    ).toMatch(/tables do not exist/);
    expect(explainSupabaseError(error(401, { message: 'Invalid API key' })).message).toBe(
      'Supabase rejected the key (Invalid API key)',
    );
    expect(explainSupabaseError(error(409, { code: '23503' })).hints.join()).toContain('--full');
  });

  it('explains tables the API may not use (Supabase stopped granting them in 2026)', () => {
    const diagnosis = explainSupabaseError(
      error(403, { code: '42501', message: 'permission denied for table products' }),
    );
    expect(diagnosis.message).toBe(
      'your key has no access to the swiss-grocery tables (permission denied for table products)',
    );
    expect(diagnosis.hints.join(' ')).toContain('swiss-grocery sync --print-schema');
  });

  it('asks for the new schema when the tables are from an older version', () => {
    const diagnosis = explainSupabaseError(
      error(400, { code: '42703', message: 'column products.brand_key does not exist' }),
    );
    expect(diagnosis.message).toBe(
      'your Supabase tables are from an older version of swiss-grocery (column products.brand_key does not exist)',
    );
    expect(diagnosis.hints.join(' ')).toContain('swiss-grocery sync --print-schema');
    expect(schemaSql()).toContain('add column if not exists brand_key text');
  });

  it('puts the schema on the clipboard where the system has a tool for it', () => {
    expect(schemaCommand('darwin')).toBe(
      'Copy the SQL with: swiss-grocery sync --print-schema | pbcopy',
    );
    expect(schemaCommand('win32')).toBe(
      'Copy the SQL with: swiss-grocery sync --print-schema | clip',
    );
    expect(schemaCommand('linux')).toBe('Print the SQL with: swiss-grocery sync --print-schema');
  });

  it('passes on other Supabase errors with their code and hint', () => {
    expect(
      explainSupabaseError(error(400, { code: 'PGRST100', message: 'bad filter', hint: 'fix it' })),
    ).toMatchObject({
      message: 'Supabase answered HTTP 400: bad filter (PGRST100)',
      hints: ['fix it'],
    });
  });
});

describe('keyProblem', () => {
  const jwt = (role: string) =>
    `x.${Buffer.from(JSON.stringify({ role })).toString('base64url')}.sig`;
  it('spots keys that cannot write before anything is sent', () => {
    expect(keyProblem('sb_publishable_abc')?.message).toMatch(/publishable key/);
    expect(keyProblem(jwt('anon'))?.message).toMatch(/anon key/);
    expect(keyProblem(jwt('service_role'))).toBeNull();
    expect(keyProblem('sb_secret_abc')).toBeNull();
  });
});

describe('checkSupabase', () => {
  it('reports missing grants, not bot protection, for a JSON 403 from Supabase (behind Cloudflare)', async () => {
    const fake = createFakeFetch(() => ({
      status: 403,
      headers: { server: 'cloudflare', 'cf-ray': '1-ZRH', 'content-type': 'application/json' },
      body: { code: '42501', hint: null, message: 'permission denied for table products' },
    }));
    const diagnosis = await checkSupabase(config, fake.fetch);
    expect(diagnosis.ok).toBe(false);
    expect(diagnosis.message).toContain('no access to the swiss-grocery tables');
    expect(fake.calls).toHaveLength(1);
  });

  it('never sends a key that cannot write', async () => {
    const fake = remote();
    const diagnosis = await checkSupabase({ ...config, key: 'sb_publishable_x' }, fake.fetch);
    expect(diagnosis.ok).toBe(false);
    expect(fake.calls).toHaveLength(0);
  });

  it('connects when the tables are there', async () => {
    expect(await checkSupabase(config, remote().fetch)).toMatchObject({ ok: true });
  });
});

describe('schemaSql', () => {
  it('prints every migration in order, including the grants Supabase no longer adds itself', () => {
    const sql = schemaSql();
    const created = sql.indexOf('create table if not exists public.products');
    const granted = sql.search(
      /grant select, insert, update, delete\s+on table public\.products, public\.prices, public\.price_history\s+to service_role;/,
    );
    expect(created).toBeGreaterThan(-1);
    expect(granted).toBeGreaterThan(created);
  });

  it('gives each store its own view', () => {
    const sql = schemaSql();
    for (const store of ['aldi', 'coop', 'denner', 'lidl', 'migros']) {
      expect(sql).toContain(`create or replace view public.${store}_products`);
      expect(sql).toContain(`from public.current_prices where store = '${store}';`);
    }
  });
});
