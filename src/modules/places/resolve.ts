import type { HttpClient } from '../../crawler/http.js';
import { editDistance, looseKey } from '../../normalization/text.js';
import type { Database } from '../../storage/database.js';
import { type GeocodeResult, geocode } from './geocode.js';
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
  /**
   * How it was found: a postcode, a place or municipality name, or swisstopo's
   * search (addresses, stations, mountains): then the postcode is the nearest one.
   */
  kind: 'postcode' | 'name' | 'search';
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

function fromPostcode(row: PostcodeRow, label: string, kind: Place['kind']): Place {
  return {
    kind,
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
  // "Wil ZH" in the municipality "Wil (ZH)" is the same name.
  const name =
    looseKey(row.locality) === looseKey(row.municipality)
      ? row.locality
      : `${row.locality} (${row.municipality})`;
  return `${row.postcode} ${name}`;
}

/**
 * How well a search result's label matches what was typed, lower is better; null when
 * no word of the query is in it. The search also returns loose matches ("Atlantis"
 * gives "Road Atlanta"), which must not be taken for the place asked for.
 */
export function matchScore(query: string, label: string): number | null {
  const typed = looseKey(query).split(' ').filter(Boolean);
  const wanted = typed.filter((w) => w.length >= 3 && !/^\d+$/.test(w));
  const words = looseKey(label).split(' ').filter(Boolean);
  let best: number | null = wanted.length === 0 ? 0 : null;
  for (const w of wanted) {
    for (const l of words) {
      // The same word; an abbreviation ("Bahnhofstr"); one letter off ("Lausane").
      const quality =
        w === l
          ? 0
          : w.length >= 6 && l.startsWith(w)
            ? 1
            : w.length >= 5 && editDistance(w, l) <= 1
              ? 2
              : null;
      if (quality !== null && (best === null || quality < best)) best = quality;
    }
  }
  if (best === null) return null;
  // Among equally good matches, the label with the fewest other words ("Lausanne (VD)"
  // rather than "Belmont-sur-Lausanne (VD)").
  const extra = words.filter((l) => !typed.includes(l)).length;
  return best * 100 + extra;
}

/** The best search result for the query, or null when none really matches it. */
export function bestMatch(query: string, results: GeocodeResult[]): GeocodeResult | null {
  let best: { result: GeocodeResult; score: number } | null = null;
  for (const result of results) {
    const score = matchScore(query, result.label);
    if (score !== null && (best === null || score < best.score)) best = { result, score };
  }
  return best?.result ?? null;
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
      place: fromPostcode(first, placeLabel(first), 'postcode'),
      alternatives: others.map((r) => fromPostcode(r, placeLabel(r), 'postcode')),
    };
  }

  const named = perMunicipality(findPlaces(db, text));
  const [first, ...others] = named;
  if (first) {
    // Only municipalities of the same name are real alternatives: "Buchs (AG)", "Buchs (SG)"
    // and "Buchs (ZH)" for "Buchs".
    const key = looseKey(text);
    const sameName = others.filter((r) => {
      const name = looseKey(r.municipality);
      return (
        name === key ||
        (name.startsWith(`${key} `) && /^[a-z]{2}$/.test(name.slice(key.length + 1)))
      );
    });
    return {
      place: fromPostcode(first, placeLabel(first), 'name'),
      alternatives: sameName.slice(0, 5).map((r) => fromPostcode(r, placeLabel(r), 'name')),
    };
  }

  const hit = bestMatch(text, await geocode(http, text, 5));
  if (!hit) throw new PlaceNotFoundError(query);
  // The municipality of a street address or a station: the closest postcode's.
  const near = nearestPostcode(db, hit.lat, hit.lon);
  return {
    place: {
      kind: 'search',
      // "Lausanne (VD)": the canton is shown separately.
      label: hit.label.replace(/\s*\([A-Z]{2}\)$/, ''),
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

/**
 * A hint about the other places a search could have meant: other municipalities of a
 * shared postcode, or of the same name ("Wil" is in St. Gallen and Zürich).
 */
export function otherPlacesHint(resolved: ResolvedPlace, command: string): string | null {
  const [first] = resolved.alternatives;
  if (!first) return null;
  const names = resolved.alternatives
    .slice(0, 3)
    .map((a) => (resolved.place.kind === 'postcode' ? (a.municipality ?? a.label) : a.label));
  const example =
    resolved.place.kind === 'postcode' ? `"${first.municipality ?? first.label}"` : first.postcode;
  return resolved.place.kind === 'postcode'
    ? `${resolved.place.postcode} is also in ${names.join(', ')}: ${command} ${example}`
    : `Other places of that name: ${names.join(', ')} (use the postcode: ${command} ${example})`;
}
