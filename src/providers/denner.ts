import { z } from 'zod';
import { computeUnitPrice, parseMoney } from '../normalization/price.js';
import { parsePriceBasis, parseQuantity } from '../normalization/quantity.js';
import { cleanLabel, cleanText, nonEmpty } from '../normalization/text.js';
import type { Category, NormalizedProduct, ProductDetails } from '../normalization/types.js';
import type { Lang, ListingSource, Provider, ProviderContext } from './types.js';
import {
  endOfZurichDay,
  fromUnixSeconds,
  normalizeEach,
  parseEnvelope,
  uniqueStrings,
} from './util.js';

/**
 * Denner — the JSON API behind denner.ch (verified October 2026; it replaced the
 * Prediggo search API, which now answers 405). denner.ch publishes its current
 * promotions and its wine shop with prices, nothing else.
 * Denner publishes no brand field: brands are recognised from the product names
 * after each crawl (see storage/brands.ts), e.g. "Feldschlösschen Bier Original".
 */
const SITE = 'https://www.denner.ch';
const PROMOTIONS = `${SITE}/nuxt-api/promotions`;
const WINES = `${SITE}/nuxt-api/wines`;
const PRODUCT_API = `${SITE}/api/product`;
const PAGE_SIZE = 100; // the most the API returns per page
const WINE_SHOP: Record<Lang, string> = { de: 'Weinshop', fr: 'Shop des vins', it: 'Shop vini' };
// The facets that group the promotion categories, with the names denner.ch shows.
const PROMOTION_GROUPS: Record<string, Record<Lang, string>> = {
  type_food: { de: 'Lebensmittel', fr: 'Aliments', it: 'Generi alimentari' },
  type_beverages: { de: 'Getränke', fr: 'Boissons', it: 'Bevande' },
  type_non_food: {
    de: 'Nicht-Lebensmittel',
    fr: 'Non alimentaire',
    it: 'Articoli non alimentari',
  },
};

const Attribute = z.object({
  attributeName: z.string(),
  vals: z.array(z.object({ value: z.string() })),
});
const RawSlotItem = z.object({
  sku: z.string(),
  price: z.number().nullish(),
  itemType: z.string().nullish(),
  attributeInfo: z.array(Attribute),
});
type RawSlotItem = z.infer<typeof RawSlotItem>;

const Facet = z.object({
  attributeName: z.string(),
  options: z.array(
    z.object({ value: z.string(), label: z.string(), nbResults: z.number().nullish() }),
  ),
});

const PageResponse = z.object({
  items: z.array(z.unknown()),
  facets: z.array(z.unknown()).nullish(),
  stats: z.object({
    totalResults: z.number(),
    currentPage: z.number(),
    totalPages: z.number(),
  }),
  // Weekend and week-start offers, listed next to the weekly promotions.
  highlights: z.array(z.object({ items: z.array(z.unknown()).nullish() })).nullish(),
});
type PageResponse = z.infer<typeof PageResponse>;

const RawDetails = z.object({
  description: z.string().nullish(),
  additionalDesription: z.string().nullish(), // sic, as named by the API
  isBio: z.boolean().nullish(),
  isVegan: z.boolean().nullish(),
  ecoLabels: z.array(z.object({ name: z.string() })).nullish(),
  rating: z
    .union([
      z.object({ value: z.number().nullish(), total: z.number().nullish() }),
      z.array(z.unknown()),
    ])
    .nullish(),
  wine: z
    .object({
      character: z.string().nullish(),
      boxInfo: z.string().nullish(),
      country: z.object({ name: z.string().nullish() }).nullish(),
      year: z.union([z.string(), z.number()]).nullish(),
    })
    .nullish(),
});

function attributes(item: RawSlotItem): Map<string, string[]> {
  return new Map(item.attributeInfo.map((a) => [a.attributeName, a.vals.map((v) => v.value)]));
}

export function normalizeDennerItem(item: RawSlotItem): NormalizedProduct | null {
  const attrs = attributes(item);
  const first = (name: string) => nonEmpty(attrs.get(name)?.[0]);
  const itemUrl = first('itemUrl');
  // navisionId is a per-publication variant id for promotions; the tracking id is the article number.
  const id = first('_tracking_item_id') ?? (itemUrl ? /~p(\d+)/.exec(itemUrl)?.[1] : null);
  const name = first('name') ?? first('_tracking_item_name');
  // Offers on a whole range ("auf alle Weine") are not products: no article number, price 0.
  if (!id || !/^\d+$/.test(id) || !name) return null;

  const isWine = first('product_type') === 'wine' || itemUrl?.includes('/weinshop/') === true;
  const subline = first('nameSubline');
  const size = first('content_size_text');
  const boxOf = Number(first('salesQuantity') ?? '1');
  const price = item.price ?? parseMoney(first('priceFormatted'));
  // Meat and produce are often priced "per 100 g" / "per kg": that is what the price refers to.
  const basis = parsePriceBasis(subline);
  const quantity =
    basis ??
    (boxOf > 1 && size ? parseQuantity(`${boxOf} x ${size}`) : null) ??
    parseQuantity(subline) ??
    parseQuantity(size?.replace('unit.', ''));
  const unit = computeUnitPrice(price, quantity);
  // e.g. "40%", "½ PREIS", "20% <vertical>ab 2 Stück</vertical>"
  const discount = cleanLabel(cleanText(first('discount_text')));
  const footnote = first('footnote');
  const category = first('_tracking_item_category2')?.split('/')[0]?.trim();

  return {
    store: 'denner',
    storeProductId: id,
    name,
    brand: null,
    categoryPath: isWine ? uniqueStrings(['Wein', category]) : uniqueStrings([category]),
    sizeText: subline ?? size,
    quantity,
    price: price != null && price > 0 ? price : null,
    regularPrice: parseMoney(first('insteadPriceText')),
    loyaltyPrice: null,
    promoLabel: discount ? (/^\d+\s*%/.test(discount) ? `-${discount}` : discount) : null,
    validFrom: fromUnixSeconds(first('promotionFrom')),
    // promotionTo is midnight at the *start* of the last valid day.
    validUntil: endOfZurichDay(fromUnixSeconds(first('promotionTo'))),
    unitPrice: unit?.unitPrice ?? null,
    unitPriceBasis: unit?.unitPriceBasis ?? null,
    // Footnotes such as "Konkurrenzvergleich" (the "statt" price is a competitor's) or
    // "Nur in der deutschen Schweiz erhältlich" describe the offer; they are kept as labels.
    labels: uniqueStrings([
      first('wine_of_the_week') === 'true' ? 'Wein der Woche' : null,
      ...(footnote ?? '').split('|'),
    ]),
    url: itemUrl ? `${SITE}${itemUrl.split('?')[0]}` : null,
    imageUrl: first('imageUrl'),
    sourceRef: {},
  };
}

type FacetData = z.infer<typeof Facet>;

function facetsOf(page: PageResponse): FacetData[] {
  return (page.facets ?? []).flatMap((f) => {
    const parsed = Facet.safeParse(f);
    return parsed.success ? [parsed.data] : [];
  });
}

/** One page of this week's promotions, optionally of one category (a facet value). */
async function promotions(
  ctx: ProviderContext,
  options: { page: number; size: number; facet?: { name: string; value: string } },
): Promise<PageResponse> {
  const body = await ctx.http.postJson(PROMOTIONS, {
    lang: ctx.lang,
    promoFlag: 'promo_current_week',
    facetName: options.facet?.name ?? null,
    facetValue: options.facet?.value ?? null,
    page: options.page,
    hitsPerPage: options.size,
    sort: null,
    // The weekend and week-start offers, listed once with the first page of everything.
    includeHighlights: options.page === 1 && !options.facet && options.size > 1,
  });
  return parseEnvelope(PageResponse, body, PROMOTIONS, 'Denner promotions');
}

/** One page of the wine shop, optionally of one wine type. */
async function wines(
  ctx: ProviderContext,
  options: { page: number; size: number; wineType?: string },
): Promise<PageResponse> {
  const body = await ctx.http.postJson(WINES, {
    lang: ctx.lang,
    onlyDiscounted: false,
    selection: options.wineType
      ? { values: { wine_type: [options.wineType] }, unitPrice: null }
      : null,
    page: options.page,
    hitsPerPage: options.size,
    sort: null,
  });
  return parseEnvelope(PageResponse, body, WINES, 'Denner wine shop');
}

/** Offers on a whole range ("20% auf alle Weine", mostly among the highlights) are not products. */
function isRangeOffer(item: unknown): boolean {
  const parsed = RawSlotItem.safeParse(item);
  if (!parsed.success) return false;
  const id = attributes(parsed.data).get('_tracking_item_id')?.[0];
  return !id || !/^\d+$/.test(id);
}

/** What a source lists. Sources saved by older versions (Prediggo page ids) still resume. */
function listOf(params: Record<string, string>): {
  list: 'promotions' | 'wine';
  facet?: { name: string; value: string };
  wineType?: string;
} {
  if (params.list === 'wine')
    return params.wineType ? { list: 'wine', wineType: params.wineType } : { list: 'wine' };
  if (params.list === 'promotions') {
    return params.facet && params.value
      ? { list: 'promotions', facet: { name: params.facet, value: params.value } }
      : { list: 'promotions' };
  }
  if (params.page === '14') {
    return params.filter === 'wine_type' && params.values
      ? { list: 'wine', wineType: params.values }
      : { list: 'wine' };
  }
  return { list: 'promotions' };
}

export const denner: Provider = {
  info: {
    id: 'denner',
    name: 'Denner',
    website: 'https://www.denner.ch',
    coverage:
      'Current promotions (about 250, changing every week) and the wine shop (about 550 wines). ' +
      'denner.ch does not publish its full grocery assortment.',
    rotating: true,
    verified: true,
    brandInName: true,
    requestsPerSecond: 2,
  },

  async categories(ctx): Promise<Category[]> {
    const categories: Category[] = [];
    const add = (groupId: string, groupName: string, facet: FacetData | undefined) => {
      if (!facet) return;
      categories.push({
        store: 'denner',
        id: groupId,
        parentId: null,
        name: groupName,
        path: [groupName],
        productCount: facet.options.reduce((sum, o) => sum + (o.nbResults ?? 0), 0),
      });
      for (const o of facet.options) {
        categories.push({
          store: 'denner',
          id: o.value,
          parentId: groupId,
          name: o.label,
          path: [groupName, o.label],
          productCount: o.nbResults ?? null,
        });
      }
    };
    const promotionFacets = facetsOf(await promotions(ctx, { page: 1, size: 1 }));
    for (const [facetName, names] of Object.entries(PROMOTION_GROUPS)) {
      add(
        facetName.replace('type_', ''),
        names[ctx.lang],
        promotionFacets.find((f) => f.attributeName === facetName),
      );
    }
    const wineFacets = facetsOf(await wines(ctx, { page: 1, size: 1 }));
    add(
      'wine',
      WINE_SHOP[ctx.lang],
      wineFacets.find((f) => f.attributeName === 'wine_type'),
    );
    return categories;
  },

  sources(categories, categoryIds) {
    if (!categoryIds) {
      return [
        { key: 'promotions', label: 'Current promotions', params: { list: 'promotions' } },
        { key: 'wine', label: 'Wine shop', params: { list: 'wine' } },
      ];
    }
    const sources = new Map<string, ListingSource>();
    for (const c of categories.filter((x) => categoryIds.includes(x.id))) {
      if (c.id === 'wine') {
        sources.set('wine', { key: 'wine', label: c.path.join(' > '), params: { list: 'wine' } });
      } else if (c.parentId === 'wine') {
        sources.set(`wine:${c.id}`, {
          key: `wine:${c.id}`,
          label: c.path.join(' > '),
          params: { list: 'wine', wineType: c.id },
        });
      } else {
        // The API filters one category at a time, so a group is listed category by category.
        const listed = c.parentId === null ? categories.filter((x) => x.parentId === c.id) : [c];
        for (const x of listed) {
          sources.set(`category:${x.id}`, {
            key: `category:${x.id}`,
            label: x.path.join(' > '),
            params: { list: 'promotions', facet: `type_${x.parentId}`, value: x.id },
          });
        }
      }
    }
    return [...sources.values()];
  },

  async fetchPage(ctx, source, cursor) {
    const page = typeof cursor === 'number' ? cursor : 1;
    const what = listOf(source.params);
    const response =
      what.list === 'wine'
        ? await wines(ctx, {
            page,
            size: PAGE_SIZE,
            ...(what.wineType ? { wineType: what.wineType } : {}),
          })
        : await promotions(ctx, {
            page,
            size: PAGE_SIZE,
            ...(what.facet ? { facet: what.facet } : {}),
          });
    const highlights = (response.highlights ?? []).flatMap((h) => h.items ?? []);
    const items = [...response.items, ...highlights].filter((item) => !isRangeOffer(item));
    const normalized = normalizeEach(items, RawSlotItem, normalizeDennerItem, ctx.debug);
    const { currentPage, totalPages, totalResults } = response.stats;
    return {
      ...normalized,
      total: totalResults,
      next: currentPage < totalPages && response.items.length > 0 ? page + 1 : null,
    };
  },

  async fetchDetails(ctx, request): Promise<ProductDetails | null> {
    const url = `${PRODUCT_API}/${encodeURIComponent(request.storeProductId)}?locale=${ctx.lang}`;
    const body = await ctx.http.getJson(url);
    const raw = parseEnvelope(z.object({ data: RawDetails }), body, url, 'Denner product').data;
    const extra: Record<string, string> = {};
    const labels = uniqueStrings([
      ...(raw.ecoLabels ?? []).map((l) => l.name),
      raw.isBio ? 'Bio' : null,
      raw.isVegan ? 'Vegan' : null,
    ]);
    if (labels.length > 0) extra.labels = labels.join(', ');
    if (raw.wine?.character) extra.tasting = cleanText(raw.wine.character) ?? '';
    if (raw.wine?.boxInfo) extra.box = raw.wine.boxInfo.trim();
    if (raw.wine?.year) extra.vintage = String(raw.wine.year);
    const rating =
      raw.rating && !Array.isArray(raw.rating) && raw.rating.value != null
        ? { average: Math.round(raw.rating.value * 10) / 10, count: raw.rating.total ?? 0 }
        : null;
    return {
      description: cleanText(
        [raw.description, raw.additionalDesription].filter(Boolean).join('\n'),
      ),
      origin: nonEmpty(raw.wine?.country?.name),
      rating,
      ...(Object.keys(extra).length > 0 ? { extra } : {}),
    };
  },

  isFood: (category) => category.id !== 'non_food',
};
