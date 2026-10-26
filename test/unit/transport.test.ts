import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { HttpClient } from '../../src/crawler/http.js';
import {
  durationMinutes,
  findStop,
  findTrips,
  lineName,
  stationboard,
  stationboardUrl,
} from '../../src/modules/transport/api.js';
import { parseTypes, parseWhen } from '../../src/modules/transport/command.js';
import { Database } from '../../src/storage/database.js';
import {
  formatDayLong,
  formatMinutes,
  parseClock,
  parseDay,
  zurichMoment,
} from '../../src/util/when.js';
import { createFakeFetch } from '../helpers/fake-fetch.js';

// Monday 26 October 2026, 20:00 in Zürich (winter time, UTC+1).
const NOW = Date.UTC(2026, 9, 26, 19, 0);

describe('dates and times', () => {
  it('reads times and days as people type them', () => {
    expect(parseClock('7:30')).toBe('07:30');
    expect(parseClock('7h05')).toBe('07:05');
    expect(parseClock('1830')).toBe('18:30');
    expect(parseClock('9')).toBe('09:00');
    expect(parseClock('25:00')).toBeNull();
    expect(parseDay('today', NOW)).toBe('2026-10-26');
    expect(parseDay('morgen', NOW)).toBe('2026-10-27');
    expect(parseDay('friday', NOW)).toBe('2026-10-30');
    expect(parseDay('lundi', NOW)).toBe('2026-10-26'); // today counts
    expect(parseDay('27.10.', NOW)).toBe('2026-10-27');
    expect(parseDay('3.1.', NOW)).toBe('2027-01-03'); // passed this year: next year
    expect(parseDay('31.11.2026', NOW)).toBeNull();
    expect(parseDay('2026-12-24', NOW)).toBe('2026-12-24');
    expect(parseDay('someday', NOW)).toBeNull();
  });

  it('formats days, durations and Swiss time', () => {
    expect(formatDayLong('2026-10-27')).toBe('Tuesday 27 October 2026');
    expect(formatMinutes(45)).toBe('45 min');
    expect(formatMinutes(142)).toBe('2h 22m');
    expect(zurichMoment(NOW)).toEqual({ date: '2026-10-26', time: '20:00' });
    // Summer time: UTC+2.
    expect(zurichMoment(Date.UTC(2026, 6, 1, 22, 30))).toEqual({
      date: '2026-07-02',
      time: '00:30',
    });
  });

  it('turns --date and --at into a timetable question', () => {
    expect(parseWhen({}, NOW)).toEqual({});
    expect(parseWhen({ at: '7:30' }, NOW)).toEqual({ time: '07:30' });
    // Another day without a time: from its start.
    expect(parseWhen({ date: 'tomorrow' }, NOW)).toEqual({ date: '2026-10-27', time: '00:00' });
    expect(() => parseWhen({ at: 'noon' }, NOW)).toThrow('is not a time');
    expect(() => parseWhen({ date: 'soon' }, NOW)).toThrow('is not a day');
    expect(parseTypes('trains, boat')).toEqual(['train', 'ship']);
    expect(() => parseTypes('rocket')).toThrow('Unknown type');
  });
});

const checkpoint = (
  name: string,
  { dep, arr, platform, delay, expected, newPlatform }: Record<string, unknown> = {},
) => ({
  station: { id: '1', name, coordinate: { type: 'WGS84', x: 46.5, y: 6.6 } },
  departureTimestamp: dep ?? null,
  arrivalTimestamp: arr ?? null,
  delay: delay ?? null,
  platform: platform ?? null,
  prognosis: {
    platform: newPlatform ?? null,
    departure: expected ?? null,
    arrival: null,
  },
});

// 07:34 and 09:56 on 27 October 2026, Swiss time.
const T0734 = Date.UTC(2026, 9, 27, 6, 34) / 1000;
const T0956 = Date.UTC(2026, 9, 27, 8, 56) / 1000;

describe('timetable', () => {
  let db: Database;
  beforeEach(() => {
    db = Database.open(':memory:');
  });
  afterEach(() => db.close());

  function client(handler: Parameters<typeof createFakeFetch>[0]) {
    const fake = createFakeFetch(handler);
    const http = new HttpClient({
      userAgent: 'test',
      requestsPerSecond: 1000,
      respectRobots: false,
      fetch: fake.fetch,
      sleep: async () => {},
    });
    return { http, fake };
  }

  it('names lines as people know them', () => {
    expect(lineName('IC', '5')).toBe('IC 5');
    expect(lineName('B', '21')).toBe('Bus 21');
    expect(lineName('T', '11')).toBe('Tram 11');
    expect(lineName('M', 'm2')).toBe('m2');
    expect(lineName('S', null)).toBe('S');
    expect(durationMinutes('00d02:22:00')).toBe(142);
    expect(durationMinutes('01d00:05:00')).toBe(1445);
  });

  it('reads trips with walks, delays and platform changes, and keeps them 30 seconds', async () => {
    const { http, fake } = client(() => ({
      body: {
        from: { id: '8501120', name: 'Lausanne' },
        to: { id: '8503000', name: 'Zürich HB' },
        connections: [
          {
            from: checkpoint('Lausanne', { dep: T0734, platform: '4' }),
            to: checkpoint('Zürich HB', { arr: T0956, platform: '33' }),
            duration: '00d02:22:00',
            transfers: 0,
            sections: [
              {
                journey: null,
                walk: { duration: 300 },
                departure: checkpoint('Rue du Midi 1, Lausanne', { dep: T0734 - 300 }),
                arrival: checkpoint('Lausanne', { arr: T0734 }),
              },
              {
                journey: {
                  category: 'IC',
                  number: '5',
                  operator: 'SBB',
                  to: 'Rorschach',
                  passList: [{}, {}, {}, {}],
                },
                walk: null,
                departure: checkpoint('Lausanne', {
                  dep: T0734,
                  platform: '4',
                  delay: 3,
                  expected: '2026-10-27T07:37:00+0100',
                  newPlatform: '7',
                }),
                arrival: checkpoint('Zürich HB', { arr: T0956, platform: '33' }),
              },
            ],
          },
        ],
      },
    }));
    const query = { from: 'Lausanne', to: 'Zürich HB', date: '2026-10-27', time: '07:30' };
    const { value } = await findTrips(db, http, query);
    expect(value.from?.name).toBe('Lausanne');
    const [trip] = value.trips;
    expect(trip?.minutes).toBe(142);
    expect(trip?.legs.map((l) => [l.line, l.walkMinutes, l.stops])).toEqual([
      [null, 5, 0],
      ['IC 5', null, 2],
    ]);
    expect(trip?.legs[1]?.departure).toEqual({
      name: 'Lausanne',
      time: T0734,
      expected: T0734 + 180,
      delay: 3,
      platform: '4',
      newPlatform: '7',
    });
    const url = new URL(fake.requests()[0]?.url ?? '');
    expect(url.pathname).toBe('/v1/connections');
    expect(url.searchParams.get('time')).toBe('07:30');
    await findTrips(db, http, query);
    expect(fake.requests()).toHaveLength(1); // cached
  });

  it('finds a stop by name, or the one nearest to an address', async () => {
    const { http, fake } = client((url) => {
      const params = new URL(url).searchParams;
      if (params.get('query') === 'Bern')
        return { body: { stations: [{ id: '8507000', name: 'Bern' }] } };
      if (params.get('query')) {
        return {
          body: {
            stations: [
              { id: null, name: 'Bundesplatz 3, Bern', coordinate: { x: 46.946, y: 7.444 } },
            ],
          },
        };
      }
      return {
        body: {
          stations: [
            { id: null, name: 'Bundesplatz 3, Bern', coordinate: { x: 46.946, y: 7.444 } },
            { id: '8576195', name: 'Bern, Bundesplatz', distance: 40 },
          ],
        },
      };
    });
    expect((await findStop(db, http, 'Bern'))?.id).toBe('8507000');
    expect((await findStop(db, http, 'Bundesplatz 3, Bern'))?.name).toBe('Bern, Bundesplatz');
    expect(new URL(fake.requests().at(-1)?.url ?? '').searchParams.get('x')).toBe('46.946');
  });

  it('reads a departure board', async () => {
    const { http } = client(() => ({
      body: {
        station: { id: '8507000', name: 'Bern' },
        stationboard: [
          {
            stop: checkpoint('Bern', { dep: T0734, platform: '5', delay: 1 }),
            category: 'IC',
            number: '61',
            operator: 'SBB',
            to: 'Basel SBB',
          },
        ],
      },
    }));
    const stop = { id: '8507000', name: 'Bern', lat: null, lon: null, type: null, distance: null };
    const { value } = await stationboard(db, http, { stop, date: '2026-10-27', time: '07:30' });
    expect(value.entries).toEqual([
      {
        line: 'IC 61',
        operator: 'SBB',
        direction: 'Basel SBB',
        departure: expect.objectContaining({ time: T0734, delay: 1, platform: '5' }),
      },
    ]);
    expect(new URL(stationboardUrl({ stop, time: '07:30' })).searchParams.get('datetime')).toMatch(
      /^\d{4}-\d{2}-\d{2} 07:30$/,
    );
  });
});
