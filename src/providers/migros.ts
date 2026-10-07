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
 * NOT WORKING (October 2026): the category product listing below answers HTTP 404
 * from home connections. Migros dropped its category search in 2026 (the
 * open-source migros-api-wrapper removed it in December 2025, and other clients
 * report "no category browse endpoint exists"). migros.ch blocks the cloud
 * network this tool is built on, so a replacement could not be worked out yet.
 * Endpoints and fields follow migros-api-wrapper (MIT, github.com/aliyss/migros-api-wrapper).
 *
 * Flow: guest token -> category tree (storemap) -> product ids per category
 * -> product cards (name, price) in batches -> product detail (optional).
 */
const BASE = 'https://www.migros.ch';
const GUEST_TOKEN = `${BASE}/authentication/public/v1/api/guest?authorizationNotRequired=true`;
const STOREMAP = `${BASE}/onesearch-oc-seaapi/public/v2/storemap`;
const CATEGORY_SEARCH = `${BASE}/onesearch-oc-seaapi/public/v5/search/category`;
const PRODUCT_CARDS = `${BASE}/product-display/public/v4/product-cards`;
const PRODUCT_DETAIL = `${BASE}/product-display/public/v2/product-detail`;
const PAGE_SIZE = 60;
const CARDS_PER_REQUEST = 30;

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

interface RawCategoryNode {
  id?: string | number | null;
  name?: string | null;
  children?: RawCategoryNode[] | null;
  categories?: RawCategoryNode[] | null;
}

function toNodes(nodes: unknown): TreeNode[] {
  if (!Array.isArray(nodes)) return [];
  return nodes.flatMap((n) => {
    const node = n as RawCategoryNode;
    if (node?.id == null || !node.name) return [];
    return [
      { id: String(node.id), name: node.name, children: toNodes(node.children ?? node.categories) },
    ];
  });
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
    unavailable:
      'Migros removed the product listing this tool reads from its website (2026), so the Migros support needs an update.',
    rotating: false,
    verified: false,
    requestsPerSecond: 1,
  },

  async categories(ctx): Promise<Category[]> {
    const url = `${STOREMAP}?language=${ctx.lang.toUpperCase()}&regionId=national&storeMapScope=DEFAULT`;
    const body = await call(ctx, (headers) => ctx.http.getJson(url, { headers }));
    const root = parseEnvelope(
      z.object({ categories: z.array(z.unknown()) }),
      body,
      url,
      'Migros category tree',
    );
    return flattenTree('migros', toNodes(root.categories));
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
    const body = await call(ctx, (headers) =>
      ctx.http.postJson(
        CATEGORY_SEARCH,
        {
          from: offset,
          categoryId: Number(source.params.categoryId),
          language: ctx.lang,
          regionId: 'national',
          productIds: [],
          sortFields: [],
          sortOrder: 'asc',
          requestSponsoredProducts: false,
          filters: {},
        },
        { headers },
      ),
    ).catch((error: unknown) => {
      if (error instanceof HttpError && error.status === 404) {
        throw new UnexpectedResponseError(
          CATEGORY_SEARCH,
          'Migros no longer offers the category product listing this tool reads (HTTP 404 for /onesearch-oc-seaapi/public/v5/search/category)',
        );
      }
      throw error;
    });
    const search = parseEnvelope(
      z.object({ productIds: z.array(z.number()), numberOfProducts: z.number().nullish() }),
      body,
      CATEGORY_SEARCH,
      'Migros category search',
    );
    // The search may return one page of ids or all of them; handle both.
    const allAtOnce = search.productIds.length > PAGE_SIZE * 2;
    const ids = allAtOnce ? search.productIds.slice(offset, offset + PAGE_SIZE) : search.productIds;
    const total = allAtOnce ? search.productIds.length : (search.numberOfProducts ?? null);
    const cards = ids.length > 0 ? await productCards(ctx, ids) : [];
    const normalized = normalizeEach(cards, RawProduct, normalizeMigrosProduct, ctx.debug);
    return { ...normalized, total, next: nextOffset(offset, ids.length, total) };
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
