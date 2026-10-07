import { z } from 'zod';
import { HttpError } from '../crawler/errors.js';
import { computeUnitPrice, parseMoney } from '../normalization/price.js';
import { parseQuantity } from '../normalization/quantity.js';
import { cleanLabel, cleanText, nonEmpty } from '../normalization/text.js';
import type { Category, NormalizedProduct, ProductDetails } from '../normalization/types.js';
import type { Lang, Provider, ProviderContext } from './types.js';
import { normalizeEach, parseEnvelope, uniqueStrings } from './util.js';

/**
 * Coop — the SAP Commerce (Hybris) REST API used by coop.ch and the Coop app
 * (verified October 2026). The coop.ch web pages sit behind DataDome bot
 * protection; this REST API answered normally. If DataDome blocks it from your
 * connection, swiss-grocery stops and explains instead of trying to get around it.
 *
 * Flow: department listings (names, sub-categories) -> paginated products -> details.
 */
const BASE = 'https://www.coop.ch/rest/v2/coopathome';
const SITE = 'https://www.coop.ch';
const GROCERIES = 'supermarket'; // "Lebensmittel": every food and drink product
const WINE = 'm_0222'; // "Weine": the wine shop (separate from groceries)
// Grocery departments (children of "supermarket"). Frozen food, ready meals and
// special diets have no known code yet: they are still covered by a full fetch.
const DEPARTMENTS = ['m_0001', 'm_0055', 'm_0087', 'm_0115', 'm_0140', 'm_2242', 'm_2506'];
const PAGE_SIZE = 100;
// The default "relevance" order is re-ranked while a crawl pages through the
// catalog, which skips some products and repeats others; alphabetical is stable.

const RawProduct = z.object({
  code: z.string(),
  title: z.string().nullish(),
  name: z.string().nullish(),
  originText: z.string().nullish(), // the brand, e.g. "Naturaplan", "Evian"
  price: z.object({ value: z.number().nullish() }).nullish(),
  originalPrice: z.object({ value: z.number().nullish() }).nullish(), // only during promotions
  content: z.union([z.string(), z.number()]).nullish(),
  contentUnit: z.string().nullish(),
  images: z.array(z.object({ url: z.string().nullish() })).nullish(),
  labels: z.array(z.object({ name: z.string().nullish() })).nullish(),
  primaryCategory: z.object({ name: z.string().nullish() }).nullish(),
  hasPromotion: z.boolean().nullish(),
  listPromotions: z.array(z.string()).nullish(), // e.g. ["40%"], ["40% ab 2"]
  vegan: z.boolean().nullish(),
  vegetarian: z.boolean().nullish(),
  glutenFree: z.boolean().nullish(),
  lactoseFree: z.boolean().nullish(),
});
type RawProduct = z.infer<typeof RawProduct>;

const ListingResponse = z.object({
  categoryName: z.string().nullish(),
  products: z.array(z.unknown()).nullish(),
  categories: z
    .array(z.object({ id: z.string().nullish(), code: z.string().nullish(), name: z.string() }))
    .nullish(),
  pagination: z.object({
    currentPage: z.number(),
    totalPages: z.number(),
    totalResults: z.number().nullish(),
  }),
});

const RawDetails = z.object({
  description: z.string().nullish(),
  ingredients: z.string().nullish(),
  ean: z.string().nullish(),
  originCountries: z.array(z.string()).nullish(),
  storageInformation: z.string().nullish(),
  regulatedProductName: z.string().nullish(),
  ecoScore: z.string().nullish(),
  averageRating: z.number().nullish(),
  numberOfRatings: z.number().nullish(),
  nutritionInformation: z
    .object({
      nutritionInformationPerUnit: z
        .object({
          description: z.string().nullish(),
          nutrients: z
            .array(z.object({ name: z.string(), assembledValue: z.string().nullish() }))
            .nullish(),
        })
        .nullish(),
    })
    .nullish(),
});

const UNIT_NAMES: Record<string, string> = { ST: 'Stück' };
const TITLE_SIZE = /(\d+\s*x\s*)?\d+(?:[.,]\d+)?\s*(?:kg|g|l|dl|cl|ml)\.?\s*$/i;

function listingUrl(category: string, lang: Lang, page: number, pageSize: number): string {
  return (
    `${BASE}/products/category/${encodeURIComponent(category)}` +
    `?currentPage=${page}&pageSize=${pageSize}&query=availableOnline:false&sort=name-asc&language=${lang}`
  );
}

async function listing(ctx: ProviderContext, category: string, page: number, pageSize: number) {
  const url = listingUrl(category, ctx.lang, page, pageSize);
  return parseEnvelope(ListingResponse, await ctx.http.getJson(url), url, 'Coop listing');
}

export function normalizeCoopProduct(raw: RawProduct, lang: Lang = 'de'): NormalizedProduct | null {
  const name = nonEmpty(raw.title) ?? nonEmpty(raw.name);
  if (!name) return null;
  const price = parseMoney(raw.price?.value);
  const unitWord = raw.contentUnit ? (UNIT_NAMES[raw.contentUnit] ?? raw.contentUnit) : '';
  const content =
    raw.content != null && raw.content !== '' ? `${raw.content} ${unitWord}`.trim() : null;
  const contentQuantity = parseQuantity(content);
  // Titles often end with the pack format ("6x1,5l"), which says more than the total ("9 l").
  const titleSize = TITLE_SIZE.exec(name)?.[0].trim() ?? null;
  const titleQuantity = parseQuantity(titleSize);
  const titleAgrees =
    titleQuantity !== null &&
    (contentQuantity === null ||
      (titleQuantity.unit === contentQuantity.unit &&
        Math.abs(titleQuantity.amount - contentQuantity.amount) <= contentQuantity.amount * 0.01));
  const sizeText = titleAgrees ? titleSize : content;
  const quantity = titleAgrees ? titleQuantity : contentQuantity;
  const unit = computeUnitPrice(price, quantity);
  const promos = (raw.listPromotions ?? []).map((p) => (/^\d+\s*%/.test(p) ? `-${p}` : p));
  return {
    store: 'coop',
    storeProductId: raw.code,
    name,
    brand: nonEmpty(raw.originText),
    categoryPath: uniqueStrings([raw.primaryCategory?.name]),
    sizeText,
    quantity,
    price,
    // A conditional promotion ("40% ab 2") keeps the regular shelf price.
    regularPrice: parseMoney(raw.originalPrice?.value),
    loyaltyPrice: null,
    promoLabel: cleanLabel(promos.join(' · ')) ?? (raw.hasPromotion ? 'Aktion' : null),
    validFrom: null,
    validUntil: null,
    unitPrice: unit?.unitPrice ?? null,
    unitPriceBasis: unit?.unitPriceBasis ?? null,
    labels: uniqueStrings([
      ...(raw.labels ?? []).map((l) => l.name),
      raw.vegan ? 'Vegan' : null,
      raw.vegetarian ? 'Vegetarisch' : null,
      raw.glutenFree ? 'Glutenfrei' : null,
      raw.lactoseFree ? 'Laktosefrei' : null,
    ]),
    url: `${SITE}/${lang}/p/${raw.code}`,
    imageUrl: nonEmpty(raw.images?.[0]?.url),
    sourceRef: {},
  };
}

/** Coop prints allergens in bold capitals inside the ingredient list. */
function allergensFrom(ingredients: string | null | undefined): string[] {
  const bold = [...(ingredients ?? '').matchAll(/<b>([^<]+)<\/b>/gi)].map((m) => cleanText(m[1]));
  return uniqueStrings(
    bold.map((a) => (a ? a.charAt(0).toUpperCase() + a.slice(1).toLowerCase() : null)),
  );
}

export const coop: Provider = {
  info: {
    id: 'coop',
    name: 'Coop',
    website: 'https://www.coop.ch',
    coverage:
      'Full online supermarket: groceries (about 11,000 products) and the wine shop (about 5,000 wines).',
    rotating: false,
    verified: true,
    requestsPerSecond: 1,
  },

  async categories(ctx): Promise<Category[]> {
    const categories: Category[] = [];
    const add = async (code: string, parent: Category | null, withChildren: boolean) => {
      const page = await listing(ctx, code, 0, 1);
      const name = nonEmpty(page.categoryName) ?? code;
      const category: Category = {
        store: 'coop',
        id: code,
        parentId: parent?.id ?? null,
        name,
        path: [...(parent?.path ?? []), name],
        productCount: page.pagination.totalResults ?? null,
      };
      categories.push(category);
      if (!withChildren) return category;
      for (const child of page.categories ?? []) {
        const id = child.id ?? child.code;
        if (!id) continue;
        categories.push({
          store: 'coop',
          id,
          parentId: code,
          name: child.name,
          path: [...category.path, child.name],
          productCount: null,
        });
      }
      return category;
    };
    const groceries = await add(GROCERIES, null, false);
    for (const code of DEPARTMENTS) await add(code, groceries, true);
    await add(WINE, null, true);
    return categories;
  },

  sources(categories, categoryIds) {
    const picked = categoryIds
      ? categories.filter((c) => categoryIds.includes(c.id))
      : categories.filter((c) => c.parentId === null);
    return picked.map((c) => ({
      key: `category:${c.id}`,
      label: c.path.join(' > '),
      params: { category: c.id },
    }));
  },

  async fetchPage(ctx, source, cursor) {
    const page = typeof cursor === 'number' ? cursor : 0;
    const result = await listing(ctx, source.params.category ?? GROCERIES, page, PAGE_SIZE);
    const products = result.products ?? [];
    const normalized = normalizeEach(
      products,
      RawProduct,
      (raw) => normalizeCoopProduct(raw, ctx.lang),
      ctx.debug,
    );
    const { currentPage, totalPages, totalResults } = result.pagination;
    return {
      ...normalized,
      total: totalResults ?? null,
      next: currentPage + 1 < totalPages && products.length > 0 ? currentPage + 1 : null,
    };
  },

  async isStillListed(ctx, request) {
    try {
      await ctx.http.getJson(
        `${BASE}/products/${encodeURIComponent(request.storeProductId)}?language=${ctx.lang}`,
      );
      return true;
    } catch (error) {
      // Coop answers 404 "ProductNotFoundError" for products it no longer has.
      if (error instanceof HttpError && error.status === 404) return false;
      throw error;
    }
  },

  async fetchDetails(ctx, request): Promise<ProductDetails | null> {
    const url = `${BASE}/products/${encodeURIComponent(request.storeProductId)}?language=${ctx.lang}`;
    const raw = parseEnvelope(RawDetails, await ctx.http.getJson(url), url, 'Coop product');
    const perUnit = raw.nutritionInformation?.nutritionInformationPerUnit;
    const nutrition: Record<string, string> = {};
    let energy = 0;
    for (const n of perUnit?.nutrients ?? []) {
      if (!n.assembledValue) continue;
      // Energy is listed twice without units: kJ first, then kcal.
      const name = n.name === 'Energie' ? `Energie (${energy++ === 0 ? 'kJ' : 'kcal'})` : n.name;
      nutrition[name] = n.assembledValue;
    }
    const allergens = allergensFrom(raw.ingredients);
    const extra: Record<string, string> = {};
    if (perUnit?.description && Object.keys(nutrition).length > 0)
      extra.nutritionPer = perUnit.description;
    if (raw.regulatedProductName) extra.legalName = raw.regulatedProductName;
    if (raw.ecoScore) extra.ecoScore = raw.ecoScore;
    return {
      description: cleanText(raw.description),
      ingredients: cleanText(raw.ingredients),
      ...(allergens.length > 0 ? { allergens } : {}),
      ...(Object.keys(nutrition).length > 0 ? { nutrition } : {}),
      origin: (raw.originCountries ?? []).join(', ') || null,
      storage: cleanText(raw.storageInformation),
      gtin: nonEmpty(raw.ean),
      rating:
        raw.averageRating != null && raw.numberOfRatings
          ? { average: raw.averageRating, count: raw.numberOfRatings }
          : null,
      ...(Object.keys(extra).length > 0 ? { extra } : {}),
    };
  },
};
