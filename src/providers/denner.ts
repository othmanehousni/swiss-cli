import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { computeUnitPrice, parseMoney } from '../normalization/price.js';
import { parsePriceBasis, parseQuantity } from '../normalization/quantity.js';
import { cleanLabel, cleanText, nonEmpty } from '../normalization/text.js';
import type { Category, NormalizedProduct, ProductDetails } from '../normalization/types.js';
import type { Lang, ListingSource, Provider } from './types.js';
import {
  endOfZurichDay,
  fromUnixSeconds,
  normalizeEach,
  parseEnvelope,
  uniqueStrings,
} from './util.js';

/**
 * Denner — the Prediggo search API behind denner.ch (verified October 2026).
 * denner.ch publishes its current promotions and its wine shop with prices.
 * (A broader index exists, but it mixes expired and future promotions, so it is
 * not used: those prices are not valid today.)
 */
const SEARCH = 'https://www.denner.ch/search-api/simplePageContent';
const PRODUCT_API = 'https://www.denner.ch/api/product';
const SITE = 'https://www.denner.ch';
const PROMOTIONS_PAGE = 12; // "Aktionen" as shown on denner.ch
const WINE_PAGE = 14; // "Weinshop"
const PAGE_SIZE = 200;
const REGION: Record<Lang, string> = { de: 'de_CH', fr: 'fr_CH', it: 'it_CH' };
const WINE_SHOP: Record<Lang, string> = { de: 'Weinshop', fr: 'Shop des vins', it: 'Shop vini' };
// Facets that group the promotion categories, as returned by the API.
const PROMOTION_GROUPS = ['type_food', 'type_beverages', 'type_non_food'];

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
  attributeLabel: z.string().nullish(),
  options: z.array(
    z.object({ value: z.string(), label: z.string(), nbResults: z.number().nullish() }),
  ),
});

const PageResponse = z.object({
  blocks: z.object({
    searches: z.array(
      z.object({
        stats: z.object({
          totalResults: z.number(),
          currentPage: z.number(),
          totalPages: z.number(),
        }),
        facets: z.array(z.unknown()).nullish(),
        slots: z.array(z.object({ item: z.unknown() })),
      }),
    ),
  }),
});

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
  if (!id || !name) return null;

  const isWine = item.itemType === 'CONTENT_3' || itemUrl?.includes('/weinshop/') === true;
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
  const discount = cleanLabel(first('discount_text'));
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
    price,
    regularPrice: parseMoney(first('insteadPriceText')),
    loyaltyPrice: null,
    promoLabel: discount ? (/^\d+%$/.test(discount) ? `-${discount}` : discount) : null,
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

const sessionId = randomUUID();

function requestBody(
  lang: Lang,
  pageId: number,
  page: number,
  size: number,
  filters?: Record<string, number[]>,
) {
  return {
    moduleVersion: 'D2.0',
    sessionId,
    region: REGION[lang],
    advanced: { device: 'COMPUTER' },
    pageId,
    parameters: {
      refiningId: `&prd_page=${page}&prd_nbResultsPerPage=${size}`,
      ...(filters ? { filters } : {}),
    },
  };
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
    requestsPerSecond: 2,
  },

  async categories(ctx): Promise<Category[]> {
    const categories: Category[] = [];
    for (const pageId of [PROMOTIONS_PAGE, WINE_PAGE]) {
      const body = await ctx.http.postJson(SEARCH, requestBody(ctx.lang, pageId, 1, 1));
      const page = parseEnvelope(PageResponse, body, SEARCH, 'Denner listing');
      const facets = page.blocks.searches
        .flatMap((b) => b.facets ?? [])
        .flatMap((f) => {
          const parsed = Facet.safeParse(f);
          return parsed.success ? [parsed.data] : [];
        });
      const groups =
        pageId === PROMOTIONS_PAGE
          ? facets.filter((f) => PROMOTION_GROUPS.includes(f.attributeName))
          : facets.filter((f) => f.attributeName === 'wine_type').slice(0, 1);
      for (const facet of groups) {
        const groupId = pageId === WINE_PAGE ? 'wine' : facet.attributeName.replace('type_', '');
        const groupName =
          pageId === WINE_PAGE ? WINE_SHOP[ctx.lang] : (facet.attributeLabel ?? groupId);
        if (categories.some((c) => c.id === groupId)) continue;
        const total = facet.options.reduce((sum, o) => sum + (o.nbResults ?? 0), 0);
        categories.push({
          store: 'denner',
          id: groupId,
          parentId: null,
          name: groupName,
          path: [groupName],
          productCount: total,
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
      }
    }
    return categories;
  },

  sources(categories, categoryIds) {
    if (!categoryIds) {
      return [
        {
          key: 'promotions',
          label: 'Current promotions',
          params: { page: String(PROMOTIONS_PAGE) },
        },
        { key: 'wine', label: 'Wine shop', params: { page: String(WINE_PAGE) } },
      ];
    }
    return categories
      .filter((c) => categoryIds.includes(c.id))
      .map((c): ListingSource => {
        const label = c.path.join(' > ');
        if (c.id === 'wine') return { key: 'wine', label, params: { page: String(WINE_PAGE) } };
        if (c.parentId === 'wine') {
          return {
            key: `wine:${c.id}`,
            label,
            params: { page: String(WINE_PAGE), filter: 'wine_type', values: c.id },
          };
        }
        const ids =
          c.parentId === null
            ? categories.filter((x) => x.parentId === c.id).map((x) => x.id)
            : [c.id];
        return {
          key: `category:${c.id}`,
          label,
          params: { page: String(PROMOTIONS_PAGE), filter: 'category', values: ids.join(',') },
        };
      });
  },

  async fetchPage(ctx, source, cursor) {
    const page = typeof cursor === 'number' ? cursor : 1;
    const { filter, values } = source.params;
    const filters = filter && values ? { [filter]: values.split(',').map(Number) } : undefined;
    const body = await ctx.http.postJson(
      SEARCH,
      requestBody(ctx.lang, Number(source.params.page), page, PAGE_SIZE, filters),
    );
    const response = parseEnvelope(PageResponse, body, SEARCH, 'Denner listing');
    const blocks = response.blocks.searches;
    const items = blocks.flatMap((b) => b.slots.map((s) => s.item));
    const normalized = normalizeEach(items, RawSlotItem, normalizeDennerItem, ctx.debug);
    // Several blocks (weekend, week start, weekly specials) page in parallel.
    const more = blocks.some((b) => b.stats.currentPage < b.stats.totalPages);
    return {
      ...normalized,
      total: blocks.reduce((sum, b) => sum + b.stats.totalResults, 0),
      next: more && items.length > 0 ? page + 1 : null,
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
