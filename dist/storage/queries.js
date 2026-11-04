import { brandKey } from '../normalization/brands.js';
import { searchKey } from '../normalization/text.js';
import { STORE_IDS } from '../normalization/types.js';
const PRODUCT_COLUMNS = `
  p.id, p.store, p.store_product_id, p.name, p.brand, p.source_title, p.brand_source,
  p.category_path, p.size_text, p.variant, p.version_text, p.quantity_amount, p.quantity_unit,
  p.pack_count, p.labels, p.url, p.image_url, p.gtin,
  p.details, p.details_fetched_at, p.first_seen_at, p.last_seen_at, p.removed_at,
  pr.price, pr.regular_price, pr.loyalty_price, pr.promo_label, pr.valid_from,
  pr.valid_until, pr.unit_price, pr.unit_price_basis, pr.observed_at`;
const FROM = 'FROM products p LEFT JOIN prices pr ON pr.product_id = p.id';
// A product is "on promotion" when it has a crossed-out price, an app price or a promo label.
const ON_PROMOTION = '(pr.regular_price IS NOT NULL OR pr.loyalty_price IS NOT NULL OR pr.promo_label IS NOT NULL)';
export function isOnPromotion(row) {
    return row.regular_price != null || row.loyalty_price != null || row.promo_label != null;
}
export const SORT_KEYS = ['relevance', 'price', 'unit-price', 'discount', 'name', 'store'];
function filterSql(filter, where, params) {
    if (!filter.includeRemoved)
        where.push('p.removed_at IS NULL');
    if (filter.stores && filter.stores.length > 0) {
        const names = filter.stores.map((store, i) => {
            params[`store${i}`] = store;
            return `$store${i}`;
        });
        where.push(`p.store IN (${names.join(', ')})`);
    }
    if (filter.onlyPromotions)
        where.push(ON_PROMOTION);
    if (filter.category) {
        where.push('p.category_path LIKE $category');
        params.category = `%${filter.category}%`;
    }
    const brands = (filter.brands ?? []).map(brandKey).filter(Boolean);
    if (brands.length > 0) {
        const any = brands.map((key, i) => {
            params[`brand${i}`] = key;
            params[`brandStart${i}`] = `${key} %`;
            return `p.brand_key = $brand${i} OR p.brand_key LIKE $brandStart${i}`;
        });
        where.push(`(${any.join(' OR ')})`);
    }
}
/**
 * Accent-insensitive search over brand + name. Every word must appear
 * ("coca cola" matches "Coca-Cola Zero 6 x 1.5 l"). Default order: best
 * matches first, cheapest per kg / litre within equally good matches.
 */
export function searchProducts(db, options) {
    const terms = searchKey(options.query).split(' ').filter(Boolean);
    const where = [];
    const params = {};
    terms.forEach((term, i) => {
        where.push(`p.search_text LIKE $term${i}`);
        params[`term${i}`] = `%${term}%`;
    });
    filterSql(options, where, params);
    const phrase = terms.join(' ');
    const rankParams = { phrase, phrasePrefix: `${phrase}%`, phraseWord: `% ${phrase}%` };
    const relevance = `CASE WHEN p.search_text = $phrase THEN 0
    WHEN p.search_text LIKE $phrasePrefix THEN 1
    WHEN ' ' || p.search_text LIKE $phraseWord THEN 2 ELSE 3 END`;
    const cheapest = 'pr.unit_price IS NULL, pr.unit_price, pr.price IS NULL, pr.price';
    const orderBy = {
        relevance: `${relevance}, ${cheapest}`,
        price: 'pr.price IS NULL, pr.price',
        'unit-price': `pr.unit_price IS NULL, pr.unit_price_basis, pr.unit_price, pr.price`,
        discount: `pr.regular_price IS NULL, (pr.regular_price - pr.price) / pr.regular_price DESC`,
        name: 'p.name COLLATE NOCASE',
        store: `p.store, ${relevance}, ${cheapest}`,
    };
    const sort = options.sort ?? 'relevance';
    const whereSql = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
    const total = db.get(`SELECT COUNT(*) AS n ${FROM} ${whereSql}`, params)?.n ?? 0;
    // node:sqlite rejects unused named parameters, so ranking params are only
    // passed to the sorts that reference them.
    const usesRank = sort === 'relevance' || sort === 'store';
    const rows = db.all(`SELECT ${PRODUCT_COLUMNS} ${FROM} ${whereSql}
     ORDER BY ${orderBy[sort]}, p.name LIMIT $limit`, { ...params, ...(usesRank ? rankParams : {}), limit: options.limit ?? 20 });
    return { rows, total };
}
/**
 * Finds products by id: "aldi:288415", or a bare store product number "288415"
 * (which may match in several stores).
 */
export function findProducts(db, reference) {
    const ref = reference.trim();
    const colon = ref.indexOf(':');
    const store = colon > 0 ? ref.slice(0, colon).toLowerCase() : null;
    const number = colon > 0 ? ref.slice(colon + 1) : ref;
    if (store) {
        const exact = db.all(`SELECT ${PRODUCT_COLUMNS} ${FROM} WHERE p.id = $id`, {
            id: `${store}:${number}`,
        });
        if (exact.length > 0)
            return exact;
    }
    return db.all(`SELECT ${PRODUCT_COLUMNS} ${FROM}
     WHERE ($store IS NULL OR p.store = $store)
       AND (p.store_product_id = $number OR ltrim(p.store_product_id, '0') = ltrim($number, '0'))
     ORDER BY p.store`, { store, number });
}
export function priceHistory(db, productId) {
    return db.all(`SELECT price, regular_price, loyalty_price, promo_label, valid_until, first_seen_at, last_seen_at
     FROM price_history WHERE product_id = $id ORDER BY id`, { id: productId });
}
/** Streams products for export, ordered by store and name. */
export function iterateProducts(db, filter = {}) {
    const where = [];
    const params = {};
    filterSql(filter, where, params);
    const whereSql = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
    return db.iterate(`SELECT ${PRODUCT_COLUMNS} ${FROM} ${whereSql} ORDER BY p.store, p.name COLLATE NOCASE`, params);
}
export function iteratePriceHistory(db, filter = {}) {
    const where = [];
    const params = {};
    filterSql({ ...filter, onlyPromotions: false }, where, params);
    const whereSql = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
    return db.iterate(`SELECT h.product_id, p.store, p.name, h.price, h.regular_price, h.loyalty_price, h.promo_label,
       h.valid_until, h.first_seen_at, h.last_seen_at
     FROM price_history h JOIN products p ON p.id = h.product_id
     LEFT JOIN prices pr ON pr.product_id = p.id
     ${whereSql} ORDER BY p.store, p.name COLLATE NOCASE, h.id`, params);
}
export function storeSummaries(db) {
    return STORE_IDS.map((store) => {
        const counts = db.get(`SELECT
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
       ${FROM} WHERE p.store = $store`, { store });
        const categories = db.get('SELECT COUNT(*) AS n FROM categories WHERE store = $store', { store })
            ?.n ?? 0;
        const lastRun = db.get('SELECT kind, status, started_at, finished_at FROM crawl_runs WHERE store = $store ORDER BY id DESC LIMIT 1', { store });
        const lastSuccess = db.get(`SELECT finished_at FROM crawl_runs WHERE store = $store AND status = 'completed'
         ORDER BY id DESC LIMIT 1`, { store })?.finished_at ?? null;
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
export function databaseTotals(db) {
    return {
        products: db.get('SELECT COUNT(*) AS n FROM products')?.n ?? 0,
        priceObservations: db.get('SELECT COUNT(*) AS n FROM price_history')?.n ?? 0,
    };
}
