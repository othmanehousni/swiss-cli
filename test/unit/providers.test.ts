import { describe, expect, it } from 'vitest';
import { aldi } from '../../src/providers/aldi.js';
import { resolveCategories } from '../../src/providers/categories.js';
import { coop } from '../../src/providers/coop.js';
import { denner } from '../../src/providers/denner.js';
import { lidl } from '../../src/providers/lidl.js';
import { migros, parseCategorySearch } from '../../src/providers/migros.js';
import { fakeContext, fixture } from '../helpers/context.js';
import type { FakeResponse } from '../helpers/fake-fetch.js';

describe('Aldi (real API fixtures)', () => {
  it('flattens the category tree and lists top-level categories for a full crawl', async () => {
    const { ctx } = fakeContext(() => ({ body: fixture('aldi-categories.json') }));
    const categories = await aldi.categories(ctx);
    expect(categories.find((c) => c.id === '158816141843305901')?.path).toEqual([
      'Milchprodukte & Eier',
      'Butter, Milch & Rahm',
    ]);
    const sources = aldi.sources(categories, null);
    expect(sources.map((s) => s.params.categoryKey)).toEqual(
      categories.filter((c) => c.parentId === null).map((c) => c.id),
    );
    // "food" leaves out the non-food special buys ("Aktionen").
    const { ids } = resolveCategories(aldi, categories, ['food']);
    expect(ids).toContain('1588161418433059');
    expect(ids).not.toContain('1588161418433031');
  });

  it('normalizes products, promotions and special-buy dates', async () => {
    const { ctx, fake } = fakeContext(() => ({ body: fixture('aldi-listing.json') }));
    const page = await aldi.fetchPage(
      ctx,
      { key: 'k', label: 'l', params: { categoryKey: '1' } },
      null,
    );
    expect(fake.requests()[0]?.url).toContain('limit=60&offset=0');
    expect(page.skipped).toBe(0);
    expect(page.next).toBe(4);

    const butter = page.products.find((p) => p.name === 'Butter');
    expect(butter).toMatchObject({
      storeProductId: '288415',
      price: 3.85,
      unitPrice: 15.4,
      unitPriceBasis: 'kg',
      sizeText: '250 g',
      labels: ['Tiefpreis'],
      categoryPath: ['Milchprodukte & Eier', 'Butter, Milch & Rahm'],
      url: 'https://www.aldi-suisse.ch/de/produkt/no-brand-butter-000000000000288415',
      sourceRef: { sku: '000000000000288415' },
    });
    expect(butter?.imageUrl).toContain('/scaleWidth/500/');

    expect(page.products.find((p) => p.name === "Vino Rosso d'Italia")).toMatchObject({
      price: 10.99,
      regularPrice: 13.99,
      promoLabel: '-21%',
      unitPrice: 14.6533,
      unitPriceBasis: 'l',
    });
    // "verfügbar ab 12.10.2026" = midnight in Zurich (CEST, UTC+2).
    expect(page.products.find((p) => p.name === 'Halloween-Mix')?.validFrom).toBe(
      '2026-10-11T22:00:00.000Z',
    );
  });

  it('reads product details', async () => {
    const { ctx, fake } = fakeContext(() => ({ body: fixture('aldi-details.json') }));
    const details = await aldi.fetchDetails?.(ctx, {
      storeProductId: '288415',
      sourceRef: { sku: '000000000000288415' },
      url: null,
    });
    expect(fake.requests()[0]?.url).toContain('/v2/products/000000000000288415?');
    expect(details).toMatchObject({
      storage: 'Vor Licht geschützt und kühl aufbewahren, bei max. +10°C mindestens haltbar bis.',
      usage: 'für die kalte und warme Küche, Brotaufstrich',
    });
  });
});

describe('Lidl (real API fixtures)', () => {
  const load = async () => {
    const { ctx } = fakeContext(() => ({ body: fixture('lidl-search.json') }));
    return lidl.fetchPage(ctx, { key: 'all', label: 'All', params: {} }, null);
  };

  it('keeps the price without the app and records the Lidl Plus price separately', async () => {
    const page = await load();
    expect(page.products.find((p) => p.storeProductId === '10059621')).toMatchObject({
      name: 'Schweizer Bio Haferdrink',
      brand: 'QUALITÉ SUISSE',
      price: 1.99,
      loyaltyPrice: 1.59,
      regularPrice: null,
      promoLabel: '-20% Mit Lidl Plus',
      quantity: { amount: 1000, unit: 'ml', packCount: 1 },
      unitPrice: 1.99,
      unitPriceBasis: 'l',
      labels: ['Schweizer Qualität', 'Vegan-Label'],
      categoryPath: ['Food und Near Food', 'Käse, Milchprodukte & Eier', 'Milch & Sahne'],
      url: 'https://www.lidl.ch/p/de-CH/qualite-suisse-schweizer-bio-haferdrink/p10059621',
    });
  });

  it('handles reductions, odd percent signs, pieces and printed unit prices', async () => {
    const page = await load();
    const byId = (id: string) => page.products.find((p) => p.storeProductId === id);
    expect(byId('10059581')).toMatchObject({ price: 2.99, regularPrice: 3.99, promoLabel: '-25%' });
    expect(byId('10059448')?.promoLabel).toBe('-25%');
    const flowers = page.products.find((p) => p.name === 'Topfrosen');
    expect(flowers).toMatchObject({
      regularPrice: null,
      quantity: { amount: 1, unit: 'piece', packCount: 1 },
      unitPriceBasis: 'piece',
    });
    const spray = page.products.find((p) => p.name.startsWith('Lufterfrischer'));
    expect(spray).toMatchObject({
      quantity: { amount: 16, unit: 'ml', packCount: 1 },
      unitPrice: 371.875,
      promoLabel: 'Aktion',
    });
    expect(page.next).toBe(page.products.length);
  });

  it('builds categories from facets and filters by category id', async () => {
    const { ctx, fake } = fakeContext(() => ({ body: fixture('lidl-search.json') }));
    const categories = await lidl.categories(ctx);
    const food = categories.find((c) => c.name === 'Essen & Trinken');
    expect(food?.id).toBe('10068374');
    const [source] = lidl.sources(categories, ['10068374']);
    await lidl.fetchPage(ctx, source as NonNullable<typeof source>, 60);
    expect(fake.requests().at(-1)?.url).toContain('category.id=10068374');
    expect(fake.requests().at(-1)?.url).toContain('offset=60');
  });
});

describe('Denner (real API fixtures)', () => {
  const route = (url: string, body?: string) => {
    if (url.includes('/api/product/')) return { body: fixture('denner-details.json') };
    const pageId = body ? JSON.parse(body).pageId : 12;
    return { body: fixture(pageId === 14 ? 'denner-wine.json' : 'denner-promotions.json') };
  };

  it('builds promotion and wine categories from facets', async () => {
    const { ctx } = fakeContext((url, call) => route(url, call.body));
    const categories = await denner.categories(ctx);
    expect(categories.filter((c) => c.parentId === null).map((c) => c.id)).toEqual([
      'food',
      'non_food',
      'wine',
    ]);
    expect(categories.find((c) => c.id === '1144363')?.path).toEqual([
      'Lebensmittel',
      'Früchte und Gemüse',
    ]);
    const sources = denner.sources(categories, ['food', '5479471']);
    expect(sources[0]?.params).toMatchObject({ page: '12', filter: 'category' });
    expect(sources[0]?.params.values?.split(',')).toContain('1144363');
    expect(sources[1]?.params).toEqual({ page: '14', filter: 'wine_type', values: '5479471' });
    expect(resolveCategories(denner, categories, ['food']).ids).toEqual(['food', 'wine']);
  });

  it('normalizes promotions: stable ids, per-100 g prices and inclusive end dates', async () => {
    const { ctx, fake } = fakeContext((url, call) => route(url, call.body));
    const page = await denner.fetchPage(
      ctx,
      { key: 'promotions', label: 'P', params: { page: '12' } },
      null,
    );
    expect(JSON.parse(fake.requests()[0]?.body ?? '{}')).toMatchObject({
      pageId: 12,
      region: 'de_CH',
    });
    expect(page.next).toBe(2); // the weekly specials block has a second page
    const satsumas = page.products.find((p) => p.name === 'Satsumas');
    expect(satsumas).toMatchObject({
      storeProductId: '1006226',
      price: 1.49,
      regularPrice: 1.95,
      promoLabel: '-23%',
      unitPrice: 1.49,
      unitPriceBasis: 'kg',
      validUntil: '2026-10-07T21:59:59.000Z', // "until 07.10." means through the end of that day
      url: 'https://www.denner.ch/de/aktionen/satsumas~p1006226',
    });
    const beef = page.products.find((p) => p.name.startsWith('Black Angus'));
    expect(beef).toMatchObject({
      price: 2.95,
      unitPrice: 29.5,
      unitPriceBasis: 'kg',
      promoLabel: '½ PREIS',
    });
    // The footnote says the "statt" price is a competitor's price; it is kept as a label.
    expect(beef?.labels).toContain('Konkurrenzvergleich');
  });

  it('prices wine boxes per litre and reads wine details', async () => {
    const { ctx } = fakeContext((url, call) => route(url, call.body));
    const page = await denner.fetchPage(
      ctx,
      { key: 'wine', label: 'W', params: { page: '14' } },
      null,
    );
    expect(page.products[0]).toMatchObject({
      storeProductId: '1027166',
      price: 89.7,
      quantity: { amount: 4500, unit: 'ml', packCount: 6 },
      unitPrice: 19.9333,
      categoryPath: ['Wein', 'Schaumwein'],
    });
    const details = await denner.fetchDetails?.(ctx, {
      storeProductId: '1027166',
      sourceRef: {},
      url: null,
    });
    expect(details?.rating).toEqual({ average: 4.4, count: 465 });
    expect(details?.origin).toBe('Italien');
    expect(details?.extra?.box).toBe('à 6 x 75 cl');
  });
});

describe('Migros (synthetic responses shaped like the website requests)', () => {
  it('gets a guest token, lists ids and hydrates product cards', async () => {
    let tokenCalls = 0;
    const { ctx, fake } = fakeContext((url) => {
      if (url.includes('/guest')) {
        tokenCalls++;
        return { headers: { leshopch: `token-${tokenCalls}` }, body: {} };
      }
      if (url.endsWith('/products/category/7494731/search'))
        return { body: { productIds: [101, 102], numberOfProducts: 2 } };
      return {
        body: [
          {
            uid: 101,
            migrosId: '104004000000',
            name: 'Vollmilch',
            offer: { price: { effectiveValue: 1.6 }, quantity: '1l' },
            breadcrumb: [{ name: 'Milchprodukte' }],
          },
          {
            uid: 102,
            migrosId: '120330400000',
            name: 'Gruyère',
            offer: {
              price: { effectiveValue: 5.5 },
              promotionPrice: { effectiveValue: 4.4 },
              quantity: '250g',
              promotionDateRange: { startDate: '2026-10-06', endDate: '2026-10-12' },
              badges: [{ type: 'PERCENTAGE_PROMOTION', description: '20%' }],
            },
            images: [{ url: 'https://image.migros.ch/d/{stack}/x.jpg' }],
          },
        ],
      };
    });
    const page = await migros.fetchPage(
      ctx,
      { key: 'k', label: 'l', params: { categoryId: '7494731' } },
      null,
    );
    expect(fake.requests().find((c) => c.url.includes('product-cards'))?.headers.leshopch).toBe(
      'token-1',
    );
    expect(page.products[0]).toMatchObject({
      storeProductId: '104004000000',
      price: 1.6,
      unitPrice: 1.6,
      unitPriceBasis: 'l',
      sourceRef: { uid: '101' },
    });
    expect(page.products[1]).toMatchObject({
      price: 4.4,
      regularPrice: 5.5,
      promoLabel: '20%',
      unitPrice: 17.6,
      validUntil: '2026-10-12T21:59:59.000Z',
      imageUrl: 'https://image.migros.ch/d/%7Bstack%7D/x.jpg',
    });
    expect(page.next).toBeNull();
  });

  it('asks the category search for 100 products at a time, without sponsored ones', async () => {
    const { ctx, fake } = fakeContext(
      (url): FakeResponse =>
        url.includes('/search')
          ? {
              body: {
                products: [{ uid: 201 }, { uid: 202 }, { uid: 999, sponsored: true }],
                total: 250,
              },
            }
          : { body: [] },
    );
    const page = await migros.fetchPage(
      ctx,
      { key: 'k', label: 'l', params: { categoryId: '7494781' } },
      100,
    );
    const search = fake.requests().find((c) => c.url.includes('/search'));
    expect(search?.url).toBe(
      'https://www.migros.ch/product-display/public/web/v1/products/category/7494781/search',
    );
    expect(JSON.parse(search?.body ?? '{}')).toMatchObject({
      from: 100,
      limit: 100,
      enabledSponsoredProducts: false,
    });
    const cards = fake.requests().find((c) => c.url.includes('product-cards'));
    expect(JSON.parse(cards?.body ?? '{}').productFilter.uids).toEqual([201, 202]);
    expect(page).toMatchObject({ total: 250, next: 103 });
  });

  it('stops after a short page when the search gives no total', async () => {
    const { ctx } = fakeContext(
      (url): FakeResponse =>
        url.includes('/search') ? { body: { productIds: [1, 2, 3] } } : { body: [] },
    );
    const page = await migros.fetchPage(
      ctx,
      { key: 'k', label: 'l', params: { categoryId: '1' } },
      null,
    );
    expect(page).toMatchObject({ total: null, next: null });
  });

  it('names the fields of a search answer it does not recognise', () => {
    expect(() =>
      parseCategorySearch({ facets: [], paging: {} }, 'https://www.migros.ch/x'),
    ).toThrow(/no list of products this tool recognises \(fields: facets, paging\)/);
  });
});

describe('Coop (real API fixtures)', () => {
  const route = (url: string) => ({
    body: fixture(
      url.includes('/products/category/supermarket')
        ? 'coop-listing.json'
        : url.includes('/products/category/')
          ? 'coop-department.json'
          : 'coop-details.json',
    ),
  });

  it('builds groceries, departments (with sub-categories) and wine as categories', async () => {
    const { ctx, fake } = fakeContext(route);
    const categories = await coop.categories(ctx);
    expect(fake.requests()).toHaveLength(9); // groceries + 7 departments + wine
    expect(categories.filter((c) => c.parentId === null).map((c) => c.id)).toEqual([
      'supermarket',
      'm_0222',
    ]);
    expect(categories.find((c) => c.id === 'supermarket')).toMatchObject({
      name: 'Lebensmittel',
      productCount: 11250,
    });
    expect(categories.find((c) => c.id === 'm_0002')?.path).toEqual([
      'Lebensmittel',
      'Früchte & Gemüse',
      'Früchte',
    ]);
    expect(coop.sources(categories, null).map((s) => s.params.category)).toEqual([
      'supermarket',
      'm_0222',
    ]);
  });

  it('normalizes products, promotions and conditional discounts', async () => {
    const { ctx, fake } = fakeContext(route);
    const page = await coop.fetchPage(
      ctx,
      { key: 'k', label: 'l', params: { category: 'supermarket' } },
      null,
    );
    expect(fake.requests()[0]?.url).toContain(
      '/products/category/supermarket?currentPage=0&pageSize=100',
    );
    expect(fake.requests()[0]?.url).toContain('sort=name-asc'); // stable order while paging
    expect(page.next).toBe(1);
    const byId = (id: string) => page.products.find((p) => p.storeProductId === id);
    expect(byId('3465933')).toMatchObject({
      name: 'Naturaplan Bio Avocado 1 Stück',
      brand: 'Naturaplan',
      price: 1.95,
      quantity: { amount: 1, unit: 'piece', packCount: 1 },
      unitPrice: 1.95,
      unitPriceBasis: 'piece',
      labels: ['Bio'],
      categoryPath: ['Avocados'],
      url: 'https://www.coop.ch/de/p/3465933',
    });
    expect(byId('3090149')).toMatchObject({
      price: 2.95,
      regularPrice: 4.95,
      promoLabel: '-40%',
      unitPrice: 2.95,
      unitPriceBasis: 'kg',
    });
    // "40% ab 2" only applies when buying two: the shelf price stays the regular price.
    expect(byId('3050447')).toMatchObject({
      price: 6.6,
      regularPrice: null,
      promoLabel: '-40% ab 2',
      unitPrice: 0.7333,
      unitPriceBasis: 'l',
    });
    expect(byId('3050447')?.sizeText).toBe('6x1,5l'); // the pack format from the title, not just "9 l"
    expect(byId('3050447')?.quantity).toEqual({ amount: 9000, unit: 'ml', packCount: 6 });
  });

  it('reads details: barcode, allergens, nutrition per 100 g', async () => {
    const { ctx } = fakeContext(route);
    const details = await coop.fetchDetails?.(ctx, {
      storeProductId: '6679118',
      sourceRef: {},
      url: null,
    });
    expect(details).toMatchObject({
      gtin: '7627534001681',
      origin: 'Thailand',
      rating: { average: 3.5, count: 56 },
      extra: { nutritionPer: '100g', ecoScore: 'B' },
    });
    expect(details?.allergens).toEqual(expect.arrayContaining(['Weizenmehl', 'Sojabohnen']));
    expect(details?.nutrition).toMatchObject({
      'Energie (kJ)': '558',
      'Energie (kcal)': '132',
      Fett: '3.2g',
    });
    expect(details?.ingredients).not.toContain('<b>');
  });
});
