import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { HttpError } from '../../src/crawler/errors.js';
import { Database } from '../../src/storage/database.js';
import { saveProducts } from '../../src/storage/products.js';
import { explainSupabaseError, syncToSupabase } from '../../src/sync/supabase.js';
import { createFakeFetch } from '../helpers/fake-fetch.js';
import { makeProduct } from '../helpers/products.js';

let db: Database;
beforeEach(() => {
  db = Database.open(':memory:');
  saveProducts(
    db,
    [makeProduct(), makeProduct({ storeProductId: '2', name: 'Milch' })],
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
    const product = JSON.parse(posts[0]?.body ?? '[]')[0];
    expect(product).toMatchObject({ id: 'aldi:288415', labels: [], details: null });
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
      'the key was rejected',
    );
    expect(explainSupabaseError(error(409, { code: '23503' })).hints.join()).toContain('--full');
  });
});
