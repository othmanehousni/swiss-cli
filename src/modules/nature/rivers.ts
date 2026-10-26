import { z } from 'zod';
import type { HttpClient } from '../../crawler/http.js';
import { looseKey } from '../../normalization/text.js';
import { parseEnvelope } from '../../providers/util.js';
import { cached } from '../../storage/cache.js';
import type { Database } from '../../storage/database.js';
import { lv95ToWgs84 } from '../places/geo.js';

/**
 * Rivers and lakes from the Federal Office for the Environment (FOEN/BAFU,
 * hydrodaten.admin.ch): water temperature, flow and lake levels every 10 minutes,
 * and the thresholds of the flood danger levels.
 */
const MAPS = 'https://www.hydrodaten.admin.ch/web-hydro-maps';
export const TEMPERATURES = `${MAPS}/hydro_sensor_temperature.geojson`;
export const FLOWS = `${MAPS}/hydro_sensor_pq.geojson`;
const MAX_AGE_MS = 10 * 60 * 1000;

const Feature = z.object({
  geometry: z.object({ coordinates: z.array(z.number()).min(2) }),
  properties: z.object({
    key: z.union([z.string(), z.number()]),
    label: z.string(),
    hydro_body_name: z.string().nullish(),
    kind: z.string().nullish(),
    last_value: z.union([z.string(), z.number()]).nullish(),
    min_24h: z.union([z.string(), z.number()]).nullish(),
    max_24h: z.union([z.string(), z.number()]).nullish(),
    unit_short: z.string().nullish(),
    metric: z.string().nullish(),
    last_measured_at: z.string().nullish(),
    failure_text: z.string().nullish(),
    wl_1: z.string().nullish(),
    wl_2: z.string().nullish(),
    wl_3: z.string().nullish(),
    wl_4: z.string().nullish(),
  }),
});
const Collection = z.object({ features: z.array(z.unknown()) });

function number(value: string | number | null | undefined): number | null {
  if (value === null || value === undefined || value === '') return null;
  const n = typeof value === 'number' ? value : Number.parseFloat(value);
  return Number.isFinite(n) ? n : null;
}

export interface Reading {
  value: number;
  min24h: number | null;
  max24h: number | null;
  unit: string;
  /** ISO time of the measurement. */
  at: string | null;
}

/** A measuring station on a river or lake. */
export interface WaterStation {
  key: string;
  /** "Aare - Bern, Schönau". */
  name: string;
  /** The river or lake: "Aare". */
  water: string;
  kind: 'river' | 'lake';
  lat: number;
  lon: number;
  temperature: Reading | null;
  /** Flow (m³/s or l/s) of a river, or the level (m above sea level) of a lake. */
  flow: Reading | null;
  /** Flood danger level 1 (none or low) to 5 (very high), where thresholds are known. */
  danger: number | null;
  /** The station's own note, e.g. when a sensor is out of order. */
  note: string | null;
}

function reading(p: z.infer<typeof Feature>['properties']): Reading | null {
  const value = number(p.last_value);
  if (value === null) return null;
  return {
    value,
    min24h: number(p.min_24h),
    max24h: number(p.max_24h),
    unit: (p.unit_short ?? '').replace('m ü.M.', 'm'),
    at: p.last_measured_at ?? null,
  };
}

/**
 * The danger level the latest value reaches: thresholds "4.0 m³/s" or "724.10 m ü.M."
 * mark levels 2 to 5; only thresholds in the value's own unit count.
 */
export function dangerLevel(
  value: Reading | null,
  thresholds: (string | null | undefined)[],
): number | null {
  if (!value) return null;
  const unitOf = (text: string) =>
    /m³\/s/.test(text) ? 'm³/s' : /l\/s/.test(text) ? 'l/s' : /m ü\.?M/.test(text) ? 'm' : '';
  const limits = thresholds
    .filter((t): t is string => Boolean(t) && unitOf(t as string) === value.unit)
    .map((t) => number(t))
    .filter((n): n is number => n !== null);
  if (limits.length === 0) return null;
  return 1 + limits.filter((limit) => value.value >= limit).length;
}

function features(data: unknown, url: string): z.infer<typeof Feature>[] {
  return parseEnvelope(Collection, data, url, 'the river data').features.flatMap((raw) => {
    const parsed = Feature.safeParse(raw);
    return parsed.success ? [parsed.data] : [];
  });
}

/** Joins the temperature and flow stations (the same key is the same station). */
export function parseWaterStations(temperatures: unknown, flows: unknown): WaterStation[] {
  const stations = new Map<string, WaterStation>();
  const station = (f: z.infer<typeof Feature>): WaterStation => {
    const key = String(f.properties.key);
    let found = stations.get(key);
    if (!found) {
      const [east = 0, north = 0] = f.geometry.coordinates;
      // The files use Swiss coordinates (LV95); WGS84 is still accepted.
      const point = east > 1000 ? lv95ToWgs84(east, north) : { lat: north, lon: east };
      found = {
        key,
        name: f.properties.label,
        water:
          f.properties.hydro_body_name || f.properties.label.split(' - ')[0] || f.properties.label,
        kind: 'river',
        lat: point.lat,
        lon: point.lon,
        temperature: null,
        flow: null,
        danger: null,
        note: null,
      };
      stations.set(key, found);
    }
    return found;
  };
  for (const f of features(temperatures, TEMPERATURES)) {
    const s = station(f);
    s.temperature = reading(f.properties);
    s.note = f.properties.failure_text?.trim() || s.note;
  }
  for (const f of features(flows, FLOWS)) {
    const s = station(f);
    const p = f.properties;
    s.kind = p.kind === 'lake' ? 'lake' : 'river';
    s.flow = reading(p);
    s.danger = dangerLevel(s.flow, [p.wl_1, p.wl_2, p.wl_3, p.wl_4]);
    s.note = p.failure_text?.trim() || s.note;
  }
  return [...stations.values()];
}

export async function loadWaterStations(
  db: Database,
  http: HttpClient,
): Promise<{ stations: WaterStation[]; fetchedAt: string; stale: boolean }> {
  const result = await cached(db, 'hydro:stations', MAX_AGE_MS, async () => {
    const [temperatures, flows] = await Promise.all([
      http.getJson(TEMPERATURES),
      http.getJson(FLOWS),
    ]);
    return parseWaterStations(temperatures, flows);
  });
  return { stations: result.value, fetchedAt: result.fetchedAt, stale: result.stale };
}

/** Stations of a river or lake, or whose name contains the words ("aare", "zürichsee"). */
export function findWaters(stations: WaterStation[], query: string): WaterStation[] {
  const key = looseKey(query);
  const exact = stations.filter((s) => looseKey(s.water) === key);
  if (exact.length > 0) return exact;
  return stations.filter((s) => looseKey(s.name).includes(key));
}

export const DANGER_NAMES: Record<number, string> = {
  1: 'no or low danger',
  2: 'moderate danger',
  3: 'considerable danger',
  4: 'high danger',
  5: 'very high danger',
};
