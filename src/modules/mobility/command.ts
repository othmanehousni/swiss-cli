import type { Command } from 'commander';
import {
  App,
  type GlobalOptions,
  parsePositiveInt,
  parsePositiveNumber,
  sourceClient,
  UserError,
} from '../../commands/shared.js';
import { formatCount } from '../../ui/format.js';
import { type Output, ProgressLine } from '../../ui/output.js';
import { formatClock } from '../../util/when.js';
import {
  otherPlacesHint,
  type Place,
  type ResolvedPlace,
  resolvePlace,
} from '../places/resolve.js';
import {
  type ChargeStatus,
  loadChargingStations,
  loadChargingStatus,
  type NearbyStation,
  stationsNear,
} from './charging.js';
import { offersNear, typeName, type VehicleType } from './sharing.js';

const CHARGE_EXAMPLES = `
Examples:
  $ swiss charge near "Lausanne gare"               charging stations around a place
  $ swiss charge 8001 --available                   with a free charge point right now
  $ swiss charge Bern --fast --plug ccs             fast DC charging (50 kW and more)
  $ swiss charge 3920 --radius 10 -n 20

Data: Swiss Federal Office of Energy (the data of ich-tanke-strom.ch), with live
availability where operators report it. Stations for customers, guests or staff
only are left out unless you add --private.`;

const SHARING_EXAMPLES = `
Examples:
  $ swiss sharing near Bern                         everything around a place
  $ swiss sharing 8001 --type e-bike                only e-bikes
  $ swiss sharing "Lausanne gare" --type car --radius 1000

Types: e-scooter, e-bike, bike, cargo, moped, car, e-car.
Data: sharedmobility.ch (Swiss Federal Office of Energy), live.`;

/** "near Lausanne gare" and "Lausanne gare" mean the same. */
function placeText(words: string[]): string {
  const text = (words[0]?.toLowerCase() === 'near' ? words.slice(1) : words).join(' ').trim();
  if (!text) throw new UserError('Which place? For example: swiss charge near Lausanne');
  return text;
}

export function formatDistance(km: number): string {
  return km < 1 ? `${Math.round((km * 1000) / 10) * 10} m` : `${km.toFixed(1)} km`;
}

const PLUG_ALIASES: Record<string, string[]> = {
  type2: ['Type 2', 'Type 2 cable'],
  'type-2': ['Type 2', 'Type 2 cable'],
  t2: ['Type 2', 'Type 2 cable'],
  ccs: ['CCS', 'CCS1'],
  chademo: ['CHAdeMO'],
  tesla: ['Tesla'],
  type1: ['Type 1'],
  'type-1': ['Type 1'],
  socket: ['Swiss socket', 'Schuko'],
  schuko: ['Schuko'],
};

export function parsePlugs(value: string): string[] {
  const plugs: string[] = [];
  for (const name of value
    .split(',')
    .map((p) => p.trim().toLowerCase().replace(/\s+/g, ''))
    .filter(Boolean)) {
    const found = PLUG_ALIASES[name];
    if (!found) {
      throw new UserError(`Unknown plug "${name}".`, [
        'Use type2, ccs, chademo, tesla, type1 or socket.',
      ]);
    }
    for (const plug of found) if (!plugs.includes(plug)) plugs.push(plug);
  }
  return plugs;
}

const TYPE_ALIASES: Record<string, VehicleType[]> = {
  scooter: ['E-Scooter'],
  scooters: ['E-Scooter'],
  'e-scooter': ['E-Scooter'],
  escooter: ['E-Scooter'],
  kickscooter: ['E-Scooter'],
  'e-bike': ['E-Bike'],
  ebike: ['E-Bike'],
  'e-bikes': ['E-Bike'],
  bike: ['Bike'],
  bikes: ['Bike'],
  bicycle: ['Bike'],
  velo: ['Bike'],
  cargo: ['E-CargoBike', 'CargoBike'],
  'cargo-bike': ['E-CargoBike', 'CargoBike'],
  cargobike: ['E-CargoBike', 'CargoBike'],
  moped: ['E-Moped'],
  'e-moped': ['E-Moped'],
  car: ['Car', 'E-Car'],
  cars: ['Car', 'E-Car'],
  'e-car': ['E-Car'],
  ecar: ['E-Car'],
};

export function parseVehicleTypes(value: string): VehicleType[] {
  const types: VehicleType[] = [];
  for (const name of value
    .split(',')
    .map((t) => t.trim().toLowerCase())
    .filter(Boolean)) {
    const found = TYPE_ALIASES[name];
    if (!found) {
      throw new UserError(`Unknown type "${name}".`, [
        'Use e-scooter, e-bike, bike, cargo, moped, car or e-car.',
      ]);
    }
    for (const type of found) if (!types.includes(type)) types.push(type);
  }
  return types;
}

function header(out: Output, title: string, place: Place, details: string): void {
  out.print();
  out.print(`  ${out.c.bold(`${title} · ${place.label}`)}`);
  out.print(`  ${out.c.dim(details)}`);
  out.print();
}

function freeCount(station: NearbyStation, status: Record<string, ChargeStatus>) {
  const states = station.points.map((p) => status[p.id] ?? 'Unknown');
  return {
    free: states.filter((s) => s === 'Available').length,
    known: states.filter((s) => s !== 'Unknown').length,
    total: states.length,
  };
}

export function registerMobilityCommands(program: Command): void {
  program
    .command('charge')
    .alias('charging')
    .summary('electric car charging stations near a place, with live availability')
    .description(
      'Public charging stations for electric cars around a place, nearest first, with ' +
        'their power, plugs and how many charge points are free right now.',
    )
    .argument('<place...>', 'postcode, municipality, address or station ("near" is optional)')
    .option('-r, --radius <km>', 'how far to look', '2')
    .option('--available', 'only stations with a free charge point right now')
    .option('--fast', 'only fast charging: 50 kW and more')
    .option('--min-power <kW>', 'only charge points with at least this power')
    .option('--plug <plugs>', 'only these plugs: type2, ccs, chademo, tesla, type1, socket')
    .option('--private', 'also stations for customers, guests or staff only')
    .option('-n, --limit <count>', 'how many stations to show', '10')
    .option('--json', 'machine-readable output')
    .addHelpText('after', CHARGE_EXAMPLES)
    .action(
      async (
        words: string[],
        opts: Record<string, string | boolean | undefined>,
        command: Command,
      ) => {
        const app = new App(command.optsWithGlobals<GlobalOptions>(), opts.json === true);
        try {
          await charge(app, placeText(words), opts);
        } finally {
          app.close();
        }
      },
    );

  program
    .command('sharing')
    .summary('shared bikes, e-scooters and cars near a place, live')
    .description(
      'Shared bikes, e-bikes, e-scooters, cargo bikes, mopeds and cars of every provider ' +
        'around a place: rental stations and vehicles parked nearby.',
    )
    .argument('<place...>', 'postcode, municipality, address or station ("near" is optional)')
    .option('-t, --type <types>', 'only these: e-scooter, e-bike, bike, cargo, moped, car, e-car')
    .option('-r, --radius <metres>', 'how far to look, up to 2000', '300')
    .option('-n, --limit <count>', 'how many rows to show', '15')
    .option('--json', 'machine-readable output')
    .addHelpText('after', SHARING_EXAMPLES)
    .action(
      async (
        words: string[],
        opts: Record<string, string | boolean | undefined>,
        command: Command,
      ) => {
        const app = new App(command.optsWithGlobals<GlobalOptions>(), opts.json === true);
        try {
          await sharing(app, placeText(words), opts);
        } finally {
          app.close();
        }
      },
    );
}

async function charge(
  app: App,
  text: string,
  opts: Record<string, string | boolean | undefined>,
): Promise<void> {
  const { out } = app;
  const radiusKm = parsePositiveNumber(String(opts.radius ?? '2'), '--radius');
  const limit = parsePositiveInt(String(opts.limit ?? '10'), '--limit');
  const minPower =
    typeof opts.minPower === 'string'
      ? parsePositiveNumber(opts.minPower, '--min-power')
      : opts.fast === true
        ? 50
        : undefined;
  const plugs = typeof opts.plug === 'string' ? parsePlugs(opts.plug) : undefined;
  const db = app.db();
  const http = sourceClient(app, 'charging');
  const progress = new ProgressLine(out);
  let resolved: ResolvedPlace;
  let place: Place;
  let stations: NearbyStation[];
  let live: Awaited<ReturnType<typeof loadChargingStatus>>;
  try {
    progress.update('Finding the place…');
    resolved = await resolvePlace(db, http, text);
    place = resolved.place;
    progress.update('Loading the charging stations (once a day, about 1 MB)…');
    const all = await loadChargingStations(db, http);
    stations = stationsNear(all, place, {
      radiusKm,
      ...(minPower ? { minPower } : {}),
      ...(plugs ? { plugs } : {}),
      includeRestricted: opts.private === true,
    });
    progress.update('Checking which charge points are free…');
    live = await loadChargingStatus(db, http);
  } finally {
    progress.clear();
  }
  const rows = stations
    .map((s) => ({ ...s, ...freeCount(s, live.status) }))
    .filter((s) => opts.available !== true || s.free > 0);
  const shown = rows.slice(0, limit);

  if (out.options.json) {
    out.json({
      place: { label: place.label, lat: place.lat, lon: place.lon },
      radiusKm,
      total: rows.length,
      stations: shown.map((s) => ({
        name: s.name,
        operator: s.operator,
        address: s.address,
        lat: s.lat,
        lon: s.lon,
        distanceKm: Math.round(s.km * 100) / 100,
        maxPowerKw: s.maxPower,
        plugs: [...new Set(s.points.flatMap((p) => p.plugs))],
        publicAccess: s.publicAccess,
        open24h: s.open24h,
        chargePoints: s.total,
        free: s.free,
        withLiveStatus: s.known,
      })),
      statusAt: live.fetchedAt,
      source: 'Swiss Federal Office of Energy (ich-tanke-strom.ch)',
    });
    return;
  }
  const filters = [
    `within ${radiusKm} km`,
    minPower ? `${minPower} kW and more` : null,
    plugs ? plugs.join(' or ') : null,
    opts.available === true ? 'free now' : null,
    `availability at ${formatClock(Date.parse(live.fetchedAt) / 1000)}`,
  ].filter(Boolean);
  header(out, 'Charging stations', place, filters.join(' · '));
  if (shown.length === 0) {
    out.info(`  No ${opts.available === true ? 'free ' : ''}charging station found.`);
    out.hint(`Look further: --radius ${Math.max(5, radiusKm * 3)}`);
    return;
  }
  out.table(shown, [
    { header: '#', value: (s) => String(rows.indexOf(s) + 1), align: 'right' },
    { header: 'Distance', value: (s) => formatDistance(s.km), align: 'right' },
    { header: 'Station', value: (s) => s.name || s.address, flex: true },
    { header: 'Operator', value: (s) => s.operator },
    {
      header: 'Power',
      value: (s) => (s.maxPower ? `${Math.round(s.maxPower)} kW` : '–'),
      align: 'right',
    },
    { header: 'Plugs', value: (s) => [...new Set(s.points.flatMap((p) => p.plugs))].join(', ') },
    {
      header: 'Free',
      value: (s) => (s.known === 0 ? `?/${s.total}` : `${s.free}/${s.total}`),
      align: 'right',
      style: (text, s) =>
        s.known === 0 ? out.c.dim(text) : s.free > 0 ? out.c.green(text) : out.c.red(text),
    },
  ]);
  if (shown.length < rows.length) {
    out.info(
      out.c.dim(`  ${formatCount(rows.length - shown.length)} more: --limit ${rows.length}`),
    );
  }
  out.print();
  out.info(
    out.c.dim(
      '  "?": the operator does not report live availability. Data: Swiss Federal Office of Energy.',
    ),
  );
  if (live.stale) out.warn('Live availability could not be loaded: these numbers are older.');
  const hint = otherPlacesHint(resolved, 'swiss charge near');
  if (hint) out.info(out.c.dim(`  ${hint}`));
}

async function sharing(
  app: App,
  text: string,
  opts: Record<string, string | boolean | undefined>,
): Promise<void> {
  const { out } = app;
  const radius = Math.min(parsePositiveInt(String(opts.radius ?? '300'), '--radius'), 2000);
  const limit = parsePositiveInt(String(opts.limit ?? '15'), '--limit');
  const types = typeof opts.type === 'string' ? parseVehicleTypes(opts.type) : [];
  const db = app.db();
  const http = sourceClient(app, 'sharedmobility');
  const progress = new ProgressLine(out);
  let resolved: ResolvedPlace;
  let place: Place;
  let found: Awaited<ReturnType<typeof offersNear>>;
  try {
    progress.update('Finding the place…');
    resolved = await resolvePlace(db, http, text);
    place = resolved.place;
    progress.update('Asking sharedmobility.ch…');
    found = await offersNear(db, http, place, radius, types);
  } finally {
    progress.clear();
  }

  // Vehicles parked anywhere, grouped by provider and type; stations one by one.
  interface Row {
    km: number;
    provider: string;
    what: string;
    where: string;
    count: number;
  }
  const groups = new Map<string, Row>();
  const rows: Row[] = [];
  for (const offer of found.offers) {
    if (offer.station === null) {
      const type = offer.types[0] ?? 'Other';
      const key = `${offer.provider}|${type}`;
      const group = groups.get(key);
      if (group) group.count++;
      else
        groups.set(key, {
          km: offer.km,
          provider: offer.provider,
          what: type,
          where: 'parked nearby',
          count: 1,
        });
    } else {
      const kinds = [...new Set(offer.types)].map((t) => typeName(t, 2)).join(', ');
      rows.push({
        km: offer.km,
        provider: offer.provider,
        what:
          offer.available > 0
            ? `${offer.available} available${kinds ? ` (${kinds})` : ''}`
            : `none available${kinds ? ` (${kinds})` : ''}`,
        where: offer.station,
        count: offer.available,
      });
    }
  }
  for (const group of groups.values()) {
    rows.push({ ...group, what: `${group.count} ${typeName(group.what, group.count)}` });
  }
  rows.sort((a, b) => a.km - b.km);
  const shown = rows.slice(0, limit);

  if (out.options.json) {
    out.json({
      place: { label: place.label, lat: place.lat, lon: place.lon },
      radiusMetres: radius,
      complete: found.complete,
      offers: found.offers.map((o) => ({ ...o, distanceMetres: Math.round(o.km * 1000) })),
      fetchedAt: found.fetchedAt,
      source: 'sharedmobility.ch',
    });
    return;
  }
  header(
    out,
    'Shared mobility',
    place,
    [
      `within ${radius} m`,
      types.length ? types.map((t) => typeName(t, 2)).join(', ') : null,
      `live at ${formatClock(Date.parse(found.fetchedAt) / 1000)}`,
    ]
      .filter(Boolean)
      .join(' · '),
  );
  if (shown.length === 0) {
    out.info('  Nothing to rent here right now.');
    out.hint(`Look further: --radius ${Math.min(2000, radius * 3)}`);
    return;
  }
  out.table(shown, [
    { header: 'Distance', value: (r) => formatDistance(r.km), align: 'right' },
    { header: 'Provider', value: (r) => r.provider },
    { header: 'Vehicles', value: (r) => r.what, style: (t, r) => (r.count > 0 ? t : out.c.dim(t)) },
    { header: 'Where', value: (r) => r.where, flex: true },
  ]);
  if (shown.length < rows.length) {
    out.info(
      out.c.dim(`  ${formatCount(rows.length - shown.length)} more: --limit ${rows.length}`),
    );
  }
  out.print();
  if (!found.complete)
    out.info(
      out.c.dim('  There is more than shown here: a smaller --radius or a --type narrows it down.'),
    );
  out.info(
    out.c.dim(
      "  Data: sharedmobility.ch (Swiss Federal Office of Energy). Rent in the providers' apps.",
    ),
  );
  const hint = otherPlacesHint(resolved, 'swiss sharing near');
  if (hint) out.info(out.c.dim(`  ${hint}`));
}
