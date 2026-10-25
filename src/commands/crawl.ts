import type { Command } from 'commander';
import type { RunKind } from '../crawler/checkpoint.js';
import { type CrawlProgress, type CrawlResult, crawlStore } from '../crawler/crawler.js';
import type { StoreId } from '../normalization/types.js';
import { resolveCategories } from '../providers/categories.js';
import { getProvider } from '../providers/index.js';
import type { Lang } from '../providers/types.js';
import { saveCategories } from '../storage/products.js';
import { storeSummaries } from '../storage/queries.js';
import { formatCount, formatDuration } from '../ui/format.js';
import { ProgressLine } from '../ui/output.js';
import {
  App,
  explainError,
  type GlobalOptions,
  parsePositiveInt,
  parsePositiveNumber,
  parseStores,
  providerContext,
  UserError,
  withInterrupt,
} from './shared.js';

interface CrawlRequest {
  kind: RunKind;
  stores: StoreId[];
  categories: string[];
  details: 'seen' | 'new' | false;
  fresh: boolean;
  limit?: number;
  rate?: number;
}

interface StoreOutcome {
  store: StoreId;
  status: CrawlResult['status'] | 'error';
  resumed?: boolean;
  sample?: boolean;
  stats?: CrawlResult['stats'];
  uniqueProducts?: number;
  failures?: CrawlResult['failures'];
  removalSkipped?: CrawlResult['removalSkipped'];
  durationMs?: number;
  error?: string;
}

function describeProgress(p: CrawlProgress): string {
  const s = p.stats;
  const extra = [
    `${formatCount(s.requests)} requests`,
    s.retries > 0 ? `${s.retries} retries` : null,
  ]
    .filter(Boolean)
    .join(' · ');
  if (p.phase === 'confirming') {
    return `Checking  ${formatCount(p.detailsDone)}/${formatCount(p.detailsTotal)} products that were not listed (still sold?)`;
  }
  if (p.phase === 'details') {
    return `Details  ${formatCount(p.detailsDone)}/${formatCount(p.detailsTotal)} products · ${extra}`;
  }
  const sections = p.sourcesTotal > 1 ? `${p.sourcesDone}/${p.sourcesTotal} sections · ` : '';
  return `Listing  ${sections}${formatCount(s.products)} products · ${extra}${p.source ? ` · ${p.source}` : ''}`;
}

function reportResult(app: App, name: string, result: CrawlResult): void {
  const { out } = app;
  const s = result.stats;
  const resumed = result.resumed ? ' (continued from an earlier run)' : '';
  if (result.status === 'interrupted') {
    out.warn(`Stopped. ${formatCount(s.products)} products saved so far${resumed}.`);
    out.hint('Run the same command again to continue where it stopped.');
    return;
  }
  out.success(
    `${formatCount(result.uniqueProducts)} products from ${name} in ${formatDuration(result.durationMs)} ` +
      `(${formatCount(s.requests)} requests)${resumed}`,
  );
  const changes = [
    `${formatCount(s.inserted)} new`,
    `${formatCount(s.priceChanges)} price change${s.priceChanges === 1 ? '' : 's'}`,
    s.removed > 0 ? `${formatCount(s.removed)} no longer listed` : null,
    s.stillListed > 0
      ? `${formatCount(s.stillListed)} missing from the listing but confirmed still sold`
      : null,
    s.rejected + s.skipped > 0
      ? `${formatCount(s.rejected + s.skipped)} unreadable items skipped`
      : null,
  ].filter(Boolean);
  out.info(`    ${changes.join(' · ')}`);
  if (s.details + s.detailsFailed > 0) {
    out.info(
      `    details fetched for ${formatCount(s.details)} products` +
        (s.detailsFailed > 0 ? ` (${s.detailsFailed} failed, retried next time)` : ''),
    );
  }
  if (result.sample) out.hint('This was a sample. Run without --limit to fetch the whole catalog.');
  if (result.failures.length > 0) {
    out.warn(
      `${result.failures.length} section(s) could not be loaded and will be retried next time:`,
    );
    for (const f of result.failures.slice(0, 5)) out.info(`    ${f.source}: ${f.error}`);
  }
  if (result.removalSkipped) {
    const { reason, unseen, active, repeated } = result.removalSkipped;
    if (reason === 'listing-shifted') {
      out.warn(
        `${name} changed the order of its listing while it was being read (${formatCount(repeated)} products ` +
          `showed up twice), so ${formatCount(unseen)} unseen products were NOT marked as removed.`,
      );
    } else {
      out.warn(
        `${formatCount(unseen)} of ${formatCount(active)} products were not listed this time. That is unusually ` +
          'many, so they were NOT marked as removed (the store may have had a hiccup).',
      );
    }
    out.hint('Run the update again later; products still missing then really are gone.');
  }
}

/** "Milk" in each product language, for the suggested first search. */
const SAMPLE_WORD: Record<Lang, string> = { de: 'milch', fr: 'lait', it: 'latte' };

async function runCrawl(app: App, request: CrawlRequest): Promise<boolean> {
  const { out } = app;
  const db = app.db();
  const outcomes: StoreOutcome[] = [];

  await withInterrupt(app, async (signal) => {
    for (const store of request.stores) {
      if (signal.aborted) break;
      const provider = getProvider(store);
      const progress = new ProgressLine(out);
      out.info();
      out.heading(
        `${provider.info.name}${request.categories.length > 0 ? ` · ${request.categories.join(', ')}` : ''}`,
      );
      out.info(out.c.dim(`  ${provider.info.coverage}`));
      if (provider.info.unavailable) {
        out.warn(`${provider.info.unavailable} Trying anyway…`);
      } else if (!provider.info.verified) {
        out.warn(
          `${provider.info.name} support is experimental (it could not be tested live yet). ` +
            `If it fails, run: swiss-grocery doctor ${store}`,
        );
      }
      try {
        const ctx = providerContext(app, provider, {
          ...(request.rate ? { rate: request.rate } : {}),
          signal,
          onRetry: (text) => progress.update(text),
        });
        progress.update('Loading categories…');
        const categories = await provider.categories(ctx);
        saveCategories(db, store, categories, new Date().toISOString());

        let categoryIds: string[] | null = null;
        if (request.categories.length > 0) {
          const { ids, unmatched } = resolveCategories(provider, categories, request.categories);
          if (unmatched.length > 0 || ids.length === 0) {
            throw new UserError(
              `${provider.info.name} has no category matching "${unmatched.join('", "') || request.categories.join('", "')}".`,
              [
                `See its categories with: swiss-grocery categories ${store}`,
                'Use a name (accents optional), an id, or "food" for all groceries.',
              ],
            );
          }
          categoryIds = ids;
          const names = categories.filter((c) => ids.includes(c.id)).map((c) => c.path.join(' > '));
          progress.clear();
          out.info(`  Categories: ${names.join(', ')}`);
        }
        if (request.details && !provider.fetchDetails) {
          progress.clear();
          out.hint(
            `${provider.info.name} publishes no extra product details; the listing already has everything.`,
          );
        }

        const result = await crawlStore({
          db,
          provider,
          ctx,
          kind: request.kind,
          categories,
          categoryIds,
          details: request.details,
          fresh: request.fresh,
          ...(request.limit ? { limit: request.limit } : {}),
          signal,
          onProgress: (p) => progress.update(describeProgress(p)),
        });
        progress.clear();
        reportResult(app, provider.info.name, result);
        outcomes.push({
          store,
          status: result.status,
          resumed: result.resumed,
          sample: result.sample,
          stats: result.stats,
          uniqueProducts: result.uniqueProducts,
          failures: result.failures,
          removalSkipped: result.removalSkipped,
          durationMs: result.durationMs,
        });
      } catch (error) {
        progress.clear();
        if (signal.aborted) {
          out.warn('Stopped. Progress so far is saved; run the same command again to continue.');
          outcomes.push({ store, status: 'interrupted' });
          break;
        }
        // A mistake in the command stops everything; the CLI prints it once.
        if (error instanceof UserError) throw error;
        const { message, hints } = explainError(error, app.options.verbose === true);
        out.error(`${provider.info.name}: ${message}`);
        for (const hint of hints) out.hint(hint);
        outcomes.push({ store, status: 'error', error: message });
      }
    }
  });

  // One spelling per brand across stores, and brands recognised in names (Denner, Coop wines).
  const brands = app.refreshBrands();
  if (out.options.json) {
    out.json({ database: app.dbPath, stores: outcomes, brands });
  } else if (outcomes.some((o) => o.status === 'completed' || o.status === 'failed')) {
    out.info();
    out.info(out.c.dim(`Saved to ${app.dbPath}`));
    const [first] = request.stores;
    const word = first ? SAMPLE_WORD[app.langFor(first)] : SAMPLE_WORD.de;
    out.info(
      `Next: ${out.c.cyan(`swiss-grocery search "${word}"`)}  ·  ${out.c.cyan('swiss-grocery status')}`,
    );
  }
  if (outcomes.some((o) => o.status === 'interrupted')) process.exitCode = 130; // conventional for Ctrl+C
  return outcomes.every((o) => o.status === 'completed');
}

const FETCH_EXAMPLES = `
Examples:
  $ swiss-grocery fetch aldi                    everything Aldi Suisse publishes (~1 minute)
  $ swiss-grocery fetch migros --all            the whole Migros catalog
  $ swiss-grocery fetch coop --category food    only groceries
  $ swiss-grocery fetch lidl denner             several stores, one after the other
  $ swiss-grocery fetch all                     every store
  $ swiss-grocery fetch aldi --details          + ingredients, origin, storage… (slower)
  $ swiss-grocery fetch aldi --limit 100        a quick sample to try things out

Good to know:
  • Fetching is polite: about 1–2 requests per second per store, and robots.txt is respected.
  • Press Ctrl+C to stop at any time. Progress is saved after every page;
    run the same command again to continue where it stopped.
  • Afterwards, keep prices fresh with: swiss-grocery update`;

const UPDATE_EXAMPLES = `
Examples:
  $ swiss-grocery update               refresh every store you have fetched before
  $ swiss-grocery update aldi lidl     only these stores
  $ swiss-grocery update --details     also fetch details for products that are new

What an update does:
  • Re-reads the store's listings (cheap: one request per 50–200 products).
  • Records price changes and promotions in the price history.
  • Adds new products and marks products that disappeared as "no longer listed".
  • Fetches product details only for new products, and only with --details.`;

function globalsOf(command: Command): GlobalOptions {
  return command.optsWithGlobals<GlobalOptions & { json?: boolean }>();
}

export function registerCrawlCommands(program: Command): void {
  program
    .command('fetch')
    .summary('download products and prices from stores')
    .description(
      'Download products and prices from one or more stores into your local database.\n' +
        'The first fetch of a store reads its whole catalog; later, `update` keeps it fresh.',
    )
    .argument('<stores...>', 'migros, coop, denner, aldi, lidl — or "all"')
    .option('--all', 'fetch the whole catalog (this is the default)')
    .option(
      '-c, --category <names...>',
      'only these categories: a name, an id, or "food" (see `categories`)',
    )
    .option(
      '-d, --details',
      'also fetch ingredients, nutrition, origin… (one extra request per product)',
    )
    .option('-n, --limit <count>', 'stop after about this many products (quick sample)')
    .option('--fresh', 'ignore saved progress from an interrupted fetch and start over')
    .option(
      '--rate <per-second>',
      'maximum requests per second (default: 1–2 depending on the store)',
    )
    .option('--json', 'print a machine-readable summary')
    .addHelpText('after', FETCH_EXAMPLES)
    .action(async (storeArgs: string[], opts: Record<string, unknown>, command: Command) => {
      const globals = globalsOf(command);
      const app = new App(globals, opts.json === true);
      try {
        if (opts.all && opts.category)
          throw new UserError('Use either --all or --category, not both.');
        let stores = parseStores(storeArgs);
        if (storeArgs.some((arg) => arg.toLowerCase().split(',').includes('all'))) {
          // "all" means every store that works; asking for one by name still tries it.
          for (const store of stores.filter((s) => getProvider(s).info.unavailable)) {
            app.out.hint(
              `Skipping ${getProvider(store).info.name}: ${getProvider(store).info.unavailable}`,
            );
          }
          stores = stores.filter((s) => !getProvider(s).info.unavailable);
        }
        const ok = await runCrawl(app, {
          kind: 'fetch',
          stores,
          categories: ((opts.category as string[] | undefined) ?? [])
            .flatMap((c) => c.split(','))
            .map((c) => c.trim())
            .filter(Boolean),
          details: opts.details ? 'seen' : false,
          fresh: opts.fresh === true,
          ...(opts.limit ? { limit: parsePositiveInt(String(opts.limit), '--limit') } : {}),
          ...(opts.rate ? { rate: parsePositiveNumber(String(opts.rate), '--rate') } : {}),
        });
        if (!ok) process.exitCode ??= 1;
      } finally {
        app.close();
      }
    });

  program
    .command('update')
    .summary('refresh prices and promotions, find new and removed products')
    .description(
      'Refresh the stores you have already fetched: current prices and promotions,\n' +
        'new products, and products that are no longer listed. Much cheaper than a first fetch.',
    )
    .argument('[stores...]', 'stores to update (default: every store in your database)')
    .option('-d, --details', 'also fetch details (ingredients, nutrition…) for new products')
    .option(
      '--rate <per-second>',
      'maximum requests per second (default: 1–2 depending on the store)',
    )
    .option('--json', 'print a machine-readable summary')
    .addHelpText('after', UPDATE_EXAMPLES)
    .action(async (storeArgs: string[], opts: Record<string, unknown>, command: Command) => {
      const app = new App(globalsOf(command), opts.json === true);
      try {
        let stores = storeArgs.length > 0 ? parseStores(storeArgs) : [];
        if (stores.length === 0) {
          stores = storeSummaries(app.db())
            .filter((s) => s.products + s.removed > 0)
            .map((s) => s.store);
          if (stores.length === 0) {
            throw new UserError('Nothing to update yet: your database is empty.', [
              'Fetch a store first, for example: swiss-grocery fetch aldi',
              'See all stores with: swiss-grocery stores',
            ]);
          }
        }
        const ok = await runCrawl(app, {
          kind: 'update',
          stores,
          categories: [],
          details: opts.details ? 'new' : false,
          fresh: false,
          ...(opts.rate ? { rate: parsePositiveNumber(String(opts.rate), '--rate') } : {}),
        });
        if (!ok) process.exitCode ??= 1;
      } finally {
        app.close();
      }
    });
}
