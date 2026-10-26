import { describe, expect, it } from 'vitest';
import { UnexpectedResponseError } from '../../src/crawler/errors.js';
import { parseQuakes, quakesUrl } from '../../src/modules/nature/quakes.js';
import { dangerLevel, findWaters, parseWaterStations } from '../../src/modules/nature/rivers.js';
import {
  bulletinFor,
  describeElevation,
  highestLevel,
  nearestSnowStations,
  parseBulletins,
  parseSnowReadings,
  regionAt,
} from '../../src/modules/nature/snow.js';

const feature = (key: string, coordinates: number[], properties: Record<string, unknown>) => ({
  type: 'Feature',
  geometry: { type: 'Point', coordinates },
  properties: { key, ...properties },
});

describe('rivers and lakes', () => {
  const temperatures = {
    features: [
      feature('2135', [2600725, 1197996], {
        label: 'Aare - Bern, Schönau',
        hydro_body_name: 'Aare',
        last_value: '13.2',
        min_24h: '12.2',
        max_24h: '13.4',
        unit_short: '°C',
        last_measured_at: '2026-10-26T21:10:00.000+01:00',
      }),
      feature('2019', [2700000, 1100000], {
        label: 'Rhein - Neuhausen',
        hydro_body_name: 'Rhein',
        last_value: '9.0',
        failure_text: 'Die Messungen sind verfälscht.',
      }),
    ],
  };
  const flows = {
    features: [
      feature('2135', [2600725, 1197996], {
        label: 'Aare - Bern, Schönau',
        kind: 'river',
        last_value: '480',
        unit_short: 'm³/s',
        wl_1: '320 m³/s',
        wl_2: '400 m³/s',
        wl_3: '500 m³/s',
        wl_4: '600 m³/s',
      }),
      feature('2031', [2687000, 1220000], {
        label: 'Ägerisee - Unterägeri',
        hydro_body_name: 'Ägerisee',
        kind: 'lake',
        last_value: '723.30',
        unit_short: 'm',
        wl_1: '724.10 m ü.M.',
      }),
      { broken: true },
    ],
  };
  const stations = parseWaterStations(temperatures, flows);

  it('joins temperature and flow of the same station, in WGS84', () => {
    expect(stations).toHaveLength(3);
    const bern = stations.find((s) => s.key === '2135');
    expect(bern).toMatchObject({
      name: 'Aare - Bern, Schönau',
      water: 'Aare',
      kind: 'river',
      temperature: { value: 13.2, min24h: 12.2, max24h: 13.4, unit: '°C' },
      flow: { value: 480, unit: 'm³/s' },
      danger: 3, // 480 m³/s passes the thresholds of levels 2 and 3
    });
    expect(bern?.lat).toBeCloseTo(46.932, 2);
    expect(bern?.lon).toBeCloseTo(7.4475, 2);
    const lake = stations.find((s) => s.key === '2031');
    expect(lake).toMatchObject({ kind: 'lake', water: 'Ägerisee', danger: 1, temperature: null });
    expect(stations.find((s) => s.key === '2019')?.note).toBe('Die Messungen sind verfälscht.');
  });

  it('only compares thresholds in the same unit', () => {
    const flow = { value: 10, min24h: null, max24h: null, unit: 'm³/s', at: null };
    expect(dangerLevel(flow, ['724.10 m ü.M.'])).toBeNull();
    expect(dangerLevel(flow, ['5 m³/s', '20 m³/s'])).toBe(2);
    expect(dangerLevel(null, ['5 m³/s'])).toBeNull();
  });

  it('finds a river or lake by name', () => {
    expect(findWaters(stations, 'aare').map((s) => s.key)).toEqual(['2135']);
    expect(findWaters(stations, 'Agerisee').map((s) => s.key)).toEqual(['2031']);
    expect(findWaters(stations, 'neuhausen').map((s) => s.key)).toEqual(['2019']);
  });
});

describe('earthquakes', () => {
  const TEXT = [
    '#EventID|Time|Latitude|Longitude|Depth/km|Author|Catalog|Contributor|ContributorID|MagType|Magnitude|MagAuthor|EventLocationName|EventType',
    'smi:ch.ethz.sed/1|2026-10-26T09:58:12.171175|46.9146|8.9161|4.96|x||SED|smi:1|MLhc|1.863|x|Linthal GL|earthquake',
    'smi:ch.ethz.sed/2|2026-10-26T11:15:00.918543|48.1575|8.5595|-0.69|x||SED|smi:2|MLhc|0.84|x|Rottweil D|quarry blast',
  ].join('\n');

  it('reads the event list, in UTC', () => {
    const quakes = parseQuakes(TEXT);
    expect(quakes).toHaveLength(2);
    expect(quakes[0]).toEqual({
      id: 'smi:ch.ethz.sed/1',
      time: '2026-10-26T09:58:12.171Z',
      lat: 46.9146,
      lon: 8.9161,
      depthKm: 4.96,
      magnitude: 1.863,
      magnitudeType: 'MLhc',
      place: 'Linthal GL',
      type: 'earthquake',
    });
    expect(quakes[1]?.type).toBe('quarry blast');
    expect(parseQuakes('')).toEqual([]); // no event: an empty answer
    expect(() => parseQuakes('<html>error</html>')).toThrow(UnexpectedResponseError);
  });

  it('asks from the start of a day, so the same question can be cached all day', () => {
    const url = new URL(quakesUrl(7, 2.5, Date.UTC(2026, 9, 26, 21, 30)));
    expect(url.searchParams.get('starttime')).toBe('2026-10-19T00:00:00');
    expect(url.searchParams.get('minmagnitude')).toBe('2.5');
    expect(url.searchParams.get('format')).toBe('text');
  });
});

describe('snow and avalanches', () => {
  it('reads snow depth now and its change over 24 hours', () => {
    const rows = Array.from({ length: 48 }, (_, i) => ({
      station_code: 'WFJ2',
      measure_date: new Date(Date.UTC(2026, 9, 25, 21, 0) + i * 30 * 60 * 1000).toISOString(),
      HS: 30 - i / 4,
      TA_30MIN_MEAN: -2.5,
    }));
    expect(parseSnowReadings(rows, 'https://x')).toEqual({
      at: '2026-10-26T20:30:00.000Z',
      depth: 18,
      change24h: -12,
      temperature: -2.5,
    });
    // Less than a day of values: no change.
    expect(parseSnowReadings(rows.slice(-4), 'https://x')?.change24h).toBeNull();
    expect(parseSnowReadings([], 'https://x')).toBeNull();
  });

  it('finds the nearest snow stations and the warning region of a place', () => {
    const stations = [
      { code: 'A', name: 'Near', lat: 46.8, lon: 9.83, elevation: 2000, canton: 'GR' },
      { code: 'B', name: 'Far', lat: 46.0, lon: 7.7, elevation: 2500, canton: 'VS' },
    ];
    expect(nearestSnowStations(stations, { lat: 46.79, lon: 9.82 }).map((s) => s.code)).toEqual([
      'A',
    ]);
    const square = {
      id: '5123',
      names: { en: 'Davos' },
      geometry: {
        type: 'Polygon' as const,
        coordinates: [
          [
            [9.7, 46.7],
            [9.9, 46.7],
            [9.9, 46.9],
            [9.7, 46.9],
            [9.7, 46.7],
          ],
        ],
      },
    };
    expect(regionAt([square], { lat: 46.79, lon: 9.82 })?.id).toBe('5123');
    expect(regionAt([square], { lat: 46.0, lon: 7.7 })).toBeNull();
  });

  it('reads the avalanche bulletin (EAWS CAAML v6 JSON)', () => {
    const bulletins = parseBulletins(
      {
        bulletins: [
          {
            regions: [
              { regionID: 'CH-5123', name: 'Davos' },
              { regionID: 'CH-5124', name: 'Schanfigg' },
            ],
            dangerRatings: [
              {
                mainValue: 'considerable',
                elevation: { lowerBound: '2200' },
                validTimePeriod: 'all_day',
              },
              { mainValue: 'moderate', elevation: { upperBound: '2200' } },
            ],
            avalancheProblems: [
              {
                problemType: 'wind_slab',
                elevation: { lowerBound: 'treeline' },
                aspects: ['N', 'NE'],
              },
            ],
            highlights: 'Fresh wind slabs.',
            validTime: { startTime: '2027-01-10T16:00:00Z', endTime: '2027-01-11T16:00:00Z' },
          },
        ],
      },
      'https://x',
    );
    const davos = bulletinFor(bulletins, '5123');
    expect(davos?.ratings).toEqual([
      { level: 3, value: 'considerable', elevation: 'above 2200 m', period: 'all_day' },
      { level: 2, value: 'moderate', elevation: 'below 2200 m', period: null },
    ]);
    expect(davos?.problems).toEqual([
      { type: 'wind_slab', elevation: 'above the treeline', aspects: ['N', 'NE'] },
    ]);
    expect(highestLevel(davos as NonNullable<typeof davos>)).toBe(3);
    expect(bulletinFor(bulletins, '9999')).toBeNull();
    expect(parseBulletins({ bulletins: [] }, 'https://x')).toEqual([]);
    expect(describeElevation(null)).toBeNull();
  });
});
