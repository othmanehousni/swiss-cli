import { z } from 'zod';
import { parseEnvelope } from '../../providers/util.js';
import { cached } from '../../storage/cache.js';
import { contains, distanceKm } from '../places/geo.js';
/**
 * Snow and avalanches from the WSL Institute for Snow and Avalanche Research (SLF):
 * the IMIS stations in the mountains (snow depth every 30 minutes), the avalanche
 * bulletin (in winter, in the EAWS CAAML v6 format) and its warning regions.
 */
const MEASUREMENTS = 'https://measurement-api.slf.ch/public/api/imis';
export const SNOW_STATIONS = `${MEASUREMENTS}/stations`;
export const WARNING_REGIONS = 'https://aws.slf.ch/api/warningregion/warnregionDefinition/current/geojson';
export const bulletinUrl = (lang) => `https://aws.slf.ch/api/bulletin/caaml/${lang}/json`;
const HOUR_MS = 3600 * 1000;
const StationSchema = z.object({
    code: z.string(),
    label: z.string(),
    lat: z.number(),
    lon: z.number(),
    elevation: z.number().nullish(),
    canton_code: z.string().nullish(),
    type: z.string().nullish(),
});
/** The stations that measure snow depth on flat ground. */
export async function loadSnowStations(db, http) {
    const result = await cached(db, 'slf:stations', 30 * 24 * HOUR_MS, async () => parseEnvelope(z.array(z.unknown()), await http.getJson(SNOW_STATIONS), SNOW_STATIONS, 'the snow stations')
        .flatMap((raw) => {
        const parsed = StationSchema.safeParse(raw);
        return parsed.success && parsed.data.type === 'SNOW_FLAT' ? [parsed.data] : [];
    })
        .map((s) => ({
        code: s.code,
        name: s.label,
        lat: s.lat,
        lon: s.lon,
        elevation: s.elevation ?? null,
        canton: s.canton_code ?? null,
    })));
    return result.value;
}
const Measurement = z.object({
    measure_date: z.string(),
    HS: z.number().nullish(),
    TA_30MIN_MEAN: z.number().nullish(),
});
/** Reads a station's last 24 hours (every 30 minutes, oldest first). */
export function parseSnowReadings(data, url) {
    const rows = parseEnvelope(z.array(z.unknown()), data, url, 'the snow measurements').flatMap((raw) => {
        const parsed = Measurement.safeParse(raw);
        return parsed.success ? [parsed.data] : [];
    });
    const withDepth = rows.filter((r) => r.HS != null);
    const latest = rows.at(-1);
    if (!latest)
        return null;
    const now = withDepth.at(-1);
    const first = withDepth[0];
    const day = 24 * HOUR_MS;
    const spansDay = now && first && Date.parse(now.measure_date) - Date.parse(first.measure_date) >= day - HOUR_MS;
    return {
        at: (now ?? latest).measure_date,
        depth: now?.HS != null ? Math.max(0, Math.round(now.HS)) : null,
        change24h: now?.HS != null && first?.HS != null && spansDay ? Math.round(now.HS - first.HS) : null,
        temperature: latest.TA_30MIN_MEAN ?? null,
    };
}
export async function latestSnow(db, http, station) {
    const url = `${MEASUREMENTS}/station/${encodeURIComponent(station.code)}/measurements`;
    const result = await cached(db, `slf:snow:${station.code}`, 30 * 60 * 1000, async () => parseSnowReadings(await http.getJson(url), url));
    return result.value;
}
/** The snow stations nearest to a point. */
export function nearestSnowStations(stations, point, count = 3, maxKm = 40) {
    return stations
        .map((s) => ({ ...s, km: distanceKm(s, point) }))
        .filter((s) => s.km <= maxKm)
        .sort((a, b) => a.km - b.km)
        .slice(0, count);
}
const RegionFeature = z.object({
    geometry: z.object({
        type: z.enum(['Polygon', 'MultiPolygon']),
        coordinates: z.array(z.unknown()),
    }),
    properties: z.object({
        sector_id: z.union([z.string(), z.number()]),
        sector_name: z.string().nullish(),
        sector_names: z.record(z.string(), z.string()).nullish(),
    }),
});
/** The avalanche warning regions (about 150), refreshed weekly. */
export async function loadWarningRegions(db, http) {
    const result = await cached(db, 'slf:regions', 7 * 24 * HOUR_MS, async () => parseEnvelope(z.object({ features: z.array(z.unknown()) }), await http.getJson(WARNING_REGIONS), WARNING_REGIONS, 'the warning regions').features.flatMap((raw) => {
        const parsed = RegionFeature.safeParse(raw);
        if (!parsed.success)
            return [];
        const p = parsed.data.properties;
        return [
            {
                id: String(p.sector_id),
                names: { ...(p.sector_names ?? {}), ...(p.sector_name ? { local: p.sector_name } : {}) },
                geometry: parsed.data.geometry,
            },
        ];
    }));
    return result.value;
}
export function regionAt(regions, point) {
    return regions.find((r) => contains(r.geometry, point)) ?? null;
}
/** EAWS danger levels. */
export const DANGER_LEVELS = {
    low: 1,
    moderate: 2,
    considerable: 3,
    high: 4,
    very_high: 5,
};
const Elevation = z
    .object({ lowerBound: z.string().nullish(), upperBound: z.string().nullish() })
    .nullish();
const BulletinsSchema = z.object({
    bulletins: z.array(z.object({
        regions: z.array(z.object({ regionID: z.string(), name: z.string().nullish() })).nullish(),
        dangerRatings: z
            .array(z.object({
            mainValue: z.string(),
            elevation: Elevation,
            validTimePeriod: z.string().nullish(),
        }))
            .nullish(),
        avalancheProblems: z
            .array(z.object({
            problemType: z.string(),
            elevation: Elevation,
            aspects: z.array(z.string()).nullish(),
        }))
            .nullish(),
        highlights: z.string().nullish(),
        validTime: z
            .object({ startTime: z.string().nullish(), endTime: z.string().nullish() })
            .nullish(),
        nextUpdate: z.string().nullish(),
    })),
});
/** "2200" -> "2200 m", "treeline" -> "the treeline". */
function bound(text) {
    return /^\d+$/.test(text) ? `${text} m` : `the ${text}`;
}
export function describeElevation(elevation) {
    if (elevation?.lowerBound)
        return `above ${bound(elevation.lowerBound)}`;
    if (elevation?.upperBound)
        return `below ${bound(elevation.upperBound)}`;
    return null;
}
export function parseBulletins(data, url) {
    return parseEnvelope(BulletinsSchema, data, url, 'the avalanche bulletin').bulletins.map((b) => ({
        regions: (b.regions ?? []).map((r) => ({ id: r.regionID, name: r.name ?? r.regionID })),
        ratings: (b.dangerRatings ?? []).map((r) => ({
            level: DANGER_LEVELS[r.mainValue] ?? null,
            value: r.mainValue,
            elevation: describeElevation(r.elevation),
            period: r.validTimePeriod ?? null,
        })),
        problems: (b.avalancheProblems ?? []).map((p) => ({
            type: p.problemType,
            elevation: describeElevation(p.elevation),
            aspects: p.aspects ?? [],
        })),
        highlights: b.highlights?.trim() || null,
        validFrom: b.validTime?.startTime ?? null,
        validUntil: b.validTime?.endTime ?? null,
        nextUpdate: b.nextUpdate ?? null,
    }));
}
export async function loadBulletins(db, http, lang) {
    const url = bulletinUrl(lang);
    const result = await cached(db, `slf:bulletin:${lang}`, 15 * 60 * 1000, async () => parseBulletins(await http.getJson(url), url));
    return { bulletins: result.value, fetchedAt: result.fetchedAt, stale: result.stale };
}
/** The bulletin of a warning region ("1111" is "CH-1111" in the bulletin). */
export function bulletinFor(bulletins, regionId) {
    return (bulletins.find((b) => b.regions.some((r) => r.id.replace(/^CH-/, '') === regionId)) ?? null);
}
export function highestLevel(bulletin) {
    const levels = bulletin.ratings.map((r) => r.level).filter((l) => l !== null);
    return levels.length > 0 ? Math.max(...levels) : null;
}
