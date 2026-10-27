import { describe, expect, it } from 'vitest';
import { parseComparisonPrice, parseMoney } from '../../src/normalization/price.js';
import { resolveCategories } from '../../src/providers/categories.js';
import { ikea } from '../../src/providers/ikea.js';
import {
  landi,
  parseCategoryId,
  parseLandiCategories,
  parseLandiProducts,
} from '../../src/providers/landi.js';
import { parseValidity, parseVolgOffers } from '../../src/providers/volg.js';
import { fakeContext, fixture } from '../helpers/context.js';

const VOLG = `<html><body>
<h2 class="c-section__subtitle">Frische-Aktionen <span>Mi. 28.10. bis Sa. 31.10.</span></h2>
<div class="row js-slider-mobile"><div class="col col-md-6 col-lg-4 col--stretch">
<div class="c-product"><h3 class="c-product__title ">Agri Natura Eier Freiland</h3>
<div class="c-product__image c-product__image--stretched"><img src="/fileadmin/_processed_/3/f/csm_promo_77134_de_39ea8208e5.jpg" width="224" height="160" alt="" /><div class="c-product__reduction"> -25% </div></div>
<div class="c-product__meta"><div class="c-product__description"> Schweiz, 10 Stück <br><small>(1 Stück = -.55)</small></div>
<div class="c-product__price"><span class="c-product__price-main">5.50</span><span class="u-text-nowrap"> statt 7.35</span></div></div></div></div>
</div>
<h2 class="c-section__subtitle">Weitere Aktionen* <span>Mo. 26.10. bis Sa. 31.10.</span></h2>
<div class="c-product"><h3 class="c-product__title ">Nectaflor Honig</h3><div class="c-product__image "></div>
<div class="c-product__meta"><div class="c-product__description"> div. Sorten, z.B. Wildblütenhonig, 250 g <br><small>(100 g = 1.58)</small></div>
<div class="c-product__price"><span class="c-product__price-main">3.95</span><span class="u-text-nowrap"> statt 4.70</span></div></div></div>
</body></html>`;

describe('Volg', () => {
  const today = new Date(Date.UTC(2026, 9, 26));

  it('reads the offers of the week by section', () => {
    const sections = parseVolgOffers(VOLG, 'de', today);
    expect(sections.map((s) => [s.id, s.name, s.products.length])).toEqual([
      ['frische-aktionen', 'Frische-Aktionen', 1],
      ['weitere-aktionen', 'Weitere Aktionen', 1],
    ]);
    const [eggs] = sections[0]?.products ?? [];
    expect(eggs).toMatchObject({
      store: 'volg',
      storeProductId: '77134',
      name: 'Agri Natura Eier Freiland',
      categoryPath: ['Frische-Aktionen'],
      sizeText: 'Schweiz, 10 Stück',
      quantity: { amount: 10, unit: 'piece', packCount: 1 },
      price: 5.5,
      regularPrice: 7.35,
      promoLabel: '-25%',
      unitPrice: 0.55,
      unitPriceBasis: 'piece',
      imageUrl: 'https://www.volg.ch/fileadmin/_processed_/3/f/csm_promo_77134_de_39ea8208e5.jpg',
    });
    // Wednesday 00:00 to Saturday 23:59:59, Swiss time.
    expect(eggs?.validFrom).toBe('2026-10-27T23:00:00.000Z');
    expect(eggs?.validUntil).toBe('2026-10-31T22:59:59.000Z');
    const [honey] = sections[1]?.products ?? [];
    // Without a picture there is no offer number: the name and size make the id.
    expect(honey?.storeProductId).toBe('nectaflor-honig-div-sorten-z-b-wildblutenhonig-250-g');
    expect(honey).toMatchObject({ promoLabel: '-16%', unitPrice: 15.8, unitPriceBasis: 'kg' });
  });

  it('dates offers around New Year in the right year', () => {
    const december = new Date(Date.UTC(2026, 11, 30));
    expect(parseValidity('Mo. 28.12. bis Sa. 2.1.', december)).toEqual([
      '2026-12-27T23:00:00.000Z',
      '2027-01-02T22:59:59.000Z',
    ]);
  });
});

const LANDI_MENU = `<nav>
<a href="/shop/lebensmittel_21" data-ga-eventlabel="Lebensmittel">Lebensmittel</a>
<a href="/shop/mehle_2102" data-ga-eventlabel="Mehle">Mehle</a>
<a href="/shop/backmehle_210201" data-ga-eventlabel="Backmehle">Backmehle</a>
<a href="/shop/spezialmehle_210202" data-ga-eventlabel="Spezialmehle">Spezialmehle</a>
<a href="/shop/garten_10" data-ga-eventlabel="Garten">Garten</a>
<a href="/shop/backmehle_210201" data-ga-eventlabel="Backmehle">again</a>
</nav>`;

const LANDI_LIST = `\r\n<div class="row product-listing" id="listings">
<div class="col-xs-6 col-md-3 product-item"><div class="product-item-wrap">
<a href="/shop/backmehle_210201/ruchmehl-cuisine-panflor-5-kg_82269" title="Ruchmehl" class="product-link" data-productCode="82269">
<span class="product-metadata price-info "><img class="product-image-price" src="/landiprice.ashx?p=7.60&amp;h=53&amp;ta=False" height="38" />
<span class="product-badges product-badges-list"><img alt="CH" class="product-image-badge" src="/x.png" /></span>
<img alt="Ruchmehl Cuisine Panflor 5 kg" class="product-image-main" src="/ImageOriginal/Img/product/082/269/82269_1.jpg?width=250&amp;height=250" />
<div class="product-caption"><h3>Ruchmehl Cuisine Panflor 5 kg</h3><div class="product-caption-info"><div class="product-caption-code">Art.Nr. 82269</div>
<div class="product-caption-price" style="display: inline-block">1.52 / kg</div></div></div></a></div></div>
<div class="col-xs-6 col-md-3 product-item"><div class="product-item-wrap">
<a href="/shop/weihnachtsbeleuchtung_151104/lichterkette-80-led_97529" title="Lichterkette 80 LED" class="product-link" data-productcode="97529">
<span class="product-metadata price-info is-top-angebot"><span class="price-text">Top Angebot</span><img class="product-image-price" src="/landiprice.ashx?p=7.50&amp;h=53&amp;ta=True" height="38" />
<span class="price-subtext">nur solange Vorrat</span></span>
<div class="product-caption"><h3>Lichterkette 80 LED</h3><div class="product-caption-price"></div></div></a></div></div>
</div>`;

describe('LANDI', () => {
  it('builds the category tree from the shop menu', () => {
    const categories = parseLandiCategories(LANDI_MENU);
    expect(categories.map((c) => [c.id, c.parentId, c.path.join(' > ')])).toEqual([
      ['garten_10', null, 'Garten'],
      ['lebensmittel_21', null, 'Lebensmittel'],
      ['mehle_2102', 'lebensmittel_21', 'Lebensmittel > Mehle'],
      ['backmehle_210201', 'mehle_2102', 'Lebensmittel > Mehle > Backmehle'],
      ['spezialmehle_210202', 'mehle_2102', 'Lebensmittel > Mehle > Spezialmehle'],
    ]);
    // Only the most specific categories list every product.
    expect(landi.sources(categories, null).map((s) => s.params.slug)).toEqual([
      'garten_10',
      'backmehle_210201',
      'spezialmehle_210202',
    ]);
    expect(landi.sources(categories, ['mehle_2102']).map((s) => s.params.slug)).toEqual([
      'backmehle_210201',
      'spezialmehle_210202',
    ]);
    expect(landi.isFood?.(categories[1] as (typeof categories)[number])).toBe(true);
    expect(landi.isFood?.(categories[0] as (typeof categories)[number])).toBe(false);
  });

  it('finds the product list of a category page', () => {
    expect(
      parseCategoryId(
        '<input id="searchUrl" type="hidden" value="/api/de/catalog/productlist?lang=de&amp;scid=4818&amp;sf=no" />',
      ),
    ).toBe('4818');
    expect(parseCategoryId('<html></html>')).toBeNull();
  });

  it('reads products: the price from the price picture, top offers, unit prices', () => {
    const products = parseLandiProducts(LANDI_LIST, ['Lebensmittel', 'Mehle', 'Backmehle'], 'de');
    expect(products).toHaveLength(2);
    expect(products[0]).toMatchObject({
      store: 'landi',
      storeProductId: '82269',
      name: 'Ruchmehl Cuisine Panflor 5 kg',
      quantity: { amount: 5000, unit: 'g', packCount: 1 },
      price: 7.6,
      promoLabel: null,
      unitPrice: 1.52,
      unitPriceBasis: 'kg',
      labels: ['CH'],
      url: 'https://www.landi.ch/shop/backmehle_210201/ruchmehl-cuisine-panflor-5-kg_82269',
      imageUrl:
        'https://www.landi.ch/ImageOriginal/Img/product/082/269/82269_1.jpg?width=250&height=250',
    });
    expect(products[1]).toMatchObject({
      storeProductId: '97529',
      price: 7.5,
      promoLabel: 'Top Angebot',
    });
  });
});

describe('IKEA (real API fixture)', () => {
  const answer = () => ({ body: fixture('ikea-search.json') });

  it('lists the top-level categories; a full fetch is one listing of everything', async () => {
    const { ctx, fake } = fakeContext(answer);
    const categories = await ikea.categories(ctx);
    expect(categories.map((c) => [c.id, c.name, c.productCount])).toEqual([
      ['ka001', 'Küchen & Elektrogeräte', 8638],
      ['700640', 'Sofas & Sessel', 4100],
      ['fb001', 'Schwedische Lebensmittel & Schwedische Getränke', 141],
    ]);
    // The search service answers the tool itself: no website client id in the address.
    expect(fake.requests()[0]?.url).toBe('https://sik.search.blue.cdtapps.com/ch/de/search');
    expect(ikea.sources(categories, null)).toEqual([
      { key: 'all', label: 'All products', params: { category: 'products' } },
    ]);
    const { ids } = resolveCategories(ikea, categories, ['food']);
    expect(ids).toEqual(['fb001']);
    expect(ikea.sources(categories, ids).map((s) => s.params.category)).toEqual(['fb001']);
  });

  it('pages through every colour and size, sorted by name', async () => {
    const { ctx, fake } = fakeContext(answer);
    const all = ikea.sources([], null)[0] as NonNullable<ReturnType<typeof ikea.sources>[0]>;
    const page = await ikea.fetchPage(ctx, all, null);
    const body = JSON.parse(fake.requests()[0]?.body ?? '{}');
    expect(body.searchParameters).toEqual({ input: 'products', type: 'CATEGORY' });
    expect(body.components[0]).toMatchObject({
      sort: 'NAME_ASCENDING',
      window: { size: 1000, offset: 0 },
      allowGprDeduplication: false,
    });
    expect(page).toMatchObject({ total: 27478, skipped: 1 }); // one item without a number
    expect(page.products).toHaveLength(9);
    // The window ends at 10 of 27,478 items: the next page starts there.
    expect(page.next).toBe(10);

    // The last page: its window reaches the end.
    const last = fakeContext(() => {
      const body = fixture<{ results: { metadata: object }[] }>('ikea-search.json');
      (body.results[0] as { metadata: object }).metadata = { start: 27468, end: 27478, max: 27478 };
      return { body };
    });
    const lastPage = await ikea.fetchPage(last.ctx, all, 27468);
    expect(JSON.parse(last.fake.requests()[0]?.body ?? '{}').components[0].window).toEqual({
      size: 1000,
      offset: 27468,
    });
    expect(lastPage.next).toBeNull();
  });

  it('reads Family prices, lower prices, offers, food by weight and packs', async () => {
    const { ctx } = fakeContext(answer);
    const all = ikea.sources([], null)[0] as NonNullable<ReturnType<typeof ikea.sources>[0]>;
    const { products } = await ikea.fetchPage(ctx, all, null);
    const byId = new Map(products.map((p) => [p.storeProductId, p]));
    // Members pay the IKEA Family price; everyone else the normal price.
    expect(byId.get('40573285')).toMatchObject({
      name: 'GLOSTAD 3er-Sofa, Knisa dunkelgrau',
      brand: 'IKEA',
      categoryPath: ['Sofas & Sessel', 'Sofas', '3er-Sofas'],
      price: 149,
      regularPrice: null,
      loyaltyPrice: 126.65,
      promoLabel: 'IKEA Family Preis',
      validFrom: '2026-10-11T22:00:00.000Z',
      validUntil: '2026-11-01T22:59:59.000Z',
      url: 'https://www.ikea.com/ch/de/p/glostad-3er-sofa-knisa-dunkelgrau-40573285/',
    });
    // "1'099" before, 949 now.
    expect(byId.get('29443059')).toMatchObject({
      price: 949,
      regularPrice: 1099,
      loyaltyPrice: null,
      promoLabel: 'Preis für dich gesenkt',
    });
    expect(byId.get('80365185')).toMatchObject({
      price: 249,
      regularPrice: 349,
      promoLabel: '-28%',
      sizeText: '51x120 cm',
      labels: ['Jetzt oder nie'],
    });
    // Food: the weight comes with the price, so the price per kg; other brands are sold too.
    expect(byId.get('00524211')).toMatchObject({
      brand: null,
      sizeText: '176 g',
      quantity: { amount: 176, unit: 'g', packCount: 1 },
      unitPrice: 8.5227,
      unitPriceBasis: 'kg',
    });
    expect(byId.get('90504529')).toMatchObject({
      quantity: { amount: 1000, unit: 'g' },
      unitPrice: 15.95,
    });
    // Six wine glasses of 44 cl: the size is a capacity, the price is for six.
    expect(byId.get('00473023')).toMatchObject({
      sizeText: '44 cl, 6 Stück',
      quantity: { amount: 6, unit: 'piece' },
      unitPrice: 1.6583,
      unitPriceBasis: 'piece',
    });
    expect(byId.get('00607409')).toMatchObject({ sizeText: '21 cm', quantity: null });
    expect(byId.get('50620998')).toMatchObject({
      sizeText: '45 cm',
      quantity: null,
      labels: ['Limitierte Auflage'],
    });
    expect(byId.get('80645737')).toMatchObject({ labels: ['Neu'], promoLabel: null });
  });
});

describe('Swiss price notation', () => {
  it('reads -.55 as 55 centimes and 5.– as five francs', () => {
    expect(parseMoney('-.55')).toBe(0.55);
    expect(parseMoney('statt .95')).toBe(0.95);
    expect(parseMoney('5.–')).toBe(5);
    expect(parseMoney('12.50')).toBe(12.5);
    expect(parseComparisonPrice('(1 Stück = -.55)')).toEqual({
      unitPrice: 0.55,
      unitPriceBasis: 'piece',
    });
  });
});
