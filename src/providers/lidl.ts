import { z } from 'zod';
import { nextOffset } from '../crawler/pagination.js';
import { computeUnitPrice, parseComparisonPrice, parseMoney } from '../normalization/price.js';
import { parseQuantity } from '../normalization/quantity.js';
import { cleanLabel, htmlListItems, nonEmpty } from '../normalization/text.js';
import type { Category, NormalizedProduct } from '../normalization/types.js';
import { flattenTree, type TreeNode } from './categories.js';
import type { Lang, Provider } from './types.js';
import { fromUnixSeconds, normalizeEach, parseEnvelope, uniqueStrings } from './util.js';

/**
 * Lidl Suisse — the search API behind lidl.ch (verified October 2026).
 * lidl.ch publishes its current weekly offers and online-shop items, not the
 * permanent food assortment, so this catalog changes every week.
 */
const SEARCH = 'https://www.lidl.ch/q/api/search';
const SITE = 'https://www.lidl.ch';
const LOCALE: Record<Lang, string> = { de: 'de_CH', fr: 'fr_CH', it: 'it_CH' };
// Larger fetch sizes are silently capped at 60 by the API.
const PAGE_SIZE = 60;

function searchUrl(
  lang: Lang,
  offset: number,
  size: number,
  extra: Record<string, string> = {},
): string {
  const params = new URLSearchParams({
    assortment: 'CH',
    locale: LOCALE[lang],
    version: 'v2.0.0',
    fetchsize: String(size),
    offset: String(offset),
    q: '*',
    ...extra,
  });
  return `${SEARCH}?${params}`;
}

interface RawFacetValue {
  value: string;
  label: string;
  count?: number | null;
  children?: RawFacetValue[] | null;
}
const RawFacetValue: z.ZodType<RawFacetValue> = z.object({
  value: z.string(),
  label: z.string(),
  count: z.number().nullish(),
  get children() {
    return z.array(RawFacetValue).nullish();
  },
});

const RawPrice = z.object({
  price: z.number().nullish(),
  oldPrice: z.number().nullish(),
  discount: z
    .object({ discountText: z.string().nullish(), deletedPrice: z.number().nullish() })
    .nullish(),
});

const RawItem = z.object({
  code: z.string(),
  gridbox: z.object({
    data: z.object({
      productId: z.number().nullish(),
      title: z.string().nullish(),
      fullTitle: z.string().nullish(),
      brand: z.object({ name: z.string().nullish() }).nullish(),
      canonicalUrl: z.string().nullish(),
      image: z.string().nullish(),
      keyfacts: z
        .object({ description: z.string().nullish(), wonCategoryPrimary: z.string().nullish() })
        .nullish(),
      price: RawPrice.nullish(),
      lidlPlus: z
        .array(
          z.object({
            price: RawPrice.nullish(),
            highlightText: z.string().nullish(),
            lidlPlusText: z.string().nullish(),
          }),
        )
        .nullish(),
      seals: z.array(z.object({ altText: z.string().nullish() })).nullish(),
      stockAvailability: z
        .object({
          badgeInfoV2: z
            .array(z.object({ validFrom: z.number().nullish(), validUntil: z.number().nullish() }))
            .nullish(),
        })
        .nullish(),
      storeStartDate: z.number().nullish(),
      storeEndDate: z.number().nullish(),
    }),
  }),
});
type RawItem = z.infer<typeof RawItem>;

const SearchResponse = z.object({
  numFound: z.number(),
  items: z.array(z.unknown()),
  facets: z.array(z.object({ code: z.string(), values: z.array(z.unknown()).nullish() })).nullish(),
});

/**
 * Seals are certifications ("Schweizer Qualität", "Vegan-Label") but also care
 * pictograms for plants, described in a sentence ("Halbschattiges Sonnensymbol für…").
 * Only the short certification names are kept as labels.
 */
function sealName(altText: string | null | undefined): string | null {
  const name = altText?.trim().replace(/\.$/, '');
  if (!name || name.split(/\s+/).length > 4 || /symbol|pfeil|piktogramm/i.test(name)) return null;
  return name;
}

/** "Bedürfniswelten/Food und Near Food/Milch & Sahne" -> ["Food und Near Food", "Milch & Sahne"]. */
function categoryPath(path: string | null | undefined): string[] {
  if (!path) return [];
  const parts = path.split('/').slice(1); // the first level is Lidl's internal root
  return parts.some((p) => /WoN Nav/i.test(p)) ? [] : parts.map((p) => p.trim()).filter(Boolean);
}

export function normalizeLidlItem(raw: RawItem): NormalizedProduct | null {
  const g = raw.gridbox.data;
  const name = nonEmpty(g.title) ?? nonEmpty(g.fullTitle);
  if (!name) return null;

  const facts = htmlListItems(g.keyfacts?.description);
  const sizeLine =
    facts.find((line) => /^(pro|par|per)\s/i.test(line)) ??
    facts.find((line) => !line.includes('=') && parseQuantity(line) !== null) ??
    null;
  const quantity = parseQuantity(sizeLine);

  // Lidl Plus items show the app price; the price without the app is the "old" price.
  const plus = g.lidlPlus?.[0] ?? null;
  const price =
    parseMoney(g.price?.price) ??
    parseMoney(plus?.price?.oldPrice) ??
    parseMoney(plus?.price?.discount?.deletedPrice);
  // oldPrice is 0.0 when there is no reduction; parseMoney treats 0 as "none".
  const regularPrice = parseMoney(g.price?.oldPrice) ?? parseMoney(g.price?.discount?.deletedPrice);
  const loyaltyPrice = plus ? parseMoney(plus.price?.price) : null;
  const plusLabel = plus
    ? uniqueStrings([plus.highlightText, plus.lidlPlusText ?? 'Lidl Plus']).join(' ')
    : null;
  const unit =
    computeUnitPrice(price, quantity) ??
    parseComparisonPrice(facts.find((line) => line.includes('=')));
  const window = g.stockAvailability?.badgeInfoV2?.[0];

  return {
    store: 'lidl',
    storeProductId: String(g.productId ?? raw.code),
    name,
    brand: nonEmpty(g.brand?.name),
    categoryPath: categoryPath(g.keyfacts?.wonCategoryPrimary),
    sizeText: sizeLine?.replace(/^(pro|par|per)\s+/i, '') ?? null,
    quantity,
    price,
    regularPrice,
    loyaltyPrice,
    promoLabel: cleanLabel(g.price?.discount?.discountText) ?? cleanLabel(plusLabel),
    validFrom: fromUnixSeconds(window?.validFrom ?? g.storeStartDate),
    validUntil: fromUnixSeconds(window?.validUntil ?? g.storeEndDate),
    unitPrice: price != null ? (unit?.unitPrice ?? null) : null,
    unitPriceBasis: price != null ? (unit?.unitPriceBasis ?? null) : null,
    labels: uniqueStrings((g.seals ?? []).map((s) => sealName(s.altText))),
    url: g.canonicalUrl ? `${SITE}${g.canonicalUrl}` : null,
    imageUrl: nonEmpty(g.image),
    sourceRef: {},
  };
}

function toNode(value: RawFacetValue): TreeNode {
  return {
    id: value.value,
    name: value.label,
    count: value.count ?? null,
    children: (value.children ?? []).map(toNode),
  };
}

export const lidl: Provider = {
  info: {
    id: 'lidl',
    name: 'Lidl Suisse',
    website: 'https://www.lidl.ch',
    coverage:
      'Current weekly offers and online-shop items only (about 750, changing every week). ' +
      'lidl.ch does not publish its permanent food assortment.',
    rotating: true,
    verified: true,
    requestsPerSecond: 2,
  },

  async categories(ctx): Promise<Category[]> {
    const url = searchUrl(ctx.lang, 0, 1);
    const page = parseEnvelope(SearchResponse, await ctx.http.getJson(url), url, 'Lidl search');
    const facet = page.facets?.find((f) => f.code === 'category');
    const values = (facet?.values ?? []).flatMap((v) => {
      const parsed = RawFacetValue.safeParse(v);
      return parsed.success ? [toNode(parsed.data)] : [];
    });
    return flattenTree('lidl', values);
  },

  sources(categories, categoryIds) {
    if (!categoryIds) return [{ key: 'all', label: 'All products', params: {} }];
    return categories
      .filter((c) => categoryIds.includes(c.id))
      .map((c) => ({
        key: `category:${c.id}`,
        label: c.path.join(' > '),
        params: { 'category.id': c.id },
      }));
  },

  async fetchPage(ctx, source, cursor) {
    const offset = typeof cursor === 'number' ? cursor : 0;
    const url = searchUrl(ctx.lang, offset, PAGE_SIZE, source.params);
    const page = parseEnvelope(SearchResponse, await ctx.http.getJson(url), url, 'Lidl search');
    // Results can include non-product entries (teasers); only products are kept.
    const isProduct = (item: unknown) => {
      const kind = (item as { resultClass?: unknown } | null)?.resultClass;
      return kind === undefined || kind === 'product';
    };
    const normalized = normalizeEach(
      page.items.filter(isProduct),
      RawItem,
      normalizeLidlItem,
      ctx.debug,
    );
    return {
      ...normalized,
      total: page.numFound,
      next: nextOffset(offset, page.items.length, page.numFound),
    };
  },

  isFood: (category) => category.id === '10068374', // "Essen & Trinken"
};
