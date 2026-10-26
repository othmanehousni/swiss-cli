import { z } from 'zod';
import { UnexpectedResponseError } from '../../crawler/errors.js';
import type { HttpClient } from '../../crawler/http.js';
import { cleanText, looseKey } from '../../normalization/text.js';
import type { Lang } from '../../providers/types.js';
import { parseEnvelope } from '../../providers/util.js';
import { cached } from '../../storage/cache.js';
import type { Database } from '../../storage/database.js';
import { findTable, parseSwissNumber } from '../../util/html.js';
import type { Place } from '../places/resolve.js';

/**
 * priminfo.admin.ch, the premium calculator of the Federal Office of Public Health
 * (BAG/OFSP): the premiums of the basic health insurance (KVG/LAMal) of every insurer
 * for a place, year of birth, deductible and accident cover. It answers each question
 * with one ordinary page, rendered on the server, which is what is read here.
 */
export const PRIMINFO = 'https://www.priminfo.admin.ch';
const LOCATIONS_URL = `${PRIMINFO}/de/praemien/locations`;

const DAY_MS = 24 * 3600 * 1000;

export const MODELS = ['standard', 'doctor', 'telmed', 'flex', 'pharmacy'] as const;
export type Model = (typeof MODELS)[number];

/** The calculator's model categories. */
const MODEL_CODES: Record<Model, string> = {
  standard: 'BASE',
  doctor: 'PRAXIS',
  telmed: 'TEL_DIG',
  flex: 'FLEX',
  pharmacy: 'PHARM',
};

export const MODEL_LABELS: Record<Model, string> = {
  standard: 'Standard',
  doctor: 'Doctor/HMO',
  telmed: 'Telmed',
  flex: 'Flex',
  pharmacy: 'Pharmacy',
};

export type AgeGroup = 'child' | 'young' | 'adult';

export const AGE_GROUP_LABELS: Record<AgeGroup, string> = {
  child: 'Child (0–18)',
  young: 'Young adult (19–25)',
  adult: 'Adult (26+)',
};

/** By the age reached in the premium year: children up to 18, young adults up to 25. */
export function ageGroup(born: number, year: number): AgeGroup {
  const age = year - born;
  return age <= 18 ? 'child' : age <= 25 ? 'young' : 'adult';
}

/** The deductibles the law allows (CHF per year); the first is the ordinary one. */
export const DEDUCTIBLES: Record<AgeGroup, number[]> = {
  child: [0, 100, 200, 300, 400, 500, 600],
  young: [300, 500, 1000, 1500, 2000, 2500],
  adult: [300, 500, 1000, 1500, 2000, 2500],
};

/**
 * The yearly maximum of the 10% co-payment above the deductible (CHF), used to tell
 * when a higher deductible pays off.
 */
export const COPAY_CAP: Record<AgeGroup, number> = { child: 350, young: 700, adult: 700 };

/** The premium year the calculator shows: next year's from October (published end of September). */
export function premiumYear(now: Date = new Date()): number {
  return now.getUTCMonth() >= 9 ? now.getUTCFullYear() + 1 : now.getUTCFullYear();
}

/** A place in the calculator, e.g. "7270 Davos Platz (Gemeinde Davos)". */
export interface Location {
  id: string;
  name: string;
}

const LocationsScript = z.object({ names: z.record(z.string(), z.string()) });

/** Reads the calculator's list of places (a script `Locations = {index, names}`), by postcode. */
export function parseLocations(script: string, url = LOCATIONS_URL): Record<string, Location[]> {
  let data: unknown = null;
  try {
    data = JSON.parse(script.slice(script.indexOf('{'), script.lastIndexOf('}') + 1));
  } catch {
    // reported below
  }
  const { names } = parseEnvelope(LocationsScript, data, url, 'the list of places');
  const byPostcode: Record<string, Location[]> = {};
  for (const [id, name] of Object.entries(names)) {
    const postcode = /^(\d{4})\s/.exec(name)?.[1];
    if (!postcode) continue;
    byPostcode[postcode] = [...(byPostcode[postcode] ?? []), { id, name }];
  }
  return byPostcode;
}

/** "7270 Davos Platz (Gemeinde Davos)" -> "Davos"; "8001 Zürich" -> "Zürich". */
export function locationMunicipality(name: string): string {
  const named = /\((?:Gemeinde|Commune|Comune)\s+([^()]+)\)\s*$/.exec(name)?.[1];
  return (named ?? name.replace(/^\d{4}\s+/, '')).trim();
}

/** The calculator's places, refreshed monthly. */
export async function loadLocations(
  db: Database,
  http: HttpClient,
): Promise<Record<string, Location[]>> {
  const result = await cached(db, 'priminfo:locations', 30 * DAY_MS, async () =>
    parseLocations(await http.getText(LOCATIONS_URL)),
  );
  return result.value;
}

/** The calculator's place for a postcode and municipality (premiums depend on both). */
export function findLocation(
  locations: Record<string, Location[]>,
  place: Pick<Place, 'postcode' | 'municipality'>,
): Location | null {
  const town = place.municipality ? looseKey(place.municipality) : null;
  const inTown = (l: Location) => town !== null && looseKey(locationMunicipality(l.name)) === town;
  const candidates = place.postcode ? (locations[place.postcode] ?? []) : [];
  if (candidates.length > 0) return candidates.find(inTown) ?? candidates[0] ?? null;
  // A postcode the calculator does not list yet: any place of the same municipality.
  return Object.values(locations).flat().find(inTown) ?? null;
}

export interface Person {
  born: number;
  deductible: number;
  accident: boolean;
}

export interface Query {
  lang: Lang;
  /** The calculator's place id. */
  location: string;
  person: Person;
}

type View = 'savings' | 'comparison' | 'change';

/** The calculator's answer page for a question (one person). */
export function calculatorUrl(query: Query, view: View, models: readonly Model[] = MODELS): string {
  const params = new URLSearchParams({
    location_id: query.location,
    'yob[0]': String(query.person.born),
    'franchise[0]': String(query.person.deductible),
    'coverage[0]': query.person.accident ? '1' : '0',
  });
  for (const model of models) params.append('models[]', MODEL_CODES[model]);
  params.set('display', view);
  return `${PRIMINFO}/${query.lang}/praemien?${params}`;
}

/** The calculator could not answer, e.g. for a place or year of birth it does not accept. */
export class PriminfoError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PriminfoError';
  }
}

/** What every answer page says about the place. */
export interface PageInfo {
  /** The premium year (the calculator shows the current one only). */
  year: number;
  municipality: string;
  /** Premium region within the canton; 0 where the canton has only one. */
  region: number;
  canton: string;
}

/** "Prämienrechner 2027" and "Gemeinde Zürich, Region 1, Kanton Zürich" (or in French/Italian). */
function parseInfo(html: string): PageInfo | null {
  const heading =
    /<h1[^>]*>([^<]*?\b20\d\d\b[^<]*)<\/h1>\s*<h2[^>]*>[\s\S]*?<\/h2>\s*<p[^>]*>([\s\S]*?)<\/p>/i.exec(
      html,
    );
  if (!heading) return null;
  const year = Number(/\b(20\d\d)\b/.exec(heading[1] ?? '')?.[1]);
  const [town = '', region = '', canton = ''] = (cleanText(heading[2]) ?? '')
    .split(',')
    .map((part) => part.trim());
  const withoutLabel = (text: string) => text.replace(/^\S+\s+/, '').trim();
  return {
    year,
    municipality: withoutLabel(town),
    region: parseSwissNumber(region) ?? 0,
    canton: withoutLabel(canton),
  };
}

/** The calculator's error messages ("Achtung", no premiums for a model...). */
function alerts(html: string): string[] {
  return [
    ...html.matchAll(/<(p|div)[^>]*class="[^"]*\balert-danger\b[^"]*"[^>]*>([\s\S]*?)<\/\1>/gi),
  ]
    .map((m) => cleanText(m[2]) ?? '')
    .filter(Boolean);
}

/** Throws when an answer page has no results; `null` when a model has no plans there. */
function checkAnswer(
  html: string,
  url: string,
  hasResults: boolean,
  model?: Model,
): 'empty' | null {
  if (hasResults) return null;
  const messages = alerts(html);
  // "For the chosen model category PHARM there are no premiums this year."
  if (model && messages.some((m) => m.includes(MODEL_CODES[model]))) return 'empty';
  if (messages.length > 0) {
    throw new PriminfoError(`priminfo.admin.ch could not answer: ${messages.join(' ')}`);
  }
  throw new UnexpectedResponseError(url, 'the premium calculator answered without results');
}

export interface Offer {
  insurer: string;
  website: string | null;
  plan: string;
  model: Model;
  /** CHF per month, as approved (before the environmental levy refund). */
  premium: number;
  /** The environmental levy refunded with every premium bill, CHF per month. */
  refund: number;
}

export interface SavingsPage {
  info: PageInfo | null;
  offers: Offer[];
}

/** Reads the "savings" view: every plan of the asked model, cheapest first. */
export function parseSavings(html: string, url: string, model: Model): SavingsPage {
  const table = findTable(html, /id="savingsTable"/);
  if (checkAnswer(html, url, table !== null, model) === 'empty') {
    return { info: parseInfo(html), offers: [] };
  }
  const offers = (table?.body ?? []).flatMap((cells, i) => {
    const [insurer = '', plan = '', premium, refund] = cells;
    const amount = parseSwissNumber(premium);
    if (!insurer || amount === null) return [];
    const website = /href="(https?:[^"]+)"/i.exec(table?.bodyHtml[i] ?? '')?.[1] ?? null;
    return [
      {
        insurer,
        website,
        plan: plan.replace(/\s+/g, ' '),
        model,
        premium: amount,
        refund: parseSwissNumber(refund) ?? 0,
      },
    ];
  });
  if (offers.length === 0 && (table?.body.length ?? 0) > 0) {
    throw new UnexpectedResponseError(url, 'the premium table has an unknown layout');
  }
  return { info: parseInfo(html), offers };
}

export interface History {
  info: PageInfo | null;
  years: number[];
  /** Each insurer's standard premium (CHF 300 deductible, with accident cover) per year. */
  insurers: { insurer: string; premiums: (number | null)[]; averageChange: number | null }[];
}

/** Reads the "change" view: each insurer's standard premium over the last years. */
export function parseHistory(html: string, url: string): History {
  const table = findTable(html, /\btable-sort\b/);
  checkAnswer(html, url, table !== null);
  const header = table?.head[0] ?? [];
  const columns = header.flatMap((text, i) => (/^20\d\d$/.test(text) ? [i] : []));
  if (columns.length === 0) {
    throw new UnexpectedResponseError(url, 'the premium history has an unknown layout');
  }
  const averageColumn = header.length - 1;
  return {
    info: parseInfo(html),
    years: columns.map((i) => Number(header[i])),
    insurers: (table?.body ?? []).flatMap((cells) => {
      const insurer = cells[0] ?? '';
      if (!insurer) return [];
      return [
        {
          insurer,
          // Each cell holds the premium, then the change in percent.
          premiums: columns.map((i) => parseSwissNumber((cells[i] ?? '').split('\n')[0])),
          averageChange:
            averageColumn > (columns.at(-1) ?? 0) ? parseSwissNumber(cells[averageColumn]) : null,
        },
      ];
    }),
  };
}

export interface DeductibleTable {
  info: PageInfo | null;
  deductibles: number[];
  plans: { insurer: string; plan: string; premiums: (number | null)[] }[];
}

/** Reads the "comparison" view: every plan's premium at each deductible. */
export function parseDeductibles(html: string, url: string): DeductibleTable {
  const table = findTable(html, /\btable-sort\b/);
  checkAnswer(html, url, table !== null);
  const header = table?.head[0] ?? [];
  const deductibles = header.slice(2).map((text) => parseSwissNumber(text));
  if (deductibles.length === 0 || deductibles.some((d) => d === null)) {
    throw new UnexpectedResponseError(url, 'the deductible comparison has an unknown layout');
  }
  return {
    info: parseInfo(html),
    deductibles: deductibles as number[],
    plans: (table?.body ?? []).flatMap((cells) => {
      const [insurer = '', plan = '', ...amounts] = cells;
      if (!insurer) return [];
      return [
        {
          insurer,
          plan: plan.replace(/\s+/g, ' '),
          premiums: deductibles.map((_, i) => parseSwissNumber(amounts[i])),
        },
      ];
    }),
  };
}

export interface Lookup<T> {
  value: T;
  fetchedAt: string;
  /** priminfo could not be reached, so an earlier answer was used. */
  stale: boolean;
}

/** Answers are kept a day: premiums are fixed for the year, but corrections happen. */
async function ask<T>(
  db: Database,
  http: HttpClient,
  url: string,
  parse: (html: string) => T,
): Promise<Lookup<T>> {
  const result = await cached(db, `priminfo:${url}`, DAY_MS, async () =>
    parse(await http.getText(url)),
  );
  return { value: result.value, fetchedAt: result.fetchedAt, stale: result.stale };
}

export interface Offers {
  info: PageInfo | null;
  offers: Offer[];
  fetchedAt: string;
  stale: boolean;
}

/**
 * Every plan for the question, cheapest first. The calculator does not say which
 * model a plan belongs to, so each model is asked for on its own (one page each).
 */
export async function findOffers(
  db: Database,
  http: HttpClient,
  query: Query,
  models: readonly Model[] = MODELS,
): Promise<Offers> {
  const pages = await Promise.all(
    models.map((model) => {
      const url = calculatorUrl(query, 'savings', [model]);
      return ask(db, http, url, (html) => parseSavings(html, url, model));
    }),
  );
  const offers = pages
    .flatMap((p) => p.value.offers)
    .sort(
      (a, b) =>
        a.premium - b.premium || a.insurer.localeCompare(b.insurer) || a.plan.localeCompare(b.plan),
    );
  return {
    info: pages.find((p) => p.value.info)?.value.info ?? null,
    offers,
    fetchedAt: pages.map((p) => p.fetchedAt).sort()[0] ?? new Date().toISOString(),
    stale: pages.some((p) => p.stale),
  };
}

export async function findHistory(
  db: Database,
  http: HttpClient,
  query: Query,
): Promise<Lookup<History>> {
  const url = calculatorUrl(query, 'change');
  return ask(db, http, url, (html) => parseHistory(html, url));
}

export async function findDeductibles(
  db: Database,
  http: HttpClient,
  query: Query,
  models: readonly Model[] = MODELS,
): Promise<Lookup<DeductibleTable>> {
  const url = calculatorUrl(query, 'comparison', models);
  return ask(db, http, url, (html) => parseDeductibles(html, url));
}
