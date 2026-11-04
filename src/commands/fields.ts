import type { ProductDetails } from '../normalization/types.js';
import { getProvider } from '../providers/index.js';
import type { ProductRow } from '../storage/queries.js';
import { formatChf, formatDate, formatOffer, formatUnitPrice } from '../ui/format.js';
import { UserError } from './shared.js';

type Value = string | number | null;

export interface Field {
  key: string;
  description: string;
  /** Raw value, for exports and JSON. */
  value: (row: ProductRow) => Value;
  /** Text shown in tables (defaults to the raw value). */
  display?: (row: ProductRow) => string;
}

function details(row: ProductRow): ProductDetails {
  return row.details ? (JSON.parse(row.details) as ProductDetails) : {};
}

function labels(row: ProductRow): string[] {
  return JSON.parse(row.labels) as string[];
}

function size(row: ProductRow): string | null {
  return row.size_text;
}

export const FIELDS: Field[] = [
  { key: 'id', description: 'product id, e.g. aldi:288415 (use with `show`)', value: (r) => r.id },
  {
    key: 'store',
    description: 'store name',
    value: (r) => r.store,
    display: (r) => getProvider(r.store).info.name,
  },
  { key: 'name', description: 'product name', value: (r) => r.name },
  { key: 'brand', description: 'brand', value: (r) => r.brand },
  {
    key: 'brand_source',
    description: 'where the brand comes from: store (its brand field) or name (recognised in it)',
    value: (r) => r.brand_source,
  },
  { key: 'size', description: 'size as printed by the store', value: size },
  {
    key: 'price',
    description: 'price you pay today, CHF',
    value: (r) => r.price,
    display: (r) => formatChf(r.price),
  },
  {
    key: 'regular_price',
    description: 'price before the promotion, CHF',
    value: (r) => r.regular_price,
    display: (r) => formatChf(r.regular_price),
  },
  {
    key: 'loyalty_price',
    description: 'price with the store app/card (Lidl Plus), CHF',
    value: (r) => r.loyalty_price,
    display: (r) => formatChf(r.loyalty_price),
  },
  {
    key: 'unit_price',
    description: 'price per kg, litre or piece, CHF',
    value: (r) => r.unit_price,
    display: (r) => formatUnitPrice(r.unit_price, r.unit_price_basis),
  },
  {
    key: 'unit',
    description: 'what the unit price refers to: kg, l or piece',
    value: (r) => r.unit_price_basis,
  },
  {
    key: 'promo',
    description: 'promotion text, e.g. -20%',
    value: (r) => r.promo_label,
    display: (r) => formatOffer(r),
  },
  {
    key: 'valid_from',
    description: 'offer starts (ISO date)',
    value: (r) => r.valid_from,
    display: (r) => formatDate(r.valid_from),
  },
  {
    key: 'valid_until',
    description: 'offer ends (ISO date)',
    value: (r) => r.valid_until,
    display: (r) => formatDate(r.valid_until),
  },
  { key: 'category', description: 'category path in the store', value: (r) => r.category_path },
  {
    key: 'labels',
    description: 'labels and certifications',
    value: (r) => labels(r).join(', ') || null,
  },
  { key: 'url', description: 'product page', value: (r) => r.url },
  { key: 'image_url', description: 'product image', value: (r) => r.image_url },
  {
    key: 'gtin',
    description: 'barcode (EAN/GTIN), when the store publishes it',
    value: (r) => r.gtin,
  },
  {
    key: 'quantity',
    description: 'total amount in g, ml or pieces',
    value: (r) => r.quantity_amount,
  },
  { key: 'quantity_unit', description: 'g, ml or piece', value: (r) => r.quantity_unit },
  { key: 'pack_count', description: 'items in a multipack', value: (r) => r.pack_count },
  {
    key: 'description',
    description: 'description (needs --details when fetching)',
    value: (r) => details(r).description ?? null,
  },
  {
    key: 'ingredients',
    description: 'ingredients (needs --details)',
    value: (r) => details(r).ingredients ?? null,
  },
  {
    key: 'allergens',
    description: 'allergens (needs --details)',
    value: (r) => details(r).allergens?.join(', ') ?? null,
  },
  {
    key: 'nutrition',
    description: 'nutrition facts (needs --details)',
    value: (r) => {
      const n = details(r).nutrition;
      return n
        ? Object.entries(n)
            .map(([k, v]) => `${k}: ${v}`)
            .join('; ')
        : null;
    },
  },
  {
    key: 'origin',
    description: 'country of origin (needs --details)',
    value: (r) => details(r).origin ?? null,
  },
  {
    key: 'storage',
    description: 'storage instructions (needs --details)',
    value: (r) => details(r).storage ?? null,
  },
  {
    key: 'rating',
    description: 'customer rating (needs --details)',
    value: (r) => {
      const rating = details(r).rating;
      return rating ? `${rating.average} (${rating.count})` : null;
    },
  },
  {
    key: 'first_seen',
    description: 'first time this tool saw the product',
    value: (r) => r.first_seen_at,
  },
  { key: 'last_seen', description: 'last time the store listed it', value: (r) => r.last_seen_at },
  {
    key: 'removed_at',
    description: 'when the store stopped listing it',
    value: (r) => r.removed_at,
  },
  {
    key: 'price_checked_at',
    description: 'when the price was last checked',
    value: (r) => r.observed_at,
  },
  {
    key: 'source_title',
    description: "the store's cleaned original product title",
    value: (r) => r.source_title,
  },
  {
    key: 'variant',
    description: 'variant, e.g. doux or 001 noir (only when certain)',
    value: (r) => r.variant,
  },
  {
    key: 'version_text',
    description: "the store's cleaned variant or version line",
    value: (r) => r.version_text,
  },
];

export const DEFAULT_EXPORT_FIELDS = [
  'id',
  'store',
  'name',
  'brand',
  'size',
  'price',
  'regular_price',
  'unit_price',
  'unit',
  'promo',
  'valid_from',
  'valid_until',
  'category',
  'url',
];

/** Parses `--fields brand,category` or `--fields all`. */
export function parseFields(value: string | undefined, defaults: string[]): Field[] {
  if (!value) return defaults.map((key) => FIELDS.find((f) => f.key === key) as Field);
  if (value.trim().toLowerCase() === 'all') return FIELDS;
  const keys = value
    .split(',')
    .map((k) => k.trim().toLowerCase().replace(/-/g, '_'))
    .filter(Boolean);
  const unknown = keys.filter((k) => !FIELDS.some((f) => f.key === k));
  if (unknown.length > 0) {
    throw new UserError(`Unknown field${unknown.length > 1 ? 's' : ''}: ${unknown.join(', ')}.`, [
      `Available fields: ${FIELDS.map((f) => f.key).join(', ')}`,
      'See what each one means with: swiss-grocery fields',
    ]);
  }
  return keys.map((key) => FIELDS.find((f) => f.key === key) as Field);
}

export function rowToObject(row: ProductRow, fields: Field[]): Record<string, Value> {
  return Object.fromEntries(fields.map((f) => [f.key, f.value(row)]));
}
