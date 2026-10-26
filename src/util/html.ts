import { cleanText } from '../normalization/text.js';

export interface HtmlTable {
  /** Rows of the table head, each cell as plain text. */
  head: string[][];
  /** The other rows. */
  body: string[][];
  /** The raw HTML of each body row, for links or attributes. */
  bodyHtml: string[];
}

/**
 * The plain text of each cell (`<th>` and `<td>`) of a row; line breaks are kept,
 * soft hyphens (hints where a long word may break) are dropped.
 */
function cells(row: string): string[] {
  return [...row.matchAll(/<t[hd]\b[^>]*>([\s\S]*?)<\/t[hd]>/gi)].map(
    (m) => cleanText(m[1])?.replace(/\u00ad/g, '') ?? '',
  );
}

/**
 * Finds the first table whose opening tag matches `pattern` (an id, a class, an
 * aria label...) and reads its rows. Nested tables are not supported.
 */
export function findTable(html: string, pattern: RegExp): HtmlTable | null {
  for (const match of html.matchAll(/<table\b([^>]*)>([\s\S]*?)<\/table>/gi)) {
    if (!pattern.test(match[1] ?? '')) continue;
    const content = match[2] ?? '';
    const headHtml = /<thead\b[^>]*>([\s\S]*?)<\/thead>/i.exec(content)?.[1] ?? '';
    const bodyPart = content.replace(/<thead\b[^>]*>[\s\S]*?<\/thead>/i, '');
    const rows = (part: string) =>
      [...part.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)].map((m) => m[1] ?? '');
    const bodyHtml = rows(bodyPart);
    return { head: rows(headHtml).map(cells), body: bodyHtml.map(cells), bodyHtml };
  }
  return null;
}

/** "4'881.60", "1'000", "8.5%", "CHF 2'500" -> a number; null when there is none. */
export function parseSwissNumber(text: string | null | undefined): number | null {
  const match = /-?\d[\d'’]*(?:[.,]\d+)?/.exec(text ?? '');
  if (!match) return null;
  const value = Number(match[0].replace(/['’]/g, '').replace(',', '.'));
  return Number.isFinite(value) ? value : null;
}
