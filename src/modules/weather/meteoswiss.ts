import { z } from 'zod';
import { HttpError, UnexpectedResponseError } from '../../crawler/errors.js';
import type { HttpClient } from '../../crawler/http.js';
import { parseEnvelope } from '../../providers/util.js';
import { cached } from '../../storage/cache.js';
import type { Database } from '../../storage/database.js';
import { parseCsv, parseCsvRecords } from '../../util/csv.js';
import { distanceKm } from '../places/geo.js';

/**
 * MeteoSwiss open data on data.geo.admin.ch: the local forecast (every postcode,
 * weather station and many mountain spots, 9 days, updated hourly) and the latest
 * measurements of the SwissMetNet weather stations (every 10 minutes).
 * The source must be named: "Source: MeteoSwiss".
 */
const STAC = 'https://data.geo.admin.ch/api/stac/v1/collections';
const FORECAST = 'ch.meteoschweiz.ogd-local-forecasting';
const STATIONS = 'ch.meteoschweiz.ogd-smn';
export const FORECAST_POINTS = `https://data.geo.admin.ch/${FORECAST}/ogd-local-forecasting_meta_point.csv`;
export const WEATHER_STATIONS = `https://data.geo.admin.ch/${STATIONS}/ogd-smn_meta_stations.csv`;

const HOUR_MS = 3600 * 1000;
const MONTH_MS = 30 * 24 * HOUR_MS;
/** A new forecast comes every hour; a daily forecast three hours old is still current. */
const FORECAST_MAX_AGE_MS = 3 * HOUR_MS;
const NOW_MAX_AGE_MS = 10 * 60 * 1000;

/** The daily values read: the day's pictogram, minimum, maximum and rain (local days). */
export const DAILY = {
  symbol: 'jp2000d0',
  min: 'tre200pn',
  max: 'tre200px',
  rain: 'rka150p0',
} as const;
type Daily = keyof typeof DAILY;

/** The metadata files are Latin-1 encoded. */
function latin1(bytes: Uint8Array): string {
  return new TextDecoder('latin1').decode(bytes);
}

function num(text: string | undefined): number | null {
  if (text === undefined || text.trim() === '') return null;
  const value = Number(text);
  return Number.isFinite(value) ? value : null;
}

/** A place the local forecast is made for. */
export interface ForecastPoint {
  /** "2:800100": the point type and id (ids repeat across types). */
  key: string;
  /** 1 weather station, 2 postcode, 3 mountain spot (peak, pass, hut). */
  type: number;
  name: string;
  postcode: string | null;
  height: number | null;
  lat: number;
  lon: number;
}

export function parseForecastPoints(csv: string): ForecastPoint[] {
  return parseCsvRecords(csv, ';').flatMap((r) => {
    const lat = num(r.point_coordinates_wgs84_lat);
    const lon = num(r.point_coordinates_wgs84_lon);
    const type = num(r.point_type_id);
    if (lat === null || lon === null || type === null || !r.point_id) return [];
    return [
      {
        key: `${type}:${r.point_id.trim()}`,
        type,
        name: (r.point_name ?? '').trim(),
        postcode: (r.postal_code ?? '').trim() || null,
        height: num(r.point_height_masl),
        lat,
        lon,
      },
    ];
  });
}

export async function loadForecastPoints(db: Database, http: HttpClient): Promise<ForecastPoint[]> {
  const result = await cached(db, 'meteoswiss:points', MONTH_MS, async () =>
    parseForecastPoints(latin1(await http.getBytes(FORECAST_POINTS))),
  );
  return result.value;
}

/**
 * The forecast point for a place: its postcode's own point for a postcode or town
 * (unless that lies far from the place, as for a hamlet up a mountain), else the
 * nearest point of any kind (a station, a mountain spot) to where it is.
 */
export function forecastPointFor(
  points: ForecastPoint[],
  place: { lat: number; lon: number; postcode: string | null; kind: string },
): ForecastPoint | null {
  if (place.kind !== 'search' && place.postcode) {
    const own = points.find((p) => p.type === 2 && p.postcode === place.postcode);
    if (own && distanceKm(own, place) <= 3) return own;
  }
  let best: { point: ForecastPoint; km: number } | null = null;
  for (const point of points) {
    const km = distanceKm(point, place);
    if (!best || km < best.km) best = { point, km };
  }
  return best?.point ?? null;
}

export interface DayForecast {
  /** "2026-10-27" (a Swiss calendar day). */
  date: string;
  symbol: number | null;
  min: number | null;
  max: number | null;
  /** mm over the day. */
  rain: number | null;
}

/** One forecast run for every point: the days, then per point [symbol, min, max, rain] per day. */
export interface ForecastRun {
  /** "202610262000" (UTC). */
  run: string;
  days: string[];
  points: Record<string, (number | null)[][]>;
}

const Item = z.object({ assets: z.record(z.string(), z.object({ href: z.string() })) });

function utcDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10).replace(/-/g, '');
}

/** The newest run that has every daily file (the files of a run appear one by one). */
export async function latestRun(
  http: HttpClient,
  now: number = Date.now(),
): Promise<{ run: string; urls: Record<Daily, string> }> {
  let url = '';
  for (const day of [utcDay(now), utcDay(now - 24 * HOUR_MS)]) {
    url = `${STAC}/${FORECAST}/items/${day}-ch`;
    let item: z.infer<typeof Item>;
    try {
      item = parseEnvelope(Item, await http.getJson(url), url, 'the forecast list');
    } catch (error) {
      if (error instanceof HttpError && error.status === 404) continue;
      throw error;
    }
    const runs = new Map<string, Record<string, string>>();
    for (const [name, asset] of Object.entries(item.assets)) {
      const match = /\.(\d{12})\.(\w+)\.csv$/.exec(name);
      if (!match?.[1] || !match[2]) continue;
      runs.set(match[1], { ...runs.get(match[1]), [match[2]]: asset.href });
    }
    const complete = [...runs.entries()]
      .filter(([, files]) => Object.values(DAILY).every((p) => files[p]))
      .sort(([a], [b]) => b.localeCompare(a))[0];
    if (complete) {
      const [run, files] = complete;
      const urls = Object.fromEntries(
        Object.entries(DAILY).map(([key, parameter]) => [key, files[parameter] as string]),
      ) as Record<Daily, string>;
      return { run, urls };
    }
  }
  throw new UnexpectedResponseError(url, 'there is no complete forecast run');
}

/** Reads the daily files of a run ("point_id;point_type_id;Date;<parameter>"). */
export function parseRun(run: string, files: Record<Daily, string>): ForecastRun {
  const order: Daily[] = ['symbol', 'min', 'max', 'rain'];
  const values = new Map<string, Map<string, (number | null)[]>>();
  const days = new Set<string>();
  order.forEach((name, column) => {
    const [header, ...rows] = parseCsv(files[name], ';');
    if (!header || header[3] !== DAILY[name]) {
      throw new Error(`the ${DAILY[name]} forecast file has unexpected columns`);
    }
    for (const [id, type, date, value] of rows) {
      if (!id || !type || !date) continue;
      const day = `${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6, 8)}`;
      days.add(day);
      const key = `${type}:${id}`;
      let point = values.get(key);
      if (!point) {
        point = new Map();
        values.set(key, point);
      }
      const entry = point.get(day) ?? [null, null, null, null];
      entry[column] = num(value);
      point.set(day, entry);
    }
  });
  const sortedDays = [...days].sort();
  const points: Record<string, (number | null)[][]> = {};
  for (const [key, byDay] of values) {
    points[key] = sortedDays.map((d) => byDay.get(d) ?? [null, null, null, null]);
  }
  return { run, days: sortedDays, points };
}

export interface Forecast {
  run: string;
  fetchedAt: string;
  stale: boolean;
  days: DayForecast[];
}

/**
 * The daily forecast of a point. The newest run's four daily files (about 1.3 MB each,
 * for every point) are downloaded at most every three hours and kept for all points.
 */
export async function dailyForecast(
  db: Database,
  http: HttpClient,
  point: ForecastPoint,
  now: number = Date.now(),
): Promise<Forecast> {
  const result = await cached(
    db,
    'meteoswiss:forecast',
    FORECAST_MAX_AGE_MS,
    async () => {
      const { run, urls } = await latestRun(http, now);
      const entries = await Promise.all(
        (Object.keys(urls) as Daily[]).map(async (name) => [name, await http.getText(urls[name])]),
      );
      return parseRun(run, Object.fromEntries(entries) as Record<Daily, string>);
    },
    now,
  );
  const { run, days, points } = result.value;
  const rows = points[point.key] ?? [];
  return {
    run,
    fetchedAt: result.fetchedAt,
    stale: result.stale,
    days: days.map((date, i) => {
      const [symbol = null, min = null, max = null, rain = null] = rows[i] ?? [];
      return { date, symbol, min, max, rain };
    }),
  };
}

export interface WeatherStation {
  id: string;
  name: string;
  canton: string;
  height: number | null;
  lat: number;
  lon: number;
}

export function parseWeatherStations(csv: string): WeatherStation[] {
  return parseCsvRecords(csv, ';').flatMap((r) => {
    const lat = num(r.station_coordinates_wgs84_lat);
    const lon = num(r.station_coordinates_wgs84_lon);
    if (lat === null || lon === null || !r.station_abbr) return [];
    return [
      {
        id: r.station_abbr.trim(),
        name: (r.station_name ?? '').trim(),
        canton: (r.station_canton ?? '').trim(),
        height: num(r.station_height_masl),
        lat,
        lon,
      },
    ];
  });
}

export async function loadWeatherStations(
  db: Database,
  http: HttpClient,
): Promise<WeatherStation[]> {
  const result = await cached(db, 'meteoswiss:stations', MONTH_MS, async () =>
    parseWeatherStations(latin1(await http.getBytes(WEATHER_STATIONS))),
  );
  return result.value;
}

/**
 * The station that best stands for a place: near it and at a similar height
 * (100 m of height count like 1 km of distance), so a valley town does not get a
 * summit's temperature.
 */
export function nearestStation(
  stations: WeatherStation[],
  place: { lat: number; lon: number },
  height: number | null,
): { station: WeatherStation; km: number } | null {
  let best: { station: WeatherStation; km: number; score: number } | null = null;
  for (const station of stations) {
    const km = distanceKm(station, place);
    const climb =
      height !== null && station.height !== null ? Math.abs(station.height - height) : 0;
    const score = km + climb / 100;
    if (!best || score < best.score) best = { station, km, score };
  }
  return best ? { station: best.station, km: best.km } : null;
}

/** The latest measurements of a station (10-minute values). */
export interface Measurement {
  /** ISO time of the measurement. */
  time: string;
  temperature: number | null;
  humidity: number | null;
  /** km/h, 10-minute mean. */
  wind: number | null;
  gusts: number | null;
  /** Degrees the wind comes from. */
  direction: number | null;
  /** mm in the last hour. */
  rainLastHour: number | null;
  /** Minutes of sunshine in the last hour. */
  sunLastHour: number | null;
  /** Snow depth in cm, where measured. */
  snow: number | null;
}

/** "26.10.2026 19:40" (UTC) -> ISO. */
function measuredAt(text: string): string | null {
  const match = /^(\d{2})\.(\d{2})\.(\d{4}) (\d{2}):(\d{2})$/.exec(text.trim());
  if (!match) return null;
  const [, d, m, y, h, min] = match.map(Number) as number[];
  return new Date(Date.UTC(y as number, (m as number) - 1, d, h, min)).toISOString();
}

/** Reads a station's "t_now" file: today's 10-minute values, the newest last. */
export function parseMeasurements(csv: string): Measurement | null {
  const rows = parseCsvRecords(csv, ';').filter((r) => num(r.tre200s0) !== null);
  const latest = rows.at(-1);
  const time = latest ? measuredAt(latest.reference_timestamp ?? '') : null;
  if (!latest || !time) return null;
  const lastHour = rows.slice(-6);
  const sum = (column: string) => {
    const values = lastHour.map((r) => num(r[column])).filter((v): v is number => v !== null);
    return values.length === 0 ? null : Math.round(values.reduce((a, b) => a + b, 0) * 10) / 10;
  };
  return {
    time,
    temperature: num(latest.tre200s0),
    humidity: num(latest.ure200s0),
    wind: num(latest.fu3010z0),
    gusts: num(latest.fu3010z1),
    direction: num(latest.dkl010z0),
    rainLastHour: sum('rre150z0'),
    sunLastHour: sum('sre000z0'),
    snow: num(latest.htoauts0),
  };
}

export async function latestMeasurement(
  db: Database,
  http: HttpClient,
  station: WeatherStation,
): Promise<Measurement | null> {
  const id = station.id.toLowerCase();
  const url = `https://data.geo.admin.ch/${STATIONS}/${id}/ogd-smn_${id}_t_now.csv`;
  const result = await cached(db, `meteoswiss:now:${id}`, NOW_MAX_AGE_MS, async () =>
    parseMeasurements(await http.getText(url)),
  );
  return result.value;
}
