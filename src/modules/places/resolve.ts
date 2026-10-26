import type { HttpClient } from '../../crawler/http.js';
import { looseKey } from '../../normalization/text.js';
import type { Database } from '../../storage/database.js';
import { geocode } from './geocode.js';
import {
  ensurePostcodes,
  findPlaces,
  nearestPostcode,
  type PostcodeRow,
  postcodeRows,
} from './postcodes.js';

/** A place in Switzerland, with its municipality when one is known. */
export interface Place {
  /** As shown to the user: "8001 Zürich", "Davos (GR)", "Lausanne, gare". */
  label: string;
  lat: number;
  lon: number;
  postcode: string | null;
  municipalityId: number | null;
  municipality: string | null;
  canton: string | null;
}

export interface ResolvedPlace {
  place: Place;
  /** Other municipalities the same postcode or name covers. */
  alternatives: Place[];
}

export class PlaceNotFoundError extends Error {
  constructor(readonly query: string) {
    super(`No place in Switzerland matches "${query}".`);
    this.name = 'PlaceNotFoundError';
  }
}

function fromPostcode(row: PostcodeRow, label: string): Place {
  return {
    label,
    lat: row.lat ?? 0,
    lon: row.lon ?? 0,
    postcode: row.postcode,
    municipalityId: row.municipalityId,
    municipality: row.municipality,
    canton: row.canton,
  };
}

/** One place per municipality, keeping the first (largest) row of each. */
function perMunicipality(rows: PostcodeRow[]): PostcodeRow[] {
  const seen = new Set<number>();
  return rows.filter((r) => !seen.has(r.municipalityId) && seen.add(r.municipalityId));
}

function placeLabel(row: PostcodeRow): string {
  const name =
    row.locality === row.municipality ? row.locality : `${row.locality} (${row.municipality})`;
  return `${row.postcode} ${name}`;
}

/**
 * Finds a place from what a user types: a postcode ("8001"), a place or
 * municipality ("Lausanne", "Davos Platz"), or anything swisstopo's search
 * knows (addresses, stations, mountains).
 */
export async function resolvePlace(
  db: Database,
  http: HttpClient,
  query: string,
): Promise<ResolvedPlace> {
  const text = query.trim();
  if (!text) throw new PlaceNotFoundError(query);
  await ensurePostcodes(db, http);

  if (/^\d{4}$/.test(text)) {
    const rows = perMunicipality(postcodeRows(db, text));
    const [first, ...others] = rows;
    if (!first) throw new PlaceNotFoundError(query);
    return {
      place: fromPostcode(first, placeLabel(first)),
      alternatives: others.map((r) => fromPostcode(r, placeLabel(r))),
    };
  }

  const named = perMunicipality(findPlaces(db, text));
  const [first, ...others] = named;
  if (first) {
    // Only municipalities of the same name are real alternatives (Buchs AG, SG and ZH).
    const key = looseKey(text);
    const sameName = others.filter((r) => looseKey(r.municipality) === key);
    return {
      place: fromPostcode(first, placeLabel(first)),
      alternatives: sameName.slice(0, 5).map((r) => fromPostcode(r, placeLabel(r))),
    };
  }

  const [hit] = await geocode(http, text, 1);
  if (!hit) throw new PlaceNotFoundError(query);
  // The municipality of a street address or a station: the closest postcode's.
  const near = nearestPostcode(db, hit.lat, hit.lon);
  return {
    place: {
      label: hit.label,
      lat: hit.lat,
      lon: hit.lon,
      postcode: near?.postcode ?? null,
      municipalityId: near?.municipalityId ?? null,
      municipality: near?.municipality ?? null,
      canton: near?.canton ?? null,
    },
    alternatives: [],
  };
}
