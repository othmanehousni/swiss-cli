import { z } from 'zod';
import { cleanText } from '../../normalization/text.js';
import { parseEnvelope } from '../../providers/util.js';
/**
 * swisstopo's search (the geocoder behind map.geo.admin.ch): municipalities,
 * postcodes, places, stops and street addresses, with their coordinates.
 */
const SEARCH = 'https://api3.geo.admin.ch/rest/services/api/SearchServer';
const SearchResponse = z.object({
    results: z.array(z.object({
        attrs: z.object({
            label: z.string(),
            origin: z.string().nullish(),
            lat: z.number().nullish(),
            lon: z.number().nullish(),
            detail: z.string().nullish(),
        }),
    })),
});
export async function geocode(http, text, limit = 5) {
    const url = `${SEARCH}?type=locations&sr=4326&limit=${limit}` + `&searchText=${encodeURIComponent(text)}`;
    const response = parseEnvelope(SearchResponse, await http.getJson(url), url, 'swisstopo search');
    return response.results.flatMap((r) => {
        const { lat, lon, label, origin } = r.attrs;
        if (lat == null || lon == null)
            return [];
        // Labels mark the kind of result in italics ("<i>Quartier</i> <b>Ouchy</b>"): drop it.
        const text = cleanText(label.replace(/<i>[\s\S]*?<\/i>/g, '')) ?? label;
        return [{ label: text, origin: origin ?? '', lat, lon }];
    });
}
