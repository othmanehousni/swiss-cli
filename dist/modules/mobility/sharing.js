import { z } from 'zod';
import { parseEnvelope } from '../../providers/util.js';
import { cached } from '../../storage/cache.js';
import { distanceKm } from '../places/geo.js';
/**
 * sharedmobility.ch (Swiss Federal Office of Energy): shared bikes, e-bikes,
 * e-scooters, cargo bikes, mopeds and cars of every provider, live. Results come
 * 50 at a time, in no particular order.
 */
export const SHARING_API = 'https://api.sharedmobility.ch/v1/sharedmobility/identify';
const PAGE = 50;
const MAX_PAGES = 4;
const LIVE_MS = 60_000;
/** The vehicle types the service knows. */
export const VEHICLE_TYPES = [
    'E-Scooter',
    'E-Bike',
    'Bike',
    'E-CargoBike',
    'CargoBike',
    'E-Moped',
    'Car',
    'E-Car',
    'Other',
];
const TYPE_NAMES = {
    'E-Scooter': ['e-scooter', 'e-scooters'],
    'E-Bike': ['e-bike', 'e-bikes'],
    Bike: ['bike', 'bikes'],
    'E-CargoBike': ['e-cargo bike', 'e-cargo bikes'],
    CargoBike: ['cargo bike', 'cargo bikes'],
    'E-Moped': ['e-moped', 'e-mopeds'],
    Car: ['car', 'cars'],
    'E-Car': ['electric car', 'electric cars'],
    Other: ['other vehicle', 'other vehicles'],
};
export function typeName(type, count = 1) {
    const names = TYPE_NAMES[type] ?? [type, type];
    return count === 1 ? names[0] : names[1];
}
const Feature = z.object({
    geometry: z.object({ x: z.number(), y: z.number() }),
    attributes: z.object({
        id: z.string(),
        provider_name: z.string().nullish(),
        pickup_type: z.string().nullish(),
        available: z.boolean().nullish(),
        station_name: z.string().nullish(),
        station_status_num_vehicle_available: z.number().nullish(),
        station_status_renting: z.boolean().nullish(),
        vehicle_type: z.array(z.string()).nullish(),
        vehicle_status_disabled: z.boolean().nullish(),
        vehicle_status_reserved: z.boolean().nullish(),
    }),
});
/** "Voi Technology AB" -> "Voi", "bird zurich" -> "Bird zurich". */
export function providerName(name) {
    const short = (name ?? '')
        .replace(/\s+from\s+.*$/i, '')
        .replace(/\s+City partners$/i, '')
        .replace(/\s+Technology\s+(AB|OÜ|Inc\.?)$/i, '')
        .replace(/\s+(AG|GmbH|SA)$/i, '')
        .trim();
    return short ? short.charAt(0).toUpperCase() + short.slice(1) : 'Unknown';
}
/** Reads one page: the offers, and how many results the page had (50 means more may follow). */
export function parseOffers(data, url) {
    const page = parseEnvelope(z.array(z.unknown()), data, url, 'the shared mobility answer');
    const offers = page.flatMap((raw) => {
        const parsed = Feature.safeParse(raw);
        if (!parsed.success)
            return [];
        const { geometry, attributes: a } = parsed.data;
        const station = a.pickup_type === 'station_based' ? (a.station_name ?? 'Station') : null;
        if (station === null &&
            (a.vehicle_status_disabled || a.vehicle_status_reserved || a.available === false)) {
            return [];
        }
        return [
            {
                id: a.id,
                provider: providerName(a.provider_name),
                station,
                types: a.vehicle_type ?? [],
                available: station === null
                    ? 1
                    : a.station_status_renting === false
                        ? 0
                        : (a.station_status_num_vehicle_available ?? 0),
                lat: geometry.y,
                lon: geometry.x,
            },
        ];
    });
    return { offers, count: page.length };
}
export function sharingUrl(point, radiusM, offset, type) {
    const params = new URLSearchParams({
        Geometry: `${point.lon.toFixed(6)},${point.lat.toFixed(6)}`,
        Tolerance: String(Math.round(radiusM)),
        offset: String(offset),
        geometryFormat: 'esrijson',
    });
    if (type)
        params.set('filters', `ch.bfe.sharedmobility.vehicle_type=${type}`);
    return `${SHARING_API}?${params}`;
}
/**
 * Stations and vehicles around a point, nearest first. One question per vehicle type
 * asked for (the service filters one type at a time), up to 200 results each.
 */
export async function offersNear(db, http, point, radiusM, types = []) {
    const found = new Map();
    let complete = true;
    let fetchedAt = new Date().toISOString();
    for (const type of types.length > 0 ? types : [undefined]) {
        for (let page = 0; page < MAX_PAGES; page++) {
            const url = sharingUrl(point, radiusM, page * PAGE, type);
            const result = await cached(db, `sharing:${url}`, LIVE_MS, async () => parseOffers(await http.getJson(url), url));
            fetchedAt = result.fetchedAt < fetchedAt ? result.fetchedAt : fetchedAt;
            for (const offer of result.value.offers)
                found.set(offer.id, offer);
            if (result.value.count < PAGE)
                break;
            if (page === MAX_PAGES - 1)
                complete = false;
        }
    }
    const offers = [...found.values()]
        .filter((o) => types.length === 0 || o.types.some((t) => types.includes(t)))
        .map((o) => ({ ...o, km: distanceKm(o, point) }))
        .sort((a, b) => a.km - b.km);
    return { offers, complete, fetchedAt };
}
