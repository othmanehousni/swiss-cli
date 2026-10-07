import type { NormalizedProduct } from '../normalization/types.js';
import type { Database } from './database.js';

type PriceFields = Pick<
  NormalizedProduct,
  | 'price'
  | 'regularPrice'
  | 'loyaltyPrice'
  | 'promoLabel'
  | 'validFrom'
  | 'validUntil'
  | 'unitPrice'
  | 'unitPriceBasis'
>;

interface HistoryHead {
  id: number;
  price: number;
  regular_price: number | null;
  loyalty_price: number | null;
  promo_label: string | null;
  valid_until: string | null;
  first_seen_at: string;
}

// SQL version of samePeriod for the current-price upsert ("prices" = old row, "excluded" = new).
const SAME_OFFER = `abs(prices.price - excluded.price) < 0.005
  AND prices.regular_price IS excluded.regular_price
  AND prices.loyalty_price IS excluded.loyalty_price
  AND prices.promo_label IS excluded.promo_label`;

function sameMoney(a: number | null, b: number | null): boolean {
  if (a == null || b == null) return a === b;
  return Math.abs(a - b) < 0.005;
}

/**
 * A price period is defined by the money: the price, the crossed-out price, the
 * app price and the discount label. Offer dates are details of the period, so a
 * listing that omits them (or extends them) does not start a new one.
 */
function samePeriod(head: HistoryHead, p: PriceFields): boolean {
  return (
    sameMoney(head.price, p.price) &&
    sameMoney(head.regular_price, p.regularPrice) &&
    sameMoney(head.loyalty_price, p.loyaltyPrice) &&
    head.promo_label === p.promoLabel
  );
}

/**
 * Stores the current price and extends or starts a price-history period.
 *
 * A product can be listed twice in one crawl (e.g. a wine in Denner's promotions
 * and in its wine shop), sometimes with more details in one listing. A period
 * that started during the current crawl (`runStartedAt`) is therefore merged in
 * place, keeping the richer details, instead of counting as a price change.
 * Returns true when the price changed compared to an earlier crawl.
 */
export function recordPrice(
  db: Database,
  productId: string,
  p: PriceFields,
  now: string,
  runStartedAt: string = now,
): boolean {
  if (p.price == null) return false;
  const price = p.price;
  const head = db.get<HistoryHead>(
    `SELECT id, price, regular_price, loyalty_price, promo_label, valid_until, first_seen_at
     FROM price_history WHERE product_id = $id ORDER BY id DESC LIMIT 1`,
    { id: productId },
  );

  let current: PriceFields = p;
  let changed = false;
  if (head && samePeriod(head, p)) {
    db.run(
      'UPDATE price_history SET last_seen_at = $now, valid_until = COALESCE($until, valid_until) WHERE id = $id',
      { id: head.id, now, until: p.validUntil },
    );
  } else if (head && head.first_seen_at >= runStartedAt) {
    current = {
      ...p,
      regularPrice:
        p.regularPrice ??
        (head.regular_price != null && head.regular_price > price ? head.regular_price : null),
      loyaltyPrice:
        p.loyaltyPrice ??
        (head.loyalty_price != null && head.loyalty_price < price ? head.loyalty_price : null),
      promoLabel: p.promoLabel ?? head.promo_label,
      validUntil: p.validUntil ?? head.valid_until,
    };
    db.run(
      `UPDATE price_history SET price = $price, regular_price = $regular, loyalty_price = $loyalty,
         promo_label = $label, valid_until = $until, last_seen_at = $now
       WHERE id = $id`,
      {
        id: head.id,
        price,
        regular: current.regularPrice,
        loyalty: current.loyaltyPrice,
        label: current.promoLabel,
        until: current.validUntil,
        now,
      },
    );
  } else {
    db.run(
      `INSERT INTO price_history (product_id, price, regular_price, loyalty_price, promo_label,
         valid_until, first_seen_at, last_seen_at)
       VALUES ($id, $price, $regular, $loyalty, $label, $until, $now, $now)`,
      {
        id: productId,
        price,
        regular: p.regularPrice,
        loyalty: p.loyaltyPrice,
        label: p.promoLabel,
        until: p.validUntil,
        now,
      },
    );
    changed = head !== undefined;
  }

  db.run(
    `INSERT INTO prices (product_id, price, regular_price, loyalty_price, promo_label,
       valid_from, valid_until, unit_price, unit_price_basis, observed_at)
     VALUES ($id, $price, $regular, $loyalty, $label, $from, $until, $unit, $basis, $now)
     ON CONFLICT (product_id) DO UPDATE SET
       -- Same offer seen again without dates (e.g. in another listing): keep the known dates.
       valid_from = CASE WHEN ${SAME_OFFER} THEN COALESCE(excluded.valid_from, valid_from) ELSE excluded.valid_from END,
       valid_until = CASE WHEN ${SAME_OFFER} THEN COALESCE(excluded.valid_until, valid_until) ELSE excluded.valid_until END,
       price = excluded.price, regular_price = excluded.regular_price,
       loyalty_price = excluded.loyalty_price, promo_label = excluded.promo_label,
       unit_price = excluded.unit_price, unit_price_basis = excluded.unit_price_basis,
       observed_at = excluded.observed_at`,
    {
      id: productId,
      price,
      regular: current.regularPrice,
      loyalty: current.loyaltyPrice,
      label: current.promoLabel,
      from: current.validFrom,
      until: current.validUntil,
      unit: current.unitPrice,
      basis: current.unitPriceBasis,
      now,
    },
  );
  return changed;
}
