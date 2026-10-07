import { searchKey } from '../normalization/text.js';
import { STORE_IDS, type StoreId } from '../normalization/types.js';
import type { Database, SqlParams } from './database.js';

/** A product joined with its current price, as stored. */
export interface ProductRow {
  id: string;
  store: StoreId;
  store_product_id: string;
  name: string;
  brand: string | null;
  category_path: string | null;
  size_text: string | null;
  quantity_amount: number | null;
  quantity_unit: 'g' | 'ml' | 'piece' | null;
  pack_count: number | null;
  labels: string;
  url: string | null;
  image_url: string | null;
  gtin: string | null;
  details: string | null;
  details_fetched_at: string | null;
  first_seen_at: string;
  last_seen_at: string;
  removed_at: string | null;
  price: number | null;
  regular_price: number | null;
  loyalty_price: number | null;
  promo_label: string | null;
  valid_from: string | null;
  valid_until: string | null;
  unit_price: number | null;
  unit_price_basis: 'kg' | 'l' | 'piece' | null;
  observed_at: string | null;
}

const PRODUCT_COLUMNS = `
  p.id, p.store, p.store_product_id, p.name, p.brand, p.category_path, p.size_text,
  p.quantity_amount, p.quantity_unit, p.pack_count, p.labels, p.url, p.image_url, p.gtin,
  p.details, p.details_fetched_at, p.first_seen_at, p.last_seen_at, p.removed_at,
  pr.price, pr.regular_price, pr.loyalty_price, pr.promo_label, pr.valid_from,
  pr.valid_until, pr.unit_price, pr.unit_price_basis, pr.observed_at`;

const FROM = 'FROM products p LEFT JOIN prices pr ON pr.product_id = p.id';

// A product is "on promotion" when it has a crossed-out price, an app price or a promo label.
const ON_PROMOTION =
  '(pr.regular_price IS NOT NULL OR pr.loyalty_price IS NOT NULL OR pr.promo_label IS NOT NULL)';

export function isOnPromotion(
  row: Pick<ProductRow, 'regular_price' | 'loyalty_price' | 'promo_label'>,
): boolean {
  return row.regular_price != null || row.loyalty_price != null || row.promo_label != null;
}

export const SORT_KEYS = ['relevance', 'price', 'unit-price', 'discount', 'name', 'store'] as const;
export type SortKey = (typeof SORT_KEYS)[number];

export interface ProductFilter {
  stores?: StoreId[];
  onlyPromotions?: boolean;
  includeRemoved?: boolean;
  /** Matches anywhere in the category path (accent-insensitive). */
  category?: string;
}

function filterSql(filter: ProductFilter, where: string[], params: SqlParams): void {
  if (!filter.includeRemoved) where.push('p.removed_at IS NULL');
  if (filter.stores && filter.stores.length > 0) {
    const names = filter.stores.map((store, i) => {
      params[`store${i}`] = store;
      return `$store${i}`;
    });
    where.push(`p.store IN (${names.join(', ')})`);
  }
  if (filter.onlyPromotions) where.push(ON_PROMOTION);
  if (filter.category) {
    where.push('p.category_path LIKE $category');
    params.category = `%${filter.category}%`;
  }
}

export interface SearchOptions extends ProductFilter {
  query: string;
  sort?: SortKey;
  limit?: number;
}

/**
 * Accent-insensitive search over brand + name. Every word must appear
 * ("coca cola" matches "Coca-Cola Zero 6 x 1.5 l"). Default order: best
 * matches first, cheapest per kg / litre within equally good matches.
 */
export function searchProducts(
  db: Database,
  options: SearchOptions,
): { rows: ProductRow[]; total: number } {
  const terms = searchKey(options.query).split(' ').filter(Boolean);
  const where: string[] = [];
  const params: SqlParams = {};
  terms.forEach((term, i) => {
    where.push(`p.search_text LIKE $term${i}`);
    params[`term${i}`] = `%${term}%`;
  });
  filterSql(options, where, params);

  const phrase = terms.join(' ');
  const rankParams: SqlParams = { phrase, phrasePrefix: `${phrase}%`, phraseWord: `% ${phrase}%` };
  const relevance = `CASE WHEN p.search_text = $phrase THEN 0
    WHEN p.search_text LIKE $phrasePrefix THEN 1
    WHEN ' ' || p.search_text LIKE $phraseWord THEN 2 ELSE 3 END`;
  const cheapest = 'pr.unit_price IS NULL, pr.unit_price, pr.price IS NULL, pr.price';
  const orderBy: Record<SortKey, string> = {
    relevance: `${relevance}, ${cheapest}`,
    price: 'pr.price IS NULL, pr.price',
    'unit-price': `pr.unit_price IS NULL, pr.unit_price_basis, pr.unit_price, pr.price`,
    discount: `pr.regular_price IS NULL, (pr.regular_price - pr.price) / pr.regular_price DESC`,
    name: 'p.name COLLATE NOCASE',
    store: `p.store, ${relevance}, ${cheapest}`,
  };
  const sort = options.sort ?? 'relevance';
  const whereSql = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
  const total = db.get<{ n: number }>(`SELECT COUNT(*) AS n ${FROM} ${whereSql}`, params)?.n ?? 0;
  // node:sqlite rejects unused named parameters, so ranking params are only
  // passed to the sorts that reference them.
  const usesRank = sort === 'relevance' || sort === 'store';
  const rows = db.all<ProductRow>(
    `SELECT ${PRODUCT_COLUMNS} ${FROM} ${whereSql}
     ORDER BY ${orderBy[sort]}, p.name LIMIT $limit`,
    { ...params, ...(usesRank ? rankParams : {}), limit: options.limit ?? 20 },
  );
  return { rows, total };
}

/**
 * Finds products by id: "aldi:288415", or a bare store product number "288415"
 * (which may match in several stores).
 */
export function findProducts(db: Database, reference: string): ProductRow[] {
  const ref = reference.trim();
  const colon = ref.indexOf(':');
  const store = colon > 0 ? ref.slice(0, colon).toLowerCase() : null;
  const number = colon > 0 ? ref.slice(colon + 1) : ref;

  if (store) {
    const exact = db.all<ProductRow>(`SELECT ${PRODUCT_COLUMNS} ${FROM} WHERE p.id = $id`, {
      id: `${store}:${number}`,
    });
    if (exact.length > 0) return exact;
  }
  return db.all<ProductRow>(
    `SELECT ${PRODUCT_COLUMNS} ${FROM}
     WHERE ($store IS NULL OR p.store = $store)
       AND (p.store_product_id = $number OR ltrim(p.store_product_id, '0') = ltrim($number, '0'))
     ORDER BY p.store`,
    { store, number },
  );
}

export interface HistoryRow {
  price: number;
  regular_price: number | null;
  loyalty_price: number | null;
  promo_label: string | null;
  valid_until: string | null;
  first_seen_at: string;
  last_seen_at: string;
}

export function priceHistory(db: Database, productId: string): HistoryRow[] {
  return db.all<HistoryRow>(
    `SELECT price, regular_price, loyalty_price, promo_label, valid_until, first_seen_at, last_seen_at
     FROM price_history WHERE product_id = $id ORDER BY id`,
    { id: productId },
  );
}

/** Streams products for export, ordered by store and name. */
export function iterateProducts(db: Database, filter: ProductFilter = {}): Generator<ProductRow> {
  const where: string[] = [];
  const params: SqlParams = {};
  filterSql(filter, where, params);
  const whereSql = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
  return db.iterate<ProductRow>(
    `SELECT ${PRODUCT_COLUMNS} ${FROM} ${whereSql} ORDER BY p.store, p.name COLLATE NOCASE`,
    params,
  );
}

export interface HistoryExportRow extends HistoryRow {
  product_id: string;
  store: StoreId;
  name: string;
}

export function iteratePriceHistory(
  db: Database,
  filter: ProductFilter = {},
): Generator<HistoryExportRow> {
  const where: string[] = [];
  const params: SqlParams = {};
  filterSql({ ...filter, onlyPromotions: false }, where, params);
  const whereSql = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
  return db.iterate<HistoryExportRow>(
    `SELECT h.product_id, p.store, p.name, h.price, h.regular_price, h.loyalty_price, h.promo_label,
       h.valid_until, h.first_seen_at, h.last_seen_at
     FROM price_history h JOIN products p ON p.id = h.product_id
     LEFT JOIN prices pr ON pr.product_id = p.id
     ${whereSql} ORDER BY p.store, p.name COLLATE NOCASE, h.id`,
    params,
  );
}

export interface StoreSummary {
  store: StoreId;
  products: number;
  removed: number;
  withPrice: number;
  withUnitPrice: number;
  withBrand: number;
  withImage: number;
  withCategory: number;
  withDetails: number;
  withGtin: number;
  onPromotion: number;
  categories: number;
  lastRun: { kind: string; status: string; startedAt: string; finishedAt: string | null } | null;
  lastSuccess: string | null;
}

export function storeSummaries(db: Database): StoreSummary[] {
  return STORE_IDS.map((store) => {
    const counts = db.get<Record<string, number>>(
      `SELECT
         COUNT(*) FILTER (WHERE p.removed_at IS NULL) AS products,
         COUNT(*) FILTER (WHERE p.removed_at IS NOT NULL) AS removed,
         COUNT(pr.price) FILTER (WHERE p.removed_at IS NULL) AS withPrice,
         COUNT(pr.unit_price) FILTER (WHERE p.removed_at IS NULL) AS withUnitPrice,
         COUNT(p.brand) FILTER (WHERE p.removed_at IS NULL) AS withBrand,
         COUNT(p.image_url) FILTER (WHERE p.removed_at IS NULL) AS withImage,
         COUNT(p.category_path) FILTER (WHERE p.removed_at IS NULL) AS withCategory,
         COUNT(p.details_fetched_at) FILTER (WHERE p.removed_at IS NULL) AS withDetails,
         COUNT(p.gtin) FILTER (WHERE p.removed_at IS NULL) AS withGtin,
         COUNT(*) FILTER (WHERE p.removed_at IS NULL AND ${ON_PROMOTION}) AS onPromotion
       ${FROM} WHERE p.store = $store`,
      { store },
    );
    const categories =
      db.get<{ n: number }>('SELECT COUNT(*) AS n FROM categories WHERE store = $store', { store })
        ?.n ?? 0;
    const lastRun = db.get<{
      kind: string;
      status: string;
      started_at: string;
      finished_at: string | null;
    }>(
      'SELECT kind, status, started_at, finished_at FROM crawl_runs WHERE store = $store ORDER BY id DESC LIMIT 1',
      { store },
    );
    const lastSuccess =
      db.get<{ finished_at: string }>(
        `SELECT finished_at FROM crawl_runs WHERE store = $store AND status = 'completed'
         ORDER BY id DESC LIMIT 1`,
        { store },
      )?.finished_at ?? null;
    return {
      store,
      products: counts?.products ?? 0,
      removed: counts?.removed ?? 0,
      withPrice: counts?.withPrice ?? 0,
      withUnitPrice: counts?.withUnitPrice ?? 0,
      withBrand: counts?.withBrand ?? 0,
      withImage: counts?.withImage ?? 0,
      withCategory: counts?.withCategory ?? 0,
      withDetails: counts?.withDetails ?? 0,
      withGtin: counts?.withGtin ?? 0,
      onPromotion: counts?.onPromotion ?? 0,
      categories,
      lastRun: lastRun
        ? {
            kind: lastRun.kind,
            status: lastRun.status,
            startedAt: lastRun.started_at,
            finishedAt: lastRun.finished_at,
          }
        : null,
      lastSuccess,
    };
  });
}

export function databaseTotals(db: Database): { products: number; priceObservations: number } {
  return {
    products: db.get<{ n: number }>('SELECT COUNT(*) AS n FROM products')?.n ?? 0,
    priceObservations: db.get<{ n: number }>('SELECT COUNT(*) AS n FROM price_history')?.n ?? 0,
  };
}
