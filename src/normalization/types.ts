/**
 * The common schema every store is normalized into.
 * Store-specific API shapes live in `src/providers/<store>.ts`; everything
 * downstream (storage, search, export, sync) only ever sees these types.
 */

export const STORE_IDS = [
  'migros',
  'coop',
  'denner',
  'aldi',
  'lidl',
  'volg',
  'landi',
  'ikea',
] as const;
export type StoreId = (typeof STORE_IDS)[number];

export function isStoreId(value: string): value is StoreId {
  return (STORE_IDS as readonly string[]).includes(value);
}

/** Base units: grams, millilitres or pieces. */
export type QuantityUnit = 'g' | 'ml' | 'piece';

export interface Quantity {
  /** Total amount in base units, e.g. 9000 (ml) for "6 x 1.5 l". */
  amount: number;
  unit: QuantityUnit;
  /** Items in a multipack ("6 x 1.5 l" -> 6), otherwise 1. */
  packCount: number;
}

/** Unit prices are always expressed per kg, per litre or per piece. */
export type UnitPriceBasis = 'kg' | 'l' | 'piece';

export interface ProductDetails {
  description?: string | null;
  ingredients?: string | null;
  allergens?: string[];
  /** Nutrient name -> value as printed, e.g. { "Fett": "82 g" }. */
  nutrition?: Record<string, string>;
  origin?: string | null;
  storage?: string | null;
  usage?: string | null;
  /** EAN / GTIN barcode, the key for matching one product across stores. */
  gtin?: string | null;
  rating?: { average: number; count: number } | null;
  /** Other store-specific facts worth keeping (wine region, grapes, ...). */
  extra?: Record<string, string>;
}

export interface NormalizedProduct {
  store: StoreId;
  /** The store's own stable product number. */
  storeProductId: string;
  name: string;
  brand: string | null;
  /** The store's cleaned original title, when it publishes one separately from `name`. */
  sourceTitle?: string | null;
  /** Category names from the top level down, e.g. ["Milchprodukte & Eier", "Käse"]. */
  categoryPath: string[];
  /** Size as the store prints it, e.g. "6 x 1.5 l". */
  sizeText: string | null;
  /** The product's variant as the store prints it ("doux", "001 noir extrême"), when certain. */
  variant?: string | null;
  /** The store's cleaned variant or version line, even when unclear (Migros "versioning"). */
  versionText?: string | null;
  quantity: Quantity | null;
  /** CHF a regular customer pays today (promotions included). null if no price is published. */
  price: number | null;
  /** Crossed-out price when `price` is reduced by a promotion. */
  regularPrice: number | null;
  /** Price with a loyalty app/card only (e.g. Lidl Plus); `price` stays the price without it. */
  loyaltyPrice: number | null;
  promoLabel: string | null;
  /**
   * When this price/offer applies (ISO 8601). Weekly offers and special buys
   * have a window; a start in the future means "not in stores yet".
   */
  validFrom: string | null;
  validUntil: string | null;
  /** CHF per kg / l / piece. */
  unitPrice: number | null;
  unitPriceBasis: UnitPriceBasis | null;
  labels: string[];
  url: string | null;
  imageUrl: string | null;
  /** Small store-specific identifiers needed to refresh or fetch details later. */
  sourceRef: Record<string, string>;
}

export interface Category {
  store: StoreId;
  id: string;
  parentId: string | null;
  name: string;
  /** Names from the top level down, including this category. */
  path: string[];
  productCount: number | null;
}

export function productKey(store: StoreId, storeProductId: string): string {
  return `${store}:${storeProductId}`;
}
