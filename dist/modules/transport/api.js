import { z } from 'zod';
import { parseEnvelope } from '../../providers/util.js';
import { cached } from '../../storage/cache.js';
import { zurichMoment } from '../../util/when.js';
/**
 * transport.opendata.ch: Swiss public transport timetables with real-time data
 * (every train, tram, bus, boat and cable car). It asks clients to cache what they
 * can: the timetable changes twice a week, real-time data every 30 seconds.
 */
export const TRANSPORT_API = 'https://transport.opendata.ch/v1';
const REAL_TIME_MS = 30_000;
const STOPS_MS = 7 * 24 * 3600 * 1000;
const Coordinate = z.object({ x: z.number().nullish(), y: z.number().nullish() }).nullish();
const LocationSchema = z.object({
    id: z.string().nullish(),
    name: z.string().nullish(),
    coordinate: Coordinate,
    distance: z.number().nullish(),
    icon: z.string().nullish(),
});
const Prognosis = z
    .object({
    platform: z.string().nullish(),
    arrival: z.string().nullish(),
    departure: z.string().nullish(),
})
    .nullish();
const Checkpoint = z.object({
    station: LocationSchema.nullish(),
    location: LocationSchema.nullish(),
    arrivalTimestamp: z.number().nullish(),
    departureTimestamp: z.number().nullish(),
    delay: z.number().nullish(),
    platform: z.string().nullish(),
    prognosis: Prognosis,
});
const Journey = z
    .object({
    category: z.string().nullish(),
    number: z.string().nullish(),
    operator: z.string().nullish(),
    to: z.string().nullish(),
    passList: z.array(z.unknown()).nullish(),
})
    .nullish();
const ConnectionsResponse = z.object({
    connections: z.array(z.object({
        from: Checkpoint,
        to: Checkpoint,
        duration: z.string().nullish(),
        transfers: z.number().nullish(),
        sections: z.array(z.object({
            journey: Journey,
            walk: z.object({ duration: z.number().nullish() }).nullish(),
            departure: Checkpoint,
            arrival: Checkpoint,
        })),
    })),
    from: LocationSchema.nullish(),
    to: LocationSchema.nullish(),
});
const LocationsResponse = z.object({ stations: z.array(LocationSchema) });
const StationboardResponse = z.object({
    station: LocationSchema.nullish(),
    stationboard: z.array(z.object({
        stop: Checkpoint,
        category: z.string().nullish(),
        number: z.string().nullish(),
        operator: z.string().nullish(),
        to: z.string().nullish(),
    })),
});
function location(raw) {
    if (!raw?.name)
        return null;
    return {
        id: raw.id ?? null,
        name: raw.name,
        lat: raw.coordinate?.x ?? null,
        lon: raw.coordinate?.y ?? null,
        type: raw.icon ?? null,
        distance: raw.distance ?? null,
    };
}
function stopTime(raw, kind) {
    const time = (kind === 'departure' ? raw.departureTimestamp : raw.arrivalTimestamp) ?? null;
    const prognosis = kind === 'departure' ? raw.prognosis?.departure : raw.prognosis?.arrival;
    const expectedMs = prognosis ? Date.parse(prognosis) : Number.NaN;
    const expected = Number.isFinite(expectedMs) ? Math.round(expectedMs / 1000) : null;
    const delay = raw.delay ?? (time !== null && expected !== null ? Math.round((expected - time) / 60) : null);
    const platform = raw.platform || null;
    const changed = raw.prognosis?.platform;
    return {
        name: raw.station?.name ?? raw.location?.name ?? '',
        time,
        expected,
        delay,
        platform,
        newPlatform: changed && changed !== platform ? changed : null,
    };
}
const CATEGORY_NAMES = {
    B: 'Bus',
    BUS: 'Bus',
    T: 'Tram',
    BAT: 'Boat',
    FUN: 'Funicular',
};
/** "IC 5", "S 3", "Bus 21", "Tram 11", "m2". */
export function lineName(category, number) {
    const cat = (category ?? '').trim();
    const num = (number ?? '').trim();
    if (!num)
        return CATEGORY_NAMES[cat] ?? cat;
    if (!cat || num.toLowerCase().startsWith(cat.toLowerCase()))
        return num;
    return `${CATEGORY_NAMES[cat] ?? cat} ${num}`;
}
/** "00d02:22:00" -> 142 (minutes). */
export function durationMinutes(text) {
    const match = /^(\d+)d(\d{2}):(\d{2}):(\d{2})$/.exec(text ?? '');
    if (!match)
        return null;
    return Number(match[1]) * 1440 + Number(match[2]) * 60 + Number(match[3]);
}
async function ask(db, http, url, maxAgeMs, parse) {
    const result = await cached(db, `transport:${url}`, maxAgeMs, async () => parse(await http.getJson(url)));
    return { value: result.value, fetchedAt: result.fetchedAt, stale: result.stale };
}
export function connectionsUrl(query) {
    const params = new URLSearchParams({ from: query.from, to: query.to });
    for (const via of query.via ?? [])
        params.append('via[]', via);
    if (query.date)
        params.set('date', query.date);
    if (query.time)
        params.set('time', query.time);
    if (query.arrive)
        params.set('isArrivalTime', '1');
    params.set('limit', String(query.limit ?? 4));
    for (const t of query.transportations ?? [])
        params.append('transportations[]', t);
    return `${TRANSPORT_API}/connections?${params}`;
}
/** The next trips from one place to another (stops, addresses or "lat,lon"). */
export async function findTrips(db, http, query) {
    const url = connectionsUrl(query);
    return ask(db, http, url, REAL_TIME_MS, (data) => {
        const response = parseEnvelope(ConnectionsResponse, data, url, 'the timetable');
        return {
            from: location(response.from),
            to: location(response.to),
            trips: response.connections.map((c) => ({
                departure: stopTime(c.from, 'departure'),
                arrival: stopTime(c.to, 'arrival'),
                minutes: durationMinutes(c.duration),
                transfers: c.transfers ?? 0,
                legs: c.sections.map((s) => ({
                    line: s.journey ? lineName(s.journey.category, s.journey.number) : null,
                    operator: s.journey?.operator ?? null,
                    direction: s.journey?.to ?? null,
                    walkMinutes: s.walk && !s.journey ? Math.max(1, Math.round((s.walk.duration ?? 0) / 60)) : null,
                    departure: stopTime(s.departure, 'departure'),
                    arrival: stopTime(s.arrival, 'arrival'),
                    stops: Math.max(0, (s.journey?.passList?.length ?? 2) - 2),
                })),
            })),
        };
    });
}
/** Stops, addresses and points matching a name, or the stops near a point. */
export async function findLocations(db, http, search) {
    const params = 'query' in search
        ? new URLSearchParams({ query: search.query })
        : new URLSearchParams({ x: String(search.lat), y: String(search.lon), type: 'station' });
    const url = `${TRANSPORT_API}/locations?${params}`;
    const result = await ask(db, http, url, STOPS_MS, (data) => parseEnvelope(LocationsResponse, data, url, 'the stop search')
        .stations.map(location)
        .filter((l) => l !== null));
    return result.value;
}
/**
 * The stop people mean by a name ("Bern", "Zurich", "Lausanne, gare"), or the stop
 * nearest to an address or postcode.
 */
export async function findStop(db, http, text) {
    const found = await findLocations(db, http, { query: text });
    const stop = found.find((l) => l.id);
    if (stop)
        return stop;
    const point = found.find((l) => l.lat !== null && l.lon !== null);
    if (!point || point.lat === null || point.lon === null)
        return null;
    return ((await findLocations(db, http, { lat: point.lat, lon: point.lon })).find((l) => l.id) ?? null);
}
export function stationboardUrl(query) {
    const params = new URLSearchParams(query.stop.id ? { id: query.stop.id } : { station: query.stop.name });
    params.set('limit', String(query.limit ?? 15));
    if (query.date || query.time) {
        const date = query.date ?? zurichMoment(Date.now()).date;
        params.set('datetime', `${date} ${query.time ?? '00:00'}`);
    }
    for (const t of query.transportations ?? [])
        params.append('transportations[]', t);
    return `${TRANSPORT_API}/stationboard?${params}`;
}
/** The departure board of a stop. */
export async function stationboard(db, http, query) {
    const url = stationboardUrl(query);
    return ask(db, http, url, REAL_TIME_MS, (data) => {
        const response = parseEnvelope(StationboardResponse, data, url, 'the departure board');
        return {
            stop: location(response.station),
            entries: response.stationboard.map((e) => ({
                line: lineName(e.category, e.number),
                operator: e.operator ?? null,
                direction: e.to ?? null,
                departure: stopTime(e.stop, 'departure'),
            })),
        };
    });
}
