import { z } from 'zod';
import type { HttpClient } from '../../crawler/http.js';
import { cleanText } from '../../normalization/text.js';
import { parseEnvelope } from '../../providers/util.js';

/**
 * swisstopo's search (the geocoder behind map.geo.admin.ch): municipalities,
 * postcodes, places, stops and street addresses, with their coordinates.
 */
const SEARCH = 'https://api3.geo.admin.ch/rest/services/api/SearchServer';

const SearchResponse = z.object({
  results: z.array(
    z.object({
      attrs: z.object({
        label: z.string(),
        origin: z.string().nullish(),
        lat: z.number().nullish(),
        lon: z.number().nullish(),
        detail: z.string().nullish(),
      }),
    }),
  ),
});

export interface GeocodeResult {
  /** e.g. "Bahnhofstrasse 1 8001 Zürich", "Davos (GR)", "Lausanne, gare". */
  label: string;
  /** gg25 (municipality), zipcode, gazetteer (place), address, haltestellen (stop), ... */
  origin: string;
  lat: number;
  lon: number;
}

export async function geocode(http: HttpClient, text: string, limit = 5): Promise<GeocodeResult[]> {
  const url =
    `${SEARCH}?type=locations&sr=4326&limit=${limit}` + `&searchText=${encodeURIComponent(text)}`;
  const response = parseEnvelope(SearchResponse, await http.getJson(url), url, 'swisstopo search');
  return response.results.flatMap((r) => {
    const { lat, lon, label, origin } = r.attrs;
    if (lat == null || lon == null) return [];
    // Labels mark the kind of result in italics ("<i>Quartier</i> <b>Ouchy</b>"): drop it.
    const text = cleanText(label.replace(/<i>[\s\S]*?<\/i>/g, '')) ?? label;
    return [{ label: text, origin: origin ?? '', lat, lon }];
  });
}
