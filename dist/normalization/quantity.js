/** Unit word -> [base unit, factor to base unit]. */
const UNITS = {
    mg: ['g', 0.001],
    g: ['g', 1],
    gr: ['g', 1],
    grm: ['g', 1],
    gramm: ['g', 1],
    kg: ['g', 1000],
    kilo: ['g', 1000],
    kilogramm: ['g', 1000],
    ml: ['ml', 1],
    cl: ['ml', 10],
    dl: ['ml', 100],
    l: ['ml', 1000],
    lt: ['ml', 1000],
    ltr: ['ml', 1000],
    liter: ['ml', 1000],
    litre: ['ml', 1000],
    litro: ['ml', 1000],
    litri: ['ml', 1000],
};
// Longest alternatives first so "kg" is not read as "k" + "g".
const UNIT_RE = 'kilogramm|kilo|kg|gramm|grm|gr|mg|g|liter|litre|litro|litri|ltr|lt|ml|cl|dl|l';
const END = '(?![a-zäöüéèàç])';
/** A word starts here: "le kg" counts, the "le" at the end of "bouteille" does not. */
const START = '(?<![a-zäöüéèàç])';
const NUM = '(\\d+(?:\\.\\d+)?)';
/** Containers and pieces in German, French and Italian ("4 Stück", "6 boîtes", "2 bottiglie"). */
const CONTAINERS = 'stück|stueck|stk\\.?|st\\.?|pcs?\\.?|pces?\\.?|pièces?|pieces?|pezzi|pz\\.?|dosen|flaschen|beutel|packungen|portionen|scheiben|boîtes?|boites?|sachets?|bouteilles?|canettes?|pots?|barquettes?|tranches?|portions?|bottiglie|lattine|bustine|confezioni|vasetti|fette';
const PIECES = `${CONTAINERS}|paar|paire?s?|bund|rollen|rolle|rouleaux|tabs|tabletten|kapseln|capsules?|dosettes?|portion|teile|blatt|feuilles?|lingettes?|eier|sets?|packung|waschgänge|waschgaenge|wg`;
// "6 x 1,5 l", "4 Stück à 125 g", "4 pièces de 125 g", "2 vasetti da 150 g"
const MULTIPACK = new RegExp(`(\\d+)\\s*(?:x|${CONTAINERS})\\s*(?:à\\s*|a\\s+|je\\s+|zu\\s+|de\\s+|d'|da\\s+)?${NUM}\\s*(${UNIT_RE})${END}`);
const SINGLE = new RegExp(`${NUM}\\s*(?:unit\\.)?\\s*(${UNIT_RE})${END}`);
// Sold by weight or volume: "per kg", "le kg", "au kg", "al kg", "/l".
const SOLD_PER = new RegExp(`(?:${START}(?:per|pro|je|par|le|au|al)\\s*|/\\s*)(?:1\\s*)?(kg|kilo|l|liter|litre)${END}`);
const PIECE_COUNT = new RegExp(`(\\d+)\\s*(?:${PIECES})${END}`);
const PACK_COUNT = /(\d+)\s*er[\s-]?pack/;
const PER_PIECE = new RegExp(`${START}(?:per|pro|je|par|la|al)\\s+(?:${PIECES})${END}`);
function round(value) {
    return Math.round(value * 1000) / 1000;
}
function prepare(text) {
    return text
        .toLowerCase()
        .replace(/×/g, 'x')
        .replace(/(\d),(\d)/g, '$1.$2')
        .replace(/\s+/g, ' ');
}
function fromUnit(amount, unitWord, packCount = 1) {
    const unit = UNITS[unitWord];
    if (!unit || !(amount > 0))
        return null;
    return { amount: round(amount * unit[1] * packCount), unit: unit[0], packCount };
}
/**
 * Parses sizes as printed by Swiss stores into a total amount in g, ml or pieces.
 *
 *   "250 g" -> 250 g        "6 x 1,5 l" -> 9000 ml (pack of 6)
 *   "75 cl" -> 750 ml       "4 Stück à 125 g" -> 500 g (pack of 4)
 *   "per kg" -> 1000 g      "10 Stück" -> 10 pieces
 *
 * Returns null when no size can be recognised.
 */
export function parseQuantity(text) {
    if (!text)
        return null;
    const s = prepare(text);
    const multi = MULTIPACK.exec(s);
    if (multi) {
        const count = Number(multi[1]);
        const q = fromUnit(Number(multi[2]), multi[3], count);
        if (q && count > 0)
            return q;
    }
    const single = SINGLE.exec(s);
    if (single) {
        const q = fromUnit(Number(single[1]), single[2]);
        if (q)
            return q;
    }
    const soldPer = SOLD_PER.exec(s);
    if (soldPer)
        return fromUnit(1, soldPer[1]);
    const pieces = PIECE_COUNT.exec(s) ?? PACK_COUNT.exec(s);
    if (pieces) {
        const count = Number(pieces[1]);
        if (count > 0)
            return { amount: count, unit: 'piece', packCount: 1 };
    }
    if (PER_PIECE.test(s))
        return { amount: 1, unit: 'piece', packCount: 1 };
    return null;
}
// "per 100 g", "pro kg", "les 100 g", "pour 100 g", "al kg", "/100 g"
const PRICE_BASIS = new RegExp(`(?:${START}(?:per|pro|je|par|pour|les|le|au|al)\\s*|/\\s*)${NUM}?\\s*(${UNIT_RE})${END}`);
/**
 * The amount a price refers to when a store prices by weight or volume,
 * e.g. "ca. 800 g, per 100 g" -> 100 g (the shelf price is per 100 g, not per pack).
 */
export function parsePriceBasis(text) {
    if (!text)
        return null;
    const match = PRICE_BASIS.exec(prepare(text));
    if (!match)
        return null;
    return fromUnit(match[1] ? Number(match[1]) : 1, match[2]);
}
/** Converts an amount in a printed unit ("100 g", "1 l") to base units. */
export function toBaseAmount(amount, unitWord) {
    const unit = UNITS[unitWord.toLowerCase()];
    if (!unit || !(amount > 0))
        return null;
    return { amount: round(amount * unit[1]), unit: unit[0] };
}
export const UNIT_PATTERN = UNIT_RE;
export const PIECE_PATTERN = PIECES;
