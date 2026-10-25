import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  BrandIndex,
  brandKey,
  brandPrefix,
  looksLikeWine,
  type PublishedBrand,
} from '../../src/normalization/brands.js';
import { normalizeCoopProduct } from '../../src/providers/coop.js';
import { normalizeMigrosProduct } from '../../src/providers/migros.js';
import {
  type BrandStore,
  brandSummaries,
  brandsNeedRefresh,
  refreshBrands,
} from '../../src/storage/brands.js';
import { Database } from '../../src/storage/database.js';
import { saveProducts } from '../../src/storage/products.js';
import { searchProducts } from '../../src/storage/queries.js';
import { MIGRATIONS } from '../../src/storage/schema.js';
import { loadSqlite } from '../../src/storage/sqlite.js';
import { makeProduct } from '../helpers/products.js';

const T1 = '2026-10-01T08:00:00.000Z';
const T2 = '2026-10-02T08:00:00.000Z';
const T3 = '2026-10-03T08:00:00.000Z';

const STORES: BrandStore[] = [
  { id: 'migros', name: 'Migros', brandInName: false },
  { id: 'coop', name: 'Coop', brandInName: true },
  { id: 'denner', name: 'Denner', brandInName: true },
  { id: 'aldi', name: 'Aldi Suisse', brandInName: false },
  { id: 'lidl', name: 'Lidl Suisse', brandInName: false },
];

/** Coop publishes the brand, and its names start with it. */
const coop = (brand: string, name: string): PublishedBrand => ({
  brand,
  name,
  store: 'coop',
  brandInName: true,
});
/** Aldi publishes the brand, but its names do not contain it. */
const aldi = (brand: string, name: string): PublishedBrand => ({
  brand,
  name,
  store: 'aldi',
  brandInName: false,
});

describe('brandPrefix', () => {
  it('finds the brand at the start of a name, as whole words', () => {
    expect(brandPrefix('Coca-Cola Zero 6x1,5l', 'coca cola')).toBe('Coca-Cola');
    expect(brandPrefix('Feldschlösschen Bier Original', 'feldschlosschen')).toBe('Feldschlösschen');
    expect(brandPrefix("Kellogg's Corn Flakes", 'kellogg s')).toBe("Kellogg's");
    expect(brandPrefix('Starbucks® by Nespresso® Kapseln', 'starbucks')).toBe('Starbucks');
    expect(brandPrefix('Coop - Milch', 'coop')).toBe('Coop');
    // A hyphen joins words: a children's toothpaste is not the brand Kinder.
    expect(brandPrefix('Kinder-Zahnpasta Erdbeer', 'kinder')).toBeNull();
    expect(brandPrefix('Kindermilch', 'kinder')).toBeNull();
    expect(brandPrefix('Milch Kinder', 'kinder')).toBeNull();
  });

  it('tells wines apart from other products', () => {
    expect(looksLikeWine('Magnum Chianti Classico DOCG')).toBe(true);
    expect(looksLikeWine('Magnum Saint-Emilion', 'Rotweine')).toBe(true);
    expect(looksLikeWine('Magnum Bonbon Salted Caramel & Almond', 'Glace')).toBe(false);
  });
});

describe('BrandIndex', () => {
  it('writes each brand the same way everywhere: mixed case, then as in names', () => {
    const index = new BrandIndex([
      aldi('COCA-COLA', 'Zero'),
      aldi('COCA-COLA', 'Original'),
      coop('Coca Cola', 'Coca-Cola Zero 6x1,5l'),
      coop('Coca Cola', 'Coca-Cola Original 6x50cl'),
      aldi('OATLY', 'Haferdrink'),
      coop('OATLY', 'Oatly Haferdrink Barista 1l'),
      aldi('MILSANI', 'Vollmilch'),
    ]);
    expect(index.spelling('COCA-COLA')).toBe('Coca-Cola');
    expect(index.spelling('coca cola')).toBe('Coca-Cola');
    expect(index.spelling('OATLY')).toBe('Oatly');
    expect(index.spelling('MILSANI')).toBe('MILSANI'); // the only spelling there is
    index.add(coop('À Table!', 'À Table! Korkenzieher'));
    expect(index.spelling('a table')).toBe('À Table!');
    expect(index.spelling('Unknown Brand')).toBe('Unknown Brand');
  });

  it('recognises brands that stores publish, at the start of names', () => {
    const index = new BrandIndex([
      coop('Feldschlösschen', 'Feldschlösschen Original 6x50cl'),
      coop('Feldschlösschen', 'Feldschlösschen Weizen 6x50cl'),
      coop('Dr. Oetker', 'Dr. Oetker Pudding Vanille'),
      coop('Dr. Oetker', 'Dr. Oetker Backpulver'),
      coop('Dr. Oetker Ristorante', 'Dr. Oetker Ristorante Pizza Margherita'),
      coop('Dr. Oetker Ristorante', 'Dr. Oetker Ristorante Pizza Funghi'),
      // Sold by two stores; Aldi names never show the brand.
      aldi('NIVEA', 'Duschgel'),
      coop('Nivea', 'Nivea Creme 150ml'),
      coop('Nivea', 'Nivea Duschgel 250ml'),
    ]);
    expect(index.recognise('Feldschlösschen Bier Original')).toBe('Feldschlösschen');
    expect(index.recognise('Dr. Oetker Ristorante Piadina Prosciutto')).toBe(
      'Dr. Oetker Ristorante',
    );
    expect(index.recognise('Dr. Oetker Pudding Schoko')).toBe('Dr. Oetker');
    expect(index.recognise('Nivea Pflegedusche Orange')).toBe('Nivea');
    expect(index.recognise('Satsumas')).toBeNull();
    // A name that is only the brand says nothing about what the product is.
    expect(index.recognise('Feldschlösschen')).toBeNull();
  });

  it('needs evidence: names that start with the brand, or several stores', () => {
    const index = new BrandIndex([
      // Only one product: not enough to trust it.
      coop('Zweifel', 'Zweifel Chips Paprika'),
      // Coop publishes "Nestlé", but most names start with the product line.
      coop('Nestlé', 'Cini Minis 375g'),
      coop('Nestlé', 'Nesquik 1kg'),
      coop('Nestlé', 'Lion Cereals'),
      coop('Nestlé', 'Nestlé Fitness 375g'),
      // A brand only stores without brands in names publish, in one store.
      aldi('GOLDEN BRIDGE', 'Honig'),
      aldi('GOLDEN BRIDGE', 'Konfitüre'),
      // Generic words that stores put in their brand field.
      aldi('BIO', 'Bananen'),
      aldi('BIO', 'Karotten'),
      { brand: 'Bio', name: 'Bio Bananen', store: 'lidl', brandInName: false },
    ]);
    expect(index.recognise('Zweifel Chips Nature')).toBeNull();
    expect(index.recognise('Nestlé LC1 Joghurt')).toBeNull();
    expect(index.recognise('Golden Bridge Akazienhonig')).toBeNull();
    expect(index.recognise('Bio Vollmilch')).toBeNull();

    // Once a second store sells Nestlé, a quarter of names starting with it is enough.
    index.add({ brand: 'NESTLE', name: 'LC1 Joghurt', store: 'aldi', brandInName: false });
    index.add(coop('Nestlé', 'Nestlé Le Parfait'));
    expect(index.recognise('Nestlé LC1 Joghurt')).toBe('Nestlé');
  });

  it('does not take a wine bottle size for the ice cream brand', () => {
    const index = new BrandIndex([
      coop('Magnum', 'Magnum Classic 4x110ml'),
      coop('Magnum', 'Magnum Mandel 4x110ml'),
    ]);
    expect(index.recognise('Magnum Bonbon Salted Caramel & Almond')).toBe('Magnum');
    expect(index.recognise('Magnum Chianti Classico DOCG Sangiovese')).toBeNull();
    expect(index.recognise('Magnum Château Lafleur', 'Rotweine')).toBeNull();
  });
});

describe('store brand fields', () => {
  it('Coop: the origin of a wine is not its brand', () => {
    const wine = normalizeCoopProduct({
      code: '1',
      title: '19 Crimes Cabernet Sauvignon South Eastern Australia',
      originText: 'Australien, 2024',
      wine: true,
    });
    const beer = normalizeCoopProduct({
      code: '2',
      title: '1664 Bier Blanc 6x33cl',
      originText: 'Kronenbourg',
      wine: false,
    });
    expect(wine?.brand).toBeNull();
    expect(beer?.brand).toBe('Kronenbourg');
  });

  it('Migros: the brand of a product card, or the one in its title', () => {
    expect(
      normalizeMigrosProduct({
        uid: 1,
        name: 'Cheese Spread',
        title: 'Kiri · Cheese Spread',
        brand: 'Kiri',
      })?.brand,
    ).toBe('Kiri');
    expect(
      normalizeMigrosProduct({ uid: 2, name: 'Vollmilch', title: 'M-Classic · Vollmilch' })?.brand,
    ).toBe('M-Classic');
    expect(
      normalizeMigrosProduct({
        uid: 3,
        name: 'Butter',
        productInformation: { mainInformation: { brand: { name: 'Floralp' } } },
      })?.brand,
    ).toBe('Floralp');
    expect(normalizeMigrosProduct({ uid: 4, name: 'Äpfel', title: 'Äpfel' })?.brand).toBeNull();
    expect(
      normalizeMigrosProduct({ uid: 5, name: 'Reis', brand: { name: 'Uncle Ben’s' } })?.brand,
    ).toBe('Uncle Ben’s');
    // An unexpected shape costs the brand, not the product.
    expect(normalizeMigrosProduct({ uid: 6, name: 'Reis', brand: 42 })).toMatchObject({
      brand: null,
    });
  });
});

describe('refreshBrands', () => {
  let db: Database;
  beforeEach(() => {
    db = Database.open(':memory:');
    saveProducts(
      db,
      [
        makeProduct({
          store: 'coop',
          storeProductId: 'c1',
          name: 'Feldschlösschen Original 6x50cl',
          brand: 'Feldschlösschen',
        }),
        makeProduct({
          store: 'coop',
          storeProductId: 'c2',
          name: 'Feldschlösschen Weizen 6x50cl',
          brand: 'Feldschlösschen',
        }),
        makeProduct({
          store: 'aldi',
          storeProductId: 'a1',
          name: 'Lager',
          brand: 'FELDSCHLÖSSCHEN',
        }),
        makeProduct({
          store: 'denner',
          storeProductId: 'd1',
          name: 'Feldschlösschen Bier Original',
        }),
        makeProduct({ store: 'denner', storeProductId: 'd2', name: 'Denner Lachsfilets' }),
        makeProduct({ store: 'denner', storeProductId: 'd3', name: 'Satsumas' }),
        // Aldi names do not contain brands: nothing is recognised there.
        makeProduct({ store: 'aldi', storeProductId: 'a2', name: 'Feldschlösschen Becher' }),
      ],
      T1,
    );
  });
  afterEach(() => db.close());

  const brandOf = (id: string) =>
    db.get<{
      brand: string | null;
      brand_source: string | null;
      brand_key: string | null;
      updated_at: string;
    }>('SELECT brand, brand_source, brand_key, updated_at FROM products WHERE id = $id', { id });

  it('fills brands from the stores and from names, then leaves them alone', () => {
    expect(refreshBrands(db, STORES, T2)).toEqual({ changed: 3, fromNames: 2 });
    expect(brandOf('denner:d1')).toEqual({
      brand: 'Feldschlösschen',
      brand_source: 'name',
      brand_key: 'feldschlosschen',
      updated_at: T2, // so the next sync sends it
    });
    expect(brandOf('denner:d2')).toMatchObject({ brand: 'Denner', brand_source: 'name' });
    expect(brandOf('denner:d3')).toMatchObject({ brand: null, brand_source: null });
    // The store's brand keeps its source, written like in the other stores.
    expect(brandOf('aldi:a1')).toMatchObject({ brand: 'Feldschlösschen', brand_source: 'store' });
    expect(brandOf('aldi:a2')).toMatchObject({ brand: null });
    expect(brandOf('coop:c1')).toMatchObject({ brand: 'Feldschlösschen', updated_at: T1 });

    expect(refreshBrands(db, STORES, T3)).toEqual({ changed: 0, fromNames: 2 });
    expect(brandsNeedRefresh(db)).toBe(false);
  });

  it('keeps a recognised brand when the store lists the product again', () => {
    refreshBrands(db, STORES, T2);
    saveProducts(
      db,
      [
        makeProduct({
          store: 'denner',
          storeProductId: 'd1',
          name: 'Feldschlösschen Bier Original',
          price: 9.95,
        }),
      ],
      T3,
    );
    expect(brandOf('denner:d1')).toMatchObject({ brand: 'Feldschlösschen', brand_source: 'name' });
  });

  it('filters by brand (accents and case optional) and sums brands up per store', () => {
    refreshBrands(db, STORES, T2);
    const ids = (brands: string[]) =>
      searchProducts(db, { query: '', brands })
        .rows.map((r) => r.id)
        .sort();
    expect(ids(['feldschlösschen'])).toEqual(['aldi:a1', 'coop:c1', 'coop:c2', 'denner:d1']);
    expect(ids(['FELDSCHLOESSCHEN'])).toHaveLength(4);
    expect(ids(['denner', 'unknown'])).toEqual(['denner:d2']);

    const [top] = brandSummaries(db);
    expect(top).toEqual({
      brand: 'Feldschlösschen',
      key: 'feldschlosschen',
      products: 4,
      stores: [
        { store: 'coop', products: 2 },
        { store: 'aldi', products: 1 },
        { store: 'denner', products: 1 },
      ],
      fromNames: 1,
    });
    expect(brandSummaries(db, { stores: ['denner'] }).map((b) => b.brand)).toEqual([
      'Denner',
      'Feldschlösschen',
    ]);
    expect(brandSummaries(db, { query: 'schlossch' })).toEqual([]);
    expect(brandSummaries(db, { query: 'feld' }).map((b) => b.brand)).toEqual(['Feldschlösschen']);
  });

  it('is needed after an upgrade, when brands have no key yet', () => {
    expect(brandsNeedRefresh(db)).toBe(false);
    db.run('UPDATE products SET brand_key = NULL');
    expect(brandsNeedRefresh(db)).toBe(true);
  });

  it('a brand key is the lowercase, accent-free brand', () => {
    expect(brandKey('Nestlé')).toBe('nestle');
    expect(brandKey('  Coca-Cola ')).toBe('coca cola');
    // However a store or a user writes the umlaut.
    for (const spelling of ['Feldschlösschen', 'FELDSCHLOESSCHEN', 'feldschlosschen']) {
      expect(brandKey(spelling)).toBe('feldschlosschen');
    }
  });
});

describe('upgrading a database from before brand sources', () => {
  it('keeps store brands, drops the wine origins Coop gave as brands, and marks them changed', () => {
    const dir = mkdtempSync(join(tmpdir(), 'swiss-grocery-v2-'));
    const path = join(dir, 'grocery.db');
    const { DatabaseSync } = loadSqlite();
    const old = new DatabaseSync(path);
    old.exec(`${MIGRATIONS[0]}${MIGRATIONS[1]} PRAGMA user_version = 2;`);
    const insert = old.prepare(
      `INSERT INTO products (id, store, store_product_id, name, brand, search_text, content_hash,
         first_seen_at, last_seen_at, updated_at)
       VALUES (?, ?, ?, ?, ?, '', '', ?, ?, ?)`,
    );
    for (const [id, name, brand] of [
      ['1', 'Naturaplan Bio Rindshackfleisch', 'Naturaplan'],
      ['2', 'Bordeaux AOC Château X', 'Frankreich, 2022'],
      ['3', 'Côtes du Rhône AOC', 'Frankreich'],
      ['4', 'Chianti DOCG', 'Italien, 2021'],
    ] as const) {
      insert.run(`coop:${id}`, 'coop', id, name, brand, T1, T1, T1);
    }
    old.close();

    const db = Database.open(path);
    expect(db.upgradedFrom).toBe(2);
    const rows = db.all<{
      id: string;
      brand: string | null;
      brand_source: string | null;
      updated_at: string;
    }>('SELECT id, brand, brand_source, updated_at FROM products ORDER BY id');
    expect(rows.map((r) => [r.id, r.brand, r.brand_source])).toEqual([
      ['coop:1', 'Naturaplan', 'store'],
      ['coop:2', null, null],
      ['coop:3', null, null],
      ['coop:4', null, null],
    ]);
    expect(rows[0]?.updated_at).toBe(T1);
    expect((rows[1]?.updated_at ?? '') > T1).toBe(true); // so the next sync clears it remotely too
    expect(brandsNeedRefresh(db)).toBe(true);
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });
});
