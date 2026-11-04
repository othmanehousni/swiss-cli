import { createHash } from 'node:crypto';
import { brandKey } from '../normalization/brands.js';
import { searchKey } from '../normalization/text.js';
import { productKey, } from '../normalization/types.js';
import { recordPrice } from './prices.js';
export function emptySaveResult() {
    return { inserted: 0, updated: 0, unchanged: 0, priceChanges: 0 };
}
function contentHash(p) {
    const { price, regularPrice, loyaltyPrice, promoLabel, validFrom, validUntil, unitPrice, unitPriceBasis, ...descriptive } = p;
    return createHash('sha1').update(JSON.stringify(descriptive)).digest('hex');
}
/**
 * Upserts a page of products with their current prices.
 * A product that is listed again is "revived" if it had been marked removed.
 * Call inside a transaction (the crawler saves each page atomically).
 */
export function saveProducts(db, products, now, runStartedAt = now) {
    const result = emptySaveResult();
    for (const p of products) {
        const id = productKey(p.store, p.storeProductId);
        const hash = contentHash(p);
        const existing = db.get('SELECT content_hash, removed_at FROM products WHERE id = $id', { id });
        const values = {
            id,
            store: p.store,
            storeId: p.storeProductId,
            name: p.name,
            brand: p.brand,
            sourceTitle: p.sourceTitle ?? null,
            brandSource: p.brand ? 'store' : null,
            brandKey: p.brand ? brandKey(p.brand) : null,
            category: p.categoryPath.length > 0 ? p.categoryPath.join(' > ') : null,
            size: p.sizeText,
            variant: p.variant ?? null,
            versionText: p.versionText ?? null,
            amount: p.quantity?.amount ?? null,
            unit: p.quantity?.unit ?? null,
            pack: p.quantity?.packCount ?? null,
            labels: JSON.stringify(p.labels),
            url: p.url,
            image: p.imageUrl,
            ref: JSON.stringify(p.sourceRef),
            search: searchKey(`${p.brand ?? ''} ${p.name} ${p.sourceTitle ?? ''} ${p.variant ?? ''}`),
            hash,
            now,
        };
        if (!existing) {
            db.run(`INSERT INTO products (id, store, store_product_id, name, brand, source_title, brand_source,
           brand_key, category_path, size_text, variant, version_text, quantity_amount, quantity_unit,
           pack_count, labels, url, image_url, source_ref, search_text, content_hash, first_seen_at,
           last_seen_at, updated_at)
         VALUES ($id, $store, $storeId, $name, $brand, $sourceTitle, $brandSource, $brandKey,
           $category, $size, $variant, $versionText, $amount, $unit, $pack, $labels, $url, $image,
           $ref, $search, $hash, $now, $now, $now)`, values);
            result.inserted++;
        }
        else if (existing.content_hash !== hash || existing.removed_at !== null) {
            const { store: _store, storeId: _storeId, ...changes } = values;
            // A brand recognised in the name stays until the brand pass looks at the product again.
            db.run(`UPDATE products SET name = $name, source_title = $sourceTitle,
           brand = CASE WHEN $brand IS NULL AND brand_source = 'name' THEN brand ELSE $brand END,
           brand_key = CASE WHEN $brand IS NULL AND brand_source = 'name' THEN brand_key ELSE $brandKey END,
           brand_source = CASE WHEN $brand IS NULL AND brand_source = 'name' THEN 'name' ELSE $brandSource END,
           category_path = $category,
           size_text = $size, variant = $variant, version_text = $versionText,
           quantity_amount = $amount, quantity_unit = $unit, pack_count = $pack,
           labels = $labels, url = $url, image_url = $image, source_ref = $ref,
           search_text = $search, content_hash = $hash, last_seen_at = $now,
           removed_at = NULL, updated_at = $now
         WHERE id = $id`, changes);
            result.updated++;
        }
        else {
            db.run('UPDATE products SET last_seen_at = $now WHERE id = $id', { id, now });
            result.unchanged++;
        }
        if (recordPrice(db, id, p, now, runStartedAt))
            result.priceChanges++;
    }
    return result;
}
export function saveDetails(db, productId, details, now) {
    db.run(`UPDATE products SET details = $details, gtin = COALESCE($gtin, gtin),
       details_fetched_at = $now, updated_at = $now
     WHERE id = $id`, { id: productId, details: JSON.stringify(details), gtin: details.gtin ?? null, now });
}
/** Products of a store that still need details, oldest first. */
/**
 * Products of a store that still need details, oldest first.
 * `seenSince`: listed since then; `firstSeenSince`: new since then.
 */
export function productsNeedingDetails(db, store, options = {}) {
    return db.all(`SELECT id, store_product_id, source_ref, url FROM products
     WHERE store = $store AND removed_at IS NULL AND details_fetched_at IS NULL
       AND ($since IS NULL OR last_seen_at >= $since)
       AND ($firstSince IS NULL OR first_seen_at >= $firstSince)
     ORDER BY first_seen_at`, { store, since: options.seenSince ?? null, firstSince: options.firstSeenSince ?? null });
}
export function countActiveProducts(db, store) {
    return (db.get('SELECT COUNT(*) AS n FROM products WHERE store = $store AND removed_at IS NULL', {
        store,
    })?.n ?? 0);
}
/** Distinct products of a store listed since `since` (e.g. during the current crawl). */
export function countSeenSince(db, store, since) {
    return (db.get('SELECT COUNT(*) AS n FROM products WHERE store = $store AND last_seen_at >= $since', {
        store,
        since,
    })?.n ?? 0);
}
/** Products a completed full crawl did not see again (they were not listed since `since`). */
export function countUnseenSince(db, store, since) {
    return (db.get(`SELECT COUNT(*) AS n FROM products
       WHERE store = $store AND removed_at IS NULL AND last_seen_at < $since`, { store, since })?.n ?? 0);
}
/** Products of a store that were not listed since `since`. */
export function unseenSince(db, store, since) {
    return db.all(`SELECT id, store_product_id, source_ref, url FROM products
     WHERE store = $store AND removed_at IS NULL AND last_seen_at < $since`, { store, since });
}
export function markRemoved(db, ids, now) {
    let removed = 0;
    db.transaction(() => {
        for (const id of ids) {
            removed += db.run('UPDATE products SET removed_at = $now, updated_at = $now WHERE id = $id AND removed_at IS NULL', { id, now });
        }
    });
    return removed;
}
/** Records that the store confirmed a product still exists (although it was not listed). */
export function markSeen(db, id, now) {
    db.run('UPDATE products SET last_seen_at = $now WHERE id = $id', { id, now });
}
export function markUnseenAsRemoved(db, store, since, now) {
    return db.run(`UPDATE products SET removed_at = $now, updated_at = $now
     WHERE store = $store AND removed_at IS NULL AND last_seen_at < $since`, { store, since, now });
}
export function saveCategories(db, store, categories, now) {
    db.transaction(() => {
        db.run('DELETE FROM categories WHERE store = $store', { store });
        for (const c of categories) {
            db.run(`INSERT OR REPLACE INTO categories (store, id, parent_id, name, path, product_count, updated_at)
         VALUES ($store, $id, $parent, $name, $path, $count, $now)`, {
                store,
                id: c.id,
                parent: c.parentId,
                name: c.name,
                path: c.path.join(' > '),
                count: c.productCount,
                now,
            });
        }
    });
}
export function loadCategories(db, store) {
    return db
        .all('SELECT id, parent_id, name, path, product_count FROM categories WHERE store = $store ORDER BY path', { store })
        .map((row) => ({
        store,
        id: row.id,
        parentId: row.parent_id,
        name: row.name,
        path: row.path.split(' > '),
        productCount: row.product_count,
    }));
}
