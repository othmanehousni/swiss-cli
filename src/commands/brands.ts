import type { Command } from 'commander';
import { getProvider } from '../providers/index.js';
import { brandSummaries } from '../storage/brands.js';
import { databaseTotals, storeSummaries } from '../storage/queries.js';
import { formatCount, formatPercent } from '../ui/format.js';
import { App, type GlobalOptions, parsePositiveInt, parseStores, UserError } from './shared.js';

const EXAMPLES = `
Examples:
  $ swiss-grocery brands                     the biggest brands in your database
  $ swiss-grocery brands --store denner      the brands of one store
  $ swiss-grocery brands cola                brands whose name contains "cola"
  $ swiss-grocery brands --all --json        every brand, for scripts
  $ swiss-grocery search --brand rivella     then: every product of one brand

Where the brands come from:
  • Migros, Coop, Aldi and Lidl publish a brand for most products.
  • Denner publishes none, and Coop none for its wines, but their product names start
    with the brand ("Feldschlösschen Bier Original"). There the brand is recognised in
    the name, using only brands the stores publish; otherwise it stays empty.
  • Each brand is written the same way in every store, so --brand finds it everywhere.`;

const storeName = (store: Parameters<typeof getProvider>[0]) =>
  getProvider(store).info.name.replace(' Suisse', '');

export function registerBrandsCommand(program: Command): void {
  program
    .command('brands')
    .summary('list the brands in your database, with their products per store')
    .description(
      'List the brands of the products in your database, the biggest first, with how many\n' +
        'products each store has. Use a brand with `search --brand` or `export --brand`.',
    )
    .argument('[words...]', 'only brands whose name contains this, e.g. "cola"')
    .option('-s, --store <stores>', 'only these stores, comma-separated')
    .option('-n, --limit <count>', 'how many brands to show', '30')
    .option('-a, --all', 'show every brand')
    .option('--json', 'machine-readable output')
    .addHelpText('after', EXAMPLES)
    .action(
      (words: string[], opts: Record<string, string | boolean | undefined>, command: Command) => {
        const app = new App(command.optsWithGlobals<GlobalOptions>(), opts.json === true);
        try {
          const db = app.db();
          if (databaseTotals(db).products === 0) {
            throw new UserError('Your database is empty, so there are no brands yet.', [
              'Fetch a store first: swiss-grocery fetch aldi',
            ]);
          }
          const stores = opts.store ? parseStores([String(opts.store)]) : [];
          const query = words.join(' ').trim();
          const brands = brandSummaries(db, {
            ...(stores.length > 0 ? { stores } : {}),
            ...(query ? { query } : {}),
          });
          const limit =
            opts.all === true ? brands.length : parsePositiveInt(String(opts.limit), '--limit');
          const shown = brands.slice(0, limit);

          if (opts.json) {
            app.out.json({ total: brands.length, brands: shown });
            return;
          }
          const { out } = app;
          if (brands.length === 0) {
            out.info(query ? `No brand contains "${query}".` : 'No brands found.');
            if (query) out.hint('Check the spelling, or list every brand: swiss-grocery brands');
            return;
          }
          const coverage = storeSummaries(db).filter(
            (s) => s.products > 0 && (stores.length === 0 || stores.includes(s.store)),
          );
          const products = coverage.reduce((sum, s) => sum + s.products, 0);
          const branded = coverage.reduce((sum, s) => sum + s.withBrand, 0);
          out.print();
          out.print(
            `  ${out.c.bold(formatCount(brands.length))} brand${brands.length === 1 ? '' : 's'}` +
              (query
                ? ` contain "${query}"`
                : out.c.dim(
                    ` · a brand is known for ${formatCount(branded)} of ${formatCount(products)} products (${formatPercent(branded, products)})`,
                  )),
          );
          out.print();
          out.table(shown, [
            { header: 'Brand', value: (b) => b.brand, flex: true },
            { header: 'Products', value: (b) => formatCount(b.products), align: 'right' },
            {
              header: 'Stores',
              value: (b) =>
                b.stores.map((s) => `${storeName(s.store)} ${formatCount(s.products)}`).join(' · '),
            },
          ]);
          if (shown.some((b) => b.fromNames > 0)) {
            out.print();
            out.print(
              out.c.dim(
                '  Denner, and Coop for its wines, publish no brand: there it is recognised in the product name.',
              ),
            );
          }
          if (shown.length < brands.length) {
            out.print();
            out.info(
              out.c.dim(
                `  ${formatCount(brands.length - shown.length)} more: --limit ${Math.min(brands.length, limit * 3)} or --all`,
              ),
            );
          }
          out.print();
          out.info(
            `Products of a brand: ${out.c.cyan(`swiss-grocery search --brand "${shown[0]?.brand ?? 'lindt'}"`)}`,
          );
        } finally {
          app.close();
        }
      },
    );
}
