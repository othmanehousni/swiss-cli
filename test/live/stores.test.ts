/**
 * Live smoke tests against the real store websites (opt-in: npm run test:live).
 * They check that each store's API still has the shape swiss-grocery expects:
 * categories load, and the first page of products comes back with prices.
 * Migros only runs with LIVE_MIGROS=1 (it blocks many cloud networks).
 */
import { describe, expect, it } from 'vitest';
import { userAgent } from '../../src/config.js';
import { HttpClient } from '../../src/crawler/http.js';
import type { StoreId } from '../../src/normalization/types.js';
import { getProvider } from '../../src/providers/index.js';
import type { ProviderContext } from '../../src/providers/types.js';

function context(store: StoreId): ProviderContext {
  const provider = getProvider(store);
  return {
    http: new HttpClient({
      userAgent: userAgent(),
      requestsPerSecond: provider.info.requestsPerSecond,
    }),
    lang: 'de',
    debug: () => {},
  };
}

const stores: StoreId[] = [
  'aldi',
  'lidl',
  'denner',
  'coop',
  ...(process.env.LIVE_MIGROS ? (['migros'] as const) : []),
];

describe.each(stores)('%s (live)', (store) => {
  it('loads categories and a first page of priced products', { timeout: 120_000 }, async () => {
    const provider = getProvider(store);
    const ctx = context(store);
    const categories = await provider.categories(ctx);
    expect(categories.length).toBeGreaterThan(0);

    const [source] = provider.sources(categories, null);
    expect(source).toBeDefined();
    const page = await provider.fetchPage(ctx, source as NonNullable<typeof source>, null);
    expect(page.products.length).toBeGreaterThan(0);
    expect(page.skipped).toBeLessThan(page.products.length * 0.1);
    const priced = page.products.filter((p) => p.price != null && p.price > 0);
    expect(priced.length / page.products.length).toBeGreaterThan(0.9);

    const sample = page.products[0];
    if (sample && provider.fetchDetails) {
      await expect(
        provider.fetchDetails(ctx, {
          storeProductId: sample.storeProductId,
          sourceRef: sample.sourceRef,
          url: sample.url,
        }),
      ).resolves.toBeDefined();
    }
  });
});
