import { CHARGING_STATUS } from './mobility/charging.js';
import { SHARING_API } from './mobility/sharing.js';
import { quakesUrl } from './nature/quakes.js';
import { TEMPERATURES } from './nature/rivers.js';
import { bulletinUrl } from './nature/snow.js';
import { PRIMINFO } from './premiums/priminfo.js';
import { TRANSPORT_API } from './transport/api.js';

/** The public data sources of `swiss`, each with one small request to check it from here. */
export const DATA_SOURCES: { name: string; what: string; url: string }[] = [
  {
    name: 'swisstopo',
    what: 'places and addresses',
    url: 'https://api3.geo.admin.ch/rest/services/api/SearchServer?type=locations&limit=1&searchText=Bern',
  },
  {
    name: 'priminfo.admin.ch',
    what: 'health insurance premiums',
    url: `${PRIMINFO}/de/praemien/franchises?yob=1990`,
  },
  {
    name: 'transport.opendata.ch',
    what: 'timetables',
    url: `${TRANSPORT_API}/locations?query=Bern`,
  },
  {
    name: 'MeteoSwiss',
    what: 'weather',
    url: 'https://data.geo.admin.ch/api/stac/v1/collections/ch.meteoschweiz.ogd-local-forecasting',
  },
  { name: 'Federal Office of Energy', what: 'charging stations', url: CHARGING_STATUS },
  {
    name: 'sharedmobility.ch',
    what: 'shared mobility',
    url: SHARING_API.replace('/identify', '/providers'),
  },
  { name: 'FOEN hydrodaten', what: 'rivers and lakes', url: TEMPERATURES },
  { name: 'Swiss Seismological Service', what: 'earthquakes', url: quakesUrl(1, null) },
  { name: 'SLF', what: 'snow and avalanches', url: bulletinUrl('en') },
];

/** What the cache keys' prefixes are about, for `status`. */
export const CACHE_SOURCES: Record<string, string> = {
  priminfo: 'health insurance',
  transport: 'timetables',
  meteoswiss: 'weather',
  charging: 'charging stations',
  sharing: 'shared mobility',
  hydro: 'rivers and lakes',
  quakes: 'earthquakes',
  slf: 'snow and avalanches',
};
