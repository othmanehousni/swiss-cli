import { PIECE_PATTERN, toBaseAmount, UNIT_PATTERN } from './quantity.js';
import type { Quantity, UnitPriceBasis } from './types.js';

export interface UnitPrice {
  unitPrice: number;
  unitPriceBasis: UnitPriceBasis;
}

/** Unit prices keep 4 decimals: a sheet of toilet paper costs about CHF 0.0023. */
function roundUnit(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}

/** Swiss price notation: "-.55" and ".55" are CHF 0.55, "5.–" is CHF 5.00. */
function swissAmounts(text: string): string {
  return text.replace(/(^|[^\d])[-–]?\.(\d{2})(?!\d)/g, '$10.$2').replace(/(\d)\.[-–]/g, '$1.00');
}

/** Parses a CHF amount from numbers or strings like "CHF 3.85", "3.85", "3,85", "3.–", "-.55". */
export function parseMoney(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) && value > 0 ? value : null;
  if (typeof value !== 'string') return null;
  const match = /(\d+(?:[.,]\d{1,2})?)/.exec(swissAmounts(value.replace(/['’]/g, '')));
  if (!match) return null;
  const amount = Number((match[1] as string).replace(',', '.'));
  // A price of 0 is how several stores encode "no price" (e.g. Lidl's oldPrice: 0.0).
  return amount > 0 ? amount : null;
}

/** CHF per kg / l / piece for a price and a parsed quantity. */
export function computeUnitPrice(
  price: number | null,
  quantity: Quantity | null,
): UnitPrice | null {
  if (price == null || !quantity || !(quantity.amount > 0)) return null;
  if (quantity.unit === 'piece') {
    return { unitPrice: roundUnit(price / quantity.amount), unitPriceBasis: 'piece' };
  }
  return {
    unitPrice: roundUnit(price / (quantity.amount / 1000)),
    unitPriceBasis: quantity.unit === 'g' ? 'kg' : 'l',
  };
}

/** Converts "price per <amount> <unit>" into CHF per kg / l / piece. */
export function unitPriceFrom(
  price: number,
  perAmount: number,
  unitWord: string,
): UnitPrice | null {
  if (!(price > 0) || !(perAmount > 0)) return null;
  if (new RegExp(`^(?:${PIECE_PATTERN})$`).test(unitWord.toLowerCase())) {
    return { unitPrice: roundUnit(price / perAmount), unitPriceBasis: 'piece' };
  }
  const base = toBaseAmount(perAmount, unitWord);
  if (!base || base.unit === 'piece') return null;
  return {
    unitPrice: roundUnit(price / (base.amount / 1000)),
    unitPriceBasis: base.unit === 'g' ? 'kg' : 'l',
  };
}

const PRICE_PER = new RegExp(
  `(?:chf\\s*)?(\\d+(?:\\.\\d+)?)\\s*/\\s*(\\d+(?:\\.\\d+)?)?\\s*(${UNIT_PATTERN}|${PIECE_PATTERN})(?![a-z])`,
);
const AMOUNT_EQUALS = new RegExp(
  `(\\d+(?:\\.\\d+)?)?\\s*(${UNIT_PATTERN}|${PIECE_PATTERN})\\s*=\\s*(?:chf\\s*)?(\\d+(?:\\.\\d+)?)`,
);

/**
 * Parses comparison prices printed by stores, e.g. "CHF 1.54/100 g", "100 ml = 37.19" or
 * "1 Stück = -.55".
 * Used when a product's own size could not be parsed.
 */
export function parseComparisonPrice(text: string | null | undefined): UnitPrice | null {
  if (!text) return null;
  const s = swissAmounts(text.toLowerCase().replace(/(\d),(\d)/g, '$1.$2'));
  const per = PRICE_PER.exec(s);
  if (per) return unitPriceFrom(Number(per[1]), Number(per[2] ?? 1), per[3] as string);
  const eq = AMOUNT_EQUALS.exec(s);
  if (eq) return unitPriceFrom(Number(eq[3]), Number(eq[1] ?? 1), eq[2] as string);
  return null;
}
