import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { HttpClient } from '../../src/crawler/http.js';
import {
  CHARGING_STATUS,
  loadChargingStatus,
  parseChargingData,
  stationsNear,
} from '../../src/modules/mobility/charging.js';
import {
  formatDistance,
  parsePlugs,
  parseVehicleTypes,
} from '../../src/modules/mobility/command.js';
import { offersNear, parseOffers, providerName } from '../../src/modules/mobility/sharing.js';
import { Database } from '../../src/storage/database.js';
import { createFakeFetch } from '../helpers/fake-fetch.js';

function evse(id: string, extra: Record<string, unknown> = {}) {
  return {
    EvseID: id,
    Accessibility: 'Free publicly accessible',
    Address: { City: 'Lausanne', PostalCode: '1003', Street: 'Avenue de la Gare' },
    ChargingFacilities: [{ power: '22.0' }],
    ChargingStationNames: [
      { lang: 'en', value: 'Gare' },
      { lang: 'fr', value: 'Gare CFF' },
    ],
    GeoCoordinates: { Google: '46.5170 6.6290' },
    IsOpen24Hours: true,
    Plugs: ['Type 2 Outlet'],
    ...extra,
  };
}

const DATA = {
  EVSEData: [
    {
      OperatorName: 'GoFast',
      EVSEDataRecord: [
        evse('CH*GOF*E1'),
        evse('CH*GOF*E2', {
          ChargingFacilities: [{ power: '150' }],
          Plugs: ['CCS Combo 2 Plug (Cable Attached)', 'CHAdeMO'],
        }),
        evse('CH*GOF*E3', { Accessibility: 'Test Station' }),
        { broken: true },
      ],
    },
    {
      OperatorName: 'Hotel',
      EVSEDataRecord: [
        evse('CH*HOT*E1', {
          Accessibility: 'Restricted access',
          GeoCoordinates: { Google: '46.5200 6.6300' },
        }),
      ],
    },
    {
      OperatorName: 'Far away',
      EVSEDataRecord: [evse('CH*FAR*E1', { GeoCoordinates: { Google: '47.3700 8.5400' } })],
    },
  ],
};

describe('charging stations', () => {
  const stations = parseChargingData(DATA, 'fr');

  it('groups charge points into stations, with names in the asked language', () => {
    expect(stations).toHaveLength(3);
    const [gofast] = stations;
    expect(gofast).toMatchObject({
      name: 'Gare CFF',
      operator: 'GoFast',
      address: 'Avenue de la Gare, 1003 Lausanne',
      publicAccess: true,
      open24h: true,
    });
    expect(gofast?.points).toEqual([
      { id: 'CH*GOF*E1', power: 22, plugs: ['Type 2'] },
      { id: 'CH*GOF*E2', power: 150, plugs: ['CCS', 'CHAdeMO'] },
    ]);
    expect(stations[1]?.publicAccess).toBe(false);
  });

  it('finds stations around a place, by power, plug and access', () => {
    const gare = { lat: 46.517, lon: 6.629 };
    expect(stationsNear(stations, gare, { radiusKm: 2 }).map((s) => s.operator)).toEqual([
      'GoFast',
    ]);
    expect(
      stationsNear(stations, gare, { radiusKm: 2, includeRestricted: true }).map((s) => s.operator),
    ).toEqual(['GoFast', 'Hotel']);
    const fast = stationsNear(stations, gare, { radiusKm: 2, minPower: 50 });
    expect(fast[0]?.points.map((p) => p.id)).toEqual(['CH*GOF*E2']);
    expect(fast[0]?.maxPower).toBe(150);
    expect(stationsNear(stations, gare, { radiusKm: 2, plugs: ['Tesla'] })).toEqual([]);
    expect(stationsNear(stations, gare, { radiusKm: 200 })).toHaveLength(2);
  });

  it('reads which charge points are free', async () => {
    const db = Database.open(':memory:');
    const fake = createFakeFetch((url) => ({
      body:
        url === CHARGING_STATUS
          ? {
              EVSEStatuses: [
                {
                  EVSEStatusRecord: [
                    { EvseID: 'CH*GOF*E1', EVSEStatus: 'Available' },
                    { EvseID: 'CH*GOF*E2', EVSEStatus: 'EvseNotFound' },
                  ],
                },
              ],
            }
          : {},
    }));
    const http = new HttpClient({
      userAgent: 't',
      requestsPerSecond: 1000,
      respectRobots: false,
      fetch: fake.fetch,
      sleep: async () => {},
    });
    const { status } = await loadChargingStatus(db, http);
    expect(status).toEqual({ 'CH*GOF*E1': 'Available', 'CH*GOF*E2': 'Unknown' });
    db.close();
  });

  it('understands plug names and formats distances', () => {
    expect(parsePlugs('type2, CCS')).toEqual(['Type 2', 'Type 2 cable', 'CCS', 'CCS1']);
    expect(() => parsePlugs('usb')).toThrow('Unknown plug');
    expect(formatDistance(0.123)).toBe('120 m');
    expect(formatDistance(2.345)).toBe('2.3 km');
  });
});

function feature(id: string, lon: number, lat: number, attributes: Record<string, unknown>) {
  return {
    geometry: { x: lon, y: lat, spatialReference: { wkid: 4326 } },
    attributes: { id, provider_name: 'Voi Technology AB', available: true, ...attributes },
  };
}

describe('shared mobility', () => {
  let db: Database;
  beforeEach(() => {
    db = Database.open(':memory:');
  });
  afterEach(() => db.close());

  it('reads stations and parked vehicles, leaving out disabled ones', () => {
    const { offers, count } = parseOffers(
      [
        feature('a', 7.44, 46.95, {
          pickup_type: 'station_based',
          station_name: 'Bern Bahnhof',
          station_status_num_vehicle_available: 3,
          vehicle_type: ['E-Bike', 'Bike'],
        }),
        feature('b', 7.441, 46.951, { pickup_type: 'free_floating', vehicle_type: ['E-Scooter'] }),
        feature('c', 7.441, 46.951, {
          pickup_type: 'free_floating',
          vehicle_type: ['E-Scooter'],
          vehicle_status_disabled: true,
        }),
      ],
      'https://x',
    );
    expect(count).toBe(3);
    expect(offers).toEqual([
      {
        id: 'a',
        provider: 'Voi',
        station: 'Bern Bahnhof',
        types: ['E-Bike', 'Bike'],
        available: 3,
        lat: 46.95,
        lon: 7.44,
      },
      expect.objectContaining({ id: 'b', station: null, available: 1 }),
    ]);
    expect(providerName('bird zurich')).toBe('Bird zurich');
    expect(providerName('Lime City partners from Partners::RegionFeedMediator')).toBe('Lime');
  });

  it('pages through full answers and asks once per type', async () => {
    const fake = createFakeFetch((url) => {
      const params = new URL(url).searchParams;
      const offset = Number(params.get('offset'));
      const type = params.get('filters')?.split('=')[1] ?? 'E-Scooter';
      // The first page is full (50), the second has one more vehicle.
      const size = offset === 0 ? 50 : 1;
      return {
        body: Array.from({ length: size }, (_, i) =>
          feature(`${type}-${offset + i}`, 7.44 + (offset + i) / 100000, 46.95, {
            pickup_type: 'free_floating',
            vehicle_type: [type],
          }),
        ),
      };
    });
    const http = new HttpClient({
      userAgent: 't',
      requestsPerSecond: 1000,
      respectRobots: false,
      fetch: fake.fetch,
      sleep: async () => {},
    });
    const point = { lat: 46.95, lon: 7.44 };
    const all = await offersNear(db, http, point, 300);
    expect(all.offers).toHaveLength(51);
    expect(all.offers[0]?.id).toBe('E-Scooter-0'); // nearest first
    expect(all.complete).toBe(true);

    const bikes = await offersNear(db, http, point, 300, parseVehicleTypes('e-bike,bike'));
    expect(new Set(bikes.offers.map((o) => o.types[0]))).toEqual(new Set(['E-Bike', 'Bike']));
    const filters = fake.requests().map((c) => new URL(c.url).searchParams.get('filters'));
    expect(filters).toContain('ch.bfe.sharedmobility.vehicle_type=E-Bike');
    expect(filters).toContain('ch.bfe.sharedmobility.vehicle_type=Bike');
    expect(() => parseVehicleTypes('rocket')).toThrow('Unknown type');
  });
});
