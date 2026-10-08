import type { Command } from 'commander';
import { searchKey } from '../normalization/text.js';
import type { ProductDetails } from '../normalization/types.js';
import { getProvider } from '../providers/index.js';
import {
  databaseTotals,
  findProducts,
  isOnPromotion,
  type ProductRow,
  priceHistory,
  SORT_KEYS,
  type SortKey,
  searchProducts,
  storeSummaries,
} from '../storage/queries.js';
import {
  formatChf,
  formatCount,
  formatDate,
  formatDay,
  formatOffer,
  formatUnitPrice,
} from '../ui/format.js';
import type { Column } from '../ui/output.js';
import { FIELDS, parseFields, rowToObject } from './fields.js';
import { App, type GlobalOptions, parsePositiveInt, parseStores, UserError } from './shared.js';

/** Name with the brand in front, unless the name already starts with or contains it. */
function displayName(row: ProductRow): string {
  if (!row.brand || searchKey(row.name).includes(searchKey(row.brand))) return row.name;
  return `${row.brand} ${row.name}`;
}

function ensureData(app: App): void {
  if (databaseTotals(app.db()).products === 0) {
    throw new UserError('Your database is empty, so there is nothing to search yet.', [
      'Fetch a store first (about a minute): swiss-grocery fetch aldi',
      'Or fetch every store: swiss-grocery fetch all',
    ]);
  }
}

const SORT_HELP: Record<SortKey, string> = {
  relevance: 'best matches first, cheapest per kg/litre among equally good matches',
  price: 'cheapest first',
  'unit-price': 'cheapest per kg / litre / piece first',
  discount: 'biggest discount first',
  name: 'alphabetical',
  store: 'grouped by store',
};

const SEARCH_EXAMPLES = `
Examples:
  $ swiss-grocery search "coca cola"
  $ swiss-grocery search lait --sort unit-price          compare price per litre
  $ swiss-grocery search fromage --store migros,coop     only some stores
  $ swiss-grocery search chocolat --promo                only promotions
  $ swiss-grocery search café --fields brand,category,url
  $ swiss-grocery search bière --json > biere.json       for scripts

Tips:
  • Every word must match; accents are optional ("cafe" finds "Café", "creme" finds "Crème").
  • Search in the language the stores were fetched in (German unless you chose --lang
    or SWISS_GROCERY_LANG, e.g. "milch" in German, "lait" in French).
  • Prices are compared per kg, per litre or per piece in the "Per unit" column.
  • See everything about one product, including its price history: swiss-grocery show <ID>`;

export function registerQueryCommands(program: Command): void {
  program
    .command('search')
    .summary('find products and compare prices across stores')
    .description(
      'Search your local database (fetch stores first) and compare prices across stores.',
    )
    .argument('<words...>', 'what to look for, e.g. "coca cola"')
    .option('-s, --store <stores>', 'only these stores, comma-separated (e.g. migros,coop)')
    .option('--sort <order>', `order of results: ${SORT_KEYS.join(', ')}`, 'relevance')
    .option('-p, --promo', 'only products on promotion')
    .option('-c, --category <text>', 'only products whose category contains this text')
    .option('-n, --limit <count>', 'how many results to show', '20')
    .option(
      '-f, --fields <list>',
      'extra columns, e.g. brand,category,url — or "all" (see `fields`)',
    )
    .option('--include-removed', 'include products the store no longer lists')
    .option('--json', 'machine-readable output')
    .addHelpText('after', SEARCH_EXAMPLES)
    .action(
      (words: string[], opts: Record<string, string | boolean | undefined>, command: Command) => {
        const app = new App(command.optsWithGlobals<GlobalOptions>(), opts.json === true);
        try {
          ensureData(app);
          const query = words.join(' ').trim();
          const sort = String(opts.sort ?? 'relevance') as SortKey;
          if (!SORT_KEYS.includes(sort)) {
            throw new UserError(`Unknown sort order "${sort}".`, [
              `Use one of: ${SORT_KEYS.join(', ')}`,
            ]);
          }
          const limit = parsePositiveInt(String(opts.limit ?? '20'), '--limit');
          const extra = opts.fields ? parseFields(String(opts.fields), []) : [];
          const { rows, total } = searchProducts(app.db(), {
            query,
            sort,
            limit,
            ...(opts.store
              ? { stores: parseStores([String(opts.store)], { allowAll: true }) }
              : {}),
            onlyPromotions: opts.promo === true,
            includeRemoved: opts.includeRemoved === true,
            ...(opts.category ? { category: String(opts.category) } : {}),
          });

          if (opts.json) {
            const fields = parseFields(undefined, [
              'id',
              'store',
              'name',
              'brand',
              'size',
              'price',
              'regular_price',
              'loyalty_price',
              'unit_price',
              'unit',
              'promo',
              'valid_from',
              'valid_until',
              'url',
            ]);
            const all = [...fields, ...extra.filter((f) => !fields.includes(f))];
            app.out.json({ query, total, results: rows.map((r) => rowToObject(r, all)) });
            return;
          }

          const { out } = app;
          if (rows.length === 0) {
            out.info(`No products match "${query}".`);
            out.hint('Check the spelling or use fewer words (every word must match).');
            if (opts.store || opts.promo || opts.category)
              out.hint('Remove --store / --promo / --category to search everywhere.');
            const langs = storeSummaries(app.db())
              .filter((s) => s.products > 0)
              .map((s) => `${getProvider(s.store).info.name} ${app.langFor(s.store)}`);
            if (langs.length > 0) {
              out.hint(`Search in the language of the product names (${langs.join(', ')}).`);
            }
            out.hint('Fetch more stores to widen the search: swiss-grocery stores');
            return;
          }
          out.info();
          out.info(
            `${out.c.bold(formatCount(total))} product${total === 1 ? '' : 's'} match "${query}" ${out.c.dim(`· ${SORT_HELP[sort]}`)}`,
          );
          out.info();
          const now = Date.now();
          const columns: Column<ProductRow>[] = [
            {
              header: 'Store',
              value: (r) => getProvider(r.store).info.name.replace(' Suisse', ''),
            },
            {
              header: 'Product',
              value: displayName,
              flex: true,
              style: (t, r) => (r.removed_at ? out.c.dim(t) : t),
            },
            { header: 'Size', value: (r) => r.size_text ?? '' },
            {
              header: 'Price',
              value: (r) => formatChf(r.price),
              align: 'right',
              style: (t, r) => (isOnPromotion(r) ? out.c.green(t) : t),
            },
            {
              header: 'Per unit',
              value: (r) => formatUnitPrice(r.unit_price, r.unit_price_basis),
              align: 'right',
            },
            { header: 'Offer', value: (r) => formatOffer(r, now), style: (t) => out.c.yellow(t) },
            ...extra.map((f) => ({
              header: f.key,
              value: (r: ProductRow) => String(f.display?.(r) ?? f.value(r) ?? ''),
            })),
            { header: 'ID', value: (r) => r.id, style: (t) => out.c.dim(t) },
          ];
          out.table(rows, columns);
          out.info();
          if (total > rows.length) {
            out.info(
              out.c.dim(
                `Showing ${rows.length} of ${formatCount(total)}. Use --limit ${Math.min(total, limit * 5)} to see more.`,
              ),
            );
          }
          out.info(out.c.dim(`More about a product: swiss-grocery show ${rows[0]?.id}`));
        } finally {
          app.close();
        }
      },
    );

  program
    .command('show')
    .summary('everything about one product, including its price history')
    .description('Show everything known about one product, including its price history.')
    .argument('<product>', 'product id from search results, e.g. aldi:288415 (or just the number)')
    .option('--json', 'machine-readable output')
    .addHelpText(
      'after',
      '\nExamples:\n  $ swiss-grocery show aldi:288415\n  $ swiss-grocery show 288415',
    )
    .action((reference: string, opts: { json?: boolean }, command: Command) => {
      const app = new App(command.optsWithGlobals<GlobalOptions>(), opts.json === true);
      try {
        const matches = findProducts(app.db(), reference);
        if (matches.length === 0) {
          throw new UserError(`No product with id "${reference}".`, [
            'Find ids with: swiss-grocery search <words> (the ID column)',
          ]);
        }
        if (matches.length > 1) {
          throw new UserError(`"${reference}" matches products in several stores:`, [
            ...matches.map((m) => `${m.id}  ${displayName(m)}`),
            `Use the full id, e.g. swiss-grocery show ${matches[0]?.id}`,
          ]);
        }
        const row = matches[0] as ProductRow;
        const history = priceHistory(app.db(), row.id);
        if (opts.json) {
          app.out.json({
            ...rowToObject(row, FIELDS),
            details: row.details ? JSON.parse(row.details) : null,
            history,
          });
          return;
        }
        printProduct(app, row, history);
      } finally {
        app.close();
      }
    });

  program
    .command('fields')
    .summary('list the fields available to search --fields and export')
    .description('List every field you can show with `search --fields` or `export --fields`.')
    .action((_opts: unknown, command: Command) => {
      const app = new App(command.optsWithGlobals<GlobalOptions>());
      app.out.info();
      app.out.table(FIELDS, [
        { header: 'Field', value: (f) => f.key, style: (t) => app.out.c.cyan(t) },
        { header: 'Meaning', value: (f) => f.description, flex: true },
      ]);
      app.out.info();
      app.out.info(
        app.out.c.dim(
          'Use several with commas (--fields brand,category,url) or everything with --fields all.',
        ),
      );
    });
}

/** Readable names for store-specific extra details. */
const EXTRA_LABELS: Record<string, string> = {
  legalName: 'Legal name',
  ecoScore: 'Eco-Score',
  tasting: 'Tasting',
  box: 'Box',
  vintage: 'Vintage',
  labels: 'Labels',
  warnings: 'Warnings',
};

function printProduct(app: App, row: ProductRow, history: ReturnType<typeof priceHistory>): void {
  const { out } = app;
  const store = getProvider(row.store).info;
  const line = (label: string, value: string | null | undefined) => {
    if (value) out.print(`  ${out.c.dim(label.padEnd(13))}${value}`);
  };
  out.print();
  out.print(`  ${out.c.bold(displayName(row))}`);
  out.print(`  ${out.c.dim([store.name, row.id, row.category_path].filter(Boolean).join(' · '))}`);
  if (row.removed_at)
    out.print(
      `  ${out.c.yellow(`No longer listed by ${store.name} since ${formatDate(row.removed_at)}`)}`,
    );
  out.print();
  const promo = isOnPromotion(row) ? out.c.green(formatChf(row.price)) : formatChf(row.price);
  line(
    'Price',
    `${promo}${row.unit_price != null ? `   (${formatUnitPrice(row.unit_price, row.unit_price_basis)})` : ''}`,
  );
  line('Offer', formatOffer(row) || null);
  line('Size', row.size_text);
  line('Labels', (JSON.parse(row.labels) as string[]).join(', ') || null);
  line('Barcode', row.gtin);
  line('Link', row.url);
  line('Image', row.image_url);
  line('Seen', `first ${formatDate(row.first_seen_at)} · last ${formatDate(row.last_seen_at)}`);

  const details = row.details ? (JSON.parse(row.details) as ProductDetails) : null;
  out.print();
  if (details) {
    out.print(
      `  ${out.c.bold('Details')} ${out.c.dim(`(fetched ${formatDate(row.details_fetched_at)})`)}`,
    );
    line('Description', details.description);
    line('Ingredients', details.ingredients);
    line('Allergens', details.allergens?.join(', '));
    line('Origin', details.origin);
    line('Storage', details.storage);
    line('Usage', details.usage);
    if (details.rating)
      line(
        'Rating',
        `${details.rating.average} / 5 (${formatCount(details.rating.count)} ratings)`,
      );
    const { nutritionPer, ...extra } = details.extra ?? {};
    for (const [key, value] of Object.entries(extra)) line(EXTRA_LABELS[key] ?? key, value);
    const nutrition = Object.entries(details.nutrition ?? {});
    if (nutrition.length > 0) {
      out.print();
      out.print(
        `  ${out.c.bold('Nutrition')}${nutritionPer ? out.c.dim(` (per ${nutritionPer})`) : ''}`,
      );
      const width = Math.max(...nutrition.map(([name]) => name.length)) + 2;
      for (const [name, value] of nutrition)
        out.print(`  ${out.c.dim(name.padEnd(width))}${value}`);
    }
  } else {
    out.print(
      out.c.dim(`  No details yet. Fetch them with: swiss-grocery fetch ${row.store} --details`),
    );
  }

  out.print();
  out.print(`  ${out.c.bold('Price history')}`);
  out.table(history, [
    { header: 'From', value: (h) => formatDate(h.first_seen_at) },
    { header: 'Until', value: (h) => formatDate(h.last_seen_at) },
    { header: 'Price', value: (h) => formatChf(h.price), align: 'right' },
    {
      header: 'Was',
      value: (h) => (h.regular_price != null ? formatChf(h.regular_price) : ''),
      align: 'right',
    },
    {
      header: 'Offer',
      value: (h) =>
        [
          h.promo_label,
          h.loyalty_price != null ? `app ${formatChf(h.loyalty_price)}` : null,
          h.valid_until ? `until ${formatDay(h.valid_until)}` : null,
        ]
          .filter(Boolean)
          .join(' · '),
    },
  ]);
  out.print();
}
