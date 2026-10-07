import { describe, expect, it } from 'vitest';
import {
  computeUnitPrice,
  parseComparisonPrice,
  parseMoney,
  unitPriceFrom,
} from '../../src/normalization/price.js';
import { parsePriceBasis, parseQuantity } from '../../src/normalization/quantity.js';
import {
  cleanText,
  decodeEntities,
  htmlListItems,
  searchKey,
} from '../../src/normalization/text.js';
import type { NormalizedProduct } from '../../src/normalization/types.js';
import { checkProduct } from '../../src/normalization/validate.js';

describe('parseQuantity', () => {
  it.each([
    ['250 g', { amount: 250, unit: 'g', packCount: 1 }],
    ['1 kg', { amount: 1000, unit: 'g', packCount: 1 }],
    ['1,5 l', { amount: 1500, unit: 'ml', packCount: 1 }],
    ['1.5L', { amount: 1500, unit: 'ml', packCount: 1 }],
    ['75 cl', { amount: 750, unit: 'ml', packCount: 1 }],
    ['2,5 dl', { amount: 250, unit: 'ml', packCount: 1 }],
    ['6 x 1.5 l', { amount: 9000, unit: 'ml', packCount: 6 }],
    ['6x1,5l', { amount: 9000, unit: 'ml', packCount: 6 }],
    ['6 × 0.33 l', { amount: 1980, unit: 'ml', packCount: 6 }],
    ['à 6 x 75 cl', { amount: 4500, unit: 'ml', packCount: 6 }],
    ['4 Stück à 125 g', { amount: 500, unit: 'g', packCount: 4 }],
    ['ca. 300 g', { amount: 300, unit: 'g', packCount: 1 }],
    ['1 unit.kg', { amount: 1000, unit: 'g', packCount: 1 }],
    ['Klasse I, per kg', { amount: 1000, unit: 'g', packCount: 1 }],
    ['Pro 1000 ml', { amount: 1000, unit: 'ml', packCount: 1 }],
    ['10 Stück', { amount: 10, unit: 'piece', packCount: 1 }],
    ['6er Pack', { amount: 6, unit: 'piece', packCount: 1 }],
    ['Pro Stück', { amount: 1, unit: 'piece', packCount: 1 }],
    ['1.1 kg', { amount: 1100, unit: 'g', packCount: 1 }],
    ['Pro 4400 Blatt', { amount: 4400, unit: 'piece', packCount: 1 }],
    ['90 Waschgänge', { amount: 90, unit: 'piece', packCount: 1 }],
    ['Pro Set', { amount: 1, unit: 'piece', packCount: 1 }],
    ['Pro Packung', { amount: 1, unit: 'piece', packCount: 1 }],
  ])('parses %j', (text, expected) => {
    expect(parseQuantity(text)).toEqual(expected);
  });

  it.each(['Höhe: ca. 30 cm', '', 'Diverse Farben', 'Glas'])('returns null for %j', (text) => {
    expect(parseQuantity(text)).toBeNull();
  });

  it('does not read unit letters inside words', () => {
    expect(parseQuantity('500 Gläser')).toBeNull();
  });
});

describe('parsePriceBasis', () => {
  it('finds the amount a weight-based price refers to', () => {
    // Denner prices meat per 100 g although the pack is about 800 g.
    const text = 'am Stück, Uruguay/Argentinien, ca. 800 g, per 100 g';
    expect(parsePriceBasis(text)).toEqual({ amount: 100, unit: 'g', packCount: 1 });
    expect(computeUnitPrice(2.95, parsePriceBasis(text))).toEqual({
      unitPrice: 29.5,
      unitPriceBasis: 'kg',
    });
    expect(parsePriceBasis('Klasse I, per kg')).toEqual({ amount: 1000, unit: 'g', packCount: 1 });
    expect(parsePriceBasis('Spanien, 1 kg')).toBeNull();
    expect(parsePriceBasis('Pro Stück')).toBeNull();
  });
});

describe('prices', () => {
  it('parses money and treats 0 as "no price"', () => {
    expect(parseMoney('CHF 3.85')).toBe(3.85);
    expect(parseMoney('statt 2.80')).toBe(2.8);
    expect(parseMoney('3,85')).toBe(3.85);
    expect(parseMoney(1.99)).toBe(1.99);
    expect(parseMoney(0)).toBeNull();
    expect(parseMoney('0.00')).toBeNull();
    expect(parseMoney(null)).toBeNull();
  });

  it('computes unit prices per kg, litre and piece', () => {
    expect(computeUnitPrice(3.85, { amount: 250, unit: 'g', packCount: 1 })).toEqual({
      unitPrice: 15.4,
      unitPriceBasis: 'kg',
    });
    expect(computeUnitPrice(9.95, { amount: 9000, unit: 'ml', packCount: 6 })).toEqual({
      unitPrice: 1.1056,
      unitPriceBasis: 'l',
    });
    expect(computeUnitPrice(4.5, { amount: 10, unit: 'piece', packCount: 1 })).toEqual({
      unitPrice: 0.45,
      unitPriceBasis: 'piece',
    });
    expect(computeUnitPrice(null, { amount: 10, unit: 'piece', packCount: 1 })).toBeNull();
  });

  it('parses store comparison prices', () => {
    expect(parseComparisonPrice('CHF 1.54/100 g')).toEqual({
      unitPrice: 15.4,
      unitPriceBasis: 'kg',
    });
    expect(parseComparisonPrice('100 ml = 37.19')).toEqual({
      unitPrice: 371.9,
      unitPriceBasis: 'l',
    });
    expect(parseComparisonPrice('1 kg = 15.40')).toEqual({ unitPrice: 15.4, unitPriceBasis: 'kg' });
    expect(parseComparisonPrice('nothing here')).toBeNull();
    expect(unitPriceFrom(0.45, 1, 'Stück')).toEqual({ unitPrice: 0.45, unitPriceBasis: 'piece' });
  });
});

describe('text', () => {
  it('decodes entities and strips HTML', () => {
    expect(decodeEntities('H&ouml;he &amp; Gr&ouml;sse &#39;x&#x27;')).toBe("Höhe & Grösse 'x'");
    expect(cleanText('<ul> <li>H&ouml;he: ca. 30 cm</li> <li>Pro St&uuml;ck</li> </ul>')).toBe(
      'Höhe: ca. 30 cm\nPro Stück',
    );
    expect(cleanText('   ')).toBeNull();
    expect(htmlListItems('<ul><li>Pro 16 ml</li><li>100 ml = 37.19</li></ul>')).toEqual([
      'Pro 16 ml',
      '100 ml = 37.19',
    ]);
  });

  it('builds accent-insensitive search keys', () => {
    expect(searchKey('Käse Gruyère')).toBe('kaese gruyere');
    expect(searchKey('Coca-Cola Zero')).toBe('coca cola zero');
    expect(searchKey('Crème brûlée')).toBe('creme brulee');
    expect(searchKey('Süssmost')).toBe('suessmost');
  });
});

describe('checkProduct', () => {
  const base: NormalizedProduct = {
    store: 'aldi',
    storeProductId: '1',
    name: 'Butter',
    brand: null,
    categoryPath: [],
    sizeText: '250 g',
    quantity: { amount: 250, unit: 'g', packCount: 1 },
    price: 3.85,
    regularPrice: null,
    loyaltyPrice: null,
    promoLabel: null,
    validFrom: null,
    validUntil: null,
    unitPrice: 15.4,
    unitPriceBasis: 'kg',
    labels: [],
    url: null,
    imageUrl: null,
    sourceRef: {},
  };

  it('rejects products without id or name', () => {
    expect(checkProduct({ ...base, storeProductId: ' ' }).ok).toBe(false);
    expect(checkProduct({ ...base, name: '' }).ok).toBe(false);
  });

  it('drops a regular price that is not higher than the current price', () => {
    const result = checkProduct({ ...base, regularPrice: 3.85 });
    expect(result.ok && result.product.regularPrice).toBeNull();
  });

  it('drops implausible prices and their unit price', () => {
    const result = checkProduct({ ...base, price: 99999 });
    expect(result.ok && result.product.price).toBeNull();
    expect(result.ok && result.product.unitPrice).toBeNull();
    expect(result.ok && result.warnings).toEqual(['implausible price 99999']);
  });

  it('drops impossible sizes such as a 750 kg muesli', () => {
    const result = checkProduct({
      ...base,
      sizeText: '750 kg',
      quantity: { amount: 750_000, unit: 'g', packCount: 1 },
      unitPrice: 0.004,
    });
    expect(result.ok && result.product.quantity).toBeNull();
    expect(result.ok && result.product.unitPrice).toBeNull();
  });

  it('keeps tiny per-piece prices (toilet paper sheets)', () => {
    expect(computeUnitPrice(9.95, { amount: 4400, unit: 'piece', packCount: 1 })).toEqual({
      unitPrice: 0.0023,
      unitPriceBasis: 'piece',
    });
  });

  it('clears inverted promotion dates', () => {
    const result = checkProduct({
      ...base,
      validFrom: '2026-10-10T00:00:00.000Z',
      validUntil: '2026-10-01T00:00:00.000Z',
    });
    expect(result.ok && result.product.validUntil).toBeNull();
  });
});
