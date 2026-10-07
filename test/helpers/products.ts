import type { NormalizedProduct } from '../../src/normalization/types.js';

export function makeProduct(overrides: Partial<NormalizedProduct> = {}): NormalizedProduct {
  return {
    store: 'aldi',
    storeProductId: '288415',
    name: 'Butter',
    brand: null,
    categoryPath: ['Milchprodukte & Eier', 'Butter, Milch & Rahm'],
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
    url: 'https://www.aldi-suisse.ch/de/produkt/no-brand-butter-000000000000288415',
    imageUrl: null,
    sourceRef: { sku: '000000000000288415' },
    ...overrides,
  };
}
