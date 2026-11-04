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
];
export function isStoreId(value) {
    return STORE_IDS.includes(value);
}
export function productKey(store, storeProductId) {
    return `${store}:${storeProductId}`;
}
