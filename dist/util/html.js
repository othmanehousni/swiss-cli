import { cleanText } from '../normalization/text.js';
/**
 * The plain text of each cell (`<th>` and `<td>`) of a row; line breaks are kept,
 * soft hyphens (hints where a long word may break) are dropped.
 */
function cells(row) {
    return [...row.matchAll(/<t[hd]\b[^>]*>([\s\S]*?)<\/t[hd]>/gi)].map((m) => cleanText(m[1])?.replace(/\u00ad/g, '') ?? '');
}
/**
 * Finds the first table whose opening tag matches `pattern` (an id, a class, an
 * aria label...) and reads its rows. Nested tables are not supported.
 */
export function findTable(html, pattern) {
    for (const match of html.matchAll(/<table\b([^>]*)>([\s\S]*?)<\/table>/gi)) {
        if (!pattern.test(match[1] ?? ''))
            continue;
        const content = match[2] ?? '';
        const headHtml = /<thead\b[^>]*>([\s\S]*?)<\/thead>/i.exec(content)?.[1] ?? '';
        const bodyPart = content.replace(/<thead\b[^>]*>[\s\S]*?<\/thead>/i, '');
        const rows = (part) => [...part.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)].map((m) => m[1] ?? '');
        const bodyHtml = rows(bodyPart);
        return { head: rows(headHtml).map(cells), body: bodyHtml.map(cells), bodyHtml };
    }
    return null;
}
/** "4'881.60", "1'000", "8.5%", "CHF 2'500" -> a number; null when there is none. */
export function parseSwissNumber(text) {
    const match = /-?\d[\d'’]*(?:[.,]\d+)?/.exec(text ?? '');
    if (!match)
        return null;
    const value = Number(match[0].replace(/['’]/g, '').replace(',', '.'));
    return Number.isFinite(value) ? value : null;
}
