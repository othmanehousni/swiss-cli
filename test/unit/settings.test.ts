import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { App, UserError } from '../../src/commands/shared.js';

const KEYS = ['SWISS_GROCERY_LANG', 'SWISS_GROCERY_MIGROS_LANG'] as const;
const saved = Object.fromEntries(KEYS.map((key) => [key, process.env[key]]));

beforeEach(() => {
  for (const key of KEYS) delete process.env[key];
});
afterEach(() => {
  for (const key of KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
});

describe('the language a store is read in', () => {
  it('is --lang, else the store setting, else SWISS_GROCERY_LANG, else German', () => {
    const app = new App({ db: ':memory:' });
    expect(app.langFor('migros')).toBe('de');
    process.env.SWISS_GROCERY_LANG = 'it';
    expect(app.langFor('migros')).toBe('it');
    process.env.SWISS_GROCERY_MIGROS_LANG = 'fr';
    expect(app.langFor('migros')).toBe('fr');
    expect(app.langFor('coop')).toBe('it');
    expect(new App({ db: ':memory:', lang: 'de' }).langFor('migros')).toBe('de');
  });

  it('explains a value it does not know', () => {
    process.env.SWISS_GROCERY_MIGROS_LANG = 'french';
    expect(() => new App({ db: ':memory:' }).langFor('migros')).toThrow(UserError);
  });
});
