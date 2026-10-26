import type { HttpClient } from '../../crawler/http.js';
import { looseKey } from '../../normalization/text.js';
import { needsRefresh, recordDataset } from '../../storage/cache.js';
import type { Database } from '../../storage/database.js';
import { parseCsvRecords } from '../../util/csv.js';
import { findZipEntry, readZip } from '../../util/zip.js';

/**
 * The official directory of Swiss postcodes ("Amtliches Ortschaftenverzeichnis",
 * swisstopo, updated monthly): every postcode with its places, municipality (BFS
 * number), canton and centre. About 200 KB, refreshed once a month.
 */
export const POSTCODE_DIRECTORY =
  'https://data.geo.admin.ch/ch.swisstopo-vd.ortschaftenverzeichnis_plz/ortschaftenverzeichnis_plz/ortschaftenverzeichnis_plz_4326.csv.zip';
const MAX_AGE_MS = 30 * 24 * 3600 * 1000;

export interface PostcodeRow {
  postcode: string;
  suffix: string;
  locality: string;
  municipalityId: number;
  municipality: string;
  canton: string;
  addressShare: number | null;
  lat: number | null;
  lon: number | null;
  language: string | null;
}

function number(text: string | undefined): number | null {
  const value = Number.parseFloat((text ?? '').replace('%', '').trim());
  return Number.isFinite(value) ? value : null;
}

/** Reads the directory's ZIP file (one semicolon-separated CSV inside). */
export function parsePostcodeDirectory(zip: Uint8Array): PostcodeRow[] {
  const entry = findZipEntry(readZip(zip), /\.csv$/i);
  if (!entry) throw new Error('the postcode directory has no CSV file');
  return parseCsvRecords(new TextDecoder('utf-8').decode(entry.read()), ';')
    .map((r) => ({
      postcode: (r.PLZ4 ?? '').trim(),
      suffix: (r.Zusatzziffer ?? '').trim(),
      locality: (r.Ortschaftsname ?? '').trim(),
      municipalityId: Number(r['BFS-Nr']),
      municipality: (r.Gemeindename ?? '').trim(),
      canton: (r.Kantonskürzel ?? '').trim(),
      addressShare: number(r.Adressenanteil),
      lon: number(r.E),
      lat: number(r.N),
      language: (r.Sprache ?? '').trim() || null,
    }))
    .filter((r) => /^\d{4}$/.test(r.postcode) && Number.isInteger(r.municipalityId) && r.canton);
}

export function savePostcodes(db: Database, rows: PostcodeRow[], now: string): void {
  db.transaction(() => {
    db.run('DELETE FROM postcodes');
    for (const r of rows) {
      db.run(
        `INSERT OR REPLACE INTO postcodes (postcode, suffix, locality, locality_key, municipality_id,
           municipality, municipality_key, canton, address_share, lat, lon, language)
         VALUES ($postcode, $suffix, $locality, $localityKey, $municipalityId, $municipality,
           $municipalityKey, $canton, $share, $lat, $lon, $language)`,
        {
          postcode: r.postcode,
          suffix: r.suffix,
          locality: r.locality,
          localityKey: looseKey(r.locality),
          municipalityId: r.municipalityId,
          municipality: r.municipality,
          municipalityKey: looseKey(r.municipality),
          canton: r.canton,
          share: r.addressShare,
          lat: r.lat,
          lon: r.lon,
          language: r.language,
        },
      );
    }
    recordDataset(db, 'postcodes', rows.length, null, now);
  });
}

/** Downloads the directory when it is missing or older than a month. */
export async function ensurePostcodes(
  db: Database,
  http: HttpClient,
  now: number = Date.now(),
): Promise<void> {
  if (!needsRefresh(db, 'postcodes', MAX_AGE_MS, now)) return;
  try {
    const rows = parsePostcodeDirectory(await http.getBytes(POSTCODE_DIRECTORY));
    savePostcodes(db, rows, new Date(now).toISOString());
  } catch (error) {
    // An older copy still answers most questions; only a first download must succeed.
    if (db.get('SELECT 1 AS yes FROM postcodes LIMIT 1') === undefined) throw error;
  }
}

interface PostcodeDbRow {
  postcode: string;
  suffix: string;
  locality: string;
  municipality_id: number;
  municipality: string;
  canton: string;
  address_share: number | null;
  lat: number | null;
  lon: number | null;
  language: string | null;
}

function fromDb(r: PostcodeDbRow): PostcodeRow {
  return {
    postcode: r.postcode,
    suffix: r.suffix,
    locality: r.locality,
    municipalityId: r.municipality_id,
    municipality: r.municipality,
    canton: r.canton,
    addressShare: r.address_share,
    lat: r.lat,
    lon: r.lon,
    language: r.language,
  };
}

const COLUMNS =
  'postcode, suffix, locality, municipality_id, municipality, canton, address_share, lat, lon, language';

/** The places of a postcode, the one with most addresses first. */
export function postcodeRows(db: Database, postcode: string): PostcodeRow[] {
  return db
    .all<PostcodeDbRow>(
      `SELECT ${COLUMNS} FROM postcodes WHERE postcode = $postcode
       ORDER BY address_share DESC NULLS LAST, suffix`,
      { postcode },
    )
    .map(fromDb);
}

/**
 * Places named like `name` ("Zurich", "Genève", "Davos Platz"): exact matches of a
 * place or municipality first, then names that start with it.
 */
export function findPlaces(db: Database, name: string): PostcodeRow[] {
  const key = looseKey(name);
  if (!key) return [];
  return db
    .all<PostcodeDbRow>(
      `SELECT ${COLUMNS} FROM postcodes
       WHERE locality_key = $key OR municipality_key = $key
          OR locality_key LIKE $prefix OR municipality_key LIKE $prefix
       ORDER BY (municipality_key = $key) DESC, (locality_key = $key) DESC,
         (locality_key = municipality_key) DESC, address_share DESC NULLS LAST, postcode
       LIMIT 50`,
      { key, prefix: `${key} %` },
    )
    .map(fromDb);
}

/** The postcode place closest to a point (for coordinates without an address). */
export function nearestPostcode(db: Database, lat: number, lon: number): PostcodeRow | null {
  // Squared degree distance with longitude scaled for Switzerland's latitude is plenty here.
  const row = db.get<PostcodeDbRow>(
    `SELECT ${COLUMNS} FROM postcodes WHERE lat IS NOT NULL
     ORDER BY (lat - $lat) * (lat - $lat) + (lon - $lon) * (lon - $lon) * 0.47 LIMIT 1`,
    { lat, lon },
  );
  return row ? fromDb(row) : null;
}
