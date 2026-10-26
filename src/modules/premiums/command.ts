import type { Command } from 'commander';
import {
  App,
  type GlobalOptions,
  parsePositiveInt,
  sourceClient,
  UserError,
} from '../../commands/shared.js';
import type { HttpClient } from '../../crawler/http.js';
import { looseKey } from '../../normalization/text.js';
import { formatCount } from '../../ui/format.js';
import { type Output, ProgressLine } from '../../ui/output.js';
import { type Place, resolvePlace } from '../places/resolve.js';
import {
  AGE_GROUP_LABELS,
  type AgeGroup,
  ageGroup,
  COPAY_CAP,
  calculatorUrl,
  DEDUCTIBLES,
  findDeductibles,
  findHistory,
  findLocation,
  findOffers,
  loadLocations,
  MODEL_LABELS,
  MODELS,
  type Model,
  type Offer,
  type PageInfo,
  type Person,
  premiumYear,
  type Query,
} from './priminfo.js';

const EXAMPLES = `
Examples:
  $ swiss premiums 8001 --age 34                     every plan for a 34-year-old in Zürich
  $ swiss premiums Lausanne --age 34 -d 2500         with the highest deductible
  $ swiss premiums 3920 --born 2015                  a child's premiums
  $ swiss premiums 8001 --age 34 --no-accident       accident cover through your employer
  $ swiss premiums 8001 --age 34 --model standard    only free choice of doctor
  $ swiss premiums 8001 --age 34 --current css       what switching from CSS saves
  $ swiss premiums 8001 --age 34 --deductibles       compare every deductible
  $ swiss premiums 8001 --age 34 --history           standard premiums since 2022

Models (cheaper than standard, in exchange for a first point of contact):
  standard   free choice of doctor
  doctor     family doctor or HMO practice first
  telmed     a medical hotline or app first
  flex       a choice of the above, depending on the plan
  pharmacy   a pharmacy first

Premiums come from priminfo.admin.ch, the federal premium calculator. Every bill is
lowered by the environmental levy refund, the same amount for everyone.`;

const MODEL_ALIASES: Record<string, Model> = {
  standard: 'standard',
  base: 'standard',
  free: 'standard',
  doctor: 'doctor',
  hmo: 'doctor',
  'family-doctor': 'doctor',
  praxis: 'doctor',
  hausarzt: 'doctor',
  telmed: 'telmed',
  tel: 'telmed',
  telemedicine: 'telmed',
  digital: 'telmed',
  flex: 'flex',
  pharmacy: 'pharmacy',
  pharm: 'pharmacy',
  apotheke: 'pharmacy',
};

export function parseModels(value: string): Model[] {
  const models: Model[] = [];
  for (const name of value
    .split(',')
    .map((m) => m.trim().toLowerCase())
    .filter(Boolean)) {
    const model = MODEL_ALIASES[name];
    if (!model) {
      throw new UserError(`Unknown model "${name}".`, [`Use one of: ${MODELS.join(', ')}`]);
    }
    if (!models.includes(model)) models.push(model);
  }
  if (models.length === 0) throw new UserError('--model needs a model, e.g. --model telmed.');
  return models;
}

/** The year of birth from --born or --age (an adult when neither is given). */
export function parseBirthYear(
  options: { born?: string; age?: string },
  year: number,
  now: Date = new Date(),
): { born: number; assumed: boolean } {
  const thisYear = now.getUTCFullYear();
  if (options.born !== undefined) {
    const born = Number(options.born);
    if (!Number.isInteger(born) || born < thisYear - 120 || born > year) {
      throw new UserError(`--born must be a year of birth, e.g. 1990 (got "${options.born}").`);
    }
    return { born, assumed: false };
  }
  if (options.age !== undefined) {
    const age = Number(options.age);
    if (!Number.isInteger(age) || age < 0 || age > 120) {
      throw new UserError(`--age must be an age in years, e.g. 34 (got "${options.age}").`);
    }
    return { born: thisYear - age, assumed: false };
  }
  return { born: year - 35, assumed: true };
}

const FOR_GROUP: Record<AgeGroup, string> = {
  child: 'for children (0–18)',
  young: 'for young adults (19–25)',
  adult: 'for adults (26+)',
};

export function parseDeductible(value: string | undefined, group: AgeGroup): number {
  const allowed = DEDUCTIBLES[group];
  if (value === undefined) return allowed[0] as number;
  const amount = Number(value.replace(/['’]/g, ''));
  if (!allowed.includes(amount)) {
    throw new UserError(`CHF ${value} is not a deductible ${FOR_GROUP[group]}.`, [
      `Choose one of: ${allowed.join(', ')}`,
    ]);
  }
  return amount;
}

/** Finds insurers by name ("css", "groupe mutuel"); several names are comma-separated. */
export function matchInsurers(value: string, insurers: string[]): string[] {
  const found: string[] = [];
  for (const name of value
    .split(',')
    .map((n) => n.trim())
    .filter(Boolean)) {
    const key = looseKey(name);
    const exact = insurers.filter((i) => looseKey(i) === key);
    const partial = insurers.filter((i) => looseKey(i).includes(key) || key.includes(looseKey(i)));
    const matches = exact.length > 0 ? exact : partial;
    if (matches.length === 0) {
      throw new UserError(`No insurer called "${name}" offers plans here.`, [
        `Insurers here: ${[...insurers].sort((a, b) => a.localeCompare(b)).join(', ')}`,
      ]);
    }
    for (const match of matches) if (!found.includes(match)) found.push(match);
  }
  return found;
}

/** The last weekday of November before the premium year: a notice to switch must arrive by then. */
export function switchDeadline(year: number): Date {
  const day = new Date(Date.UTC(year - 1, 10, 30));
  while (day.getUTCDay() === 0 || day.getUTCDay() === 6) day.setUTCDate(day.getUTCDate() - 1);
  return day;
}

function formatLongDate(date: Date): string {
  const part = (options: Intl.DateTimeFormatOptions) =>
    new Intl.DateTimeFormat('en-GB', { ...options, timeZone: 'UTC' }).format(date);
  return `${part({ weekday: 'long' })} ${part({ day: 'numeric' })} ${part({ month: 'long' })} ${date.getUTCFullYear()}`;
}

/**
 * With bills of CHF `costs` in a year, what a person pays out of pocket: the deductible
 * first, then 10% of the rest up to the yearly maximum.
 */
function outOfPocket(costs: number, deductible: number, cap: number): number {
  return Math.min(costs, deductible) + Math.min(0.1 * Math.max(costs - deductible, 0), cap);
}

/**
 * The medical bills per year above which the lower deductible becomes cheaper, given
 * what the higher one saves in premiums; null when the higher one always pays off.
 */
export function breakEven(
  low: number,
  high: number,
  savedPerYear: number,
  cap: number,
): number | null {
  for (let costs = 0; costs <= 50_000; costs += 10) {
    if (outOfPocket(costs, high, cap) - outOfPocket(costs, low, cap) >= savedPerYear) return costs;
  }
  return null;
}

const chf = (value: number) => value.toFixed(2);
const chfRound = (value: number) => formatCount(Math.round(value));

interface Context {
  app: App;
  http: HttpClient;
  place: Place;
  alternatives: Place[];
  info: PageInfo | null;
  person: Person;
  group: AgeGroup;
  query: Query;
}

function printHeader(out: Output, ctx: Context, title: string, details: string[]): void {
  const region = ctx.info && ctx.info.region > 0 ? `, premium region ${ctx.info.region}` : '';
  const canton = ctx.place.canton ?? ctx.info?.canton ?? '';
  const where =
    ctx.info &&
    ctx.place.municipality &&
    looseKey(ctx.info.municipality) !== looseKey(ctx.place.municipality)
      ? ` · priced as ${ctx.info.municipality}`
      : '';
  out.print();
  out.print(`  ${out.c.bold(title)} · ${ctx.place.label} (${canton}${region})${where}`);
  out.print(`  ${out.c.dim(details.join(' · '))}`);
  out.print();
}

function personDetails(ctx: Context, assumed: boolean): string {
  const label = AGE_GROUP_LABELS[ctx.group];
  return assumed ? `${label}, assumed (use --age)` : `${label}, born ${ctx.person.born}`;
}

function printAlternatives(out: Output, ctx: Context): void {
  if (ctx.alternatives.length === 0) return;
  const names = ctx.alternatives.map((a) => a.municipality ?? a.label);
  out.info(
    out.c.dim(
      `  ${ctx.place.postcode} also covers ${names.join(', ')}; premiums can differ there: ` +
        `swiss premiums "${names[0]}"`,
    ),
  );
}

function printSource(out: Output, stale: boolean, fetchedAt: string): void {
  out.info(
    out.c.dim(
      `  Source: priminfo.admin.ch, the premium calculator of the Federal Office of Public Health${
        stale ? ` (offline: answer from ${fetchedAt.slice(0, 10)})` : ''
      }`,
    ),
  );
}

export function registerPremiumsCommand(program: Command): void {
  program
    .command('premiums')
    .alias('insurance')
    .summary('health insurance premiums: every insurer and plan for your place and age')
    .description(
      'Compare the premiums of the basic health insurance (KVG/LAMal) of every insurer for a ' +
        'place, age, deductible and accident cover, cheapest first.',
    )
    .argument('<place...>', 'postcode, municipality or address, e.g. 8001 or Lausanne')
    .option('--age <years>', 'age today (default: an adult)')
    .option('--born <year>', 'year of birth, instead of --age')
    .option(
      '-d, --deductible <chf>',
      'yearly deductible: 300, 500, 1000, 1500, 2000 or 2500 (children: 0 to 600)',
    )
    .option('--no-accident', 'without accident cover (you work 8+ hours a week for one employer)')
    .option('-m, --model <models>', `only these models: ${MODELS.join(', ')}`)
    .option('-i, --insurer <names>', 'only these insurers, comma-separated')
    .option('--current <insurer>', 'your insurer now: shows what switching saves')
    .option('--deductibles', 'compare the premiums at every deductible')
    .option('--history', "each insurer's standard premium since 2022")
    .option('-n, --limit <count>', 'how many plans to show', '15')
    .option('-a, --all', 'show every plan')
    .option('--json', 'machine-readable output')
    .addHelpText('after', EXAMPLES)
    .action(
      async (
        words: string[],
        opts: Record<string, string | boolean | undefined>,
        command: Command,
      ) => {
        const app = new App(command.optsWithGlobals<GlobalOptions>(), opts.json === true);
        try {
          await premiums(app, words.join(' '), opts);
        } finally {
          app.close();
        }
      },
    );
}

async function premiums(
  app: App,
  text: string,
  opts: Record<string, string | boolean | undefined>,
): Promise<void> {
  const { out } = app;
  const year = premiumYear();
  const { born, assumed } = parseBirthYear(
    {
      ...(typeof opts.born === 'string' ? { born: opts.born } : {}),
      ...(typeof opts.age === 'string' ? { age: opts.age } : {}),
    },
    year,
  );
  const group = ageGroup(born, year);
  const deductible = parseDeductible(
    typeof opts.deductible === 'string' ? opts.deductible : undefined,
    group,
  );
  const models = typeof opts.model === 'string' ? parseModels(opts.model) : [...MODELS];
  const limit =
    opts.all === true
      ? Number.POSITIVE_INFINITY
      : parsePositiveInt(String(opts.limit ?? '15'), '--limit');
  const person: Person = { born, deductible, accident: opts.accident !== false };

  const db = app.db();
  const http = sourceClient(app, 'premiums');
  const progress = new ProgressLine(out);
  try {
    progress.update('Finding the place…');
    const { place, alternatives } = await resolvePlace(db, http, text);
    progress.update('Asking priminfo.admin.ch…');
    const location = findLocation(await loadLocations(db, http), place);
    if (!location) {
      throw new UserError(`The premium calculator does not know ${place.label}.`, [
        'Try the postcode or the municipality, e.g. swiss premiums 8001',
      ]);
    }
    const query: Query = { lang: app.langFor(), location: location.id, person };
    const ctx: Context = { app, http, place, alternatives, info: null, person, group, query };
    if (opts.deductibles !== true && opts.history !== true) {
      await showOffers(ctx, models, opts, limit, assumed, progress);
      return;
    }
    // One JSON document, also when both views are asked for.
    const json: Record<string, unknown> = {};
    if (opts.deductibles === true) {
      json.deductibles = await showDeductibles(ctx, models, opts, limit, progress);
    }
    if (opts.history === true) json.history = await showHistory(ctx, opts, progress);
    if (out.options.json) out.json(Object.keys(json).length === 1 ? Object.values(json)[0] : json);
  } finally {
    progress.clear();
  }
}

async function showOffers(
  ctx: Context,
  models: Model[],
  opts: Record<string, string | boolean | undefined>,
  limit: number,
  assumed: boolean,
  progress: ProgressLine,
): Promise<void> {
  const { app, person } = ctx;
  const { out } = app;
  const result = await findOffers(app.db(), ctx.http, ctx.query, models);
  progress.clear();
  ctx.info = result.info;
  const insurers = [...new Set(result.offers.map((o) => o.insurer))];
  const only = typeof opts.insurer === 'string' ? matchInsurers(opts.insurer, insurers) : null;
  const mine = typeof opts.current === 'string' ? currentInsurer(opts.current, insurers) : null;
  const offers = only ? result.offers.filter((o) => only.includes(o.insurer)) : result.offers;
  const shown = offers.slice(0, limit);
  const year = result.info?.year ?? premiumYear();

  if (out.options.json) {
    out.json({
      year,
      place: {
        label: ctx.place.label,
        postcode: ctx.place.postcode,
        municipality: result.info?.municipality ?? ctx.place.municipality,
        canton: ctx.place.canton,
        region: result.info?.region ?? null,
      },
      person: {
        born: person.born,
        ageGroup: ctx.group,
        deductible: person.deductible,
        accident: person.accident,
      },
      total: offers.length,
      offers: shown.map((o, i) => ({
        rank: i + 1,
        insurer: o.insurer,
        plan: o.plan,
        model: o.model,
        premiumPerMonth: o.premium,
        premiumPerYear: Math.round(o.premium * 1200) / 100,
        refundPerMonth: o.refund,
        website: o.website,
      })),
      source: calculatorUrl(ctx.query, 'savings', models),
      fetchedAt: result.fetchedAt,
    });
    return;
  }

  const insurerCount = new Set(offers.map((o) => o.insurer)).size;
  printHeader(out, ctx, `Health insurance ${year}`, [
    personDetails(ctx, assumed),
    `deductible CHF ${person.deductible}`,
    person.accident ? 'with accident cover' : 'without accident cover',
    `${formatCount(offers.length)} plan${offers.length === 1 ? '' : 's'} from ${formatCount(insurerCount)} insurer${insurerCount === 1 ? '' : 's'}`,
  ]);
  if (offers.length === 0) {
    out.info(
      `  No plans${models.length < MODELS.length ? ` of the model ${models.join(', ')}` : ''} here.`,
    );
    out.hint(`Leave out --model${only ? ' or --insurer' : ''} to see every plan.`);
    return;
  }
  const highlight = (text: string, o: Offer) => (o.insurer === mine ? out.c.cyan(text) : text);
  out.table(shown, [
    { header: '#', value: (o) => String(offers.indexOf(o) + 1), align: 'right' },
    { header: 'Insurer', value: (o) => o.insurer, style: highlight },
    { header: 'Plan', value: (o) => o.plan, flex: true, style: highlight },
    { header: 'Model', value: (o) => MODEL_LABELS[o.model] },
    { header: 'CHF/month', value: (o) => chf(o.premium), align: 'right' },
    { header: 'CHF/year', value: (o) => chf(o.premium * 12), align: 'right' },
  ]);
  if (shown.length < offers.length) {
    out.info(
      out.c.dim(
        `  ${formatCount(offers.length - shown.length)} more: --limit ${Math.min(offers.length, shown.length * 3)} or --all`,
      ),
    );
  }
  out.print();

  const cheapest = offers[0] as Offer;
  const standard = offers.find((o) => o.model === 'standard');
  if (standard && cheapest.model !== 'standard') {
    out.print(
      `  Cheapest with free choice of doctor: ${standard.insurer} ${standard.plan}, CHF ${chf(standard.premium)} a month.`,
    );
  }
  if (mine) printSwitching(out, offers, mine, cheapest, standard);
  if (cheapest.refund > 0) {
    out.print(
      out.c.dim(
        `  Bills are CHF ${chf(cheapest.refund)} a month lower than the premium: the environmental levy refund, the same for everyone.`,
      ),
    );
  }
  printNextSteps(out, ctx, year, opts);
  printAlternatives(out, ctx);
  printSource(out, result.stale, result.fetchedAt);
}

/** --current takes one insurer. */
function currentInsurer(name: string, insurers: string[]): string {
  const matches = matchInsurers(name, insurers);
  if (matches.length > 1) {
    throw new UserError(`"${name}" matches several insurers: ${matches.join(', ')}.`, [
      `Write the name as listed, e.g. --current "${matches[0]}"`,
    ]);
  }
  return matches[0] as string;
}

function printSwitching(
  out: Output,
  offers: Offer[],
  mine: string,
  cheapest: Offer,
  standard: Offer | undefined,
): void {
  const theirs = offers.filter((o) => o.insurer === mine);
  const own = theirs[0];
  if (!own) {
    out.print(`  ${mine} has no plan here that matches your choices.`);
    return;
  }
  const saving = (own.premium - cheapest.premium) * 12;
  out.print(
    `  ${out.c.cyan(mine)}: its cheapest plan here is ${own.plan} at CHF ${chf(own.premium)} a month (#${offers.indexOf(own) + 1}).` +
      (saving > 0
        ? ` Switching to ${cheapest.insurer} ${cheapest.plan} saves CHF ${chfRound(saving)} a year.`
        : ' No other plan is cheaper.'),
  );
  const ownStandard = theirs.find((o) => o.model === 'standard');
  if (ownStandard && standard && ownStandard.premium > standard.premium) {
    out.print(
      `  With ${mine}'s standard plan (CHF ${chf(ownStandard.premium)} a month), switching to the cheapest ` +
        `standard plan, ${standard.insurer}, saves CHF ${chfRound((ownStandard.premium - standard.premium) * 12)} a year.`,
    );
  }
}

function printNextSteps(
  out: Output,
  ctx: Context,
  year: number,
  opts: Record<string, string | boolean | undefined>,
): void {
  const now = new Date();
  const deadline = switchDeadline(year);
  if (year > now.getUTCFullYear() && now.getTime() < deadline.getTime() + 24 * 3600 * 1000) {
    out.print(
      `  To switch for ${year}, your notice must reach your insurer by ${out.c.bold(formatLongDate(deadline))} ` +
        '(send it by registered letter).',
    );
  }
  if (ctx.person.accident && ctx.group !== 'child') {
    out.hint(
      'Working 8+ hours a week for one employer? Accidents are insured at work: --no-accident',
    );
  }
  if (opts.deductible === undefined && ctx.group !== 'child') {
    out.hint('A higher deductible lowers the premium: compare them with --deductibles');
  }
  if (!opts.current) out.hint('What switching saves: --current <your insurer>');
}

async function showDeductibles(
  ctx: Context,
  models: Model[],
  opts: Record<string, string | boolean | undefined>,
  limit: number,
  progress: ProgressLine,
): Promise<unknown> {
  const { app, person } = ctx;
  const { out } = app;
  const result = await findDeductibles(app.db(), ctx.http, ctx.query, models);
  progress.clear();
  const table = result.value;
  ctx.info = table.info;
  const insurers = [...new Set(table.plans.map((p) => p.insurer))];
  const only = typeof opts.insurer === 'string' ? matchInsurers(opts.insurer, insurers) : null;
  const column = Math.max(0, table.deductibles.indexOf(person.deductible));
  const plans = table.plans
    .filter((p) => (!only || only.includes(p.insurer)) && p.premiums[column] != null)
    .sort((a, b) => (a.premiums[column] as number) - (b.premiums[column] as number));
  const shown = plans.slice(0, limit);
  const year = table.info?.year ?? premiumYear();

  if (out.options.json) {
    return {
      year,
      place: {
        label: ctx.place.label,
        municipality: table.info?.municipality ?? ctx.place.municipality,
        region: table.info?.region ?? null,
      },
      person: { born: person.born, ageGroup: ctx.group, accident: person.accident },
      deductibles: table.deductibles,
      total: plans.length,
      plans: shown.map((p) => ({
        insurer: p.insurer,
        plan: p.plan,
        premiumsPerMonth: p.premiums,
      })),
      source: calculatorUrl(ctx.query, 'comparison', models),
      fetchedAt: result.fetchedAt,
    };
  }
  printHeader(out, ctx, `Health insurance ${year}`, [
    `${AGE_GROUP_LABELS[ctx.group]}, born ${person.born}`,
    person.accident ? 'with accident cover' : 'without accident cover',
    'CHF per month at each deductible',
  ]);
  if (shown.length === 0) {
    out.info('  No plans match.');
    return null;
  }
  out.table(shown, [
    { header: '#', value: (p) => String(plans.indexOf(p) + 1), align: 'right' },
    { header: 'Insurer', value: (p) => p.insurer },
    { header: 'Plan', value: (p) => p.plan, flex: true },
    ...table.deductibles.map((d, i) => ({
      header: String(d),
      value: (p: (typeof shown)[number]) =>
        p.premiums[i] == null ? '–' : chf(p.premiums[i] as number),
      align: 'right' as const,
      style: (text: string) => (i === column ? out.c.bold(text) : text),
    })),
  ]);
  if (shown.length < plans.length) {
    out.info(out.c.dim(`  ${formatCount(plans.length - shown.length)} more: --limit or --all`));
  }
  out.print();
  printBreakEven(out, ctx, table.deductibles, shown[0]);
  printSource(out, result.stale, result.fetchedAt);
  return null;
}

/** For the cheapest plan: when the highest deductible pays off against the lowest. */
function printBreakEven(
  out: Output,
  ctx: Context,
  deductibles: number[],
  best: { insurer: string; plan: string; premiums: (number | null)[] } | undefined,
): void {
  const low = deductibles[0];
  const high = deductibles.at(-1);
  const lowPremium = best?.premiums[0];
  const highPremium = best?.premiums.at(-1);
  if (
    !best ||
    low === undefined ||
    high === undefined ||
    lowPremium == null ||
    highPremium == null
  ) {
    return;
  }
  const saved = (lowPremium - highPremium) * 12;
  if (saved <= 0) return;
  const cap = COPAY_CAP[ctx.group];
  const point = breakEven(low, high, saved, cap);
  // With very high bills, both deductibles are paid in full and both co-payments reach the cap.
  const worst = high - low;
  out.print(
    `  ${best.insurer} ${best.plan}: a CHF ${high} deductible instead of CHF ${low} saves CHF ${chfRound(saved)} a year in premiums.`,
  );
  out.print(
    point === null
      ? `  That always pays off: even with high medical bills you pay at most CHF ${chfRound(worst)} more yourself.`
      : `  It pays off as long as your medical bills stay below about CHF ${chfRound(point)} a year; ` +
          `with high bills it costs up to CHF ${chfRound(worst - saved)} more in total.`,
  );
  out.print(
    out.c.dim(
      '  (You pay the deductible, then 10% of further bills up to a yearly maximum; hospital stays and some drugs cost extra.)',
    ),
  );
}

async function showHistory(
  ctx: Context,
  opts: Record<string, string | boolean | undefined>,
  progress: ProgressLine,
): Promise<unknown> {
  const { app } = ctx;
  const { out } = app;
  const result = await findHistory(app.db(), ctx.http, ctx.query);
  progress.clear();
  const history = result.value;
  ctx.info = history.info;
  const insurers = history.insurers.map((i) => i.insurer);
  const mine = typeof opts.current === 'string' ? currentInsurer(opts.current, insurers) : null;
  const only = typeof opts.insurer === 'string' ? matchInsurers(opts.insurer, insurers) : null;
  const latest = history.years.length - 1;
  const premiumIn = (row: (typeof history.insurers)[number]) =>
    row.premiums[latest] ?? Number.POSITIVE_INFINITY;
  const rows = history.insurers
    .filter((i) => !only || only.includes(i.insurer))
    .sort((a, b) => premiumIn(a) - premiumIn(b));
  const deductible = DEDUCTIBLES[ctx.group][0] as number;

  if (out.options.json) {
    return {
      place: {
        label: ctx.place.label,
        municipality: history.info?.municipality ?? ctx.place.municipality,
        region: history.info?.region ?? null,
      },
      ageGroup: ctx.group,
      plan: 'standard',
      deductible,
      accident: true,
      years: history.years,
      insurers: rows.map((r) => ({
        insurer: r.insurer,
        premiumsPerMonth: r.premiums,
        averageChangePercent: r.averageChange,
      })),
      source: calculatorUrl(ctx.query, 'change'),
      fetchedAt: result.fetchedAt,
    };
  }
  const span = `${history.years[0]}–${history.years.at(-1)}`;
  printHeader(out, ctx, `Standard premiums ${span}`, [
    AGE_GROUP_LABELS[ctx.group],
    `standard plan, deductible CHF ${deductible}, with accident cover`,
    'CHF per month',
  ]);
  const highlight = (text: string, row: (typeof rows)[number]) =>
    row.insurer === mine ? out.c.cyan(text) : text;
  out.table(rows, [
    { header: 'Insurer', value: (r) => r.insurer, style: highlight },
    ...history.years.map((y, i) => ({
      header: String(y),
      value: (r: (typeof rows)[number]) =>
        r.premiums[i] == null ? '–' : chf(r.premiums[i] as number),
      align: 'right' as const,
    })),
    {
      header: 'Yearly',
      value: (r) =>
        r.averageChange == null
          ? '–'
          : `${r.averageChange > 0 ? '+' : ''}${r.averageChange.toFixed(1)}%`,
      align: 'right',
    },
  ]);
  out.print();
  out.print(out.c.dim('  "Yearly": the average change per year over this period.'));
  printSource(out, result.stale, result.fetchedAt);
  return null;
}
