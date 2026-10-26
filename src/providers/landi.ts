import { z } from 'zod';
import { UnexpectedResponseError } from '../crawler/errors.js';
import { computeUnitPrice, parseComparisonPrice, parseMoney } from '../normalization/price.js';
import { parseQuantity } from '../normalization/quantity.js';
import { cleanText, decodeEntities } from '../normalization/text.js';
import type { Category, NormalizedProduct } from '../normalization/types.js';
import { flattenTree, type TreeNode } from './categories.js';
import type { Lang, Provider, ProviderContext } from './types.js';
import { parseEnvelope } from './util.js';

/**
 * LANDI — the online shop on landi.ch (verified October 2026): garden, DIY, household,
 * pets, food and drinks. Category pages are rendered on the server; their product
 * lists come from the endpoint the pages themselves use to load more products
 * (/api/<lang>/catalog/productlist), which answers HTML in a JSON string.
 */
const SITE = 'https://www.landi.ch';
const PREFIX: Record<Lang, string> = { de: '', fr: '/fr', it: '' }; // no Italian shop
const API_LANG: Record<Lang, string> = { de: 'de', fr: 'fr', it: 'de' };
/** One request returns a whole category; none has nearly this many products. */
const PAGE_SIZE = 1000;

/** The shop's categories, from the menu: codes 21 > 2102 > 210201 nest by prefix. */
export function parseLandiCategories(html: string): Category[] {
  const names = new Map<string, { slug: string; name: string }>();
  for (const m of html.matchAll(
    /<a\b[^>]*href="\/(?:fr\/)?shop\/([a-z0-9-]+)_(\d{2,6})"[^>]*>/gi,
  )) {
    const [tag, slug, code] = m as unknown as [string, string, string];
    const label = /data-ga-eventlabel="([^"]*)"/.exec(tag)?.[1];
    if (!label || names.has(code)) continue;
    names.set(code, { slug, name: decodeEntities(label).trim() });
  }
  const nodes = new Map<string, TreeNode>();
  const roots: TreeNode[] = [];
  for (const [code, { slug, name }] of [...names.entries()].sort(
    ([a], [b]) => a.length - b.length || a.localeCompare(b),
  )) {
    const node: TreeNode = { id: `${slug}_${code}`, name, children: [] };
    nodes.set(code, node);
    const parent = code.length > 2 ? nodes.get(code.slice(0, -2)) : undefined;
    if (parent) parent.children = [...(parent.children ?? []), node];
    else if (code.length === 2) roots.push(node);
  }
  return flattenTree('landi', roots);
}

/** The category id the product list wants, from a category page. */
export function parseCategoryId(html: string): string | null {
  const value = /<input[^>]*id="searchUrl"[^>]*value="([^"]*)"/.exec(html)?.[1];
  return value ? (/[?&;]scid=(\d+)/.exec(decodeEntities(value))?.[1] ?? null) : null;
}

/** Reads the products of a list fragment. */
export function parseLandiProducts(
  fragment: string,
  categoryPath: string[],
  lang: Lang,
): NormalizedProduct[] {
  const products: NormalizedProduct[] = [];
  for (const block of fragment.split(/<div class="col-xs-6 col-md-3 product-item">/i).slice(1)) {
    const link = /<a href="([^"]+)"[^>]*class="product-link"[^>]*data-productcode="(\d+)"/i.exec(
      block,
    );
    const name = cleanText(/<h3>([\s\S]*?)<\/h3>/i.exec(block)?.[1]);
    if (!link?.[1] || !link[2] || !name) continue;
    // The price is drawn as an image: /landiprice.ashx?p=7.60&h=53&ta=False (ta: top offer).
    const priceImage = decodeEntities(/landiprice\.ashx\?([^"]+)"/i.exec(block)?.[1] ?? '');
    const params = new URLSearchParams(priceImage);
    const price = parseMoney(params.get('p'));
    const topOffer = params.get('ta')?.toLowerCase() === 'true';
    const offerText = cleanText(/<span class="price-text">([\s\S]*?)<\/span>/i.exec(block)?.[1]);
    const comparison = cleanText(
      /<div class="product-caption-price"[^>]*>([\s\S]*?)<\/div>/i.exec(block)?.[1],
    );
    const image = /<img[^>]*class="product-image-main"[^>]*src="([^"]+)"/i.exec(block)?.[1];
    const quantity = parseQuantity(name);
    const unit = parseComparisonPrice(comparison) ?? computeUnitPrice(price, quantity);
    const badges = [
      ...block.matchAll(
        /class="product-image-badge"[^>]*alt="([^"]+)"|alt="([^"]+)"[^>]*class="product-image-badge"/gi,
      ),
    ]
      .map((m) => decodeEntities(m[1] ?? m[2] ?? '').trim())
      .filter((b) => b && b !== name);
    products.push({
      store: 'landi',
      storeProductId: link[2],
      name,
      brand: null,
      categoryPath,
      sizeText: null,
      quantity,
      price,
      regularPrice: null,
      loyaltyPrice: null,
      promoLabel: topOffer ? (offerText ?? 'Top-Angebot') : null,
      validFrom: null,
      validUntil: null,
      unitPrice: price != null ? (unit?.unitPrice ?? null) : null,
      unitPriceBasis: price != null ? (unit?.unitPriceBasis ?? null) : null,
      labels: [...new Set(badges)],
      url: new URL(`${PREFIX[lang]}${decodeEntities(link[1])}`, SITE).href,
      imageUrl: image ? new URL(decodeEntities(image), SITE).href : null,
      sourceRef: {},
    });
  }
  return products;
}

async function categoryId(ctx: ProviderContext, slug: string): Promise<string> {
  const url = `${SITE}${PREFIX[ctx.lang]}/shop/${slug}`;
  const id = parseCategoryId(await ctx.http.getText(url));
  if (!id)
    throw new UnexpectedResponseError(url, 'the category page no longer names its product list');
  return id;
}

export const landi: Provider = {
  info: {
    id: 'landi',
    name: 'LANDI',
    website: 'https://www.landi.ch',
    coverage:
      'The online shop: garden, DIY, household, pets, clothing, food and drinks (thousands of ' +
      'products; a full fetch takes about 15 minutes).',
    rotating: false,
    verified: true,
    requestsPerSecond: 1,
  },

  async categories(ctx): Promise<Category[]> {
    const url = `${SITE}${PREFIX[ctx.lang]}/`;
    const categories = parseLandiCategories(await ctx.http.getText(url));
    if (categories.length === 0)
      throw new UnexpectedResponseError(url, 'the shop menu has no categories any more');
    return categories;
  },

  sources(categories, categoryIds) {
    // Only the most specific categories list every product (the others show a selection).
    const leaves = categories.filter((c) => !categories.some((other) => other.parentId === c.id));
    const picked = categoryIds
      ? leaves.filter((leaf) =>
          categoryIds.some(
            (id) => leaf.id === id || (leaf.path.length > 0 && isUnder(categories, leaf, id)),
          ),
        )
      : leaves;
    return picked.map((c) => ({
      key: `category:${c.id}`,
      label: c.path.join(' > '),
      params: { slug: c.id, path: JSON.stringify(c.path) },
    }));
  },

  async fetchPage(ctx, source) {
    const slug = source.params.slug ?? '';
    const path = JSON.parse(source.params.path ?? '[]') as string[];
    const id = await categoryId(ctx, slug);
    const url = `${SITE}/api/${API_LANG[ctx.lang]}/catalog/productlist?lang=${API_LANG[ctx.lang]}&scid=${id}&sf=no&pai=1&pas=${PAGE_SIZE}`;
    const fragment = parseEnvelope(
      z.string(),
      await ctx.http.getJson(url),
      url,
      'the LANDI product list',
    );
    const products = parseLandiProducts(fragment, path, ctx.lang);
    if (products.length >= PAGE_SIZE)
      ctx.debug(`landi: ${slug} may have more than ${PAGE_SIZE} products`);
    return { products, skipped: 0, total: products.length, next: null };
  },

  // Drinks (20) and food (21); the other sections are garden, DIY, animals, ...
  isFood: (category) => /_2[01]$/.test(category.id),
};

function isUnder(categories: Category[], category: Category, ancestorId: string): boolean {
  let current: Category | undefined = category;
  while (current) {
    if (current.id === ancestorId) return true;
    const parentId: string | null = current.parentId;
    current = parentId ? categories.find((c) => c.id === parentId) : undefined;
  }
  return false;
}
