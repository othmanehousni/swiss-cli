/**
 * Runs the real command-line program against a small local database, offline:
 * results on stdout, messages on stderr, each error printed once, exit codes.
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Database } from '../../src/storage/database.js';
import { saveProducts } from '../../src/storage/products.js';
import { makeProduct } from '../helpers/products.js';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const T1 = '2026-10-01T08:00:00.000Z';

let dir: string;
let dbPath: string;
let emptyDbPath: string;

function run(env: Record<string, string>, db: string, args: string[]) {
  const result = spawnSync(
    process.execPath,
    ['--import', 'tsx', 'src/cli.ts', '--db', db, '--no-color', ...args],
    { cwd: ROOT, encoding: 'utf-8', timeout: 30_000, env: { ...process.env, ...env } },
  );
  return { code: result.status, stdout: result.stdout, stderr: result.stderr };
}

function cli(db: string, ...args: string[]) {
  return run({}, db, args);
}

function occurrences(text: string, part: string): number {
  return text.split(part).length - 1;
}

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'swiss-grocery-cli-'));
  dbPath = join(dir, 'grocery.db');
  emptyDbPath = join(dir, 'empty.db');
  const db = Database.open(dbPath);
  saveProducts(
    db,
    [
      makeProduct(),
      makeProduct({
        store: 'coop',
        storeProductId: '3393474',
        name: 'Floralp Butter',
        brand: 'Floralp',
        price: 3.5,
        regularPrice: 4.4,
        promoLabel: '-20%',
        unitPrice: 14,
        url: 'https://www.coop.ch/de/p/3393474',
        sourceRef: {},
      }),
      makeProduct({
        store: 'lidl',
        storeProductId: '10059631',
        name: 'Coca-Cola',
        categoryPath: ['Getränke'],
        sizeText: '12 x 0,5 l',
        quantity: { amount: 6000, unit: 'ml', packCount: 12 },
        price: 12.39,
        unitPrice: 2.065,
        unitPriceBasis: 'l',
        url: null,
        sourceRef: {},
      }),
    ],
    T1,
  );
  db.close();
}, 30_000);

afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('swiss-grocery (command line)', { timeout: 30_000 }, () => {
  it('prints search results as a table on stdout', () => {
    const { code, stdout, stderr } = cli(dbPath, 'search', 'butter', '--sort', 'unit-price');
    expect(code).toBe(0);
    const lines = stdout.trim().split('\n');
    expect(lines[0]).toMatch(/Store\s+Product\s+Size\s+Price\s+Per unit\s+Offer\s+ID/);
    expect(lines[1]).toContain('coop:3393474');
    expect(lines[1]).toContain('CHF 14.00/kg');
    expect(lines[2]).toContain('aldi:288415');
    expect(stdout).not.toContain('Coca-Cola');
    expect(stderr).toContain('2 products match "butter"');
  });

  it('prints clean JSON with --json', () => {
    const { code, stdout, stderr } = cli(dbPath, 'search', 'kase', 'butter', '--json');
    expect(code).toBe(0);
    expect(stderr).toBe('');
    expect(JSON.parse(stdout)).toEqual({ query: 'kase butter', total: 0, results: [] });

    const coke = JSON.parse(cli(dbPath, 'search', 'coca', 'cola', '--json').stdout);
    expect(coke.total).toBe(1);
    expect(coke.results[0]).toMatchObject({ id: 'lidl:10059631', price: 12.39, unit: 'l' });
  });

  it('shows one product with its price history', () => {
    const { code, stdout } = cli(dbPath, 'show', 'aldi:288415', '--json');
    expect(code).toBe(0);
    const product = JSON.parse(stdout);
    expect(product).toMatchObject({ id: 'aldi:288415', name: 'Butter', price: 3.85 });
    expect(product.history).toHaveLength(1);
  });

  it('exports CSV into a folder that does not exist yet', () => {
    const file = join(dir, 'exports', 'all.csv');
    const { code } = cli(dbPath, 'export', file, '--delimiter', ';');
    expect(code).toBe(0);
    const csv = readFileSync(file, 'utf-8');
    expect(csv.startsWith('\uFEFF')).toBe(true);
    const lines = csv.slice(1).trim().split(/\r?\n/);
    expect(lines).toHaveLength(4);
    expect(lines[0]).toContain(';');
  });

  it('explains a mistyped store once and exits with code 2', () => {
    const { code, stdout, stderr } = cli(dbPath, 'search', 'butter', '--store', 'migro');
    expect(code).toBe(2);
    expect(stdout).toBe('');
    expect(occurrences(stderr, 'Unknown store "migro"')).toBe(1);
    expect(stderr).toContain('Did you mean "migros"?');
  });

  it('reports a missing product id', () => {
    const { code, stderr } = cli(dbPath, 'show', '999999');
    expect(code).toBe(2);
    expect(occurrences(stderr, 'No product with id "999999"')).toBe(1);
  });

  it('rejects contradictory crawl options before contacting any store', () => {
    const { code, stderr } = cli(dbPath, 'fetch', 'aldi', '--all', '--category', 'food');
    expect(code).toBe(2);
    expect(occurrences(stderr, 'Use either --all or --category, not both.')).toBe(1);
  });

  it('lists each store with its status', () => {
    const { code, stdout } = cli(dbPath, 'stores', '--json');
    expect(code).toBe(0);
    const status = Object.fromEntries(
      JSON.parse(stdout).map((s: { id: string; status: string }) => [s.id, s.status]),
    );
    expect(status).toMatchObject({ aldi: 'ready', coop: 'ready', migros: 'not working' });
  });

  it('prints a Supabase schema that includes the grants', () => {
    const { code, stdout } = cli(dbPath, 'sync', '--print-schema');
    expect(code).toBe(0);
    expect(stdout).toContain('create table if not exists public.products');
    expect(stdout).toContain('to service_role;');
  });

  it('refuses a publishable Supabase key before sending anything', () => {
    const env = {
      SUPABASE_URL: 'https://example.invalid',
      SUPABASE_SECRET_KEY: 'sb_publishable_test',
    };
    const { code, stderr } = run(env, dbPath, ['sync']);
    expect(code).toBe(2);
    expect(occurrences(stderr, 'your Supabase key is a publishable key')).toBe(1);
    expect(stderr).toContain('sb_secret_');
  });

  it('guides a new user when the database is still empty', () => {
    const search = cli(emptyDbPath, 'search', 'milch');
    expect(search.code).toBe(2);
    expect(search.stderr).toContain('Your database is empty');
    expect(search.stderr).toContain('swiss-grocery fetch aldi');

    const update = cli(emptyDbPath, 'update');
    expect(update.code).toBe(2);
    expect(occurrences(update.stderr, 'Nothing to update yet')).toBe(1);
  });
});
