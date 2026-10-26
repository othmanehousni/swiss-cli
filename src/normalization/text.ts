/** Text helpers shared by all stores: HTML cleanup and search keys. */

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  shy: '',
  auml: 'ä',
  ouml: 'ö',
  uuml: 'ü',
  Auml: 'Ä',
  Ouml: 'Ö',
  Uuml: 'Ü',
  szlig: 'ß',
  eacute: 'é',
  egrave: 'è',
  ecirc: 'ê',
  euml: 'ë',
  Eacute: 'É',
  Egrave: 'È',
  agrave: 'à',
  aacute: 'á',
  acirc: 'â',
  Agrave: 'À',
  ccedil: 'ç',
  Ccedil: 'Ç',
  icirc: 'î',
  iuml: 'ï',
  ocirc: 'ô',
  ograve: 'ò',
  ugrave: 'ù',
  ucirc: 'û',
  ntilde: 'ñ',
  oelig: 'œ',
  deg: '°',
  frac12: '½',
  frac14: '¼',
  sup2: '²',
  sup3: '³',
  times: '×',
  middot: '·',
  bull: '•',
  ndash: '–',
  mdash: '—',
  hellip: '…',
  euro: '€',
  laquo: '«',
  raquo: '»',
  lsquo: '‘',
  rsquo: '’',
  ldquo: '“',
  rdquo: '”',
  bdquo: '„',
  reg: '®',
  trade: '™',
  copy: '©',
};

export function decodeEntities(input: string): string {
  return input.replace(/&(#x[0-9a-f]+|#\d+|[a-z][a-z0-9]*);/gi, (match, entity: string) => {
    if (entity[0] === '#') {
      const code =
        entity[1] === 'x' || entity[1] === 'X'
          ? Number.parseInt(entity.slice(2), 16)
          : Number.parseInt(entity.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff
        ? String.fromCodePoint(code)
        : match;
    }
    return NAMED_ENTITIES[entity] ?? match;
  });
}

/** Strips tags, decodes entities and collapses whitespace. Returns null for empty input. */
export function cleanText(input: string | null | undefined): string | null {
  if (input == null) return null;
  const text = decodeEntities(
    input.replace(/<\s*(br|\/p|\/li|\/div|\/h\d)\s*\/?>/gi, '\n').replace(/<[^>]*>/g, ' '),
  )
    .replace(/[ \t\u00a0]+/g, ' ')
    .replace(/\s*\n\s*/g, '\n')
    .trim();
  return text === '' ? null : text;
}

/** Splits an HTML list (`<li>` items) into clean text lines. */
export function htmlListItems(html: string | null | undefined): string[] {
  if (!html) return [];
  const items = [...html.matchAll(/<li[^>]*>([\s\S]*?)<\/li>/gi)]
    .map((m) => cleanText(m[1]))
    .filter((t): t is string => t !== null);
  if (items.length > 0) return items;
  const text = cleanText(html);
  return text ? text.split('\n') : [];
}

/**
 * A lowercase, accent-free form used for matching search queries.
 * German umlauts are transliterated (ä -> ae) so "Käse" and "Kaese" match.
 */
export function searchKey(input: string): string {
  return input
    .toLowerCase()
    .replace(/ä/g, 'ae')
    .replace(/ö/g, 'oe')
    .replace(/ü/g, 'ue')
    .replace(/ß/g, 'ss')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/**
 * A looser key for names people type in many ways: umlauts fold to their vowel, so
 * "Zürich", "Zuerich" and "Zurich", or "Feldschlösschen" and "Feldschlosschen", match.
 */
export function looseKey(input: string): string {
  return searchKey(input).replace(/ae/g, 'a').replace(/oe/g, 'o').replace(/ue/g, 'u');
}

/** Returns trimmed text, or null when empty. */
export function nonEmpty(input: string | null | undefined): string | null {
  const text = input?.trim();
  return text ? text : null;
}

/** Normalizes promotion labels: trims, and fixes odd percent signs ("-25\uFE6A" -> "-25%"). */
export function cleanLabel(input: string | null | undefined): string | null {
  const text = nonEmpty(input);
  return text ? text.replace(/[\uFE6A\uFF05]/g, '%').replace(/\s+/g, ' ') : null;
}

/** Levenshtein distance: how many letters to add, remove or change to turn `a` into `b`. */
export function editDistance(a: string, b: string): number {
  const dp = Array.from({ length: a.length + 1 }, (_, i) => [
    i,
    ...Array<number>(b.length).fill(0),
  ]);
  for (let j = 1; j <= b.length; j++) (dp[0] as number[])[j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const row = dp[i] as number[];
      const prev = dp[i - 1] as number[];
      row[j] = Math.min(
        (prev[j] as number) + 1,
        (row[j - 1] as number) + 1,
        (prev[j - 1] as number) + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
  }
  return (dp[a.length] as number[])[b.length] as number;
}
