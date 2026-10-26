import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { HttpClient } from '../../src/crawler/http.js';
import { dayLabel, describeNow, describeSymbol } from '../../src/modules/weather/command.js';
import {
  dailyForecast,
  type ForecastPoint,
  forecastPointFor,
  latestRun,
  nearestStation,
  parseForecastPoints,
  parseMeasurements,
  parseRun,
  parseWeatherStations,
} from '../../src/modules/weather/meteoswiss.js';
import { Database } from '../../src/storage/database.js';
import { createFakeFetch } from '../helpers/fake-fetch.js';

const POINTS_CSV = [
  'point_id;point_type_id;station_abbr;postal_code;point_name;point_type_de;point_type_fr;point_type_it;point_type_en;point_height_masl;point_coordinates_lv95_east;point_coordinates_lv95_north;point_coordinates_wgs84_lat;point_coordinates_wgs84_lon',
  '41;1;ZER;;Zermatt;Station;Station;Stazione;Station;1638.0;2624298.0;1097574.0;46.029272;7.752433',
  '392000;2;;3920;Zermatt;Zentrum Postleitzahl;Centre code postal;Centro codice postale;Postal code center;1608.0;2624000.0;1097000.0;46.0207;7.7491',
  '601000;2;;6010;Kriens;Zentrum Postleitzahl;Centre code postal;Centro codice postale;Postal code center;482.0;2665000.0;1210000.0;47.0333;8.2833',
  '17;3;;;Pilatus;Gipfel;Sommet;Vetta;Peak;2105.0;2661900.0;1203400.0;46.9786;8.2547',
].join('\r\n');

function file(parameter: string, rows: [string, string, string, string][]): string {
  return [`point_id;point_type_id;Date;${parameter}`, ...rows.map((r) => r.join(';'))].join('\n');
}

describe('MeteoSwiss forecast', () => {
  const points = parseForecastPoints(POINTS_CSV);

  it('reads the forecast points', () => {
    expect(points).toHaveLength(4);
    expect(points[1]).toEqual({
      key: '2:392000',
      type: 2,
      name: 'Zermatt',
      postcode: '3920',
      height: 1608,
      lat: 46.0207,
      lon: 7.7491,
    });
  });

  it("takes a town's postcode point, else the nearest point", () => {
    const at = (lat: number, lon: number, postcode: string | null, kind: string) =>
      forecastPointFor(points, { lat, lon, postcode, kind })?.key;
    expect(at(46.02, 7.75, '3920', 'postcode')).toBe('2:392000');
    // Pilatus Kulm has the postcode of Kriens, far below: the nearest point instead.
    expect(at(46.979, 8.255, '6010', 'name')).toBe('3:17');
    // A search hit: whatever point is nearest.
    expect(at(46.0292, 7.7524, '3920', 'search')).toBe('1:41');
  });

  it('reads a run of daily files and finds the newest complete run', async () => {
    const run = parseRun('202610262000', {
      symbol: file('jp2000d0', [
        ['392000', '2', '202610260000', '3'],
        ['392000', '2', '202610270000', '101'],
      ]),
      min: file('tre200pn', [['392000', '2', '202610260000', '-2.5']]),
      max: file('tre200px', [['392000', '2', '202610260000', '8.1']]),
      rain: file('rka150p0', [['392000', '2', '202610270000', '1.2']]),
    });
    expect(run.days).toEqual(['2026-10-26', '2026-10-27']);
    expect(run.points['2:392000']).toEqual([
      [3, -2.5, 8.1, null],
      [101, null, null, 1.2],
    ]);
    expect(() => parseRun('x', { symbol: 'a;b;c;d', min: '', max: '', rain: '' })).toThrow(
      'unexpected columns',
    );

    const now = Date.UTC(2026, 9, 26, 21, 10);
    const asset = (run: string, p: string) => ({
      [`vnut12.lssw.${run}.${p}.csv`]: { href: `https://files/${run}.${p}.csv` },
    });
    const fake = createFakeFetch((url) => {
      if (url.endsWith('/items/20261026-ch')) {
        return {
          body: {
            assets: {
              ...Object.assign(
                {},
                ...['jp2000d0', 'tre200pn', 'tre200px', 'rka150p0'].map((p) =>
                  asset('202610262000', p),
                ),
              ),
              // The newest run is still being published: not complete.
              ...asset('202610262100', 'tre200px'),
            },
          },
        };
      }
      const parameter = /\.(\w+)\.csv$/.exec(url)?.[1] ?? '';
      return { body: file(parameter, [['392000', '2', '202610260000', '5']]) };
    });
    const http = new HttpClient({
      userAgent: 't',
      requestsPerSecond: 1000,
      respectRobots: false,
      fetch: fake.fetch,
      sleep: async () => {},
    });
    const latest = await latestRun(http, now);
    expect(latest.run).toBe('202610262000');
    expect(latest.urls.max).toBe('https://files/202610262000.tre200px.csv');

    const db = Database.open(':memory:');
    const point = points[1] as ForecastPoint;
    const forecast = await dailyForecast(db, http, point, now);
    expect(forecast.days).toEqual([{ date: '2026-10-26', symbol: 5, min: 5, max: 5, rain: 5 }]);
    const requests = fake.requests().length;
    await dailyForecast(db, http, points[0] as ForecastPoint, now + 60_000);
    expect(fake.requests()).toHaveLength(requests); // one download serves every point
    db.close();
  });
});

describe('MeteoSwiss measurements', () => {
  const stations = parseWeatherStations(
    [
      'station_abbr;station_name;station_canton;station_height_masl;station_coordinates_wgs84_lat;station_coordinates_wgs84_lon',
      'PIL;Pilatus;OW;2106.0;46.979;8.252',
      'LUZ;Luzern;LU;454.0;47.036;8.301',
    ].join('\n'),
  );

  it('picks a station near the place and at a similar height', () => {
    // Kriens (480 m) is closer to Pilatus than to Luzern, but Luzern is at its height.
    const kriens = { lat: 47.033, lon: 8.283 };
    expect(nearestStation(stations, kriens, 480)?.station.id).toBe('LUZ');
    expect(nearestStation(stations, { lat: 46.979, lon: 8.255 }, 2100)?.station.id).toBe('PIL');
  });

  it("reads today's latest values and sums the last hour", () => {
    const header =
      'station_abbr;reference_timestamp;tre200s0;ure200s0;fu3010z0;fu3010z1;dkl010z0;rre150z0;sre000z0;htoauts0';
    // 18:00 to 19:10, every 10 minutes.
    const rows = Array.from({ length: 8 }, (_, i) => {
      const minutes = 18 * 60 + i * 10;
      const time = `${Math.floor(minutes / 60)}:${String(minutes % 60).padStart(2, '0')}`;
      return `BER;26.10.2026 ${time};8.${i};90;7;20;225;0.2;5;`;
    });
    rows.push('BER;26.10.2026 19:20;;;;;;;;'); // not measured yet
    const now = parseMeasurements([header, ...rows].join('\n'));
    expect(now).toMatchObject({
      time: '2026-10-26T19:10:00.000Z',
      temperature: 8.7,
      humidity: 90,
      wind: 7,
      gusts: 20,
      direction: 225,
      rainLastHour: 1.2,
      sunLastHour: 30,
      snow: null,
    });
    expect(describeNow(now as NonNullable<typeof now>)).toBe(
      '8.7 °C · humidity 90% · wind 7 km/h from SW, gusts 20 · 1.2 mm of rain in the last hour',
    );
    expect(parseMeasurements(header)).toBeNull();
  });

  it('describes pictograms and days', () => {
    expect(describeSymbol(1)).toBe('sunny');
    expect(describeSymbol(101, 'fr')).toBe('ciel dégagé');
    expect(describeSymbol(133)).toBe('overcast, frequent rain showers');
    expect(describeSymbol(null)).toBe('–');
    expect(describeSymbol(999)).toBe('weather 999');
    expect(dayLabel('2026-10-27')).toBe('Tue 27.10.');
  });
});

describe('weather cache', () => {
  let db: Database;
  beforeEach(() => {
    db = Database.open(':memory:');
  });
  afterEach(() => db.close());

  it('keeps an older forecast when MeteoSwiss cannot be reached', async () => {
    const files = (parameter: string) => file(parameter, [['392000', '2', '202610260000', '1']]);
    let online = true;
    const fake = createFakeFetch((url) => {
      if (!online) return new Error('offline');
      if (url.includes('/items/')) {
        return {
          body: {
            assets: Object.fromEntries(
              ['jp2000d0', 'tre200pn', 'tre200px', 'rka150p0'].map((p) => [
                `vnut12.lssw.202610260600.${p}.csv`,
                { href: `https://files/${p}.csv` },
              ]),
            ),
          },
        };
      }
      return { body: files(/\/(\w+)\.csv$/.exec(url)?.[1] ?? '') };
    });
    const http = new HttpClient({
      userAgent: 't',
      requestsPerSecond: 1000,
      respectRobots: false,
      fetch: fake.fetch,
      sleep: async () => {},
      retry: { maxAttempts: 1, baseDelayMs: 0, maxDelayMs: 0, maxRetryAfterMs: 0 },
    });
    const point = parseForecastPoints(POINTS_CSV)[1] as ForecastPoint;
    const now = Date.UTC(2026, 9, 26, 7);
    expect((await dailyForecast(db, http, point, now)).stale).toBe(false);
    online = false;
    const later = await dailyForecast(db, http, point, now + 5 * 3600 * 1000);
    expect(later).toMatchObject({ stale: true, run: '202610260600' });
  });
});
