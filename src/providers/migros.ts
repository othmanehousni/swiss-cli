import { z } from 'zod';
import { HttpError, UnexpectedResponseError } from '../crawler/errors.js';
import { nextOffset } from '../crawler/pagination.js';
import { computeUnitPrice, parseMoney, unitPriceFrom } from '../normalization/price.js';
import { parseQuantity } from '../normalization/quantity.js';
import { cleanLabel, cleanText, nonEmpty } from '../normalization/text.js';
import type { Category, NormalizedProduct, ProductDetails } from '../normalization/types.js';
import { flattenTree, type TreeNode } from './categories.js';
import type { Provider, ProviderContext } from './types.js';
import { normalizeEach, parseEnvelope, uniqueStrings, zurichDateToIso } from './util.js';

/**
 * Migros — the JSON APIs behind migros.ch.
 *
 * Verified October 2026 from a home connection (migros.ch blocks many cloud networks,
 * including the one this tool is built on). The breadcrumb, category search and product
 * cards requests are the ones the migros.ch website makes (seen in a browser in
 * October 2026); they replaced the onesearch storemap and category search, which
 * now answer 404. The website's own category list sits under /shopping-list, which
 * robots.txt closes to tools, so the categories come from the sitemap instead.
 * The product fields follow migros-api-wrapper (MIT, github.com/aliyss/migros-api-wrapper).
 *
 * Flow: sitemap (category pages) -> breadcrumb (id and names of each top-level
 * category) -> category search (its subcategories; then its product uids, 100 at
 * a time) -> product cards (name, price), 100 per request -> product detail (optional).
 */
const BASE = 'https://www.migros.ch';
const GUEST_TOKEN = `${BASE}/authentication/public/v1/api/guest?authorizationNotRequired=true`;
const SITEMAP = `${BASE}/sitemap.xml`;
const BREADCRUMB = `${BASE}/product-display/public/v1/categories-breadcrumb`;
const PRODUCT_CARDS = `${BASE}/product-display/public/v4/product-cards`;
const PRODUCT_DETAIL = `${BASE}/product-display/public/v2/product-detail`;
/** The website asks for 100 products per page and per product-cards request. */
const PAGE_SIZE = 100;
const CARDS_PER_REQUEST = 100;

function categorySearchUrl(categoryId: string): string {
  return `${BASE}/product-display/public/web/v1/products/category/${encodeURIComponent(categoryId)}/search`;
}

/** Price region: "national" or a cooperative such as "gmz" (Zürich) or "gmaa" (Aare). */
function region(): string {
  return process.env.SWISS_GROCERY_MIGROS_REGION?.trim() || 'national';
}

function today(): string {
  return `${new Date().toISOString().slice(0, 10)}T00:00:00`;
}

let guestToken: Promise<string> | null = null;

async function token(ctx: ProviderContext): Promise<string> {
  guestToken ??= ctx.http.request(GUEST_TOKEN).then((response) => {
    const value = response.headers.get('leshopch');
    if (!value) throw new Error('Migros did not return a guest token (leshopch header missing)');
    return value;
  });
  try {
    return await guestToken;
  } catch (error) {
    guestToken = null;
    throw error;
  }
}

/** Calls a Migros API with a guest token, renewing it once if it expired. */
async function call<T>(
  ctx: ProviderContext,
  run: (headers: Record<string, string>) => Promise<T>,
): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    const headers = {
      leshopch: await token(ctx),
      'migros-language': ctx.lang,
      'Accept-Language': ctx.lang,
    };
    try {
      return await run(headers);
    } catch (error) {
      if (attempt === 1 && error instanceof HttpError && error.status === 401) {
        guestToken = null;
        continue;
      }
      throw error;
    }
  }
}

const RawProduct = z.object({
  uid: z.union([z.number(), z.string()]).nullish(),
  migrosId: z.union([z.string(), z.number()]).nullish(),
  name: z.string().nullish(),
  title: z.string().nullish(),
  versioning: z.string().nullish(),
  offer: z
    .object({
      price: z
        .object({
          effectiveValue: z.number().nullish(),
          advertisedValue: z.number().nullish(),
          unitPrice: z
            .object({ value: z.number().nullish(), unit: z.string().nullish() })
            .nullish(),
        })
        .nullish(),
      promotionPrice: z.object({ effectiveValue: z.number().nullish() }).nullish(),
      quantity: z.string().nullish(),
      promotionDateRange: z
        .object({ startDate: z.string().nullish(), endDate: z.string().nullish() })
        .nullish(),
      badges: z
        .array(z.object({ type: z.string().nullish(), description: z.string().nullish() }))
        .nullish(),
    })
    .nullish(),
  images: z.array(z.object({ url: z.string().nullish() })).nullish(),
  productUrls: z.string().nullish(),
  breadcrumb: z.array(z.object({ name: z.string().nullish() })).nullish(),
  productInformation: z
    .object({
      mainInformation: z
        .object({
          brand: z.object({ name: z.string().nullish() }).nullish(),
          labels: z.array(z.object({ name: z.string().nullish() })).nullish(),
        })
        .nullish(),
    })
    .nullish(),
});
type RawProduct = z.infer<typeof RawProduct>;

function asList(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (value && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    for (const key of ['productCards', 'products', 'items', 'data']) {
      if (Array.isArray(obj[key])) return obj[key] as unknown[];
    }
    return Object.values(obj); // some endpoints return {"0": {...}, "1": {...}}
  }
  return [];
}

/** A product uid in the search answer: a number, or an object such as {"uid": 100002880}. */
function uidOf(entry: unknown): number | null {
  if (typeof entry === 'number') return Number.isSafeInteger(entry) && entry > 0 ? entry : null;
  if (typeof entry === 'string') return /^\d+$/.test(entry) ? Number(entry) : null;
  if (!entry || typeof entry !== 'object') return null;
  const item = entry as Record<string, unknown>;
  for (const key of ['uid', 'productUid', 'productId', 'id']) {
    const uid = uidOf(item[key]);
    if (uid != null) return uid;
  }
  return null;
}

const LIST_FIELDS = ['productIds', 'uids', 'products', 'results', 'items', 'hits'];
const TOTAL_FIELDS = ['numberOfProducts', 'total', 'totalCount', 'totalHits', 'totalResults'];

/**
 * Reads one page of the category search: the product uids and, if given, the
 * total. Accepts a list of numbers or of objects, under the usual field names.
 * Anything else is reported with its field names, so a change is easy to fix.
 */
export function parseCategorySearch(
  body: unknown,
  url: string,
): { uids: number[]; received: number; total: number | null } {
  const root = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
  const scopes = [root, root.data].filter(
    (scope): scope is Record<string, unknown> => !!scope && typeof scope === 'object',
  );
  for (const scope of scopes) {
    const field = LIST_FIELDS.find((name) => Array.isArray(scope[name]));
    if (!field) continue;
    const entries = scope[field] as unknown[];
    // The website's answer is {"items": [{"id": 100014192, "type": "PRODUCT"}, ...]}. Other item
    // types (teasers) and sponsored products, which belong to other categories, are skipped.
    const listed = entries.filter((e) => {
      if (!e || typeof e !== 'object') return true;
      const { type, sponsored } = e as { type?: unknown; sponsored?: unknown };
      return sponsored !== true && (typeof type !== 'string' || type.toUpperCase() === 'PRODUCT');
    });
    const uids = [...new Set(listed.map(uidOf).filter((uid): uid is number => uid != null))];
    if (listed.length > 0 && uids.length === 0) break;
    const total = TOTAL_FIELDS.map((name) => scope[name] ?? root[name]).find(
      (value): value is number => typeof value === 'number',
    );
    return { uids, received: entries.length, total: total ?? null };
  }
  const fields = Object.keys(root).join(', ') || 'none';
  throw new UnexpectedResponseError(
    url,
    `the Migros category search has no list of products this tool recognises (fields: ${fields})`,
  );
}

export function normalizeMigrosProduct(raw: RawProduct): NormalizedProduct | null {
  const id = raw.migrosId != null ? String(raw.migrosId) : raw.uid != null ? String(raw.uid) : null;
  const name = nonEmpty(raw.name) ?? nonEmpty(raw.title);
  if (!id || !name) return null;
  const offer = raw.offer;
  // On a promotion, promotionPrice is what you pay and price is the regular price.
  const promo = parseMoney(offer?.promotionPrice?.effectiveValue);
  const listed = parseMoney(offer?.price?.effectiveValue);
  const price = promo ?? listed;
  const regularPrice = promo != null ? listed : parseMoney(offer?.price?.advertisedValue);
  const quantity = parseQuantity(offer?.quantity) ?? parseQuantity(raw.versioning);
  const reported = offer?.price?.unitPrice;
  const unit =
    computeUnitPrice(price, quantity) ??
    (reported?.value && reported.unit
      ? unitPriceFrom(
          reported.value,
          Number(/\d+/.exec(reported.unit)?.[0] ?? 1),
          reported.unit.replace(/[\d\s]/g, ''),
        )
      : null);
  const percent = offer?.badges?.find((b) => b.type === 'PERCENTAGE_PROMOTION')?.description;
  const info = raw.productInformation?.mainInformation;

  return {
    store: 'migros',
    storeProductId: id,
    name,
    brand: nonEmpty(info?.brand?.name),
    categoryPath: uniqueStrings((raw.breadcrumb ?? []).map((b) => b.name)),
    sizeText: nonEmpty(offer?.quantity) ?? nonEmpty(raw.versioning),
    quantity,
    price,
    regularPrice,
    loyaltyPrice: null,
    promoLabel: cleanLabel(percent) ?? (promo != null ? 'Aktion' : null),
    validFrom: zurichDateToIso(offer?.promotionDateRange?.startDate),
    validUntil: zurichDateToIso(offer?.promotionDateRange?.endDate, true),
    unitPrice: price != null ? (unit?.unitPrice ?? null) : null,
    unitPriceBasis: price != null ? (unit?.unitPriceBasis ?? null) : null,
    labels: uniqueStrings((info?.labels ?? []).map((l) => l.name)),
    url: nonEmpty(raw.productUrls) ?? `${BASE}/de/product/${id}`,
    // Image URLs carry a literal "{stack}" placeholder; encode it so URLs are valid.
    imageUrl: raw.images?.[0]?.url?.replace(/\{/g, '%7B').replace(/\}/g, '%7D') ?? null,
    sourceRef: raw.uid != null ? { uid: String(raw.uid) } : {},
  };
}

function safeDecode(text: string): string {
  try {
    return decodeURIComponent(text);
  } catch {
    return text;
  }
}

/** Languages to look categories up in: the website asks in English, so English first. */
const SLUG_LANGS = ['en', 'de', 'fr', 'it'];

/**
 * The top-level category pages the sitemap lists, e.g. ".../en/category/snacks-sweets"
 * (deeper pages count for their first part), in the first language it has addresses for.
 * Page addresses and their alternate-language links both count.
 */
export function topCategorySlugs(sitemap: string): { lang: string; slugs: string[] } {
  const byLang = new Map<string, Set<string>>();
  const page = /https:\/\/www\.migros\.ch\/(de|fr|it|en)\/category\/([^<>"'?#\s]+)/g;
  for (const [, lang = '', path = ''] of sitemap.matchAll(page)) {
    const slug = safeDecode(path.replace(/&amp;/g, '&')).split('/')[0];
    if (!slug) continue;
    if (!byLang.has(lang)) byLang.set(lang, new Set());
    byLang.get(lang)?.add(slug);
  }
  const lang = SLUG_LANGS.find((l) => byLang.has(l)) ?? 'en';
  return { lang, slugs: [...(byLang.get(lang) ?? [])] };
}

/** A category by its page address: {"id": "7494736", "name": {"de": "…", "en": "…"}, ...}. */
const Breadcrumb = z.object({
  id: z.union([z.number(), z.string()]),
  name: z.union([z.string(), z.record(z.string(), z.string())]),
});

/** The subcategories a category search lists next to its products. */
const SearchSubcategories = z.object({
  categories: z
    .array(z.object({ id: z.union([z.number(), z.string()]), name: z.string() }))
    .nullish(),
});

function localName(name: string | Record<string, string>, lang: string): string | null {
  if (typeof name === 'string') return nonEmpty(name);
  return nonEmpty(name[lang]) ?? nonEmpty(name.de) ?? nonEmpty(Object.values(name)[0]);
}

/** One page of a category search, as the website asks for it. */
function searchCategory(
  ctx: ProviderContext,
  categoryId: string,
  from: number,
  limit: number,
): Promise<unknown> {
  return call(ctx, (headers) =>
    ctx.http.postJson(
      categorySearchUrl(categoryId),
      {
        regionId: region(),
        language: ctx.lang,
        sortFields: [],
        sortOrder: 'asc',
        from,
        limit,
        filters: {},
        searchAlgorithm: 'DEFAULT',
        enabledSponsoredProducts: false,
      },
      { headers },
    ),
  );
}

async function productCards(ctx: ProviderContext, uids: number[]): Promise<unknown[]> {
  const out: unknown[] = [];
  for (let i = 0; i < uids.length; i += CARDS_PER_REQUEST) {
    const batch = uids.slice(i, i + CARDS_PER_REQUEST);
    const body = await call(ctx, (headers) =>
      ctx.http.postJson(
        PRODUCT_CARDS,
        {
          productFilter: { uids: batch },
          offerFilter: { storeType: 'OFFLINE', region: region(), ongoingOfferDate: today() },
        },
        { headers },
      ),
    );
    out.push(...asList(body));
  }
  return out;
}

export const migros: Provider = {
  info: {
    id: 'migros',
    name: 'Migros',
    website: 'https://www.migros.ch',
    coverage: 'Full assortment with prices as shown on migros.ch.',
    rotating: false,
    verified: true,
    requestsPerSecond: 1,
  },

  async categories(ctx): Promise<Category[]> {
    const { lang, slugs } = topCategorySlugs(await ctx.http.getText(SITEMAP));
    if (slugs.length === 0) {
      throw new UnexpectedResponseError(SITEMAP, 'the sitemap lists no category pages');
    }
    const nodes: TreeNode[] = [];
    const unknown: string[] = [];
    for (const slug of slugs) {
      // Asked like the website does: with the guest token, in the address's language
      // (English first). The answer has the id and the names in every language.
      const url = `${BREADCRUMB}?slug=${encodeURIComponent(slug)}`;
      let body: unknown;
      try {
        body = await call(ctx, (headers) =>
          ctx.http.getJson(url, {
            headers: { ...headers, 'migros-language': lang, 'Accept-Language': lang },
          }),
        );
      } catch (error) {
        // A sitemap can still list a category page that Migros has removed.
        if (!(error instanceof HttpError && error.status === 404)) throw error;
        unknown.push(slug);
        ctx.debug(`Migros does not know the category page "${lang}/category/${slug}"; skipped`);
        continue;
      }
      const category = parseEnvelope(Breadcrumb, body, url, 'Migros category');
      const id = String(category.id);
      const name = localName(category.name, ctx.lang) ?? slug;
      // A search for one product also lists the category's subcategories.
      const search = parseEnvelope(
        SearchSubcategories,
        await searchCategory(ctx, id, 0, 1),
        categorySearchUrl(id),
        'Migros category search',
      );
      const children = (search.categories ?? []).map((c) => ({ id: String(c.id), name: c.name }));
      nodes.push({ id, name, children });
    }
    if (nodes.length === 0) {
      throw new UnexpectedResponseError(
        BREADCRUMB,
        `the category lookup answered 404 for every category page in the sitemap (${lang}: ${unknown.slice(0, 3).join(', ')}…)`,
      );
    }
    return flattenTree('migros', nodes);
  },

  sources(categories, categoryIds) {
    const picked = categoryIds
      ? categories.filter((c) => categoryIds.includes(c.id))
      : categories.filter((c) => c.parentId === null);
    return picked.map((c) => ({
      key: `category:${c.id}`,
      label: c.path.join(' > '),
      params: { categoryId: c.id },
    }));
  },

  async fetchPage(ctx, source, cursor) {
    const offset = typeof cursor === 'number' ? cursor : 0;
    const categoryId = source.params.categoryId ?? '';
    const url = categorySearchUrl(categoryId);
    const body = await searchCategory(ctx, categoryId, offset, PAGE_SIZE);
    const { uids, received, total } = parseCategorySearch(body, url);
    const cards = uids.length > 0 ? await productCards(ctx, uids) : [];
    const normalized = normalizeEach(cards, RawProduct, normalizeMigrosProduct, ctx.debug);
    // Without a total, a short page is the last one.
    const next =
      total != null
        ? nextOffset(offset, received, total)
        : received < PAGE_SIZE
          ? null
          : offset + received;
    return { ...normalized, total, next };
  },

  async fetchDetails(ctx, request): Promise<ProductDetails | null> {
    const uid = request.sourceRef.uid;
    if (!uid) return null;
    const url =
      `${PRODUCT_DETAIL}?uids=${encodeURIComponent(uid)}&storeType=OFFLINE&warehouseId=1` +
      `&region=${encodeURIComponent(region())}&ongoingOfferDate=${encodeURIComponent(today())}`;
    const body = await call(ctx, (headers) => ctx.http.getJson(url, { headers }));
    const raw = asList(body)[0] as Record<string, unknown> | undefined;
    if (!raw) return null;
    const info = (raw.productInformation ?? {}) as Record<
      string,
      Record<string, unknown> | undefined
    >;
    const main = info.mainInformation ?? {};
    const text = (value: unknown) => (typeof value === 'string' ? cleanText(value) : null);
    const nutrition: Record<string, string> = {};
    const table = (
      info.nutrientsInformation as { nutrientsTable?: { rows?: unknown[] } } | undefined
    )?.nutrientsTable;
    for (const row of table?.rows ?? []) {
      const r = row as { label?: string; values?: unknown[] };
      if (r.label && typeof r.values?.[0] === 'string') nutrition[r.label] = r.values[0];
    }
    const gtins = raw.gtins ?? raw.gtin ?? raw.ean;
    return {
      description: text(raw.description) ?? text(main.description),
      ingredients: text(main.ingredients),
      origin:
        text(main.origin) ??
        text((info.otherInformation as Record<string, unknown> | undefined)?.origin),
      ...(Object.keys(nutrition).length > 0 ? { nutrition } : {}),
      gtin: Array.isArray(gtins)
        ? String(gtins[0] ?? '') || null
        : typeof gtins === 'string'
          ? gtins
          : null,
    };
  },
};
