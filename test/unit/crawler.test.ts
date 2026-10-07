import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Checkpoints } from '../../src/crawler/checkpoint.js';
import { type CrawlOptions, crawlStore, StoreBusyError } from '../../src/crawler/crawler.js';
import { BlockedError } from '../../src/crawler/errors.js';
import { HttpClient } from '../../src/crawler/http.js';
import type { Category, NormalizedProduct } from '../../src/normalization/types.js';
import type { Cursor, Provider, ProviderContext } from '../../src/providers/types.js';
import { Database } from '../../src/storage/database.js';
import { priceHistory, searchProducts } from '../../src/storage/queries.js';
import { makeProduct } from '../helpers/products.js';

const categories: Category[] = [
  { store: 'aldi', id: 'a', parentId: null, name: 'A', path: ['A'], productCount: null },
  { store: 'aldi', id: 'b', parentId: null, name: 'B', path: ['B'], productCount: null },
];

const p = (id: string, price = 1) =>
  makeProduct({
    storeProductId: id,
    name: `Product ${id}`,
    price,
    unitPrice: null,
    unitPriceBasis: null,
  });

interface FakeOptions {
  pages: Record<string, NormalizedProduct[][]>;
  rotating?: boolean;
  onFetch?: (key: string, cursor: Cursor) => void;
  details?: boolean;
}

function fakeProvider(options: FakeOptions) {
  const fetched: string[] = [];
  const detailed: string[] = [];
  const provider: Provider = {
    info: {
      id: 'aldi',
      name: 'Fake',
      website: '',
      coverage: '',
      rotating: options.rotating ?? false,
      verified: true,
      requestsPerSecond: 1,
    },
    categories: async () => categories,
    sources: (cats, ids) =>
      cats
        .filter((c) => !ids || ids.includes(c.id))
        .map((c) => ({ key: c.id, label: c.name, params: {} })),
    fetchPage: async (_ctx, source, cursor) => {
      fetched.push(`${source.key}@${cursor ?? 0}`);
      options.onFetch?.(source.key, cursor);
      const pages = options.pages[source.key] ?? [];
      const index = typeof cursor === 'number' ? cursor : 0;
      return {
        products: pages[index] ?? [],
        next: index + 1 < pages.length ? index + 1 : null,
        total: null,
        skipped: 0,
      };
    },
    ...(options.details === false
      ? {}
      : {
          fetchDetails: async (_ctx: ProviderContext, request: { storeProductId: string }) => {
            detailed.push(request.storeProductId);
            return { ingredients: `ingredients of ${request.storeProductId}` };
          },
        }),
  };
  return { provider, fetched, detailed };
}

let db: Database;
let clock: number;
const now = () => new Date(clock++ * 1000).toISOString();
const ctx: ProviderContext = {
  http: new HttpClient({ userAgent: 't', respectRobots: false }),
  lang: 'de',
  debug: () => {},
};

function crawl(provider: Provider, extra: Partial<CrawlOptions> = {}) {
  return crawlStore({
    db,
    provider,
    ctx,
    kind: 'fetch',
    categories,
    categoryIds: null,
    details: false,
    concurrency: 1,
    now,
    ...extra,
  });
}

beforeEach(() => {
  db = Database.open(':memory:');
  clock = Date.parse('2026-10-01T00:00:00Z') / 1000;
});
afterEach(() => db.close());

describe('crawlStore', () => {
  it('crawls every page of every source and records the run', async () => {
    const { provider, fetched } = fakeProvider({
      pages: { a: [[p('1'), p('2')], [p('3')]], b: [[p('4')]] },
    });
    const result = await crawl(provider);
    expect(result).toMatchObject({ status: 'completed', resumed: false });
    expect(result.stats).toMatchObject({ pages: 3, products: 4, inserted: 4 });
    expect(fetched).toEqual(['a@0', 'a@1', 'b@0']);
    expect(searchProducts(db, { query: 'product' }).total).toBe(4);
  });

  it('resumes from the page whose request was cancelled by Ctrl+C', async () => {
    const controller = new AbortController();
    const pages = { a: [[p('1')], [p('2')], [p('3')]], b: [[p('4')]] };
    const first = fakeProvider({
      pages,
      onFetch: (key, cursor) => {
        if (key === 'a' && cursor === 1) {
          controller.abort();
          throw new DOMException('This operation was aborted', 'AbortError');
        }
      },
    });
    const interrupted = await crawl(first.provider, { signal: controller.signal });
    expect(interrupted.status).toBe('interrupted');

    const second = fakeProvider({ pages });
    const resumed = await crawl(second.provider);
    expect(resumed).toMatchObject({ status: 'completed', resumed: true });
    // a@0 was saved before the interruption; the cancelled a@1 is fetched again.
    expect(second.fetched).toEqual(['a@1', 'a@2', 'b@0']);
    expect(resumed.stats.products).toBe(4);
    expect(priceHistory(db, 'aldi:1')).toHaveLength(1);
  });

  it('does not fetch again a page that finished just before the interruption', async () => {
    const controller = new AbortController();
    const pages = { a: [[p('1')], [p('2')], [p('3')]], b: [[p('4')]] };
    const first = fakeProvider({
      pages,
      onFetch: (key, cursor) => key === 'a' && cursor === 1 && controller.abort(),
    });
    expect((await crawl(first.provider, { signal: controller.signal })).status).toBe('interrupted');
    const second = fakeProvider({ pages });
    await crawl(second.provider);
    expect(second.fetched).toEqual(['a@2', 'b@0']);
  });

  it('keeps going when one source fails, and retries only that source next time', async () => {
    let failB = true;
    const pages = { a: [[p('1')]], b: [[p('2')]] };
    const { provider } = fakeProvider({
      pages,
      onFetch: (key) => {
        if (key === 'b' && failB) throw new Error('server error');
      },
    });
    const failed = await crawl(provider);
    expect(failed.status).toBe('failed');
    expect(failed.failures).toEqual([{ source: 'B', error: 'server error' }]);
    expect(failed.stats.products).toBe(1);

    failB = false;
    const retry = fakeProvider({ pages });
    const done = await crawl(retry.provider);
    expect(done).toMatchObject({ status: 'completed', resumed: true });
    expect(retry.fetched).toEqual(['b@0']);
  });

  it('stops the store on a bot block but keeps progress for later', async () => {
    const { provider } = fakeProvider({
      pages: { a: [[p('1')], [p('2')]], b: [[p('3')]] },
      onFetch: (key, cursor) => {
        if (key === 'a' && cursor === 1) throw new BlockedError('https://x.ch', 'DataDome', 403);
      },
    });
    await expect(crawl(provider)).rejects.toBeInstanceOf(BlockedError);
    const run = new Checkpoints(db).findUnfinished('aldi', 'fetch', 'all');
    expect(run?.status).toBe('failed');
    expect(searchProducts(db, { query: 'product' }).total).toBe(1);
  });

  it('marks products a complete crawl no longer lists as removed (rotating catalogs)', async () => {
    await crawl(
      fakeProvider({ rotating: true, pages: { a: [[p('1'), p('2')]], b: [[p('3')]] } }).provider,
    );
    const second = await crawl(
      fakeProvider({ rotating: true, pages: { a: [[p('1')]], b: [[]] } }).provider,
    );
    expect(second.stats.removed).toBe(2);
    expect(searchProducts(db, { query: 'product' }).rows.map((r) => r.id)).toEqual(['aldi:1']);
  });

  it('refuses to remove a large share of a stable catalog at once', async () => {
    const many = Array.from({ length: 100 }, (_, i) => p(String(i)));
    await crawl(fakeProvider({ pages: { a: [many], b: [[]] } }).provider);
    const second = await crawl(
      fakeProvider({ pages: { a: [many.slice(0, 40)], b: [[]] } }).provider,
    );
    expect(second.removalSkipped).toEqual({
      reason: 'too-many',
      unseen: 60,
      active: 100,
      repeated: 0,
    });
    expect(second.stats.removed).toBe(0);
  });

  it('does not remove products when the listing shifted while being read', async () => {
    const many = Array.from({ length: 60 }, (_, i) => p(String(i)));
    await crawl(
      fakeProvider({ rotating: true, pages: { a: [many.slice(0, 30), many.slice(30)], b: [[]] } })
        .provider,
    );
    // Second crawl: the order shifted, page 2 repeats 10 products of page 1 and 10 others are never shown.
    const shifted = await crawl(
      fakeProvider({
        rotating: true,
        pages: { a: [many.slice(0, 30), [...many.slice(20, 30), ...many.slice(40)]], b: [[]] },
      }).provider,
    );
    expect(shifted.removalSkipped).toMatchObject({
      reason: 'listing-shifted',
      unseen: 10,
      repeated: 10,
    });
    expect(shifted.stats.removed).toBe(0);
  });

  it('asks the store about missing products and only removes confirmed ones', async () => {
    const pages = { a: [[p('1'), p('2'), p('3'), p('4')]], b: [[]] };
    await crawl(fakeProvider({ pages }).provider);
    const { provider } = fakeProvider({ pages: { a: [[p('1')]], b: [[]] } });
    const asked: string[] = [];
    provider.isStillListed = async (_ctx, request) => {
      asked.push(request.storeProductId);
      if (request.storeProductId === '4') throw new Error('network hiccup');
      return request.storeProductId === '2'; // 2 still sold, 3 gone, 4 unknown
    };
    const result = await crawl(provider);
    expect(asked.sort()).toEqual(['2', '3', '4']);
    expect(result.stats).toMatchObject({ removed: 1, stillListed: 1 });
    expect(
      searchProducts(db, { query: 'product' })
        .rows.map((r) => r.id)
        .sort(),
    ).toEqual(['aldi:1', 'aldi:2', 'aldi:4']);
  });

  it('never removes products after a category-only or sample crawl', async () => {
    await crawl(fakeProvider({ rotating: true, pages: { a: [[p('1')]], b: [[p('2')]] } }).provider);
    const partial = await crawl(
      fakeProvider({ rotating: true, pages: { a: [[]], b: [[]] } }).provider,
      { categoryIds: ['a'] },
    );
    expect(partial.stats.removed).toBe(0);
    const sample = await crawl(
      fakeProvider({ rotating: true, pages: { a: [[p('9')]], b: [[]] } }).provider,
      { limit: 1 },
    );
    expect(sample).toMatchObject({ sample: true, status: 'completed' });
    expect(sample.stats.removed).toBe(0);
  });

  it('stops a sample crawl after the requested number of products', async () => {
    const { provider, fetched } = fakeProvider({
      pages: { a: [[p('1'), p('2')], [p('3')]], b: [[p('4')]] },
    });
    const result = await crawl(provider, { limit: 2 });
    expect(result.stats.products).toBe(2);
    expect(fetched).toEqual(['a@0']);
  });

  it('fetches details for listed products, or only for new ones during updates', async () => {
    const first = fakeProvider({ pages: { a: [[p('1'), p('2')]], b: [[]] } });
    const fetch = await crawl(first.provider, { details: 'seen' });
    expect(first.detailed.sort()).toEqual(['1', '2']);
    expect(fetch.stats.details).toBe(2);

    const update = fakeProvider({ pages: { a: [[p('1'), p('2'), p('3')]], b: [[]] } });
    await crawl(update.provider, { kind: 'update', details: 'new' });
    expect(update.detailed).toEqual(['3']);
  });

  it('refuses to run while another process crawls the same store', async () => {
    const { provider } = fakeProvider({ pages: { a: [[p('1')]], b: [[]] } });
    new Checkpoints(db).start('aldi', 'fetch', 'all', true, false, [], now());
    await expect(crawl(provider)).rejects.toBeInstanceOf(StoreBusyError);
  });

  it('starts over with fresh=true', async () => {
    const controller = new AbortController();
    const pages = { a: [[p('1')], [p('2')]], b: [[p('3')]] };
    await crawl(
      fakeProvider({ pages, onFetch: (_k, c) => c === 1 && controller.abort() }).provider,
      { signal: controller.signal },
    );
    clock += 600; // the interrupted run's heartbeat is old
    const fresh = fakeProvider({ pages });
    const result = await crawl(fresh.provider, { fresh: true });
    expect(result.resumed).toBe(false);
    expect(fresh.fetched).toEqual(['a@0', 'a@1', 'b@0']);
  });
});
