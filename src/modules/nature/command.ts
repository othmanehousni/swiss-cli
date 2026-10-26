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
import { formatClock, zurichMoment } from '../../util/when.js';
import { distanceKm } from '../places/geo.js';
import { type Place, resolvePlace } from '../places/resolve.js';
import { recentQuakes } from './quakes.js';
import { DANGER_NAMES, findWaters, loadWaterStations, type WaterStation } from './rivers.js';
import {
  type Bulletin,
  bulletinFor,
  highestLevel,
  latestSnow,
  loadBulletins,
  loadSnowStations,
  loadWarningRegions,
  nearestSnowStations,
  regionAt,
  type WarningRegion,
} from './snow.js';

type Options = Record<string, string | boolean | undefined>;

const RIVERS_EXAMPLES = `
Examples:
  $ swiss rivers                       water temperature of every river and lake station
  $ swiss rivers aare                  one river or lake
  $ swiss rivers --near Thun           the stations nearest to a place
  $ swiss aare                         the Aare, Bern first

Flood danger levels (1 no or low, 2 moderate, 3 considerable, 4 high, 5 very high)
are shown where the FOEN publishes thresholds. Data: FOEN (hydrodaten.admin.ch).`;

const QUAKES_EXAMPLES = `
Examples:
  $ swiss quakes                       the last 7 days in and around Switzerland
  $ swiss quakes --days 90 --min 2.5   the ones people may have felt
  $ swiss quakes --near Basel --radius 30 --days 365

Data: Swiss Seismological Service (SED) at ETH Zürich.`;

const SNOW_EXAMPLES = `
Examples:
  $ swiss snow Davos
  $ swiss snow 3920 --stations 5
  $ swiss avalanche Zermatt            the avalanche bulletin for a place
  $ swiss avalanche                    the whole country

Data: WSL Institute for Snow and Avalanche Research SLF.`;

/** Names in English unless another language was chosen (--lang or SWISS_GROCERY_LANG). */
function textLang(app: App): 'en' | 'de' | 'fr' | 'it' {
  return app.options.lang ?? (process.env.SWISS_GROCERY_LANG ? app.langFor() : 'en');
}

function measuredAt(iso: string | null | undefined): string {
  if (!iso) return '';
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return '';
  const { date } = zurichMoment(ms);
  const today = zurichMoment(Date.now()).date;
  if (date === today) return formatClock(ms / 1000);
  const day = `${date.slice(8, 10)}.${date.slice(5, 7)}.`;
  return `${date.slice(0, 4) === today.slice(0, 4) ? day : `${day}${date.slice(0, 4)}`} ${formatClock(ms / 1000)}`;
}

function distance(km: number): string {
  return km < 1 ? `${Math.round(km * 1000)} m` : `${km.toFixed(km < 10 ? 1 : 0)} km`;
}

async function placeFor(app: App, text: string, progress: ProgressLine): Promise<Place> {
  progress.update('Finding the place…');
  return (await resolvePlace(app.db(), sourceClient(app, 'places'), text)).place;
}

// ---- rivers and lakes -------------------------------------------------------------

function flowText(s: WaterStation): string {
  if (!s.flow) return '–';
  const { value, unit } = s.flow;
  if (unit === 'm') return `${value.toFixed(2)} m`;
  const digits = value < 10 ? 1 : 0;
  return `${value.toFixed(value < 1 ? 2 : digits)} ${unit}`;
}

function printWaters(
  out: Output,
  stations: (WaterStation & { km?: number })[],
  withDistance: boolean,
): void {
  out.table(stations, [
    ...(withDistance
      ? [
          {
            header: 'Distance',
            value: (s: WaterStation & { km?: number }) => distance(s.km ?? 0),
            align: 'right' as const,
          },
        ]
      : []),
    { header: 'Station', value: (s) => s.name, flex: true },
    {
      header: 'Water',
      value: (s) => (s.temperature ? `${s.temperature.value.toFixed(1)} °C` : '–'),
      align: 'right',
      style: (t) => out.c.cyan(t),
    },
    {
      header: '24 h',
      value: (s) =>
        s.temperature?.min24h != null && s.temperature.max24h != null
          ? `${s.temperature.min24h.toFixed(1)}–${s.temperature.max24h.toFixed(1)}`
          : '',
      align: 'right',
    },
    { header: 'Flow / level', value: flowText, align: 'right' },
    {
      header: 'Flood danger',
      value: (s) =>
        s.danger && s.danger >= 2
          ? `${s.danger} ${DANGER_NAMES[s.danger]?.replace(' danger', '')}`
          : '',
      style: (t, s) => ((s.danger ?? 0) >= 3 ? out.c.red(t) : out.c.yellow(t)),
    },
  ]);
}

async function rivers(app: App, words: string[], opts: Options, focus?: string): Promise<void> {
  const { out } = app;
  const query = words.join(' ').trim();
  const limit =
    opts.all === true
      ? Number.POSITIVE_INFINITY
      : parsePositiveInt(String(opts.limit ?? '20'), '--limit');
  const progress = new ProgressLine(out);
  let place: Place | null = null;
  let data: Awaited<ReturnType<typeof loadWaterStations>>;
  try {
    if (typeof opts.near === 'string') place = await placeFor(app, opts.near, progress);
    progress.update('Loading river and lake measurements…');
    data = await loadWaterStations(app.db(), sourceClient(app, 'hydrodaten'));
  } finally {
    progress.clear();
  }
  let stations: (WaterStation & { km?: number })[] = query
    ? findWaters(data.stations, query)
    : data.stations;
  if (query && stations.length === 0) {
    throw new UserError(`No river or lake station matches "${query}".`, [
      'See them all: swiss rivers --all',
    ]);
  }
  if (place) {
    const here = place;
    stations = stations
      .map((s) => ({ ...s, km: distanceKm(s, here) }))
      .sort((a, b) => (a.km ?? 0) - (b.km ?? 0));
  } else {
    // Without a place: those with a water temperature first, by river and station.
    stations = [...stations].sort(
      (a, b) =>
        Number(b.temperature !== null) - Number(a.temperature !== null) ||
        a.water.localeCompare(b.water) ||
        a.name.localeCompare(b.name),
    );
    if (!query) stations = stations.filter((s) => s.temperature !== null);
  }
  const shown = stations.slice(0, limit);

  if (out.options.json) {
    out.json({
      stations: shown,
      total: stations.length,
      fetchedAt: data.fetchedAt,
      source: 'FOEN (hydrodaten.admin.ch)',
    });
    return;
  }
  out.print();
  const title = place
    ? `Rivers and lakes near ${place.label}`
    : query
      ? `Rivers and lakes · ${query}`
      : 'Rivers and lakes';
  out.print(`  ${out.c.bold(title)}`);
  const latest = shown
    .map((s) => s.temperature?.at ?? s.flow?.at)
    .filter(Boolean)
    .sort()
    .at(-1);
  out.print(
    `  ${out.c.dim(`measured ${measuredAt(latest)} · water temperature, its range over 24 hours, flow (lakes: level)`)}`,
  );
  out.print();
  const highlight = focus ? shown.find((s) => s.name.includes(focus) && s.temperature) : undefined;
  if (highlight?.temperature) {
    out.print(
      `  ${out.c.bold(`${highlight.water} in ${focus}: ${highlight.temperature.value.toFixed(1)} °C`)}` +
        `${highlight.flow ? `, ${flowText(highlight)}` : ''} ${out.c.dim(`(${highlight.name}, ${measuredAt(highlight.temperature.at)})`)}`,
    );
    out.print();
  }
  printWaters(out, shown, place !== null);
  if (shown.length < stations.length) {
    out.info(out.c.dim(`  ${formatCount(stations.length - shown.length)} more: --all`));
  }
  const notes = shown.filter((s) => s.note);
  if (notes.length > 0) {
    out.print();
    for (const s of notes) out.info(out.c.dim(`  ${s.name}: ${s.note}`));
  }
  out.print();
  if (data.stale) out.warn('hydrodaten.admin.ch could not be reached: these values are older.');
  out.info(out.c.dim('  Data: Federal Office for the Environment FOEN (hydrodaten.admin.ch).'));
}

// ---- earthquakes ------------------------------------------------------------------

async function quakes(app: App, opts: Options): Promise<void> {
  const { out } = app;
  const days = Math.min(parsePositiveInt(String(opts.days ?? '7'), '--days'), 3650);
  const min = typeof opts.min === 'string' ? Number(opts.min) : null;
  if (min !== null && !Number.isFinite(min))
    throw new UserError('--min must be a magnitude, e.g. 2.5');
  const radius = parsePositiveNumber(String(opts.radius ?? '50'), '--radius');
  const limit =
    opts.all === true
      ? Number.POSITIVE_INFINITY
      : parsePositiveInt(String(opts.limit ?? '15'), '--limit');
  const progress = new ProgressLine(out);
  let place: Place | null = null;
  let data: Awaited<ReturnType<typeof recentQuakes>>;
  try {
    if (typeof opts.near === 'string') place = await placeFor(app, opts.near, progress);
    progress.update('Asking the Swiss Seismological Service…');
    data = await recentQuakes(app.db(), sourceClient(app, 'seismo'), days, min);
  } finally {
    progress.clear();
  }
  const here = place;
  const events = data.quakes
    .filter((q) => opts.blasts === true || q.type === 'earthquake')
    .map((q) => ({ ...q, km: here ? distanceKm(q, here) : null }))
    .filter((q) => q.km === null || q.km <= radius)
    .sort((a, b) => b.time.localeCompare(a.time));
  const shown = events.slice(0, limit);

  if (out.options.json) {
    out.json({
      days,
      minMagnitude: min,
      near: here?.label ?? null,
      total: events.length,
      events: shown,
      fetchedAt: data.fetchedAt,
      source: 'Swiss Seismological Service (SED)',
    });
    return;
  }
  out.print();
  out.print(
    `  ${out.c.bold(`Earthquakes · last ${days} day${days === 1 ? '' : 's'}`)}${here ? ` · within ${radius} km of ${here.label}` : ''}`,
  );
  out.print(
    `  ${out.c.dim(`${formatCount(events.length)} event${events.length === 1 ? '' : 's'}${min !== null ? ` of magnitude ${min} or more` : ''}, newest first`)}`,
  );
  out.print();
  if (shown.length === 0) {
    out.info('  None recorded.');
    if (min !== null || here) out.hint('Fewer limits: leave out --min or --near, or more --days.');
    return;
  }
  out.table(shown, [
    { header: 'When', value: (q) => measuredAt(q.time) },
    {
      header: 'Mag.',
      value: (q) => (q.magnitude === null ? '–' : q.magnitude.toFixed(1)),
      align: 'right',
      style: (t, q) => ((q.magnitude ?? 0) >= 2.5 ? out.c.red(out.c.bold(t)) : t),
    },
    { header: 'Where', value: (q) => q.place, flex: true },
    {
      header: 'Depth',
      value: (q) => (q.depthKm === null ? '–' : `${Math.max(0, q.depthKm).toFixed(0)} km`),
      align: 'right',
    },
    ...(here
      ? [
          {
            header: 'Distance',
            value: (q: (typeof shown)[number]) => distance(q.km ?? 0),
            align: 'right' as const,
          },
        ]
      : []),
    ...(opts.blasts === true
      ? [{ header: 'Type', value: (q: (typeof shown)[number]) => q.type }]
      : []),
  ]);
  if (shown.length < events.length)
    out.info(out.c.dim(`  ${formatCount(events.length - shown.length)} more: --all`));
  out.print();
  const strongest = [...events].sort((a, b) => (b.magnitude ?? 0) - (a.magnitude ?? 0))[0];
  if (strongest?.magnitude != null) {
    out.print(
      `  Strongest: magnitude ${strongest.magnitude.toFixed(1)}, ${strongest.place}, ${measuredAt(strongest.time)}.`,
    );
  }
  out.info(
    out.c.dim(
      '  From about magnitude 2.5, people nearby may feel a quake. Data: Swiss Seismological Service (SED).',
    ),
  );
}

// ---- snow and avalanches ----------------------------------------------------------

const PROBLEMS: Record<string, string> = {
  new_snow: 'new snow',
  wind_slab: 'wind slabs',
  persistent_weak_layers: 'persistent weak layers',
  wet_snow: 'wet snow',
  gliding_snow: 'gliding snow',
  cornices: 'cornices',
  no_distinct_avalanche_problem: 'no distinct avalanche problem',
  favourable_situation: 'favourable situation',
};

const LEVEL_NAMES: Record<number, string> = {
  1: 'low',
  2: 'moderate',
  3: 'considerable',
  4: 'high',
  5: 'very high',
};

function regionName(region: WarningRegion, lang: string): string {
  return region.names[lang] ?? region.names.en ?? region.names.local ?? region.id;
}

function describeBulletin(out: Output, bulletin: Bulletin): string[] {
  const lines: string[] = [];
  for (const r of bulletin.ratings) {
    const level = r.level ? `${r.level} – ${LEVEL_NAMES[r.level]}` : r.value.replace(/_/g, ' ');
    const when = r.period === 'earlier' ? ' (morning)' : r.period === 'later' ? ' (afternoon)' : '';
    const text = `Danger ${level}${r.elevation ? ` ${r.elevation}` : ''}${when}`;
    lines.push(
      (r.level ?? 0) >= 3
        ? out.c.red(out.c.bold(text))
        : (r.level ?? 0) === 2
          ? out.c.yellow(text)
          : text,
    );
  }
  for (const p of bulletin.problems) {
    const where = [p.elevation, p.aspects.length ? `aspects ${p.aspects.join(', ')}` : null]
      .filter(Boolean)
      .join(', ');
    lines.push(
      `Problem: ${PROBLEMS[p.type] ?? p.type.replace(/_/g, ' ')}${where ? ` (${where})` : ''}`,
    );
  }
  if (bulletin.highlights) lines.push(bulletin.highlights);
  if (bulletin.validUntil)
    lines.push(
      out.c.dim(
        `Valid until ${measuredAt(bulletin.validUntil)}${bulletin.nextUpdate ? `, next update ${measuredAt(bulletin.nextUpdate)}` : ''}`,
      ),
    );
  return lines;
}

const NO_BULLETIN =
  'No avalanche bulletin right now: the SLF publishes it daily in winter (from the first snow, usually November).';

async function snow(app: App, text: string, opts: Options): Promise<void> {
  const { out } = app;
  const count = Math.min(parsePositiveInt(String(opts.stations ?? '3'), '--stations'), 10);
  const lang = textLang(app);
  const db = app.db();
  const http = sourceClient(app, 'slf');
  const progress = new ProgressLine(out);
  let place: Place;
  let readings: {
    station: ReturnType<typeof nearestSnowStations>[number];
    snow: Awaited<ReturnType<typeof latestSnow>>;
  }[];
  let region: WarningRegion | null;
  let bulletin: Bulletin | null = null;
  let bulletinsOut = false;
  try {
    place = await placeFor(app, text, progress);
    progress.update('Loading SLF snow measurements…');
    const stations = nearestSnowStations(await loadSnowStations(db, http), place, count);
    readings = await Promise.all(
      stations.map(async (station) => ({
        station,
        snow: await latestSnow(db, http, station).catch(() => null),
      })),
    );
    progress.update('Loading the avalanche bulletin…');
    region = regionAt(await loadWarningRegions(db, http), place);
    const { bulletins } = await loadBulletins(db, http, lang);
    bulletinsOut = bulletins.length === 0;
    bulletin = region ? bulletinFor(bulletins, region.id) : null;
  } finally {
    progress.clear();
  }

  if (out.options.json) {
    out.json({
      place: { label: place.label, lat: place.lat, lon: place.lon },
      stations: readings.map((r) => ({
        code: r.station.code,
        name: r.station.name,
        elevation: r.station.elevation,
        distanceKm: Math.round(r.station.km * 10) / 10,
        ...r.snow,
      })),
      region: region ? { id: region.id, name: regionName(region, lang) } : null,
      bulletin,
      source: 'WSL Institute for Snow and Avalanche Research SLF',
    });
    return;
  }
  out.print();
  out.print(`  ${out.c.bold(`Snow · ${place.label}`)}`);
  out.print();
  if (readings.length === 0) {
    out.info('  No SLF snow station within 40 km: the stations are in the Alps and the Jura.');
  } else {
    out.table(readings, [
      {
        header: 'Station',
        value: (r) => r.station.name,
        flex: true,
      },
      {
        header: 'Altitude',
        value: (r) => (r.station.elevation === null ? '–' : `${Math.round(r.station.elevation)} m`),
        align: 'right',
      },
      { header: 'Distance', value: (r) => distance(r.station.km), align: 'right' },
      {
        header: 'Snow',
        value: (r) => (r.snow?.depth == null ? '–' : `${r.snow.depth} cm`),
        align: 'right',
        style: (t) => out.c.bold(t),
      },
      {
        header: '24 h',
        value: (r) =>
          r.snow?.change24h == null
            ? ''
            : `${r.snow.change24h > 0 ? '+' : ''}${r.snow.change24h} cm`,
        align: 'right',
      },
      {
        header: 'Air',
        value: (r) => (r.snow?.temperature == null ? '–' : `${r.snow.temperature.toFixed(1)} °C`),
        align: 'right',
      },
      { header: 'Measured', value: (r) => measuredAt(r.snow?.at) },
    ]);
  }
  out.print();
  if (bulletin) {
    out.print(`  ${out.c.bold(`Avalanche bulletin · ${region ? regionName(region, lang) : ''}`)}`);
    for (const line of describeBulletin(out, bulletin)) out.print(`  ${line}`);
  } else if (bulletinsOut) {
    out.info(`  ${NO_BULLETIN}`);
  } else if (region) {
    out.info(`  The avalanche bulletin has no rating for ${regionName(region, lang)}.`);
  }
  out.print();
  out.info(out.c.dim('  Data: WSL Institute for Snow and Avalanche Research SLF.'));
}

async function avalanche(app: App, words: string[], opts: Options): Promise<void> {
  const { out } = app;
  const lang = textLang(app);
  const db = app.db();
  const http = sourceClient(app, 'slf');
  const progress = new ProgressLine(out);
  let place: Place | null = null;
  let regions: WarningRegion[];
  let data: Awaited<ReturnType<typeof loadBulletins>>;
  try {
    if (words.length > 0) place = await placeFor(app, words.join(' '), progress);
    progress.update('Loading the avalanche bulletin…');
    data = await loadBulletins(db, http, lang);
    regions = await loadWarningRegions(db, http);
  } finally {
    progress.clear();
  }
  const region = place ? regionAt(regions, place) : null;
  if (out.options.json) {
    out.json({
      place: place
        ? {
            label: place.label,
            region: region ? { id: region.id, name: regionName(region, lang) } : null,
          }
        : null,
      bulletins: region ? [bulletinFor(data.bulletins, region.id)].filter(Boolean) : data.bulletins,
      fetchedAt: data.fetchedAt,
      source: 'WSL Institute for Snow and Avalanche Research SLF',
    });
    return;
  }
  out.print();
  if (data.bulletins.length === 0) {
    out.info(`  ${NO_BULLETIN}`);
    out.hint('Snow depths are measured all year: swiss snow <place>');
    return;
  }
  if (place) {
    if (!region) {
      out.info(`  ${place.label} is outside the SLF's warning regions.`);
      return;
    }
    const bulletin = bulletinFor(data.bulletins, region.id);
    out.print(
      `  ${out.c.bold(`Avalanche bulletin · ${regionName(region, lang)}`)} ${out.c.dim(`(${place.label})`)}`,
    );
    out.print();
    if (!bulletin) {
      out.info('  No rating for this region today.');
    } else {
      for (const line of describeBulletin(out, bulletin)) out.print(`  ${line}`);
    }
  } else {
    // The whole country: the regions by their highest danger level.
    const byLevel = new Map<number, string[]>();
    for (const bulletin of data.bulletins) {
      const level = highestLevel(bulletin);
      if (level === null) continue;
      const names = bulletin.regions.map((r) => {
        const known = regions.find((g) => g.id === r.id.replace(/^CH-/, ''));
        return known ? regionName(known, lang) : r.name;
      });
      byLevel.set(level, [...(byLevel.get(level) ?? []), ...names]);
    }
    out.print(`  ${out.c.bold('Avalanche danger in Switzerland')}`);
    out.print();
    for (const level of [...byLevel.keys()].sort((a, b) => b - a)) {
      const names = byLevel.get(level) ?? [];
      const label = `${level} – ${LEVEL_NAMES[level]}`;
      out.print(
        `  ${level >= 3 ? out.c.red(out.c.bold(label)) : level === 2 ? out.c.yellow(label) : label}: ${formatCount(names.length)} region${names.length === 1 ? '' : 's'}`,
      );
      if (level >= 3 || opts.all === true) out.print(out.c.dim(`     ${names.join(', ')}`));
    }
    out.print();
    out.hint('One place in detail: swiss avalanche <place>');
  }
  out.print();
  out.info(
    out.c.dim(
      '  Data: WSL Institute for Snow and Avalanche Research SLF. Always check slf.ch before a tour.',
    ),
  );
}

export function registerNatureCommands(program: Command): void {
  program
    .command('rivers')
    .alias('lakes')
    .summary('water temperature, flow and flood danger of rivers and lakes')
    .description(
      'Water temperature, flow (lakes: level) and flood danger at the FOEN measuring stations, every 10 minutes.',
    )
    .argument('[name...]', 'a river or lake, e.g. aare or "lac léman"')
    .option('--near <place>', 'the stations nearest to a place')
    .option('-n, --limit <count>', 'how many stations to show', '20')
    .option('-a, --all', 'show every station')
    .option('--json', 'machine-readable output')
    .addHelpText('after', RIVERS_EXAMPLES)
    .action(async (words: string[], opts: Options, command: Command) => {
      const app = new App(command.optsWithGlobals<GlobalOptions>(), opts.json === true);
      try {
        await rivers(app, words, opts);
      } finally {
        app.close();
      }
    });

  program
    .command('aare')
    .summary('the Aare: water temperature and flow, Bern first')
    .description('The Aare from Brienz to the Rhine: water temperature and flow, Bern first.')
    .option('--json', 'machine-readable output')
    .action(async (opts: Options, command: Command) => {
      const app = new App(command.optsWithGlobals<GlobalOptions>(), opts.json === true);
      try {
        await rivers(app, ['Aare'], { ...opts, all: true }, 'Bern');
      } finally {
        app.close();
      }
    });

  program
    .command('quakes')
    .alias('earthquakes')
    .summary('recent earthquakes in and around Switzerland')
    .description(
      'Recent earthquakes in and around Switzerland recorded by the Swiss Seismological Service.',
    )
    .option('--days <count>', 'how many days back', '7')
    .option('--min <magnitude>', 'only from this magnitude, e.g. 2.5')
    .option('--near <place>', 'only around a place')
    .option('--radius <km>', 'with --near: how far around', '50')
    .option('--blasts', 'also quarry blasts and other non-earthquake events')
    .option('-n, --limit <count>', 'how many to show', '15')
    .option('-a, --all', 'show every event')
    .option('--json', 'machine-readable output')
    .addHelpText('after', QUAKES_EXAMPLES)
    .action(async (opts: Options, command: Command) => {
      const app = new App(command.optsWithGlobals<GlobalOptions>(), opts.json === true);
      try {
        await quakes(app, opts);
      } finally {
        app.close();
      }
    });

  program
    .command('snow')
    .summary('snow depth at the nearest SLF stations and the avalanche danger')
    .description(
      'Snow depth now and over the last 24 hours at the SLF stations nearest to a place, and the avalanche bulletin for it.',
    )
    .argument('<place...>', 'postcode, municipality, mountain or address, e.g. Davos')
    .option('--stations <count>', 'how many stations to show', '3')
    .option('--json', 'machine-readable output')
    .addHelpText('after', SNOW_EXAMPLES)
    .action(async (words: string[], opts: Options, command: Command) => {
      const app = new App(command.optsWithGlobals<GlobalOptions>(), opts.json === true);
      try {
        await snow(app, words.join(' '), opts);
      } finally {
        app.close();
      }
    });

  program
    .command('avalanche')
    .alias('avalanches')
    .summary('the SLF avalanche bulletin, for a place or the whole country')
    .description(
      'The avalanche bulletin of the SLF: the danger level, the avalanche problems and where they are.',
    )
    .argument('[place...]', 'a place in the Alps or the Jura (default: the whole country)')
    .option('-a, --all', 'list every region')
    .option('--json', 'machine-readable output')
    .addHelpText('after', SNOW_EXAMPLES)
    .action(async (words: string[], opts: Options, command: Command) => {
      const app = new App(command.optsWithGlobals<GlobalOptions>(), opts.json === true);
      try {
        await avalanche(app, words, opts);
      } finally {
        app.close();
      }
    });
}
