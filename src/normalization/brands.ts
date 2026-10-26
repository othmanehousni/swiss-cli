/**
 * Brands: one spelling per brand across stores, and brands recognised in product names.
 *
 * Most stores publish a brand field. Denner does not, and Coop does not for wines, but
 * their product names start with the brand ("Feldschlösschen Bier Original"). There,
 * the brand is recognised from the start of the name, using only brands the stores
 * themselves publish, so nothing is guessed from the words alone.
 */
import { looseKey, searchKey } from './text.js';

/**
 * Lowercase, accent-free form of a brand: how brands are compared and filtered.
 * Umlauts fold to their vowel, so "Feldschlösschen", "Feldschloesschen" and
 * "Feldschlosschen" are one brand, however a store or a user types it.
 */
export function brandKey(brand: string): string {
  return looseKey(brand);
}

/**
 * Words some stores publish in their brand field that are not brands to look for
 * at the start of a name: product types, labels, seasons, origins.
 */
const NOT_BRANDS = new Set(
  [
    'bio',
    'organic',
    'natur',
    'nature',
    'vegan',
    'veggie',
    'halloween',
    'weihnachten',
    'noel',
    'natale',
    'ostern',
    'paques',
    'pasqua',
    'original',
    'classic',
    'premium',
    'gourmet',
    'swiss',
    'suisse',
    'schweiz',
    'schweizer',
    'svizzera',
    'fairtrade',
    'diverse',
    'divers',
    'div',
    'sonstige',
    'ohne marke',
    'no name',
  ].map(brandKey),
);

/** Bottle sizes that start wine names ("Magnum Chianti Classico DOCG"): not the ice cream. */
const BOTTLE_SIZES = new Set(['magnum', 'jeroboam', 'rehoboam', 'mathusalem', 'imperial']);

/** Appellations and words that only wine names contain. */
const WINE_WORDS =
  /\b(AOC|AOP|AC|DOC|DOCG|DOCa|DOP|DO|IGT|IGP|VdP|Cru|Grand Cru|Vin de Pays|Vino|Wein|Weine|Vins?|Rotwein|Weisswein|Champagner?|Prosecco|Cava|Crémant)\b/u;

/** Wines, from their name or their category ("Rotweine", "Vins rouges", "Weinshop"). */
export function looksLikeWine(name: string, category: string | null = null): boolean {
  return WINE_WORDS.test(name) || /wein|vins?\b|vino|vini\b|wine|champagn/i.test(category ?? '');
}

/**
 * How much of a store's products with a brand must have names starting with it.
 * A brand only one store publishes needs more evidence than one several stores sell.
 */
const NAME_SHARE_ONE_STORE = 0.5;
const NAME_SHARE_SEVERAL_STORES = 0.25;

export interface PublishedBrand {
  /** As the store writes it. */
  brand: string;
  store: string;
  /** The product's name, to see whether the store's names start with the brand. */
  name: string;
  /** True for stores whose product names start with the brand. */
  brandInName: boolean;
}

interface Spelling {
  text: string;
  /** Names that start with the brand written this way: how it is written on the pack. */
  inNames: number;
  /** Brand fields written this way. */
  inFields: number;
}

interface Evidence {
  spellings: Map<string, Spelling>;
  stores: Set<string>;
  /** Products of brand-first stores that carry the brand, and how many names start with it. */
  inBrandFirstStores: number;
  namesStartingWithIt: number;
}

/**
 * The start of the name that spells the brand ("Coca-Cola" in "Coca-Cola Zero"), or null
 * when the name does not start with the brand as whole words: "Kinder-Zahnpasta" is a
 * children's toothpaste, not the brand Kinder.
 */
export function brandPrefix(name: string, key: string): string | null {
  const nameKey = brandKey(name);
  if (!key || !(nameKey === key || nameKey.startsWith(`${key} `))) return null;
  // Walk the name's words and gaps until the brand's words are used up. Counting words
  // through searchKey keeps both in step ("ø" splits a word there, "ä" does not).
  const words = key.split(' ').length;
  let seen = 0;
  let length = 0;
  for (const part of name.match(/[\p{L}\p{N}]+|[^\p{L}\p{N}]+/gu) ?? []) {
    if (/^[\p{L}\p{N}]/u.test(part)) {
      seen += searchKey(part).split(' ').filter(Boolean).length;
      length += part.length;
      continue;
    }
    if (seen === words) {
      // A hyphen without spaces joins words; with spaces ("Coop - Milch") it separates them.
      if (!/\s/.test(part) && /[-‐‑]/.test(part)) return null;
      return name.slice(0, length).trim();
    }
    length += part.length;
  }
  return seen === words ? name.trim() : null;
}

export function startsWithBrand(name: string, key: string): boolean {
  return brandPrefix(name, key) !== null;
}

function isMixedCase(text: string): boolean {
  return /\p{Ll}/u.test(text) && /\p{Lu}/u.test(text);
}

/**
 * What the stores publish, turned into the brands to recognise and the spelling to
 * use for each. Build it from every product that has a brand from its store.
 */
export class BrandIndex {
  private readonly evidence = new Map<string, Evidence>();
  private recognisable: Map<string, string> | null = null;
  private longestBrandWords = 1;

  constructor(published: Iterable<PublishedBrand> = []) {
    for (const p of published) this.add(p);
  }

  add(p: PublishedBrand): void {
    const key = brandKey(p.brand);
    if (!key) return;
    let e = this.evidence.get(key);
    if (!e) {
      e = {
        spellings: new Map(),
        stores: new Set(),
        inBrandFirstStores: 0,
        namesStartingWithIt: 0,
      };
      this.evidence.set(key, e);
    }
    const count = (text: string, where: 'inNames' | 'inFields') => {
      const spelling = e.spellings.get(text) ?? { text, inNames: 0, inFields: 0 };
      spelling[where]++;
      e.spellings.set(text, spelling);
    };
    const field = p.brand.trim();
    count(field, 'inFields');
    e.stores.add(p.store);
    if (p.brandInName) {
      e.inBrandFirstStores++;
      const prefix = brandPrefix(p.name, key);
      if (prefix) {
        e.namesStartingWithIt++;
        // A name that starts with the field's exact spelling keeps it: "Ja! Milch" -> "Ja!".
        count(p.name.trimStart().startsWith(field) ? field : prefix, 'inNames');
      }
    }
    this.recognisable = null;
  }

  /**
   * The spelling to show for a brand, the same in every store: mixed case first
   * ("Oatly" over "OATLY"), then as most often written in names ("Coca-Cola" over the
   * "Coca Cola" of a brand field), then in brand fields. Unknown brands keep theirs.
   */
  spelling(brand: string): string {
    const e = this.evidence.get(brandKey(brand));
    if (!e) return brand.trim();
    const rank = (s: Spelling) => [Number(isMixedCase(s.text)), s.inNames, s.inFields];
    let best: Spelling | null = null;
    for (const s of e.spellings.values()) {
      if (!best) {
        best = s;
        continue;
      }
      const [a, b] = [rank(s), rank(best)];
      const order = a.findIndex((value, i) => value !== b[i]);
      if (order >= 0 ? (a[order] as number) > (b[order] as number) : s.text < best.text) best = s;
    }
    return best?.text ?? brand.trim();
  }

  /**
   * Brands that can be recognised in names: published by a brand-first store whose
   * names mostly start with it, or published by at least two stores. Too short,
   * numeric-only and generic words never are.
   */
  private brands(): Map<string, string> {
    if (this.recognisable) return this.recognisable;
    const brands = new Map<string, string>();
    for (const [key, e] of this.evidence) {
      if (key.length < 3 || !/[a-z]/.test(key) || NOT_BRANDS.has(key)) continue;
      const share = (minimum: number) =>
        e.namesStartingWithIt >= 2 && e.namesStartingWithIt >= e.inBrandFirstStores * minimum;
      const recognisable =
        share(NAME_SHARE_ONE_STORE) ||
        (e.stores.size >= 2 && (e.inBrandFirstStores === 0 || share(NAME_SHARE_SEVERAL_STORES)));
      if (!recognisable) continue;
      brands.set(key, this.spelling(key));
      this.longestBrandWords = Math.max(this.longestBrandWords, key.split(' ').length);
    }
    this.recognisable = brands;
    return brands;
  }

  /** Brands that can be recognised in names (for tests and the `brands` command). */
  get size(): number {
    return this.brands().size;
  }

  /**
   * The brand a product name starts with, in its usual spelling, or null.
   * The longest published brand wins ("Dr. Oetker Ristorante" over "Dr. Oetker"),
   * and the name must go on after it: a name that is only a brand is left alone.
   */
  recognise(name: string, category: string | null = null): string | null {
    const brands = this.brands();
    const words = brandKey(name).split(' ').filter(Boolean);
    for (let n = Math.min(this.longestBrandWords, words.length - 1); n >= 1; n--) {
      const key = words.slice(0, n).join(' ');
      const brand = brands.get(key);
      if (!brand || !startsWithBrand(name, key)) continue;
      if (BOTTLE_SIZES.has(key) && looksLikeWine(name, category)) return null;
      return brand;
    }
    return null;
  }
}
