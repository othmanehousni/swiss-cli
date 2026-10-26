import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { UnexpectedResponseError } from '../../src/crawler/errors.js';
import { HttpClient } from '../../src/crawler/http.js';
import {
  breakEven,
  matchInsurers,
  parseBirthYear,
  parseDeductible,
  parseModels,
  switchDeadline,
} from '../../src/modules/premiums/command.js';
import {
  ageGroup,
  calculatorUrl,
  findLocation,
  findOffers,
  locationMunicipality,
  PriminfoError,
  parseDeductibles,
  parseHistory,
  parseLocations,
  parseSavings,
  premiumYear,
  type Query,
} from '../../src/modules/premiums/priminfo.js';
import { Database } from '../../src/storage/database.js';
import { createFakeFetch } from '../helpers/fake-fetch.js';

/** The parts of a priminfo answer page that are read, laid out as the real one. */
function page(table: string, { info = true } = {}): string {
  const header = info
    ? `<div class="col-md-12">
    <h1>
        Prämienrechner        2027    </h1>

    <h2>
        Prämien        Zürich    </h2>

    <p>
        Gemeinde        Zürich,
        Region        1,
        Kanton        Zürich    </p>
</div>`
    : `<h1 style="word-wrap: break-word;">Prämienrechner 2027</h1><div><h2>Medienmitteilung</h2><p>…</p></div>`;
  return `<html><body><h1><a href="/">Priminfo</a></h1>${header}
<table class="table table-condensed" aria-label="Übersicht über die angegebenen Personen">
  <thead><tr><th>Person</th><th>Kategorie</th></tr></thead>
  <tbody><tr><th>1</th><td>Erwachsene</td></tr></tbody>
</table>
${table}</body></html>`;
}

function savingsTable(rows: [string, string, number][]): string {
  const body = rows
    .map(
      ([insurer, plan, premium]) => `<tr>
        <th class="text-left" scope="row">
          <a href="http://www.${insurer.toLowerCase()}.ch" class="icon icon--after icon--external" target="_blank">${insurer}</a>
        </th>
        <th class="text-left" scope="row">
          ${plan}
        </th>
        <td class="monthlyCell">${premium.toFixed(2)}</td>
        <td class="monthlyCell">4.75</td>
        <td class="monthlyCell">${(premium - 4.75).toFixed(2)}</td>
        <td class="yearlyCell">${(premium * 12).toFixed(2).replace(/\B(?=(\d{3})+\.)/, "'")}</td>
        <td class="yearlyCell">57.00</td>
        <td class="yearlyCell">0</td>
      </tr>`,
    )
    .join('\n');
  return `<table class="table table-bordered table-sort text-right" id="savingsTable"
    aria-description="Tabelle mit Krankenkassen">
    <thead><tr>
      <th class="text-left">Krankenkasse</th><th class="text-left">Modell</th>
      <th class="monthlyCell">Prämie</th><th class="monthlyCell">Vergütung</th><th class="monthlyCell">Total</th>
      <th class="yearlyCell">Prämie</th><th class="yearlyCell">Vergütung</th><th class="yearlyCell">Total</th>
    </tr></thead>
    <tbody id="disableAriaLive">${body}</tbody>
  </table>`;
}

const NO_PLANS = (code: string) =>
  page(
    `<p class="alert alert-danger" role="alert">
      Für die gewählte Modellkategorie ${code} gibt es in diesem Prämienjahr keine Prämien.<br>Bitte wählen Sie eine andere Modellkategorie aus.
    </p>`,
    { info: false },
  );

const QUERY: Query = {
  lang: 'de',
  location: '80011450512497',
  person: { born: 1992, deductible: 2500, accident: true },
};

describe('priminfo pages', () => {
  it('reads the plans of a model, their insurer, website and premium', () => {
    const html = page(
      savingsTable([
        ['Atupri', 'HMO', 406.8],
        ['KPT', 'KPTwin.smart - Hausarzt­ mit App', 428.5],
      ]),
    );
    const result = parseSavings(html, 'https://x', 'doctor');
    expect(result.info).toEqual({
      year: 2027,
      municipality: 'Zürich',
      region: 1,
      canton: 'Zürich',
    });
    expect(result.offers).toEqual([
      {
        insurer: 'Atupri',
        website: 'http://www.atupri.ch',
        plan: 'HMO',
        model: 'doctor',
        premium: 406.8,
        refund: 4.75,
      },
      // The soft hyphen (a hint where to break a long word) is dropped.
      expect.objectContaining({ insurer: 'KPT', plan: 'KPTwin.smart - Hausarzt mit App' }),
    ]);
  });

  it('knows a model without plans from an error', () => {
    expect(parseSavings(NO_PLANS('PHARM'), 'https://x', 'pharmacy').offers).toEqual([]);
    expect(() => parseSavings(NO_PLANS('PHARM'), 'https://x', 'standard')).toThrow(PriminfoError);
    expect(() => parseSavings(page(''), 'https://x', 'standard')).toThrow(UnexpectedResponseError);
  });

  it('reads the history of standard premiums and the deductible comparison', () => {
    const history = parseHistory(
      page(`<table class="table table-bordered table-sort text-right" aria-description="…">
        <thead><tr><th>Krankenkasse</th><th>2025</th><th>2026</th><th>2027</th>
          <th>durch&shy;schnitt&shy;liche Zu&shy;nahme</th></tr></thead>
        <tbody><tr>
          <th class="text-left" scope="row"> Agrisano </th>
          <td><div> 603.60 </div><div> </div></td>
          <td><div> 639.80 </div><div> 6.0% </div></td>
          <td><div> 681.40 </div><div> 6.5% </div></td>
          <td><div>&nbsp;</div> 6.2% </td>
        </tr></tbody></table>`),
      'https://x',
    );
    expect(history.years).toEqual([2025, 2026, 2027]);
    expect(history.insurers).toEqual([
      { insurer: 'Agrisano', premiums: [603.6, 639.8, 681.4], averageChange: 6.2 },
    ]);

    const comparison = parseDeductibles(
      page(`<table class="table table-bordered table-sort text-right" aria-description="…">
        <thead><tr><th>Krankenkasse</th><th>Modell</th><th>300</th><th>1'000</th><th>2'500</th></tr></thead>
        <tbody><tr><th>Agrisano</th><th>AGRIcontact</th><td> 623.50 </td><td> – </td><td> 506.10 </td></tr></tbody>
      </table>`),
      'https://x',
    );
    expect(comparison.deductibles).toEqual([300, 1000, 2500]);
    expect(comparison.plans).toEqual([
      { insurer: 'Agrisano', plan: 'AGRIcontact', premiums: [623.5, null, 506.1] },
    ]);
  });

  it('builds the question the way the calculator form sends it', () => {
    const url = new URL(calculatorUrl(QUERY, 'savings', ['standard', 'telmed']));
    expect(url.pathname).toBe('/de/praemien');
    expect(url.searchParams.get('location_id')).toBe('80011450512497');
    expect(url.searchParams.get('yob[0]')).toBe('1992');
    expect(url.searchParams.get('franchise[0]')).toBe('2500');
    expect(url.searchParams.get('coverage[0]')).toBe('1');
    expect(url.searchParams.getAll('models[]')).toEqual(['BASE', 'TEL_DIG']);
    expect(url.searchParams.get('display')).toBe('savings');
  });
});

describe('priminfo places', () => {
  const script = `Locations = ${JSON.stringify({
    index: { '8001': ['80011'], '7270': ['72701'] },
    names: {
      '80011': '8001 Zürich',
      '72701': '7270 Davos Platz (Gemeinde Davos)',
      '10081': '1008 Jouxtens-Mézery (Gemeinde Jouxtens-Mézery)',
      '10082': '1008 Prilly',
    },
  })};`;

  it('finds the calculator place of a postcode and municipality', () => {
    const locations = parseLocations(script);
    expect(locationMunicipality('7270 Davos Platz (Gemeinde Davos)')).toBe('Davos');
    expect(locationMunicipality('8001 Zürich')).toBe('Zürich');
    expect(findLocation(locations, { postcode: '1008', municipality: 'Prilly' })?.id).toBe('10082');
    expect(findLocation(locations, { postcode: '1008', municipality: 'Jouxtens-Mezery' })?.id).toBe(
      '10081',
    );
    // A postcode the calculator does not list: the municipality decides.
    expect(findLocation(locations, { postcode: '7260', municipality: 'Davos' })?.id).toBe('72701');
    expect(findLocation(locations, { postcode: '9999', municipality: 'Nowhere' })).toBeNull();
    expect(() => parseLocations('Locations = nothing')).toThrow(UnexpectedResponseError);
  });
});

describe('premium lookups', () => {
  let db: Database;
  beforeEach(() => {
    db = Database.open(':memory:');
  });
  afterEach(() => db.close());

  it('asks for each model, labels and sorts the plans, and keeps the answers a day', async () => {
    const pages: Record<string, string> = {
      BASE: page(savingsTable([['SLKK', 'Grundversicherung', 504.7]])),
      PRAXIS: page(savingsTable([['Atupri', 'HMO', 406.8]])),
      TEL_DIG: page(
        savingsTable([
          ['Sanitas', 'TelMed Basic', 412.5],
          ['Avenir', 'SanaTel', 424.4],
        ]),
      ),
      FLEX: NO_PLANS('FLEX'),
      PHARM: NO_PLANS('PHARM'),
    };
    const fake = createFakeFetch((url) => {
      const model = new URL(url).searchParams.getAll('models[]')[0] ?? '';
      return { body: pages[model] ?? '' };
    });
    const http = new HttpClient({
      userAgent: 'test',
      requestsPerSecond: 1000,
      respectRobots: false,
      fetch: fake.fetch,
      sleep: async () => {},
    });

    const result = await findOffers(db, http, QUERY);
    expect(result.info?.region).toBe(1);
    expect(result.offers.map((o) => [o.insurer, o.model, o.premium])).toEqual([
      ['Atupri', 'doctor', 406.8],
      ['Sanitas', 'telmed', 412.5],
      ['Avenir', 'telmed', 424.4],
      ['SLKK', 'standard', 504.7],
    ]);
    expect(fake.requests()).toHaveLength(5);

    await findOffers(db, http, QUERY);
    expect(fake.requests()).toHaveLength(5); // answered from the cache
    await findOffers(db, http, QUERY, ['standard']);
    expect(fake.requests()).toHaveLength(5); // the standard page is cached too
  });
});

describe('premium choices', () => {
  const october = new Date(Date.UTC(2026, 9, 26));

  it('shows next year from October and groups ages by the premium year', () => {
    expect(premiumYear(october)).toBe(2027);
    expect(premiumYear(new Date(Date.UTC(2026, 5, 1)))).toBe(2026);
    expect(ageGroup(2009, 2027)).toBe('child'); // 18 in 2027
    expect(ageGroup(2008, 2027)).toBe('young');
    expect(ageGroup(2002, 2027)).toBe('young');
    expect(ageGroup(2001, 2027)).toBe('adult');
  });

  it('reads the age or year of birth, assuming an adult without either', () => {
    expect(parseBirthYear({ age: '34' }, 2027, october)).toEqual({ born: 1992, assumed: false });
    expect(parseBirthYear({ born: '2015' }, 2027, october)).toEqual({ born: 2015, assumed: false });
    expect(parseBirthYear({}, 2027, october)).toEqual({ born: 1992, assumed: true });
    expect(() => parseBirthYear({ age: 'old' }, 2027, october)).toThrow('--age');
    expect(() => parseBirthYear({ born: '3000' }, 2027, october)).toThrow('--born');
  });

  it('accepts only the deductibles the law allows', () => {
    expect(parseDeductible(undefined, 'adult')).toBe(300);
    expect(parseDeductible(undefined, 'child')).toBe(0);
    expect(parseDeductible("2'500", 'young')).toBe(2500);
    expect(() => parseDeductible('100', 'adult')).toThrow('not a deductible for adults');
    expect(() => parseDeductible('2500', 'child')).toThrow('not a deductible for children');
  });

  it('understands model names and insurer names', () => {
    expect(parseModels('hmo, telmed,standard')).toEqual(['doctor', 'telmed', 'standard']);
    expect(() => parseModels('cheap')).toThrow('Unknown model');
    const insurers = ['CSS', 'Sanitas', 'Sana24', 'Mutuel', 'Vivao Sympany'];
    expect(matchInsurers('css', insurers)).toEqual(['CSS']);
    expect(matchInsurers('Groupe Mutuel,sympany', insurers)).toEqual(['Mutuel', 'Vivao Sympany']);
    expect(matchInsurers('sana', insurers)).toEqual(['Sana24']);
    expect(() => matchInsurers('Allianz', insurers)).toThrow('No insurer called "Allianz"');
  });

  it('knows the deadline to switch and when a high deductible pays off', () => {
    expect(switchDeadline(2027).toISOString().slice(0, 10)).toBe('2026-11-30'); // a Monday
    expect(switchDeadline(2026).toISOString().slice(0, 10)).toBe('2025-11-28'); // the 30th is a Sunday
    // Saving CHF 1,540 a year: 0.9 × (bills − 300) reaches it at about CHF 2,011 of bills.
    expect(breakEven(300, 2500, 1540, 700)).toBe(2020);
    // Saving more than the CHF 2,200 difference: the high deductible always pays off.
    expect(breakEven(300, 2500, 2300, 700)).toBeNull();
  });
});
