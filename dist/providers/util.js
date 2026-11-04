import { UnexpectedResponseError } from '../crawler/errors.js';
const ZURICH_PARTS = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Europe/Zurich',
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
});
function zurichParts(utcMillis) {
    const parts = {};
    for (const part of ZURICH_PARTS.formatToParts(new Date(utcMillis))) {
        if (part.type !== 'literal')
            parts[part.type] = Number(part.value);
    }
    return parts;
}
/** Converts a Swiss wall-clock time (Europe/Zurich, DST-aware) to an ISO timestamp. */
export function zurichTimeToIso(year, month, day, h = 0, m = 0, s = 0) {
    const guess = Date.UTC(year, month - 1, day, h, m, s);
    const p = zurichParts(guess);
    const offset = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - guess;
    return new Date(guess - offset).toISOString();
}
/** "2026-10-12" (a Swiss calendar date) -> start of that day as ISO. */
export function zurichDateToIso(date, endOfDay = false) {
    const match = date ? /^(\d{4})-(\d{2})-(\d{2})/.exec(date) : null;
    if (!match)
        return null;
    const [y, m, d] = [Number(match[1]), Number(match[2]), Number(match[3])];
    return endOfDay ? zurichTimeToIso(y, m, d, 23, 59, 59) : zurichTimeToIso(y, m, d);
}
/** Unix seconds -> ISO, or null for missing/zero values. */
export function fromUnixSeconds(value) {
    const seconds = typeof value === 'string' ? Number(value) : value;
    if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds <= 0)
        return null;
    return new Date(seconds * 1000).toISOString();
}
/** End (23:59:59 Swiss time) of the calendar day that contains the given instant. */
export function endOfZurichDay(iso) {
    if (!iso)
        return null;
    const p = zurichParts(Date.parse(iso));
    return zurichTimeToIso(p.year, p.month, p.day, 23, 59, 59);
}
/** Validates the envelope of a store response; a mismatch means the store changed its API. */
export function parseEnvelope(schema, data, url, what) {
    const result = schema.safeParse(data);
    if (result.success)
        return result.data;
    const issue = result.error.issues[0];
    const where = issue?.path.length ? ` at "${issue.path.join('.')}"` : '';
    throw new UnexpectedResponseError(url, `${what} has an unexpected format${where} (${issue?.message ?? 'invalid'})`);
}
/**
 * Normalizes each raw item independently, so one odd product does not fail a
 * whole page. Returns the products and how many items were skipped.
 */
export function normalizeEach(items, schema, normalize, debug) {
    const products = [];
    let skipped = 0;
    for (const item of items) {
        const parsed = schema.safeParse(item);
        if (!parsed.success) {
            skipped++;
            debug(`skipped an item: ${parsed.error.issues[0]?.path.join('.')} ${parsed.error.issues[0]?.message}`);
            continue;
        }
        const product = normalize(parsed.data);
        if (product)
            products.push(product);
        else
            skipped++;
    }
    return { products, skipped };
}
/** Removes duplicates and empty strings, keeping order. */
export function uniqueStrings(values) {
    return [...new Set(values.map((v) => v?.trim()).filter((v) => !!v))];
}
