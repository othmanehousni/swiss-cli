import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Database } from '../../src/storage/database.js';
import {
  countUnseenSince,
  loadCategories,
  markUnseenAsRemoved,
  productsNeedingDetails,
  saveCategories,
  saveDetails,
  saveProducts,
} from '../../src/storage/products.js';
import {
  findProducts,
  iterateProducts,
  priceHistory,
  searchProducts,
  storeSummaries,
} from '../../src/storage/queries.js';
import { makeProduct } from '../helpers/products.js';

const T1 = '2026-10-01T08:00:00.000Z';
const T2 = '2026-10-02T08:00:00.000Z';
const T3 = '2026-10-03T08:00:00.000Z';

let db: Database;
beforeEach(() => {
  db = Database.open(':memory:');
});
afterEach(() => db.close());

describe('database', () => {
  it('applies migrations on open', () => {
    expect(db.get<{ user_version: number }>('PRAGMA user_version')?.user_version).toBe(6);
    expect(db.upgradedFrom).toBeNull(); // a new database is not an upgrade
  });

  it('upgrades existing records additively and does not rerun migrations', () => {
    const dir = mkdtempSync(join(tmpdir(), 'swiss-grocery-metadata-migration-'));
    const path = join(dir, 'legacy.db');
    let legacy: Database | null = Database.open(path);
    try {
      saveProducts(legacy, [makeProduct()], T1);
      legacy.exec('ALTER TABLE products DROP COLUMN source_title');
      legacy.exec('ALTER TABLE products DROP COLUMN version_text');
      legacy.exec('ALTER TABLE products DROP COLUMN variant');
      legacy.exec('PRAGMA user_version = 4');
      legacy.close();
      legacy = null;

      const upgraded = Database.open(path);
      expect(upgraded.upgradedFrom).toBe(4);
      expect(upgraded.get<{ user_version: number }>('PRAGMA user_version')?.user_version).toBe(6);
      expect(findProducts(upgraded, 'aldi:288415')[0]).toMatchObject({
        source_title: null,
        variant: null,
        version_text: null,
      });
      upgraded.close();

      const reopened = Database.open(path);
      expect(reopened.upgradedFrom).toBeNull();
      expect(findProducts(reopened, 'aldi:288415')).toHaveLength(1);
      reopened.close();
    } finally {
      legacy?.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('rolls back a failed transaction', () => {
    expect(() =>
      db.transaction(() => {
        saveProducts(db, [makeProduct()], T1);
        throw new Error('boom');
      }),
    ).toThrow('boom');
    expect(db.get<{ n: number }>('SELECT COUNT(*) AS n FROM products')?.n).toBe(0);
  });
});

describe('saveProducts', () => {
  it('inserts, then recognises unchanged products', () => {
    expect(saveProducts(db, [makeProduct()], T1)).toEqual({
      inserted: 1,
      updated: 0,
      unchanged: 0,
      priceChanges: 0,
    });
    expect(saveProducts(db, [makeProduct()], T2)).toEqual({
      inserted: 0,
      updated: 0,
      unchanged: 1,
      priceChanges: 0,
    });
    const row = db.get<{ last_seen_at: string; updated_at: string }>(
      'SELECT last_seen_at, updated_at FROM products',
    );
    expect(row).toEqual({ last_seen_at: T2, updated_at: T1 });
  });

  it('keeps one history row per price period', () => {
    saveProducts(db, [makeProduct()], T1);
    saveProducts(db, [makeProduct()], T2);
    const promo = makeProduct({
      price: 2.99,
      regularPrice: 3.85,
      promoLabel: '-22%',
      validUntil: '2026-10-08T21:59:59.000Z',
    });
    expect(saveProducts(db, [promo], T3).priceChanges).toBe(1);

    const history = priceHistory(db, 'aldi:288415');
    expect(history).toHaveLength(2);
    expect(history[0]).toMatchObject({ price: 3.85, first_seen_at: T1, last_seen_at: T2 });
    expect(history[1]).toMatchObject({
      price: 2.99,
      regular_price: 3.85,
      promo_label: '-22%',
      first_seen_at: T3,
    });
    expect(db.get<{ price: number }>('SELECT price FROM prices')?.price).toBe(2.99);
  });

  it('treats the same offer seen again without dates as the same period', () => {
    // Denner lists wines on promotion twice: with dates (promotions) and without (wine shop).
    const promo = { price: 35.95, regularPrice: 53.95, promoLabel: '-33%' };
    const until = '2026-10-07T21:59:59.000Z';
    expect(saveProducts(db, [makeProduct({ ...promo, validUntil: until })], T1).priceChanges).toBe(
      0,
    );
    expect(saveProducts(db, [makeProduct({ ...promo, validUntil: null })], T1).priceChanges).toBe(
      0,
    );
    const history = priceHistory(db, 'aldi:288415');
    expect(history).toHaveLength(1);
    expect(history[0]?.valid_until).toBe(until);
    expect(db.get<{ valid_until: string }>('SELECT valid_until FROM prices')?.valid_until).toBe(
      until,
    );

    // A real change of price replaces the old dates, even with none.
    saveProducts(db, [makeProduct({ price: 53.95, validUntil: null })], T2);
    expect(
      db.get<{ valid_until: string | null }>('SELECT valid_until FROM prices')?.valid_until,
    ).toBeNull();
  });

  it('bumps updated_at only when product data really changes', () => {
    saveProducts(db, [makeProduct()], T1);
    expect(saveProducts(db, [makeProduct({ name: 'Vorzugsbutter' })], T2).updated).toBe(1);
    expect(
      db.get<{ name: string; updated_at: string }>('SELECT name, updated_at FROM products'),
    ).toEqual({
      name: 'Vorzugsbutter',
      updated_at: T2,
    });
  });

  it('stores products without a published price but no price row', () => {
    saveProducts(db, [makeProduct({ price: null, unitPrice: null, unitPriceBasis: null })], T1);
    expect(db.get<{ n: number }>('SELECT COUNT(*) AS n FROM prices')?.n).toBe(0);
    expect(db.get<{ n: number }>('SELECT COUNT(*) AS n FROM products')?.n).toBe(1);
  });
});

describe('removed products', () => {
  it('marks products a full crawl did not see, and revives them when listed again', () => {
    saveProducts(db, [makeProduct(), makeProduct({ storeProductId: '1', name: 'Milch' })], T1);
    saveProducts(db, [makeProduct()], T2); // second crawl only sees the butter
    expect(countUnseenSince(db, 'aldi', T2)).toBe(1);
    expect(markUnseenAsRemoved(db, 'aldi', T2, T2)).toBe(1);
    expect(searchProducts(db, { query: 'milch' }).total).toBe(0);
    expect(searchProducts(db, { query: 'milch', includeRemoved: true }).total).toBe(1);

    expect(
      saveProducts(db, [makeProduct({ storeProductId: '1', name: 'Milch' })], T3).updated,
    ).toBe(1);
    expect(searchProducts(db, { query: 'milch' }).total).toBe(1);
  });

  it('only touches the given store', () => {
    saveProducts(db, [makeProduct(), makeProduct({ store: 'lidl', storeProductId: '9' })], T1);
    expect(markUnseenAsRemoved(db, 'aldi', T2, T2)).toBe(1);
    expect(storeSummaries(db).find((s) => s.store === 'lidl')?.products).toBe(1);
  });
});

describe('search', () => {
  beforeEach(() => {
    saveProducts(
      db,
      [
        makeProduct({
          storeProductId: '1',
          name: 'Coca-Cola Classic',
          sizeText: '6 x 1.5 l',
          price: 9.95,
          unitPrice: 1.11,
          unitPriceBasis: 'l',
        }),
        makeProduct({
          store: 'denner',
          storeProductId: '2',
          name: 'Coca-Cola Zero',
          price: 1.95,
          unitPrice: 3.9,
          unitPriceBasis: 'l',
          regularPrice: 2.4,
          promoLabel: '-19%',
        }),
        makeProduct({
          store: 'lidl',
          storeProductId: '3',
          name: 'Cola Mix',
          price: 0.95,
          unitPrice: 0.63,
          unitPriceBasis: 'l',
        }),
        makeProduct({
          storeProductId: '4',
          name: 'Gruyère Käse',
          brand: 'Le Superbe',
          price: 5.5,
          unitPrice: 27.5,
        }),
      ],
      T1,
    );
  });

  it('requires every word and ignores punctuation', () => {
    const { rows, total } = searchProducts(db, { query: 'coca cola' });
    expect(total).toBe(2);
    expect(rows.map((r) => r.name)).toEqual(['Coca-Cola Classic', 'Coca-Cola Zero']);
  });

  it('matches accents and umlauts in both spellings, plus brands', () => {
    expect(searchProducts(db, { query: 'käse' }).total).toBe(1);
    expect(searchProducts(db, { query: 'kaese gruyere' }).total).toBe(1);
    expect(searchProducts(db, { query: 'superbe' }).total).toBe(1);
  });

  it('filters by store and promotions, and sorts by unit price', () => {
    expect(searchProducts(db, { query: 'cola', stores: ['lidl'] }).rows.map((r) => r.id)).toEqual([
      'lidl:3',
    ]);
    expect(
      searchProducts(db, { query: 'cola', onlyPromotions: true }).rows.map((r) => r.id),
    ).toEqual(['denner:2']);
    expect(searchProducts(db, { query: 'cola', sort: 'unit-price' }).rows.map((r) => r.id)).toEqual(
      ['lidl:3', 'aldi:1', 'denner:2'],
    );
  });

  it('finds products by id, by number, and ignores leading zeros', () => {
    expect(findProducts(db, 'denner:2').map((r) => r.id)).toEqual(['denner:2']);
    expect(findProducts(db, 'DENNER:2').map((r) => r.id)).toEqual(['denner:2']);
    expect(findProducts(db, '0004').map((r) => r.id)).toEqual(['aldi:4']);
    expect(findProducts(db, 'nope:42')).toEqual([]);
  });
});

describe('details and categories', () => {
  it('records details and the barcode', () => {
    saveProducts(db, [makeProduct()], T1);
    expect(productsNeedingDetails(db, 'aldi')).toHaveLength(1);
    saveDetails(db, 'aldi:288415', { ingredients: 'Rahm', gtin: '7610000000000' }, T2);
    expect(productsNeedingDetails(db, 'aldi')).toHaveLength(0);
    const row = findProducts(db, 'aldi:288415')[0];
    expect(row?.gtin).toBe('7610000000000');
    expect(JSON.parse(row?.details ?? '{}')).toEqual({
      ingredients: 'Rahm',
      gtin: '7610000000000',
    });
  });

  it('replaces a store category tree', () => {
    saveCategories(
      db,
      'aldi',
      [
        {
          store: 'aldi',
          id: '1',
          parentId: null,
          name: 'Käse',
          path: ['Milch', 'Käse'],
          productCount: 3,
        },
      ],
      T1,
    );
    saveCategories(
      db,
      'aldi',
      [
        {
          store: 'aldi',
          id: '2',
          parentId: null,
          name: 'Brot',
          path: ['Brot'],
          productCount: null,
        },
      ],
      T2,
    );
    expect(loadCategories(db, 'aldi').map((c) => c.name)).toEqual(['Brot']);
  });

  it('streams products for export and summarises stores', () => {
    saveProducts(
      db,
      [
        makeProduct(),
        makeProduct({ storeProductId: '5', name: 'Rahm', price: 2, regularPrice: 2.5 }),
      ],
      T1,
    );
    expect([...iterateProducts(db, { stores: ['aldi'] })].map((r) => r.name)).toEqual([
      'Butter',
      'Rahm',
    ]);
    const aldi = storeSummaries(db).find((s) => s.store === 'aldi');
    expect(aldi).toMatchObject({ products: 2, withPrice: 2, onPromotion: 1 });
  });
});

describe('the same product listed twice in one crawl', () => {
  it('merges into one period, keeping the richer details', () => {
    // Promotions listing: label "SPECIAL"; wine shop listing: same price, no label.
    saveProducts(db, [makeProduct({ price: 56.7, promoLabel: 'SPECIAL' })], T1, T1);
    const second = saveProducts(
      db,
      [makeProduct({ price: 56.7, promoLabel: null })],
      T1.replace('08:00', '08:01'),
      T1,
    );
    expect(second.priceChanges).toBe(0);
    const history = priceHistory(db, 'aldi:288415');
    expect(history).toHaveLength(1);
    expect(history[0]?.promo_label).toBe('SPECIAL');
    expect(db.get<{ promo_label: string }>('SELECT promo_label FROM prices')?.promo_label).toBe(
      'SPECIAL',
    );
  });

  it('still records a real change in a later crawl', () => {
    saveProducts(db, [makeProduct({ price: 56.7, promoLabel: 'SPECIAL' })], T1, T1);
    const later = saveProducts(db, [makeProduct({ price: 56.7, promoLabel: null })], T2, T2);
    expect(later.priceChanges).toBe(1);
    expect(priceHistory(db, 'aldi:288415')).toHaveLength(2);
  });
});
