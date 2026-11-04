const MAX_PLAUSIBLE_PRICE = 20_000;
/** 100 kg or 100 l: nothing on a supermarket shelf is bigger. */
const MAX_PLAUSIBLE_AMOUNT = 100_000;
/**
 * Data-quality gate applied to every product before it is stored.
 * Rejects products that cannot be identified; repairs inconsistent promotion
 * data instead of storing it; reports anything suspicious as a warning.
 */
export function checkProduct(input) {
    if (!input.storeProductId.trim())
        return { ok: false, reason: 'missing product id' };
    if (!input.name.trim())
        return { ok: false, reason: `product ${input.storeProductId} has no name` };
    const product = { ...input };
    const warnings = [];
    if (product.price != null && !(product.price > 0 && product.price < MAX_PLAUSIBLE_PRICE)) {
        warnings.push(`implausible price ${product.price}`);
        product.price = null;
    }
    if (product.quantity &&
        product.quantity.unit !== 'piece' &&
        product.quantity.amount > MAX_PLAUSIBLE_AMOUNT) {
        // e.g. a muesli listed as "750 kg": a typo in the store's data, not a 750 kg box.
        warnings.push(`implausible size ${product.sizeText ?? product.quantity.amount}`);
        product.quantity = null;
        product.unitPrice = null;
        product.unitPriceBasis = null;
    }
    if (product.price == null) {
        product.unitPrice = null;
        product.unitPriceBasis = null;
    }
    if (product.regularPrice != null &&
        (product.price == null || product.regularPrice <= product.price)) {
        // A "was" price that is not higher than the current price is not a discount.
        product.regularPrice = null;
    }
    if (product.loyaltyPrice != null &&
        product.price != null &&
        !(product.loyaltyPrice > 0 && product.loyaltyPrice < product.price)) {
        product.loyaltyPrice = null;
    }
    if (product.validFrom && product.validUntil && product.validUntil < product.validFrom) {
        warnings.push('offer ends before it starts');
        product.validFrom = null;
        product.validUntil = null;
    }
    if (product.unitPrice != null && !(product.unitPrice > 0)) {
        product.unitPrice = null;
        product.unitPriceBasis = null;
    }
    return { ok: true, product, warnings };
}
