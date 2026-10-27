import { z } from 'zod';
import { UnexpectedResponseError } from '../crawler/errors.js';
import { computeUnitPrice } from '../normalization/price.js';
import { parseQuantity } from '../normalization/quantity.js';
import { cleanLabel, nonEmpty } from '../normalization/text.js';
import type { Category, NormalizedProduct, Quantity } from '../normalization/types.js';
import type { Provider, ProviderContext } from './types.js';
import { normalizeEach, parseEnvelope, uniqueStrings, zurichDateToIso } from './util.js';

/**
 * IKEA Switzerland — the search service behind ikea.com/ch (verified October 2026).
 * Its robots.txt allows everything and it answers this tool as itself: no client id
 * of the website is needed. One listing holds the whole range; with
 * `allowGprDeduplication: false` every colour and size is its own item.
 */
const SEARCH = 'https://sik.search.blue.cdtapps.com/ch';
/** The category that lists every product. */
const ALL_PRODUCTS = 'products';
/** About 3 MB per page; the whole range (~27,000 items) takes 28 requests. */
const PAGE_SIZE = 1000;
/** "Schwedische Lebensmittel & Schwedische Getränke": the only food category. */
const FOOD_CATEGORY = 'fb001';

const PriceParts = z.object({
  wholeNumber: z.string(),
  decimals: z.string().nullish(),
});

const RawProduct = z.object({
  itemNo: z.string(),
  itemType: z.string().nullish(),
  name: z.string(),
  typeName: z.string().nullish(),
  validDesignText: z.string().nullish(),
  itemMeasureReferenceText: z.string().nullish(),
  pipUrl: z.string().nullish(),
  mainImageUrl: z.string().nullish(),
  lastChance: z.boolean().nullish(),
  lastChanceText: z.string().nullish(),
  badge: z.object({ text: z.string().nullish() }).nullish(),
  categoryPath: z.array(z.object({ key: z.string(), name: z.string() })).nullish(),
  salesPrice: z
    .object({
      numeral: z.number().nullish(),
      previous: PriceParts.nullish(),
      tag: z.string().nullish(),
      tagText: z.string().nullish(),
      discountPercentage: z.number().nullish(),
      validFrom: z.string().nullish(),
      validTo: z.string().nullish(),
      // What the price is for: "6 Stück", "0.176 kg", "kg" (per kg), "2.46 m".
      priceUnit: z.string().nullish(),
      unitText: z.string().nullish(),
    })
    .nullish(),
});
type RawProduct = z.infer<typeof RawProduct>;

const SearchAnswer = z.object({
  results: z.array(
    z.object({
      component: z.string(),
      items: z.array(z.object({ type: z.string(), product: z.unknown().optional() })).nullish(),
      filters: z
        .array(
          z.object({
            id: z.string(),
            values: z
              .array(z.object({ id: z.string(), name: z.string(), count: z.number().nullish() }))
              .nullish(),
          }),
        )
        .nullish(),
      metadata: z.object({ start: z.number(), end: z.number(), max: z.number() }).nullish(),
    }),
  ),
});
type ProductArea = z.infer<typeof SearchAnswer>['results'][number];

/** The request the website sends for a category page, sorted by name so paging is stable. */
function searchRequest(category: string, offset: number, size: number): unknown {
  return {
    searchParameters: { input: category, type: 'CATEGORY' },
    isUserLoggedIn: false,
    isB2B: false,
    components: [
      {
        component: 'PRIMARY_AREA',
        columns: 4,
        types: { main: 'PRODUCT', breakouts: [] },
        filterConfig: {},
        sort: 'NAME_ASCENDING',
        window: { size, offset },
        allVariants: false,
        allowGprDeduplication: false,
      },
    ],
  };
}

async function search(
  ctx: ProviderContext,
  category: string,
  offset: number,
  size: number,
): Promise<ProductArea & { url: string }> {
  const url = `${SEARCH}/${ctx.lang}/search`;
  const body = await ctx.http.postJson(url, searchRequest(category, offset, size));
  const answer = parseEnvelope(SearchAnswer, body, url, 'the IKEA product listing');
  const area = answer.results.find((r) => r.component === 'PRIMARY_AREA');
  if (!area) throw new UnexpectedResponseError(url, 'the IKEA listing has no products any more');
  return { ...area, url };
}

/** The top-level categories, from the category filter of the whole range. */
function parseIkeaCategories(area: ProductArea): Category[] {
  const filter = area.filters?.find((f) => f.id === 'CATEGORIES');
  return (filter?.values ?? []).map((v) => ({
    store: 'ikea',
    id: v.id,
    parentId: null,
    name: v.name,
    path: [v.name],
    productCount: v.count ?? null,
  }));
}

/** { wholeNumber: "1'099", decimals: "00" } -> 1099 */
function partsToNumber(parts: z.infer<typeof PriceParts> | null | undefined): number | null {
  if (!parts) return null;
  const value = Number(`${parts.wholeNumber.replace(/[^\d]/g, '')}.${parts.decimals || '0'}`);
  return value > 0 ? value : null;
}

/**
 * The amount the price is for. priceUnit says it when it has a number ("6 Stück",
 * "0.176 kg"); food sold "per kg" or "per l" has its weight in the size instead.
 * Other sizes are dimensions or capacities ("80x28x202 cm", a glass's "44 cl").
 */
function ikeaQuantity(raw: RawProduct): Quantity | null {
  const priceUnit = raw.salesPrice?.priceUnit;
  if (priceUnit && /\d/.test(priceUnit)) return parseQuantity(priceUnit);
  if (/^(kg|l)$/i.test(raw.salesPrice?.unitText ?? '')) {
    return parseQuantity(raw.itemMeasureReferenceText);
  }
  return null;
}

function normalizeIkeaProduct(raw: RawProduct): NormalizedProduct {
  const sales = raw.salesPrice;
  const current = sales?.numeral != null && sales.numeral > 0 ? sales.numeral : null;
  const previous = partsToNumber(sales?.previous);
  // The IKEA Family price is for members; the "normal price" is what everyone pays.
  const family = sales?.tag === 'FAMILY_PRICE';
  const price = family ? previous : current;
  const reduced = !family && previous != null && current != null && previous > current;
  const promoLabel = family
    ? (cleanLabel(sales?.tagText) ?? 'IKEA Family')
    : reduced
      ? (cleanLabel(sales?.tagText) ??
        `-${Math.round(sales?.discountPercentage ?? (1 - (current ?? 0) / previous) * 100)}%`)
      : null;
  const quantity = ikeaQuantity(raw);
  const unit = computeUnitPrice(price, quantity);
  const measure = nonEmpty(raw.itemMeasureReferenceText);
  // A count says how many come at this price ("6 Stück"); a weight repeats the size.
  const priceUnit = /\d/.test(sales?.priceUnit ?? '') ? nonEmpty(sales?.priceUnit) : null;
  const count = priceUnit && quantity?.unit === 'piece' && quantity.amount > 1 ? priceUnit : null;
  const path = (raw.categoryPath ?? []).map((c) => c.name);
  const food = raw.categoryPath?.[0]?.key === FOOD_CATEGORY;
  return {
    store: 'ikea',
    storeProductId: raw.itemNo,
    // As on the product page: "GLOSTAD 3er-Sofa, Knisa dunkelgrau".
    name: [[raw.name, raw.typeName].filter(Boolean).join(' '), nonEmpty(raw.validDesignText)]
      .filter(Boolean)
      .join(', '),
    // The Swedish food market also sells other brands (Arla, Ahlgrens, ...).
    brand: food ? null : 'IKEA',
    categoryPath: path,
    sizeText: uniqueStrings([measure ?? priceUnit, measure ? count : null]).join(', ') || null,
    quantity,
    price,
    regularPrice: reduced ? previous : null,
    loyaltyPrice: family ? current : null,
    promoLabel,
    validFrom: promoLabel ? zurichDateToIso(sales?.validFrom) : null,
    validUntil: promoLabel ? zurichDateToIso(sales?.validTo, true) : null,
    unitPrice: unit?.unitPrice ?? null,
    unitPriceBasis: unit?.unitPriceBasis ?? null,
    labels: uniqueStrings([
      raw.badge?.text,
      sales?.tag === 'NEW_PRODUCT' ? sales.tagText : null,
      raw.lastChance ? raw.lastChanceText : null,
    ]),
    url: nonEmpty(raw.pipUrl),
    imageUrl: nonEmpty(raw.mainImageUrl),
    sourceRef: raw.itemType ? { itemType: raw.itemType } : {},
  };
}

export const ikea: Provider = {
  info: {
    id: 'ikea',
    name: 'IKEA',
    website: 'https://www.ikea.com/ch/',
    coverage:
      'The whole IKEA Switzerland range, every colour and size (about 27,000 items): furniture, ' +
      'kitchens, textiles, decoration and the Swedish food market. A full fetch takes about 30 seconds.',
    rotating: false,
    verified: true,
    searchExample: 'billy',
    requestsPerSecond: 1,
  },

  async categories(ctx): Promise<Category[]> {
    const area = await search(ctx, ALL_PRODUCTS, 0, 1);
    const categories = parseIkeaCategories(area);
    if (categories.length === 0) {
      throw new UnexpectedResponseError(area.url, 'the IKEA range no longer lists its categories');
    }
    return categories;
  },

  sources(categories, categoryIds) {
    if (!categoryIds) {
      return [{ key: 'all', label: 'All products', params: { category: ALL_PRODUCTS } }];
    }
    return categories
      .filter((c) => categoryIds.includes(c.id))
      .map((c) => ({
        key: `category:${c.id}`,
        label: c.path.join(' > '),
        params: { category: c.id },
      }));
  },

  async fetchPage(ctx, source, cursor) {
    const offset = typeof cursor === 'number' ? cursor : 0;
    const area = await search(ctx, source.params.category ?? ALL_PRODUCTS, offset, PAGE_SIZE);
    const items = (area.items ?? []).filter((i) => i.type === 'PRODUCT').map((i) => i.product);
    const { products, skipped } = normalizeEach(items, RawProduct, normalizeIkeaProduct, ctx.debug);
    const end = area.metadata?.end ?? offset;
    const total = area.metadata?.max ?? null;
    const next = end > offset && total != null && end < total ? end : null;
    return { products, skipped, total, next };
  },

  isFood: (category) => category.id === FOOD_CATEGORY,
};
