import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { FIELDS } from '../../src/commands/fields.js';
import { classifyVersioning, normalizeMigrosProduct } from '../../src/providers/migros.js';
import { Database } from '../../src/storage/database.js';
import { saveProducts } from '../../src/storage/products.js';
import { findProducts } from '../../src/storage/queries.js';

type RawMigrosProduct = Parameters<typeof normalizeMigrosProduct>[0];

/** Synthetic input shaped like a Migros product card; it is not a captured source response. */
function syntheticCard(overrides: Partial<RawMigrosProduct> = {}) {
  return normalizeMigrosProduct({
    uid: 1,
    migrosId: 'synthetic-product',
    name: 'Tourist',
    brand: 'Frey',
    offer: { price: { effectiveValue: 2.2 }, quantity: '100g' },
    ...overrides,
  });
}

describe('Migros title preservation (synthetic product cards)', () => {
  it('keeps name canonical and preserves a separately cleaned title', () => {
    expect(
      syntheticCard({
        name: 'Crunchy bar',
        title: '  Example Brand <b>Crunchy bar dark</b>  ',
        brand: 'Example Brand',
      }),
    ).toMatchObject({
      name: 'Crunchy bar',
      brand: 'Example Brand',
      sourceTitle: 'Example Brand Crunchy bar dark',
    });
  });

  it('keeps a name when no title is present', () => {
    expect(syntheticCard({ name: 'Name only', title: undefined })).toMatchObject({
      name: 'Name only',
      sourceTitle: null,
    });
  });

  it('retains the legacy title fallback when no name is present', () => {
    expect(syntheticCard({ name: undefined, title: '  Title only  ' })).toMatchObject({
      name: 'Title only',
      sourceTitle: 'Title only',
    });
  });

  it('ignores an empty title without changing the name', () => {
    expect(syntheticCard({ name: 'Name only', title: ' \t\n ' })).toMatchObject({
      name: 'Name only',
      sourceTitle: null,
    });
  });

  it('can derive a missing brand from a title without duplicating it into the name', () => {
    expect(
      syntheticCard({ name: 'Cheese Spread', title: 'Kiri · Cheese Spread', brand: undefined }),
    ).toMatchObject({
      name: 'Cheese Spread',
      brand: 'Kiri',
      sourceTitle: 'Kiri · Cheese Spread',
    });
  });
});

describe('classifyVersioning', () => {
  it.each([
    ['doux', 'variant'],
    ['affiné en grotte', 'variant'],
    ['à la truffe', 'variant'],
    ['noir, résistant à l’eau', 'variant'],
    ['001 noir extrême', 'variant'],
    ['24 mois', 'variant'],
    ['100g', 'quantity'],
    ['6 x 35g', 'quantity'],
    ['24 pastilles', 'quantity'],
    ['350 grammes', 'quantity'],
    ['1300 Tabl.', 'quantity'],
    ['le kg', 'quantity'],
    ['175', 'unclear'],
    ['8x100', 'unclear'],
    ['Ø 65cm', 'unclear'],
    ['dès 6 mois', 'unclear'],
    ['Packungsgrösse\n60ml', 'unclear'],
    ['x'.repeat(61), 'unclear'],
  ])('%j is %s', (text, kind) => {
    expect(classifyVersioning(text)).toBe(kind);
  });
});

describe('Migros versioning preservation (synthetic product cards)', () => {
  it('keeps an explicit quantity and a classified variant apart', () => {
    expect(syntheticCard({ versioning: 'Lait' })).toMatchObject({
      sizeText: '100g',
      variant: 'Lait',
      versionText: 'Lait',
      quantity: { amount: 100, unit: 'g', packCount: 1 },
    });
  });

  it('preserves the legacy size fallback even when versioning is a variant', () => {
    expect(
      syntheticCard({ versioning: 'doux', offer: { price: {}, quantity: undefined } }),
    ).toMatchObject({
      sizeText: 'doux',
      variant: 'doux',
      versionText: 'doux',
    });
  });

  it('does not classify quantities or ambiguous lines as variants', () => {
    expect(
      syntheticCard({ versioning: '24 pastilles', offer: { price: {}, quantity: undefined } }),
    ).toMatchObject({ sizeText: '24 pastilles', variant: null, versionText: '24 pastilles' });
    expect(
      syntheticCard({ versioning: '175', offer: { price: {}, quantity: undefined } }),
    ).toMatchObject({ sizeText: '175', variant: null, versionText: '175' });
  });

  it('cleans preserved text and leaves multiline or missing values unclassified', () => {
    expect(syntheticCard({ versioning: '<b>doux</b>' })).toMatchObject({
      variant: 'doux',
      versionText: 'doux',
    });
    expect(syntheticCard({ versioning: 'Packungsgrösse\n60ml' })).toMatchObject({
      sizeText: '100g',
      variant: null,
      versionText: 'Packungsgrösse\n60ml',
    });
    expect(syntheticCard({ versioning: '   ' })).toMatchObject({
      variant: null,
      versionText: null,
    });
    expect(syntheticCard({ versioning: undefined })).toMatchObject({
      variant: null,
      versionText: null,
    });
  });
});

describe('reported Migros product identities', () => {
  it('documents the three regression ids without inventing missing source titles', () => {
    // These are minimal synthetic identity cases from the bug report, not raw Migros responses.
    // Titles are deliberately absent because permitted product-card responses were unavailable.
    const products = [
      syntheticCard({ migrosId: '100103800000', name: 'Framboise intense', title: undefined }),
      syntheticCard({ migrosId: '100200600000', name: 'Chocolat au lait', title: undefined }),
      syntheticCard({ migrosId: '100102700000', name: 'M-Budget Lait', title: undefined }),
    ];

    expect(products.map((product) => [product?.storeProductId, product?.name])).toEqual([
      ['100103800000', 'Framboise intense'],
      ['100200600000', 'Chocolat au lait'],
      ['100102700000', 'M-Budget Lait'],
    ]);
    expect(products.every((product) => product?.sourceTitle === null)).toBe(true);

    const db = Database.open(':memory:');
    try {
      saveProducts(
        db,
        products.filter((product) => product !== null),
        '2026-11-04T08:00:00.000Z',
      );
      expect(findProducts(db, '100102700000').map((row) => row.name)).toEqual(['M-Budget Lait']);
      expect(findProducts(db, '100200600000').map((row) => row.name)).toEqual(['Chocolat au lait']);
    } finally {
      db.close();
    }
  });
});

describe('Migros metadata storage', () => {
  it('inserts, reads, updates and recognises unchanged metadata', () => {
    const db = Database.open(':memory:');
    try {
      const product = syntheticCard({
        migrosId: 'synthetic-storage',
        title: 'Frey · Tourist Lait',
        versioning: 'Lait',
      });
      if (!product) throw new Error('synthetic product was not normalized');

      expect(saveProducts(db, [product], '2026-11-01T08:00:00.000Z').inserted).toBe(1);
      expect(saveProducts(db, [product], '2026-11-02T08:00:00.000Z').unchanged).toBe(1);
      expect(
        saveProducts(
          db,
          [
            {
              ...product,
              sourceTitle: 'Frey · Tourist Blanc',
              variant: 'Blanc',
              versionText: 'Blanc',
            },
          ],
          '2026-11-03T08:00:00.000Z',
        ).updated,
      ).toBe(1);

      const [row] = findProducts(db, 'migros:synthetic-storage');
      expect(row).toMatchObject({
        source_title: 'Frey · Tourist Blanc',
        variant: 'Blanc',
        version_text: 'Blanc',
        size_text: '100g',
      });
      const exported = Object.fromEntries(
        FIELDS.filter((field) =>
          ['source_title', 'variant', 'version_text'].includes(field.key),
        ).map((field) => [field.key, row ? field.value(row) : null]),
      );
      expect(exported).toEqual({
        source_title: 'Frey · Tourist Blanc',
        variant: 'Blanc',
        version_text: 'Blanc',
      });
    } finally {
      db.close();
    }
  });
});

describe('Supabase metadata migrations', () => {
  function statements(name: string): string[] {
    const sql = readFileSync(new URL(`../../supabase/migrations/${name}`, import.meta.url), 'utf8')
      .replace(/--.*$/gm, '')
      .trim();
    return sql
      .split(';')
      .map((statement) => statement.trim())
      .filter(Boolean);
  }

  it('uses additive, idempotent migrations without changing published views', () => {
    const variant = statements('20261028000000_variant.sql');
    const title = statements('20261104000000_migros_source_title.sql');
    expect(variant.filter((statement) => statement.startsWith('alter table'))).toEqual([
      'alter table public.products add column if not exists variant text',
      'alter table public.products add column if not exists version_text text',
    ]);
    expect(title.filter((statement) => statement.startsWith('alter table'))).toEqual([
      'alter table public.products add column if not exists source_title text',
    ]);
    expect([...variant, ...title].join('\n')).not.toMatch(
      /\b(create or replace view|drop|update|delete)\b/i,
    );
  });
});
