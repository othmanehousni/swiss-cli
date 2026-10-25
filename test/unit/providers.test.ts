import { describe, expect, it } from 'vitest';
import { aldi } from '../../src/providers/aldi.js';
import { resolveCategories } from '../../src/providers/categories.js';
import { coop } from '../../src/providers/coop.js';
import { denner } from '../../src/providers/denner.js';
import { lidl } from '../../src/providers/lidl.js';
import { migros, parseCategorySearch, topCategorySlugs } from '../../src/providers/migros.js';
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
  const route = (url: string) => {
    if (url.includes('/api/product/')) return { body: fixture('denner-details.json') };
    return {
      body: fixture(
        url.endsWith('/nuxt-api/wines') ? 'denner-wine.json' : 'denner-promotions.json',
      ),
    };
  };

  it('builds promotion and wine categories from facets', async () => {
    const { ctx } = fakeContext((url) => route(url));
    const categories = await denner.categories(ctx);
    expect(categories.filter((c) => c.parentId === null).map((c) => c.id)).toEqual([
      'food',
      'beverages',
      'non_food',
      'wine',
    ]);
    expect(categories.find((c) => c.id === '1144363')?.path).toEqual([
      'Lebensmittel',
      'Früchte und Gemüse',
    ]);
    // The API filters one category at a time: a group becomes one source per category.
    const sources = denner.sources(categories, ['food', '1144363', 'Schaumwein']);
    const food = categories.filter((c) => c.parentId === 'food');
    expect(sources).toHaveLength(food.length + 1);
    expect(sources[0]?.params).toEqual({
      list: 'promotions',
      facet: 'type_food',
      value: '1144363',
    });
    expect(sources.at(-1)?.params).toEqual({ list: 'wine', wineType: 'Schaumwein' });
    expect(resolveCategories(denner, categories, ['food']).ids).toEqual([
      'food',
      'beverages',
      'wine',
    ]);
  });

  it('normalizes promotions: stable ids, per-100 g prices and inclusive end dates', async () => {
    const { ctx, fake } = fakeContext((url) => route(url));
    const page = await denner.fetchPage(
      ctx,
      { key: 'promotions', label: 'P', params: { list: 'promotions' } },
      null,
    );
    expect(fake.requests()[0]?.url).toBe('https://www.denner.ch/nuxt-api/promotions');
    expect(JSON.parse(fake.requests()[0]?.body ?? '{}')).toMatchObject({
      lang: 'de',
      promoFlag: 'promo_current_week',
      page: 1,
      hitsPerPage: 100,
      includeHighlights: true,
    });
    expect(page).toMatchObject({ next: 2, total: 280, skipped: 0 });
    // Seven weekly promotions and one weekend offer; "20% auf alle Weine" is not a product.
    expect(page.products).toHaveLength(8);
    expect(page.products.find((p) => p.name === 'Satsumas')).toMatchObject({
      storeProductId: '1006226',
      brand: null, // Denner publishes no brand; it is recognised from names after the crawl
      price: 1.49,
      regularPrice: 1.95,
      promoLabel: '-23%',
      unitPrice: 1.49,
      unitPriceBasis: 'kg',
      validUntil: '2026-10-28T22:59:59.000Z', // "until 28.10." means through the end of that day
      url: 'https://www.denner.ch/de/aktionen/satsumas~p1006226',
    });
    expect(page.products.find((p) => p.storeProductId === '1133887')).toMatchObject({
      price: 6.95,
      unitPrice: 69.5, // priced per 100 g
      unitPriceBasis: 'kg',
    });
    const malbec = page.products.find((p) => p.storeProductId === '1026795');
    expect(malbec?.promoLabel).toBe('½ PREIS');
    // The footnote says the "statt" price is a competitor's price; it is kept as a label.
    expect(malbec?.labels).toContain('Konkurrenzvergleich');
    expect(page.products.find((p) => p.storeProductId === '1020098')?.promoLabel).toBe(
      '-20% ab 2 Stück',
    );
    expect(page.products.find((p) => p.storeProductId === '1008826')?.validUntil).toBe(
      '2026-10-25T22:59:59.000Z', // the weekend offer; winter time from that day
    );
  });

  it('asks for one category or wine type, and resumes sources saved by older versions', async () => {
    const { ctx, fake } = fakeContext((url) => route(url));
    await denner.fetchPage(
      ctx,
      {
        key: 'c',
        label: 'C',
        params: { list: 'promotions', facet: 'type_food', value: '1144363' },
      },
      2,
    );
    expect(JSON.parse(fake.requests()[0]?.body ?? '{}')).toMatchObject({
      facetName: 'type_food',
      facetValue: '1144363',
      page: 2,
      includeHighlights: false,
    });
    await denner.fetchPage(
      ctx,
      { key: 'w', label: 'W', params: { list: 'wine', wineType: 'Rosé' } },
      null,
    );
    expect(JSON.parse(fake.requests()[1]?.body ?? '{}')).toMatchObject({
      selection: { values: { wine_type: ['Rosé'] }, unitPrice: null },
    });
    await denner.fetchPage(ctx, { key: 'wine', label: 'W', params: { page: '14' } }, null);
    expect(fake.requests()[2]?.url).toBe('https://www.denner.ch/nuxt-api/wines');
  });

  it('prices wine boxes per litre and reads wine details', async () => {
    const { ctx } = fakeContext((url) => route(url));
    const page = await denner.fetchPage(
      ctx,
      { key: 'wine', label: 'W', params: { list: 'wine' } },
      null,
    );
    expect(page).toMatchObject({ next: 2, total: 565 });
    expect(page.products[0]).toMatchObject({
      storeProductId: '1027134',
      price: 101.7,
      quantity: { amount: 4500, unit: 'ml', packCount: 6 },
      unitPrice: 22.6,
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

  const sitemap = `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
<url><loc>https://www.migros.ch/de</loc></url>
<url><loc>https://www.migros.ch/de/brand/a-vogel</loc></url>
<url><loc>https://www.migros.ch/de/category/fruchte-gemuse</loc></url>
<url><loc>https://www.migros.ch/de/category/snacks-sussigkeiten</loc></url>
<url><loc>https://www.migros.ch/de/category/snacks-sussigkeiten/guetzli</loc></url>
<url><loc>https://www.migros.ch/de/category/alte-kategorie</loc></url>
<url><loc>https://www.migros.ch/fr/category/snacks-confiseries</loc></url>
</urlset>`;

  it('finds the top-level category pages in the sitemap', () => {
    expect(topCategorySlugs(sitemap)).toEqual({
      lang: 'de',
      slugs: ['fruchte-gemuse', 'snacks-sussigkeiten', 'alte-kategorie'],
    });
    // English first (the website looks categories up in English), alternate links included.
    const alternates = `<url><loc>https://www.migros.ch/de/category/snacks-sussigkeiten</loc>
<xhtml:link rel="alternate" hreflang="en" href="https://www.migros.ch/en/category/snacks-sweets"/></url>`;
    expect(topCategorySlugs(alternates)).toEqual({ lang: 'en', slugs: ['snacks-sweets'] });
    expect(topCategorySlugs('<urlset></urlset>')).toEqual({ lang: 'en', slugs: [] });
  });

  it('builds the category tree from the sitemap, the breadcrumb and the search', async () => {
    const { ctx, fake } = fakeContext((url): FakeResponse => {
      if (url.endsWith('/sitemap.xml')) return { body: sitemap };
      if (url.includes('categories-breadcrumb?slug=fruchte-gemuse'))
        return { body: { id: '7494732', name: { de: 'Früchte & Gemüse', en: 'Fruits' } } };
      if (url.includes('categories-breadcrumb?slug=snacks-sussigkeiten'))
        return {
          body: {
            id: '7494736',
            name: { de: 'Snacks & Süssigkeiten', en: 'Snacks & sweets' },
            nbSubLevels: 3,
            parents: [],
            slug: { de: 'snacks-sussigkeiten', en: 'snacks-sweets' },
          },
        };
      if (url.includes('categories-breadcrumb?slug=alte-kategorie'))
        return { status: 404, body: { error: 'Not Found', status: 404 } };
      if (url.includes('/category/7494736/search'))
        return {
          body: {
            categories: [{ id: 7494781, name: 'Guetzli', slug: 'guetzli' }],
            filters: [],
            items: [{ id: 100002880, type: 'PRODUCT' }],
          },
        };
      return { body: { categories: [], filters: [], items: [] } };
    });
    const categories = await migros.categories(ctx);
    expect(categories.map((c) => [c.id, c.parentId, c.path.join(' > ')])).toEqual([
      ['7494732', null, 'Früchte & Gemüse'],
      ['7494736', null, 'Snacks & Süssigkeiten'],
      ['7494781', '7494736', 'Snacks & Süssigkeiten > Guetzli'],
    ]);
    const crumb = fake.requests().find((c) => c.url.includes('slug=snacks-sussigkeiten'));
    expect(crumb?.headers['migros-language']).toBe('de');
    expect(crumb?.headers.leshopch).toBeTruthy(); // the lookup answers 401 without the guest token
    const search = fake.requests().find((c) => c.url.includes('/category/7494736/search'));
    expect(JSON.parse(search?.body ?? '{}')).toMatchObject({ from: 0, limit: 1, language: 'de' });
    // Nothing under /shopping-list, which robots.txt closes to tools.
    expect(fake.requests().some((c) => c.url.includes('/shopping-list'))).toBe(false);
    // A full crawl reads the top-level categories; their searches include everything below.
    expect(migros.sources(categories, null).map((s) => s.params.categoryId)).toEqual([
      '7494732',
      '7494736',
    ]);
  });

  it('says so when the sitemap has no category page the lookup knows', async () => {
    const { ctx } = fakeContext(
      (url): FakeResponse =>
        url.endsWith('/sitemap.xml')
          ? { body: '<loc>https://www.migros.ch/en/category/gone</loc>' }
          : { status: 404, body: { error: 'Not Found' } },
    );
    await expect(migros.categories(ctx)).rejects.toThrow(
      /answered 404 for every category page in the sitemap \(en: gone…\)/,
    );
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

  it('reads the product ids from the items of the real search answer', () => {
    const answer = {
      categories: [{ id: 7495010, name: 'Chocolate biscuits & cookies', slug: 'chocolate' }],
      filters: [{ count: 14, id: 'promotion', label: 'Promotions', type: 'SINGLE' }],
      items: [
        { id: 100014192, type: 'PRODUCT' },
        { id: 100018540, type: 'PRODUCT' },
        { id: 5, type: 'TEASER' },
      ],
    };
    expect(parseCategorySearch(answer, 'u')).toEqual({
      uids: [100014192, 100018540],
      received: 3,
      total: null,
    });
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
