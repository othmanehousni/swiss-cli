/**
 * Live smoke tests against the public data sources of `swiss` (opt-in: npm run
 * test:live). They check that each source still answers in the shape expected.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { userAgent } from '../../src/config.js';
import { HttpClient } from '../../src/crawler/http.js';
import { loadChargingStatus } from '../../src/modules/mobility/charging.js';
import { offersNear } from '../../src/modules/mobility/sharing.js';
import { recentQuakes } from '../../src/modules/nature/quakes.js';
import { findWaters, loadWaterStations } from '../../src/modules/nature/rivers.js';
import {
  latestSnow,
  loadBulletins,
  loadSnowStations,
  loadWarningRegions,
} from '../../src/modules/nature/snow.js';
import { resolvePlace } from '../../src/modules/places/resolve.js';
import { findLocation, findOffers, loadLocations } from '../../src/modules/premiums/priminfo.js';
import { findStop, findTrips, stationboard } from '../../src/modules/transport/api.js';
import {
  dailyForecast,
  forecastPointFor,
  loadForecastPoints,
} from '../../src/modules/weather/meteoswiss.js';
import { Database } from '../../src/storage/database.js';

const db = Database.open(':memory:');
const http = new HttpClient({ userAgent: userAgent(), requestsPerSecond: 2 });
afterAll(() => db.close());

const LONG = { timeout: 120_000 };

describe('swiss data sources (live)', () => {
  it('places: a postcode, a town and an address', LONG, async () => {
    expect((await resolvePlace(db, http, '8001')).place.municipality).toBe('Zürich');
    expect((await resolvePlace(db, http, 'Lausanne')).place.canton).toBe('VD');
    expect((await resolvePlace(db, http, 'Bahnhofstrasse 1, Zürich')).place.kind).toBe('search');
  });

  it('premiums: the standard plans for Zürich', LONG, async () => {
    const { place } = await resolvePlace(db, http, '8001');
    const location = findLocation(await loadLocations(db, http), place);
    expect(location).not.toBeNull();
    const result = await findOffers(
      db,
      http,
      {
        lang: 'de',
        location: location?.id ?? '',
        person: { born: 1990, deductible: 300, accident: true },
      },
      ['standard'],
    );
    expect(result.info?.region).toBe(1);
    expect(result.offers.length).toBeGreaterThan(10);
  });

  it('transport: a connection and a departure board', LONG, async () => {
    const trips = await findTrips(db, http, { from: 'Bern', to: 'Zürich HB', limit: 2 });
    expect(trips.value.trips.length).toBeGreaterThan(0);
    const stop = await findStop(db, http, 'Bern');
    expect(stop?.id).toBe('8507000');
    const board = await stationboard(db, http, {
      stop: stop as NonNullable<typeof stop>,
      limit: 5,
    });
    expect(board.value.entries.length).toBeGreaterThan(0);
  });

  it('weather: the forecast for Zürich', LONG, async () => {
    const points = await loadForecastPoints(db, http);
    const point = forecastPointFor(points, {
      lat: 47.37,
      lon: 8.54,
      postcode: '8001',
      kind: 'postcode',
    });
    expect(point?.postcode).toBe('8001');
    const forecast = await dailyForecast(db, http, point as NonNullable<typeof point>);
    expect(forecast.days.length).toBeGreaterThan(5);
    expect(forecast.days.filter((d) => d.symbol !== null).length).toBeGreaterThan(5);
  });

  it('mobility: charging availability and shared vehicles in Bern', LONG, async () => {
    const { status } = await loadChargingStatus(db, http);
    expect(Object.keys(status).length).toBeGreaterThan(1000);
    const sharing = await offersNear(db, http, { lat: 46.948, lon: 7.4474 }, 500);
    expect(Array.isArray(sharing.offers)).toBe(true);
  });

  it('nature: rivers, earthquakes, snow and the avalanche bulletin', LONG, async () => {
    const { stations } = await loadWaterStations(db, http);
    expect(stations.length).toBeGreaterThan(50);
    expect(findWaters(stations, 'aare').some((s) => s.temperature !== null)).toBe(true);
    const { quakes } = await recentQuakes(db, http, 30, null);
    expect(quakes.length).toBeGreaterThan(0);
    const snowStations = await loadSnowStations(db, http);
    expect(snowStations.length).toBeGreaterThan(50);
    const weissfluhjoch = snowStations.find((s) => s.code === 'WFJ2');
    expect(
      await latestSnow(db, http, weissfluhjoch as NonNullable<typeof weissfluhjoch>),
    ).not.toBeNull();
    expect((await loadWarningRegions(db, http)).length).toBeGreaterThan(100);
    expect(Array.isArray((await loadBulletins(db, http, 'en')).bulletins)).toBe(true);
  });
});
