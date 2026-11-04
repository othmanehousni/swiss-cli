import { UnexpectedResponseError } from '../crawler/errors.js';
import { computeUnitPrice, parseComparisonPrice, parseMoney } from '../normalization/price.js';
import { parseQuantity } from '../normalization/quantity.js';
import { cleanLabel, cleanText, looseKey } from '../normalization/text.js';
import { zurichDateToIso } from './util.js';
/**
 * Volg — the village shops' weekly offers on volg.ch (verified October 2026). Volg
 * publishes no assortment online, only this one page of offers in sections ("fresh"
 * offers from Wednesday, the others from Monday), rendered on the server.
 */
const SITE = 'https://www.volg.ch';
const OFFERS = {
    de: `${SITE}/sortiment/wochenaktionen/`,
    fr: `${SITE}/fr/assortiment/actions-hebdomadaires/`,
    // volg.ch has no Italian pages.
    it: `${SITE}/sortiment/wochenaktionen/`,
};
/**
 * "Mi. 28.10. bis Sa. 31.10." -> the two days as ISO dates. The year is the one
 * closest to `today` (offers around New Year span two years).
 */
export function parseValidity(text, today) {
    const days = [...text.matchAll(/(\d{1,2})\.(\d{1,2})\.(\d{4})?/g)].map((m) => {
        const day = Number(m[1]);
        const month = Number(m[2]);
        let year = m[3] ? Number(m[3]) : today.getUTCFullYear();
        if (!m[3]) {
            const candidate = Date.UTC(year, month - 1, day);
            const halfYear = 182 * 24 * 3600 * 1000;
            if (candidate - today.getTime() > halfYear)
                year--;
            else if (today.getTime() - candidate > halfYear)
                year++;
        }
        return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    });
    const [from, until] = days;
    return [zurichDateToIso(from ?? null), zurichDateToIso(until ?? from ?? null, true)];
}
function productId(image, title, description) {
    // The image of an offer is named after it: ".../csm_promo_77134_de_39ea8208e5.jpg".
    const promo = image ? /promo_(\d+)/.exec(image)?.[1] : undefined;
    if (promo)
        return promo;
    return looseKey(`${title} ${description}`).replace(/\s+/g, '-').slice(0, 80);
}
/** Reads the offers page: its sections and their products. */
export function parseVolgOffers(html, lang, today = new Date()) {
    const sections = [];
    const parts = html.split(/<h2 class="c-section__subtitle">/).slice(1);
    for (const part of parts) {
        const heading = /^([\s\S]*?)<span>([\s\S]*?)<\/span>/.exec(part);
        const name = (cleanText(heading?.[1] ?? part.slice(0, part.indexOf('<'))) ?? '')
            .replace(/\*$/, '')
            .trim();
        const [validFrom, validUntil] = parseValidity(cleanText(heading?.[2]) ?? '', today);
        const id = looseKey(name).replace(/\s+/g, '-');
        const products = [];
        for (const block of part.split(/<div class="c-product">/).slice(1)) {
            const title = cleanText(/<h3 class="c-product__title[^"]*">([\s\S]*?)<\/h3>/.exec(block)?.[1]);
            const price = parseMoney(/<span class="c-product__price-main">([\s\S]*?)<\/span>/.exec(block)?.[1]);
            if (!title || price === null)
                continue;
            const descriptionHtml = /<div class="c-product__description">([\s\S]*?)<\/div>/.exec(block)?.[1] ?? '';
            const description = cleanText(descriptionHtml.split(/<br\s*\/?>/i)[0]) ?? '';
            const comparison = cleanText(/<small>([\s\S]*?)<\/small>/.exec(descriptionHtml)?.[1]);
            // "statt 7.35" / "au lieu de 7.35"
            const regularPrice = parseMoney(/<span class="u-text-nowrap">([\s\S]*?)<\/span>/.exec(block)?.[1]);
            const reduction = cleanLabel(cleanText(/<div class="c-product__reduction">([\s\S]*?)<\/div>/.exec(block)?.[1]));
            const image = /<img src="([^"]+)"/.exec(block)?.[1] ?? null;
            // The size comes last in the description: "div. Sorten, z.B. Wildblütenhonig, 250 g".
            const size = description.split(',').at(-1)?.trim() || null;
            const quantity = parseQuantity(size);
            const unit = parseComparisonPrice(comparison) ?? computeUnitPrice(price, quantity);
            products.push({
                store: 'volg',
                storeProductId: productId(image, title, description),
                name: title,
                brand: null,
                categoryPath: [name],
                // As printed: origin or variants, then the size ("Schweiz, 10 Stück").
                sizeText: description || null,
                quantity,
                price,
                regularPrice: regularPrice && regularPrice > price ? regularPrice : null,
                loyaltyPrice: null,
                promoLabel: reduction ??
                    (regularPrice && regularPrice > price
                        ? `-${Math.round((1 - price / regularPrice) * 100)}%`
                        : null),
                validFrom,
                validUntil,
                unitPrice: unit?.unitPrice ?? null,
                unitPriceBasis: unit?.unitPriceBasis ?? null,
                labels: [],
                url: OFFERS[lang],
                imageUrl: image ? new URL(image, SITE).href : null,
                sourceRef: { section: id },
            });
        }
        sections.push({ id, name, validFrom, validUntil, products });
    }
    return sections;
}
async function offers(ctx) {
    const url = OFFERS[ctx.lang];
    const sections = parseVolgOffers(await ctx.http.getText(url), ctx.lang);
    if (sections.length === 0) {
        throw new UnexpectedResponseError(url, 'the weekly offers page has no offers any more');
    }
    return sections;
}
export const volg = {
    info: {
        id: 'volg',
        name: 'Volg',
        website: 'https://www.volg.ch',
        coverage: 'The offers of the week (about 25, from Monday and Wednesday). volg.ch does not publish ' +
            'its assortment.',
        rotating: true,
        verified: true,
        brandInName: true,
        requestsPerSecond: 1,
    },
    async categories(ctx) {
        return (await offers(ctx)).map((s) => ({
            store: 'volg',
            id: s.id,
            parentId: null,
            name: s.name,
            path: [s.name],
            productCount: s.products.length,
        }));
    },
    sources(_categories, categoryIds) {
        return [
            {
                key: 'offers',
                label: 'Offers of the week',
                params: categoryIds ? { sections: categoryIds.join(',') } : {},
            },
        ];
    },
    async fetchPage(ctx, source) {
        const wanted = source.params.sections?.split(',').filter(Boolean) ?? [];
        const products = (await offers(ctx))
            .filter((s) => wanted.length === 0 || wanted.includes(s.id))
            .flatMap((s) => s.products);
        return { products, skipped: 0, total: products.length, next: null };
    },
};
