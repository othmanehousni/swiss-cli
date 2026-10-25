import { BrandIndex, brandKey, brandPrefix } from '../normalization/brands.js';
import type { StoreId } from '../normalization/types.js';
import type { Database, SqlParams } from './database.js';

/** What the brand pass needs to know about a store. */
export interface BrandStore {
  id: StoreId;
  /** The store's own name, which is also its own label ("Denner Lachsfilets"). */
  name: string;
  /** Its product names start with the brand, so brands can be recognised there. */
  brandInName: boolean;
}

export interface BrandRefresh {
  /** Products whose brand, its spelling or its source changed. */
  changed: number;
  /** Products whose brand was recognised from the name. */
  fromNames: number;
}

interface Row {
  id: string;
  store: StoreId;
  name: string;
  category_path: string | null;
  brand: string | null;
  brand_source: 'store' | 'name' | null;
  brand_key: string | null;
}

/**
 * Brings every product's brand up to date with what the stores publish:
 * - brands from the store keep their source, in one spelling for all stores;
 * - products without one, in stores whose names start with the brand (Coop wines,
 *   Denner), get the published brand their name starts with, if any.
 * Changed products count as updated, so the next sync sends them.
 */
export function refreshBrands(db: Database, stores: BrandStore[], now: string): BrandRefresh {
  const byId = new Map(stores.map((s) => [s.id, s]));
  const rows = db.all<Row>(
    'SELECT id, store, name, category_path, brand, brand_source, brand_key FROM products',
  );
  const index = new BrandIndex(
    rows
      .filter((r) => r.brand_source === 'store' && r.brand)
      .map((r) => ({
        brand: r.brand as string,
        store: r.store,
        name: r.name,
        brandInName: byId.get(r.store)?.brandInName === true,
      })),
  );

  const result: BrandRefresh = { changed: 0, fromNames: 0 };
  db.transaction(() => {
    for (const row of rows) {
      const store = byId.get(row.store);
      let brand: string | null = null;
      let source: Row['brand_source'] = null;
      if (row.brand_source === 'store' && row.brand) {
        brand = index.spelling(row.brand);
        source = 'store';
      } else if (store?.brandInName) {
        brand =
          index.recognise(row.name, row.category_path) ??
          (brandPrefix(row.name, brandKey(store.name)) &&
          brandKey(row.name) !== brandKey(store.name)
            ? store.name
            : null);
        source = brand ? 'name' : null;
      }
      if (source === 'name') result.fromNames++;
      const key = brand ? brandKey(brand) : null;
      if (brand === row.brand && source === row.brand_source && key === row.brand_key) continue;
      db.run(
        `UPDATE products SET brand = $brand, brand_source = $source, brand_key = $key,
           updated_at = $now WHERE id = $id`,
        { id: row.id, brand, source, key, now },
      );
      result.changed++;
    }
  });
  return result;
}

/** True after an upgrade, when stored brands have not been through `refreshBrands` yet. */
export function brandsNeedRefresh(db: Database): boolean {
  return (
    db.get(
      'SELECT 1 AS yes FROM products WHERE brand IS NOT NULL AND brand_key IS NULL LIMIT 1',
    ) !== undefined
  );
}

export interface BrandSummary {
  brand: string;
  /** Lowercase, accent-free: what `--brand` matches. */
  key: string;
  products: number;
  /** Products per store, largest first. */
  stores: { store: StoreId; products: number }[];
  /** Products whose brand was recognised from the name (the store gives none). */
  fromNames: number;
}

/**
 * Brands of the products stores currently list, with how many each store has,
 * the biggest first. `query` keeps brands whose name contains it (accents optional).
 */
export function brandSummaries(
  db: Database,
  options: { stores?: StoreId[]; query?: string } = {},
): BrandSummary[] {
  const where = ['removed_at IS NULL', 'brand_key IS NOT NULL'];
  const params: SqlParams = {};
  if (options.stores && options.stores.length > 0) {
    where.push(
      `store IN (${options.stores
        .map((store, i) => {
          params[`store${i}`] = store;
          return `$store${i}`;
        })
        .join(', ')})`,
    );
  }
  const query = options.query ? brandKey(options.query) : '';
  if (query) {
    where.push("(' ' || brand_key) LIKE $query");
    params.query = `% ${query}%`;
  }
  const rows = db.all<{
    brand_key: string;
    brand: string;
    store: StoreId;
    products: number;
    from_names: number;
  }>(
    `SELECT brand_key, MIN(brand) AS brand, store, COUNT(*) AS products,
       COUNT(*) FILTER (WHERE brand_source = 'name') AS from_names
     FROM products WHERE ${where.join(' AND ')}
     GROUP BY brand_key, store`,
    params,
  );
  const brands = new Map<string, BrandSummary>();
  for (const row of rows) {
    let summary = brands.get(row.brand_key);
    if (!summary) {
      summary = { brand: row.brand, key: row.brand_key, products: 0, stores: [], fromNames: 0 };
      brands.set(row.brand_key, summary);
    }
    summary.products += row.products;
    summary.fromNames += row.from_names;
    summary.stores.push({ store: row.store, products: row.products });
  }
  for (const summary of brands.values()) summary.stores.sort((a, b) => b.products - a.products);
  return [...brands.values()].sort(
    (a, b) => b.products - a.products || a.brand.localeCompare(b.brand),
  );
}
