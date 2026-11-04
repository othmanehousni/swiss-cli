import { UnexpectedResponseError } from '../../crawler/errors.js';
import { cached } from '../../storage/cache.js';
/**
 * Earthquakes in and around Switzerland from the Swiss Seismological Service (SED,
 * ETH Zürich), through its FDSN event service. Most are far too weak to be felt;
 * from about magnitude 2.5 people nearby may notice them.
 */
export const QUAKE_SERVICE = 'https://eida.ethz.ch/fdsnws/event/1/query';
/** Switzerland and its border regions. */
const AREA = { minlatitude: 45.4, maxlatitude: 48.2, minlongitude: 5.6, maxlongitude: 11.0 };
const MAX_AGE_MS = 5 * 60 * 1000;
/** Reads the service's text format: one event per line, fields separated by "|". */
export function parseQuakes(text, url = QUAKE_SERVICE) {
    const lines = text.split(/\r?\n/).filter((l) => l.trim());
    const header = lines[0]
        ?.replace(/^#/, '')
        .split('|')
        .map((h) => h.trim());
    if (!header?.includes('Time') || !header.includes('Magnitude')) {
        if (lines.length === 0)
            return []; // no event (the service answers 204 with nothing)
        throw new UnexpectedResponseError(url, 'the earthquake list has an unknown layout');
    }
    const col = (name) => header.indexOf(name);
    const index = {
        id: col('EventID'),
        time: col('Time'),
        lat: col('Latitude'),
        lon: col('Longitude'),
        depth: col('Depth/km'),
        magType: col('MagType'),
        mag: col('Magnitude'),
        place: col('EventLocationName'),
        type: col('EventType'),
    };
    return lines.slice(1).flatMap((line) => {
        const f = line.split('|');
        const num = (i) => {
            const v = Number.parseFloat(f[i] ?? '');
            return Number.isFinite(v) ? v : null;
        };
        const lat = num(index.lat);
        const lon = num(index.lon);
        const time = f[index.time]?.trim();
        if (lat === null || lon === null || !time)
            return [];
        return [
            {
                id: f[index.id]?.trim() ?? '',
                time: new Date(/[zZ]|[+-]\d\d:?\d\d$/.test(time) ? time : `${time}Z`).toISOString(),
                lat,
                lon,
                depthKm: num(index.depth),
                magnitude: num(index.mag),
                magnitudeType: f[index.magType]?.trim() || null,
                place: f[index.place]?.trim() || '',
                type: f[index.type]?.trim() || 'earthquake',
            },
        ];
    });
}
/** The events since the start of the UTC day `days` ago (stable for a day, so it caches). */
export function quakesUrl(days, minMagnitude, now = Date.now()) {
    const start = new Date(now - days * 24 * 3600 * 1000).toISOString().slice(0, 10);
    const params = new URLSearchParams({
        starttime: `${start}T00:00:00`,
        ...Object.fromEntries(Object.entries(AREA).map(([k, v]) => [k, String(v)])),
        format: 'text',
        orderby: 'time',
    });
    if (minMagnitude !== null)
        params.set('minmagnitude', String(minMagnitude));
    return `${QUAKE_SERVICE}?${params}`;
}
export async function recentQuakes(db, http, days, minMagnitude, now = Date.now()) {
    const url = quakesUrl(days, minMagnitude, now);
    const result = await cached(db, `quakes:${url}`, MAX_AGE_MS, async () => parseQuakes(await http.getText(url, { timeoutMs: 60_000 }), url), now);
    const since = now - days * 24 * 3600 * 1000;
    return {
        quakes: result.value.filter((q) => Date.parse(q.time) >= since),
        fetchedAt: result.fetchedAt,
        stale: result.stale,
    };
}
