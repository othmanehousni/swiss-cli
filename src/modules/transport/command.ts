import type { Command } from 'commander';
import {
  App,
  type GlobalOptions,
  parsePositiveInt,
  sourceClient,
  UserError,
} from '../../commands/shared.js';
import type { HttpClient } from '../../crawler/http.js';
import type { Database } from '../../storage/database.js';
import { type Output, ProgressLine, visibleLength } from '../../ui/output.js';
import {
  formatClock,
  formatDayLong,
  formatMinutes,
  parseClock,
  parseDay,
  zurichMoment,
} from '../../util/when.js';
import { PlaceNotFoundError, resolvePlace } from '../places/resolve.js';
import {
  type BoardEntry,
  connectionsUrl,
  findLocations,
  findStop,
  findTrips,
  type Leg,
  type StopTime,
  stationboard,
  stationboardUrl,
  type Trip,
} from './api.js';

const TRAIN_EXAMPLES = `
Examples:
  $ swiss train Lausanne "Zürich HB"                   the next connections
  $ swiss train Lausanne Zürich --at 7:30 --date tomorrow
  $ swiss train Bern Genève --at 18:00 --arrive        arrive by 18:00
  $ swiss train Basel Lugano --via Luzern
  $ swiss train "Bahnhofstrasse 1, Zürich" 3920        from an address to a postcode
  $ swiss train Lausanne Genève --type train -n 8

Times are Swiss time. Real-time delays and platform changes are shown when known.
Timetables: transport.opendata.ch (Swiss public transport open data).`;

const DEPARTURES_EXAMPLES = `
Examples:
  $ swiss departures Bern
  $ swiss departures "Lausanne, gare" --type tram,bus
  $ swiss departures Zürich HB --at 7:30 --date friday -n 30
  $ swiss departures 8001                              the stop nearest to a postcode

Timetables: transport.opendata.ch (Swiss public transport open data).`;

const TYPES: Record<string, string> = {
  train: 'train',
  trains: 'train',
  tram: 'tram',
  trams: 'tram',
  bus: 'bus',
  buses: 'bus',
  ship: 'ship',
  boat: 'ship',
  boats: 'ship',
  cableway: 'cableway',
  'cable-car': 'cableway',
  gondola: 'cableway',
};

export function parseTypes(value: string): string[] {
  const types: string[] = [];
  for (const name of value
    .split(',')
    .map((t) => t.trim().toLowerCase())
    .filter(Boolean)) {
    const type = TYPES[name];
    if (!type) {
      throw new UserError(`Unknown type "${name}".`, ['Use train, tram, bus, ship or cableway.']);
    }
    if (!types.includes(type)) types.push(type);
  }
  return types;
}

/** --date and --at, as the timetable wants them. */
export function parseWhen(
  opts: { date?: string; at?: string },
  now: number = Date.now(),
): { date?: string; time?: string } {
  const date = opts.date === undefined ? undefined : parseDay(opts.date, now);
  if (date === null) {
    throw new UserError(`"${opts.date}" is not a day I know.`, [
      'Use today, tomorrow, a weekday (friday), 27.10. or 2026-10-27',
    ]);
  }
  const time = opts.at === undefined ? undefined : parseClock(opts.at);
  if (time === null) throw new UserError(`"${opts.at}" is not a time.`, ['Use e.g. 7:30 or 18:05']);
  return {
    ...(date ? { date } : {}),
    // A day without a time means from the start of it, unless it is today.
    ...(time ? { time } : date && date !== zurichMoment(now).date ? { time: '00:00' } : {}),
  };
}

/** "07:34", "07:34 +3'" when late. */
function clock(out: Output, stop: StopTime): string {
  if (stop.time === null) return '–';
  const time = formatClock(stop.time);
  if (!stop.delay || stop.delay <= 0) return time;
  const late = `+${stop.delay}'`;
  return `${time} ${stop.delay >= 3 ? out.c.red(late) : out.c.yellow(late)}`;
}

function platform(out: Output, stop: StopTime, word = 'platform'): string {
  if (stop.newPlatform) return out.c.yellow(`${word} ${stop.newPlatform} (changed)`);
  return stop.platform ? `${word} ${stop.platform}` : '';
}

function transfers(trip: Trip): string {
  return trip.transfers === 0
    ? 'direct'
    : `${trip.transfers} change${trip.transfers === 1 ? '' : 's'}`;
}

function rides(trip: Trip): Leg[] {
  return trip.legs.filter((l) => l.line !== null);
}

function padVisible(text: string, width: number): string {
  return text + ' '.repeat(Math.max(0, width - visibleLength(text)));
}

function printTrip(out: Output, trip: Trip): void {
  const lines = rides(trip).map((l) => l.line);
  out.print(
    `  ${out.c.bold(`${clock(out, trip.departure)} → ${clock(out, trip.arrival)}`)}   ` +
      `${trip.minutes === null ? '' : formatMinutes(trip.minutes)}   ${transfers(trip)}   ${out.c.dim(lines.join(', '))}`,
  );
  // One row per stop of the trip: time, stop, platform, then what happens there.
  const rows: [StopTime, string, string][] = [];
  trip.legs.forEach((leg, i) => {
    if (leg.line === null) {
      rows.push([leg.departure, '', out.c.dim(`walk ${leg.walkMinutes ?? 1} min`)]);
      return;
    }
    rows.push([
      leg.departure,
      platform(out, leg.departure),
      `${leg.line}${leg.direction ? ` → ${leg.direction}` : ''}`,
    ]);
    const next = trip.legs[i + 1];
    const change =
      next?.line && next.departure.time !== null && leg.arrival.time !== null
        ? out.c.dim(`change: ${Math.round((next.departure.time - leg.arrival.time) / 60)} min`)
        : '';
    rows.push([leg.arrival, platform(out, leg.arrival), change]);
  });
  const nameWidth = Math.max(...rows.map(([stop]) => visibleLength(stop.name)));
  const platformWidth = Math.max(...rows.map(([, where]) => visibleLength(where)));
  for (const [stop, where, what] of rows) {
    out.print(
      `     ${padVisible(clock(out, stop), 5)}  ${padVisible(stop.name, nameWidth)}  ${padVisible(where, platformWidth)}  ${what}`.trimEnd(),
    );
  }
}

function dayOf(stop: StopTime): string | null {
  return stop.time === null ? null : zurichMoment(stop.time * 1000).date;
}

function staleNote(out: Output, stale: boolean, fetchedAt: string): void {
  if (stale) {
    out.warn(
      `transport.opendata.ch could not be reached: this is the timetable from ${formatClock(Date.parse(fetchedAt) / 1000)}.`,
    );
  }
}

const iso = (seconds: number | null) =>
  seconds === null ? null : new Date(seconds * 1000).toISOString();

function stopJson(s: StopTime) {
  return {
    name: s.name,
    time: iso(s.time),
    expected: iso(s.expected),
    delayMinutes: s.delay,
    platform: s.newPlatform ?? s.platform,
    platformChanged: s.newPlatform !== null,
  };
}

function tripJson(trip: Trip) {
  return {
    departure: stopJson(trip.departure),
    arrival: stopJson(trip.arrival),
    minutes: trip.minutes,
    transfers: trip.transfers,
    legs: trip.legs.map((l) => ({
      line: l.line,
      operator: l.operator,
      direction: l.direction,
      walkMinutes: l.walkMinutes,
      stops: l.stops,
      departure: stopJson(l.departure),
      arrival: stopJson(l.arrival),
    })),
  };
}

/**
 * Where an address or postcode is, as "lat,lon" for the timetable (whose own search
 * does not know every address); null when no place matches.
 */
async function coordinates(db: Database, http: HttpClient, text: string): Promise<string | null> {
  try {
    const { place } = await resolvePlace(db, http, text);
    return `${place.lat.toFixed(6)},${place.lon.toFixed(6)}`;
  } catch (error) {
    if (error instanceof PlaceNotFoundError) return null;
    throw error;
  }
}

export function registerTransportCommands(program: Command): void {
  program
    .command('train')
    .alias('trip')
    .summary('public transport connections from one place to another')
    .description(
      'The next connections by train, tram, bus, boat and cable car between two stops, ' +
        'addresses or postcodes, with real-time delays and platforms.',
    )
    .argument('<from>', 'stop, address or postcode, e.g. Lausanne or "Zürich HB"')
    .argument('<to>', 'stop, address or postcode')
    .option('--at <time>', 'when to leave, e.g. 7:30 (default: now)')
    .option('--date <day>', 'today, tomorrow, a weekday, 27.10. or 2026-10-27')
    .option('--arrive', 'arrive by --at instead of leaving at it')
    .option(
      '--via <stop>',
      'travel via this stop (twice for two stops)',
      (value: string, previous: string[]) => [...previous, value],
      [] as string[],
    )
    .option('-t, --type <types>', 'only these: train, tram, bus, ship, cableway')
    .option('-n, --limit <count>', 'how many connections (up to 16)', '4')
    .option('--json', 'machine-readable output')
    .addHelpText('after', TRAIN_EXAMPLES)
    .action(
      async (
        from: string,
        to: string,
        opts: Record<string, string | string[] | boolean | undefined>,
        command: Command,
      ) => {
        const app = new App(command.optsWithGlobals<GlobalOptions>(), opts.json === true);
        try {
          await train(app, from, to, opts);
        } finally {
          app.close();
        }
      },
    );

  program
    .command('departures')
    .alias('board')
    .summary('the departure board of a stop')
    .description('The next departures from a stop, with real-time delays and platforms.')
    .argument('<stop...>', 'stop, address or postcode, e.g. Bern or "Lausanne, gare"')
    .option('--at <time>', 'from this time, e.g. 7:30 (default: now)')
    .option('--date <day>', 'today, tomorrow, a weekday, 27.10. or 2026-10-27')
    .option('-t, --type <types>', 'only these: train, tram, bus, ship, cableway')
    .option('-n, --limit <count>', 'how many departures', '15')
    .option('--json', 'machine-readable output')
    .addHelpText('after', DEPARTURES_EXAMPLES)
    .action(
      async (
        words: string[],
        opts: Record<string, string | boolean | undefined>,
        command: Command,
      ) => {
        const app = new App(command.optsWithGlobals<GlobalOptions>(), opts.json === true);
        try {
          await departures(app, words.join(' '), opts);
        } finally {
          app.close();
        }
      },
    );
}

async function train(
  app: App,
  from: string,
  to: string,
  opts: Record<string, string | string[] | boolean | undefined>,
): Promise<void> {
  const { out } = app;
  const when = parseWhen({
    ...(typeof opts.date === 'string' ? { date: opts.date } : {}),
    ...(typeof opts.at === 'string' ? { at: opts.at } : {}),
  });
  const via = Array.isArray(opts.via) ? opts.via : [];
  if (via.length > 2) throw new UserError('At most two --via stops.');
  if (opts.arrive === true && !when.time) {
    throw new UserError('--arrive needs a time: --at 18:00 --arrive');
  }
  const limit = parsePositiveInt(String(opts.limit ?? '4'), '--limit');
  const query = {
    from,
    to,
    via,
    ...when,
    arrive: opts.arrive === true,
    limit: Math.min(limit, 16),
    ...(typeof opts.type === 'string' ? { transportations: parseTypes(opts.type) } : {}),
  };
  const db = app.db();
  const http = sourceClient(app, 'transport');
  const progress = new ProgressLine(out);
  progress.update('Asking the timetable…');
  let result: Awaited<ReturnType<typeof findTrips>>;
  try {
    result = await findTrips(db, http, query);
    if (!result.value.from || !result.value.to) {
      const start = result.value.from ? from : await coordinates(db, http, from);
      const end = result.value.to ? to : await coordinates(db, http, to);
      if (start === null) throw new UserError(`No stop, address or place matches "${from}".`);
      if (end === null) throw new UserError(`No stop, address or place matches "${to}".`);
      query.from = start;
      query.to = end;
      result = await findTrips(db, http, query);
    }
  } finally {
    progress.clear();
  }
  const { trips } = result.value;
  // With --via, the timetable names the via stop as the destination: the trips know better.
  const fromName = trips[0]?.departure.name || result.value.from?.name || from;
  const toName = trips[0]?.arrival.name || to;

  if (out.options.json) {
    out.json({
      from: fromName,
      to: toName,
      via,
      trips: trips.map(tripJson),
      source: connectionsUrl(query),
      fetchedAt: result.fetchedAt,
    });
    return;
  }
  const day = when.date ?? zurichMoment(Date.now()).date;
  const moment = when.time
    ? `${opts.arrive === true ? 'arriving by' : 'leaving from'} ${when.time}`
    : 'leaving now';
  out.print();
  out.print(
    `  ${out.c.bold(`${fromName} → ${toName}`)}${via.length ? out.c.dim(` via ${via.join(', ')}`) : ''}`,
  );
  out.print(`  ${out.c.dim(`${formatDayLong(day)} · ${moment}`)}`);
  out.print();
  staleNote(out, result.stale, result.fetchedAt);
  if (trips.length === 0) {
    out.info('  No connections found.');
    out.hint('Try another time or day (--at, --date), or fewer filters.');
    return;
  }
  let shownDay = day;
  for (const trip of trips) {
    const tripDay = dayOf(trip.departure);
    if (tripDay && tripDay !== shownDay) {
      out.print(`  ${out.c.dim(formatDayLong(tripDay))}`);
      shownDay = tripDay;
    }
    printTrip(out, trip);
    out.print();
  }
  out.info(out.c.dim('  Timetable: transport.opendata.ch'));
}

async function departures(
  app: App,
  text: string,
  opts: Record<string, string | boolean | undefined>,
): Promise<void> {
  const { out } = app;
  const when = parseWhen({
    ...(typeof opts.date === 'string' ? { date: opts.date } : {}),
    ...(typeof opts.at === 'string' ? { at: opts.at } : {}),
  });
  const limit = parsePositiveInt(String(opts.limit ?? '15'), '--limit');
  const transportations = typeof opts.type === 'string' ? parseTypes(opts.type) : undefined;
  const db = app.db();
  const http = sourceClient(app, 'transport');
  const progress = new ProgressLine(out);
  progress.update('Asking the timetable…');
  let stop: Awaited<ReturnType<typeof findStop>>;
  let board: Awaited<ReturnType<typeof stationboard>>;
  let query: Parameters<typeof stationboardUrl>[0];
  try {
    stop = await findStop(db, http, text);
    if (!stop) {
      // An address the timetable does not know: the stop nearest to it.
      const point = await coordinates(db, http, text);
      const [lat, lon] = (point ?? '').split(',').map(Number);
      stop =
        point && lat !== undefined && lon !== undefined
          ? ((await findLocations(db, http, { lat, lon })).find((l) => l.id) ?? null)
          : null;
    }
    if (!stop) {
      throw new UserError(`No stop matches "${text}".`, [
        'Check the spelling, e.g. "Lausanne, gare".',
      ]);
    }
    query = { stop, ...when, limit, ...(transportations ? { transportations } : {}) };
    board = await stationboard(db, http, query);
  } finally {
    progress.clear();
  }
  const entries = board.value.entries.slice(0, limit);
  const name = board.value.stop?.name ?? stop.name;

  if (out.options.json) {
    out.json({
      stop: board.value.stop ?? stop,
      departures: entries.map((e) => ({
        line: e.line,
        operator: e.operator,
        direction: e.direction,
        ...stopJson(e.departure),
      })),
      source: stationboardUrl(query),
      fetchedAt: board.fetchedAt,
    });
    return;
  }
  const day = when.date ?? zurichMoment(Date.now()).date;
  out.print();
  out.print(`  ${out.c.bold(`Departures · ${name}`)}`);
  out.print(
    `  ${out.c.dim(`${formatDayLong(day)} · ${when.time ? `from ${when.time}` : 'from now'}`)}`,
  );
  out.print();
  staleNote(out, board.stale, board.fetchedAt);
  if (entries.length === 0) {
    out.info('  No departures found.');
    if (transportations) out.hint('Leave out --type to see every departure.');
    return;
  }
  out.table(entries, [
    { header: 'Time', value: (e: BoardEntry) => clock(out, e.departure) },
    { header: 'Line', value: (e) => e.line },
    { header: 'To', value: (e) => e.direction ?? '', flex: true },
    { header: 'Platform', value: (e) => platform(out, e.departure, '').trim() },
  ]);
  out.print();
  out.info(out.c.dim('  Timetable: transport.opendata.ch'));
}
