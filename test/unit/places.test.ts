import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { HttpClient } from '../../src/crawler/http.js';
import { contains, distanceKm, lv95ToWgs84 } from '../../src/modules/places/geo.js';
import { POSTCODE_DIRECTORY, parsePostcodeDirectory } from '../../src/modules/places/postcodes.js';
import { PlaceNotFoundError, resolvePlace } from '../../src/modules/places/resolve.js';
import { cached, datasetInfo } from '../../src/storage/cache.js';
import { Database } from '../../src/storage/database.js';
import { createFakeFetch } from '../helpers/fake-fetch.js';
import { makeZip } from '../helpers/zip.js';

const DIRECTORY_CSV = [
  'Ortschaftsname;PLZ4;Zusatzziffer;ZIP_ID;Gemeindename;BFS-Nr;Kantonskürzel;Adressenanteil;E;N;Sprache;Validity',
  'Zürich;8001;00;4385;Zürich;261;ZH;100 %;8.5424538;47.3723086;de;2008-07-01',
  'Zermatt;3920;00;2305;Zermatt;6300;VS;100 %;7.7486898;46.0187772;de;2008-07-01',
  'Lausanne;1003;00;130;Lausanne;5586;VD;100 %;6.6327025;46.5196535;fr;2008-07-01',
  'Wallisellen;8304;00;5006;Wallisellen;69;ZH;98.9 %;8.5949;47.4148;de;2008-07-01',
  'Wallisellen;8304;00;5006;Dübendorf;191;ZH;1.1 %;8.6001;47.4122;de;2008-07-01',
  'Davos Platz;7270;00;3201;Davos;3851;GR;100 %;9.8240;46.7947;de;2008-07-01',
].join('\r\n');

function directoryZip(): Uint8Array {
  return makeZip([
    { name: 'AMTOVZ_CSV_WGS84/', data: '' },
    { name: 'AMTOVZ_CSV_WGS84/AMTOVZ_CSV_WGS84.csv', data: `﻿${DIRECTORY_CSV}`, deflate: true },
  ]);
}

function client(handler: Parameters<typeof createFakeFetch>[0]) {
  const fake = createFakeFetch(handler);
  const binary = async (url: string, init: Parameters<typeof fake.fetch>[1]) => {
    const response = await fake.fetch(url, init);
    // The directory is a ZIP file: answer it as bytes.
    if (url === POSTCODE_DIRECTORY) {
      const bytes = directoryZip();
      return { ...response, arrayBuffer: async () => bytes.slice().buffer };
    }
    return response;
  };
  const http = new HttpClient({
    userAgent: 'test',
    requestsPerSecond: 1000,
    respectRobots: false,
    fetch: binary,
    sleep: async () => {},
  });
  return { http, fake };
}

describe('geometry', () => {
  it('converts Swiss LV95 coordinates to WGS84', () => {
    const bern = lv95ToWgs84(2_600_000, 1_200_000);
    expect(bern.lat).toBeCloseTo(46.95108, 4);
    expect(bern.lon).toBeCloseTo(7.43864, 4);
    const schoenau = lv95ToWgs84(2_600_725, 1_197_996);
    expect(distanceKm(bern, schoenau)).toBeCloseTo(2.13, 1);
  });

  it('measures distances and finds points in polygons with holes', () => {
    expect(distanceKm({ lat: 47.3769, lon: 8.5417 }, { lat: 46.948, lon: 7.4474 })).toBeCloseTo(
      95.5,
      0,
    );
    const square = {
      type: 'Polygon' as const,
      coordinates: [
        [
          [0, 0],
          [10, 0],
          [10, 10],
          [0, 10],
          [0, 0],
        ],
        [
          [4, 4],
          [6, 4],
          [6, 6],
          [4, 6],
          [4, 4],
        ],
      ],
    };
    expect(contains(square, { lat: 2, lon: 2 })).toBe(true);
    expect(contains(square, { lat: 5, lon: 5 })).toBe(false); // in the hole
    expect(contains(square, { lat: 11, lon: 5 })).toBe(false);
  });
});

describe('places', () => {
  let db: Database;
  beforeEach(() => {
    db = Database.open(':memory:');
  });
  afterEach(() => db.close());

  it('reads the official postcode directory', () => {
    const rows = parsePostcodeDirectory(directoryZip());
    expect(rows).toHaveLength(6);
    expect(rows[0]).toEqual({
      postcode: '8001',
      suffix: '00',
      locality: 'Zürich',
      municipalityId: 261,
      municipality: 'Zürich',
      canton: 'ZH',
      addressShare: 100,
      lat: 47.3723086,
      lon: 8.5424538,
      language: 'de',
    });
  });

  it('finds places by postcode, by name and by address, downloading the directory once', async () => {
    const { http, fake } = client((url) => {
      if (url.includes('SearchServer')) {
        return {
          body: {
            results: [
              {
                attrs: {
                  label: 'Bahnhofstrasse 1 <b>8001 Zürich</b>',
                  origin: 'address',
                  lat: 47.3673,
                  lon: 8.5399,
                },
              },
            ],
          },
        };
      }
      return { body: '' };
    });

    const zurich = await resolvePlace(db, http, '8001');
    expect(zurich.place).toMatchObject({
      label: '8001 Zürich',
      municipalityId: 261,
      canton: 'ZH',
      postcode: '8001',
    });
    // A postcode shared by two municipalities: the larger first, the other as an alternative.
    const wallisellen = await resolvePlace(db, http, '8304');
    expect(wallisellen.place.municipality).toBe('Wallisellen');
    expect(wallisellen.alternatives.map((p) => p.label)).toEqual(['8304 Wallisellen (Dübendorf)']);

    expect((await resolvePlace(db, http, 'lausanne')).place).toMatchObject({
      municipalityId: 5586,
      canton: 'VD',
    });
    expect((await resolvePlace(db, http, 'Davos')).place.label).toBe('7270 Davos Platz (Davos)');

    const address = await resolvePlace(db, http, 'Bahnhofstrasse 1 Zürich');
    expect(address.place).toMatchObject({
      label: 'Bahnhofstrasse 1 8001 Zürich',
      municipalityId: 261,
      lat: 47.3673,
    });
    expect(fake.calls.filter((c) => c.url === POSTCODE_DIRECTORY)).toHaveLength(1);
    expect(datasetInfo(db, 'postcodes')?.rows).toBe(6);
  });

  it('says so when nothing matches', async () => {
    const { http } = client((url) => ({
      body: url.includes('SearchServer') ? { results: [] } : '',
    }));
    await expect(resolvePlace(db, http, 'Atlantis')).rejects.toBeInstanceOf(PlaceNotFoundError);
    await expect(resolvePlace(db, http, '9999')).rejects.toThrow('No place in Switzerland');
  });
});

describe('cache', () => {
  it('reuses fresh answers and falls back to an old one when the source fails', async () => {
    const db = Database.open(':memory:');
    let calls = 0;
    const load = async () => ++calls;
    expect(await cached(db, 'k', 60_000, load, 1_000)).toMatchObject({
      value: 1,
      fromCache: false,
    });
    expect(await cached(db, 'k', 60_000, load, 2_000)).toMatchObject({ value: 1, fromCache: true });
    expect(await cached(db, 'k', 60_000, load, 100_000)).toMatchObject({ value: 2, stale: false });
    const failing = async (): Promise<number> => {
      throw new Error('offline');
    };
    expect(await cached(db, 'k', 60_000, failing, 500_000)).toMatchObject({
      value: 2,
      stale: true,
    });
    await expect(cached(db, 'other', 60_000, failing)).rejects.toThrow('offline');
    db.close();
  });
});
