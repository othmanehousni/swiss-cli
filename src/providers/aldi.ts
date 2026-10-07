import { z } from 'zod';
import { nextOffset } from '../crawler/pagination.js';
import { computeUnitPrice, parseComparisonPrice, parseMoney } from '../normalization/price.js';
import { parseQuantity } from '../normalization/quantity.js';
import { cleanText, nonEmpty } from '../normalization/text.js';
import type { Category, NormalizedProduct, ProductDetails } from '../normalization/types.js';
import { flattenTree, isFoodByName, type TreeNode } from './categories.js';
import type { Lang, Provider, ProviderContext } from './types.js';
import { normalizeEach, parseEnvelope, uniqueStrings, zurichDateToIso } from './util.js';

/**
 * Aldi Suisse — the JSON API behind aldi-suisse.ch (verified October 2026).
 * Flow: category tree -> paginated product search per category -> product details.
 */
const API = 'https://api.aldi-suisse.ch';
const SITE = 'https://www.aldi-suisse.ch';
// The store aldi-suisse.ch uses for visitors who did not pick one. Shelf prices
// are national, so the choice of store does not change them.
const SERVICE = 'serviceType=walk-in&servicePoint=E172';
// The API only accepts 12, 16, 24, 30, 32, 48 or 60.
const PAGE_SIZE = 60;
const PRODUCT_PATH: Record<Lang, string> = { de: 'produkt', fr: 'produit', it: 'prodotto' };
const ACCEPT_LANGUAGE: Record<Lang, string> = { de: 'de-CH', fr: 'fr-CH', it: 'it-CH' };
const SPECIAL_BUYS_CATEGORY = '1588161418433031'; // "Aktionen": weekly non-food special buys

interface RawCategory {
  key: string;
  name: string;
  children?: RawCategory[] | null;
}
const RawCategory: z.ZodType<RawCategory> = z.object({
  key: z.string(),
  name: z.string(),
  get children() {
    return z.array(RawCategory).nullish();
  },
});

const RawProduct = z.object({
  sku: z.string(),
  name: z.string(),
  brandName: z.string().nullish(),
  urlSlugText: z.string().nullish(),
  discontinued: z.boolean().nullish(),
  sellingSize: z.string().nullish(),
  onSaleDate: z.string().nullish(),
  price: z
    .object({
      amount: z.number().nullish(), // in Rappen (cents)
      amountRelevant: z.number().nullish(),
      comparisonDisplay: z.string().nullish(),
      wasPriceDisplay: z.string().nullish(),
    })
    .nullish(),
  categories: z.array(z.object({ id: z.string(), name: z.string() })).nullish(),
  assets: z.array(z.object({ url: z.string() })).nullish(),
  badges: z
    .array(
      z.object({
        items: z.array(z.object({ displayText: z.string().nullish(), alt: z.string().nullish() })),
      }),
    )
    .nullish(),
});
type RawProduct = z.infer<typeof RawProduct>;

const RawDetails = z.object({
  description: z.string().nullish(),
  countryOrigin: z.string().nullish(),
  storageInstructions: z.string().nullish(),
  usageInstructions: z.string().nullish(),
  ingredients: z.string().nullish(),
  allergens: z.array(z.unknown()).nullish(),
  warnings: z.string().nullish(),
});

const SearchResponse = z.object({
  meta: z.object({ pagination: z.object({ totalCount: z.number() }) }),
  data: z.array(z.unknown()),
});

function categoryPath(raw: RawProduct): string[] {
  const [first, ...rest] = raw.categories ?? [];
  if (!first) return [];
  // Child ids extend their parent's id; keep the first branch only.
  return [first.name, ...rest.filter((c) => c.id.startsWith(first.id)).map((c) => c.name)];
}

export function normalizeAldiProduct(raw: RawProduct, lang: Lang): NormalizedProduct | null {
  if (raw.discontinued) return null;
  const cents = raw.price?.amountRelevant ?? raw.price?.amount ?? null;
  const price = cents && cents > 0 ? cents / 100 : null;
  const regularPrice = parseMoney(raw.price?.wasPriceDisplay);
  const quantity = parseQuantity(raw.sellingSize);
  const unit =
    computeUnitPrice(price, quantity) ?? parseComparisonPrice(raw.price?.comparisonDisplay);
  const slug = raw.urlSlugText ?? 'produkt';
  const discount =
    price && regularPrice && regularPrice > price
      ? Math.round((1 - price / regularPrice) * 100)
      : null;

  return {
    store: 'aldi',
    // SKUs are zero-padded to 18 digits ("000000000000288415"); keep the readable number.
    storeProductId: raw.sku.replace(/^0+(?=\d)/, ''),
    name: raw.name.trim(),
    brand: nonEmpty(raw.brandName),
    categoryPath: categoryPath(raw),
    sizeText: nonEmpty(raw.sellingSize),
    quantity,
    price,
    regularPrice,
    loyaltyPrice: null,
    promoLabel: discount ? `-${discount}%` : null,
    // Special buys show "available from <date>"; that is when this price starts to apply.
    validFrom: zurichDateToIso(raw.onSaleDate),
    validUntil: null,
    unitPrice: price != null ? (unit?.unitPrice ?? null) : null,
    unitPriceBasis: price != null ? (unit?.unitPriceBasis ?? null) : null,
    labels: uniqueStrings(
      (raw.badges ?? []).flatMap((b) => b.items.map((i) => i.displayText ?? null)),
    ),
    url: `${SITE}/${lang}/${PRODUCT_PATH[lang]}/${slug}-${raw.sku}`,
    imageUrl: raw.assets?.[0]?.url.replace('{width}', '500').replace('{slug}', slug) ?? null,
    sourceRef: { sku: raw.sku },
  };
}

export const aldi: Provider = {
  info: {
    id: 'aldi',
    name: 'Aldi Suisse',
    website: 'https://www.aldi-suisse.ch',
    coverage: 'Full regular assortment plus current special buys (about 2,300 products).',
    rotating: false,
    verified: true,
    requestsPerSecond: 2,
  },

  async categories(ctx: ProviderContext): Promise<Category[]> {
    const url = `${API}/v2/product-category-tree?${SERVICE}`;
    const body = await ctx.http.getJson(url, {
      headers: { 'Accept-Language': ACCEPT_LANGUAGE[ctx.lang] },
    });
    const tree = parseEnvelope(
      z.object({ data: z.array(RawCategory) }),
      body,
      url,
      'Aldi category tree',
    );
    const toNode = (c: RawCategory): TreeNode => ({
      id: c.key,
      name: c.name,
      children: (c.children ?? []).map(toNode),
    });
    return flattenTree('aldi', tree.data.map(toNode));
  },

  sources(categories, categoryIds) {
    const picked = categoryIds
      ? categories.filter((c) => categoryIds.includes(c.id))
      : categories.filter((c) => c.parentId === null);
    // Top-level categories include their sub-categories' products.
    return picked.map((c) => ({
      key: `category:${c.id}`,
      label: c.path.join(' > '),
      params: { categoryKey: c.id },
    }));
  },

  async fetchPage(ctx, source, cursor) {
    const offset = typeof cursor === 'number' ? cursor : 0;
    const url =
      `${API}/v3/product-search?currency=CHF&${SERVICE}&categoryKey=${encodeURIComponent(source.params.categoryKey ?? '')}` +
      `&limit=${PAGE_SIZE}&offset=${offset}`;
    const body = await ctx.http.getJson(url, {
      headers: { 'Accept-Language': ACCEPT_LANGUAGE[ctx.lang] },
    });
    const page = parseEnvelope(SearchResponse, body, url, 'Aldi product listing');
    const { products, skipped } = normalizeEach(
      page.data,
      RawProduct,
      (raw) => normalizeAldiProduct(raw, ctx.lang),
      ctx.debug,
    );
    const total = page.meta.pagination.totalCount;
    return { products, skipped, total, next: nextOffset(offset, page.data.length, total) };
  },

  async fetchDetails(ctx, request): Promise<ProductDetails | null> {
    const sku = request.sourceRef.sku ?? request.storeProductId.padStart(18, '0');
    const url = `${API}/v2/products/${encodeURIComponent(sku)}?${SERVICE}`;
    const body = await ctx.http.getJson(url, {
      headers: { 'Accept-Language': ACCEPT_LANGUAGE[ctx.lang] },
    });
    const raw = parseEnvelope(
      z.object({ data: RawDetails }),
      body,
      url,
      'Aldi product details',
    ).data;
    const allergens = uniqueStrings(
      (raw.allergens ?? []).map((a) =>
        typeof a === 'string'
          ? a
          : typeof a === 'object' && a && 'name' in a
            ? String(a.name)
            : null,
      ),
    );
    return {
      description: cleanText(raw.description),
      ingredients: cleanText(raw.ingredients),
      ...(allergens.length > 0 ? { allergens } : {}),
      origin: nonEmpty(raw.countryOrigin),
      storage: cleanText(raw.storageInstructions),
      usage: cleanText(raw.usageInstructions),
      ...(raw.warnings ? { extra: { warnings: cleanText(raw.warnings) ?? '' } } : {}),
    };
  },

  isFood: (category) => category.id !== SPECIAL_BUYS_CATEGORY && isFoodByName(category),
};
