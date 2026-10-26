import { z } from 'zod';
import type { HttpClient } from '../../crawler/http.js';
import { parseEnvelope } from '../../providers/util.js';
import { cached } from '../../storage/cache.js';
import type { Database } from '../../storage/database.js';
import { distanceKm } from '../places/geo.js';

/**
 * Public charging points for electric cars, from the Swiss Federal Office of Energy
 * (data.geo.admin.ch, the data behind ich-tanke-strom.ch): every operator's charge
 * points with plugs and power, and whether each one is free right now.
 */
const FILES = 'https://data.geo.admin.ch/ch.bfe.ladestellen-elektromobilitaet';
export const CHARGING_DATA = `${FILES}/data/ch.bfe.ladestellen-elektromobilitaet.json`;
export const CHARGING_STATUS = `${FILES}/status/ch.bfe.ladestellen-elektromobilitaet.json`;
const DAY_MS = 24 * 3600 * 1000;
const STATUS_MAX_AGE_MS = 60_000;

const EvseRecord = z.object({
  EvseID: z.string(),
  Accessibility: z.string().nullish(),
  Address: z
    .object({
      City: z.string().nullish(),
      PostalCode: z.string().nullish(),
      Street: z.string().nullish(),
      HouseNum: z.string().nullish(),
    })
    .nullish(),
  ChargingFacilities: z
    .array(z.object({ power: z.union([z.string(), z.number()]).nullish() }))
    .nullish(),
  ChargingStationNames: z.array(z.object({ lang: z.string(), value: z.string() })).nullish(),
  GeoCoordinates: z.object({ Google: z.string().nullish() }).nullish(),
  IsOpen24Hours: z.boolean().nullish(),
  Plugs: z.array(z.string()).nullish(),
});
const DataFile = z.object({
  EVSEData: z.array(
    z.object({
      OperatorName: z.string().nullish(),
      EVSEDataRecord: z.array(z.unknown()),
    }),
  ),
});
const StatusFile = z.object({
  EVSEStatuses: z.array(
    z.object({
      EVSEStatusRecord: z.array(z.object({ EvseID: z.string(), EVSEStatus: z.string() })),
    }),
  ),
});

/** The plugs by the names people know. */
const PLUGS: Record<string, string> = {
  'Type 2 Outlet': 'Type 2',
  'Type 2 Connector (Cable Attached)': 'Type 2 cable',
  'CCS Combo 2 Plug (Cable Attached)': 'CCS',
  'CCS Combo 1 Plug (Cable Attached)': 'CCS1',
  CHAdeMO: 'CHAdeMO',
  'Tesla Connector': 'Tesla',
  'Type 1 Connector (Cable Attached)': 'Type 1',
  'Type J Swiss Standard': 'Swiss socket',
  'Type F Schuko': 'Schuko',
  'Type G British Standard': 'UK socket',
};

export function plugName(plug: string): string {
  return PLUGS[plug] ?? plug;
}

/** One charge point (a connector that charges one car at a time). */
export interface ChargePoint {
  id: string;
  /** kW. */
  power: number | null;
  plugs: string[];
}

/** A charging station: the charge points of one operator at one place. */
export interface ChargingStation {
  name: string;
  operator: string;
  address: string;
  lat: number;
  lon: number;
  /** Anyone may charge (free or paying); otherwise customers, guests or staff only. */
  publicAccess: boolean;
  open24h: boolean;
  points: ChargePoint[];
}

function stationAddress(r: z.infer<typeof EvseRecord>): string {
  const street = [r.Address?.Street, r.Address?.HouseNum].filter(Boolean).join(' ').trim();
  const town = [r.Address?.PostalCode, r.Address?.City].filter(Boolean).join(' ').trim();
  return [street, town].filter(Boolean).join(', ');
}

/** Reads the operators' charge points and groups them into stations. */
export function parseChargingData(data: unknown, lang = 'en'): ChargingStation[] {
  const file = parseEnvelope(DataFile, data, CHARGING_DATA, 'the charging station list');
  const stations = new Map<string, ChargingStation>();
  for (const operator of file.EVSEData) {
    for (const raw of operator.EVSEDataRecord) {
      const parsed = EvseRecord.safeParse(raw);
      if (!parsed.success) continue;
      const r = parsed.data;
      const [lat, lon] = (r.GeoCoordinates?.Google ?? '').split(/\s+/).map(Number);
      if (!lat || !lon || !Number.isFinite(lat) || !Number.isFinite(lon)) continue;
      if (r.Accessibility === 'Test Station') continue;
      const operatorName = operator.OperatorName ?? '';
      const key = `${operatorName}|${lat.toFixed(5)},${lon.toFixed(5)}`;
      let station = stations.get(key);
      if (!station) {
        const names = r.ChargingStationNames ?? [];
        const name = (names.find((n) => n.lang === lang) ?? names[0])?.value.trim() ?? '';
        station = {
          name,
          operator: operatorName,
          address: stationAddress(r),
          lat,
          lon,
          publicAccess: r.Accessibility !== 'Restricted access',
          open24h: r.IsOpen24Hours === true,
          points: [],
        };
        stations.set(key, station);
      }
      const powers = (r.ChargingFacilities ?? [])
        .map((f) => Number(f.power))
        .filter((p) => Number.isFinite(p) && p > 0);
      station.points.push({
        id: r.EvseID,
        power: powers.length > 0 ? Math.max(...powers) : null,
        plugs: [...new Set((r.Plugs ?? []).map(plugName))],
      });
    }
  }
  return [...stations.values()];
}

/** The stations, downloaded at most once a day (about 1 MB compressed). */
export async function loadChargingStations(
  db: Database,
  http: HttpClient,
  lang = 'en',
): Promise<ChargingStation[]> {
  const result = await cached(db, `charging:stations:${lang}`, DAY_MS, async () =>
    parseChargingData(await http.getJson(CHARGING_DATA, { timeoutMs: 120_000 }), lang),
  );
  return result.value;
}

export type ChargeStatus = 'Available' | 'Occupied' | 'OutOfService' | 'Reserved' | 'Unknown';

/** Whether each charge point is free right now (refreshed every minute). */
export async function loadChargingStatus(
  db: Database,
  http: HttpClient,
): Promise<{ status: Record<string, ChargeStatus>; fetchedAt: string; stale: boolean }> {
  const result = await cached(db, 'charging:status', STATUS_MAX_AGE_MS, async () => {
    const file = parseEnvelope(
      StatusFile,
      await http.getJson(CHARGING_STATUS),
      CHARGING_STATUS,
      'the charging status',
    );
    const status: Record<string, ChargeStatus> = {};
    for (const operator of file.EVSEStatuses) {
      for (const r of operator.EVSEStatusRecord) {
        status[r.EvseID] = (
          ['Available', 'Occupied', 'OutOfService', 'Reserved'].includes(r.EVSEStatus)
            ? r.EVSEStatus
            : 'Unknown'
        ) as ChargeStatus;
      }
    }
    return status;
  });
  return { status: result.value, fetchedAt: result.fetchedAt, stale: result.stale };
}

export interface StationFilter {
  radiusKm: number;
  minPower?: number;
  /** Plug names as shown (Type 2, CCS, ...). */
  plugs?: string[];
  includeRestricted?: boolean;
}

export interface NearbyStation extends ChargingStation {
  km: number;
  maxPower: number | null;
}

/** Stations around a point, nearest first. */
export function stationsNear(
  stations: ChargingStation[],
  point: { lat: number; lon: number },
  filter: StationFilter,
): NearbyStation[] {
  const out: NearbyStation[] = [];
  for (const station of stations) {
    if (!filter.includeRestricted && !station.publicAccess) continue;
    const km = distanceKm(station, point);
    if (km > filter.radiusKm) continue;
    const points = station.points.filter(
      (p) =>
        (!filter.minPower || (p.power ?? 0) >= filter.minPower) &&
        (!filter.plugs?.length || p.plugs.some((plug) => filter.plugs?.includes(plug))),
    );
    if (points.length === 0) continue;
    const powers = points.map((p) => p.power).filter((p): p is number => p !== null);
    out.push({ ...station, points, km, maxPower: powers.length ? Math.max(...powers) : null });
  }
  return out.sort((a, b) => a.km - b.km);
}
