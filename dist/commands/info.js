import { accessSync, constants, existsSync, statSync } from 'node:fs';
import { dirname } from 'node:path';
import { CACHE_SOURCES, DATA_SOURCES } from '../modules/sources.js';
import { FOOD_ALIASES, resolveCategories } from '../providers/categories.js';
import { allProviders, getProvider } from '../providers/index.js';
import { cacheSummary } from '../storage/cache.js';
import { loadCategories, saveCategories } from '../storage/products.js';
import { databaseTotals, storeSummaries } from '../storage/queries.js';
import { checkFirebase, explainFirebaseError, firebaseConfig, } from '../sync/firebase.js';
import { checkSupabase, supabaseConfig } from '../sync/supabase.js';
import { formatAgo, formatBytes, formatCount, formatDuration, formatPercent, } from '../ui/format.js';
import { ProgressLine } from '../ui/output.js';
import { App, explainError, parseStores, providerContext, sourceClient, UserError, } from './shared.js';
const MIN_NODE = [22, 13];
function nodeVersionOk() {
    const [major = 0, minor = 0] = process.versions.node.split('.').map(Number);
    return (major > MIN_NODE[0] || (major === MIN_NODE[0] && minor >= MIN_NODE[1]));
}
/** All the commands about the stores, for `swiss-grocery`. */
export function registerInfoCommands(program) {
    registerStoreCommands(program);
    registerStatusCommand(program);
    registerDoctorCommand(program);
}
/** `stores` and `categories`. */
export function registerStoreCommands(program) {
    program
        .command('stores')
        .summary('list supported stores and what each one publishes online')
        .description('List the supported stores, what each one publishes online, and what you have fetched.')
        .option('--json', 'machine-readable output')
        .action((opts, command) => {
        const app = new App(command.optsWithGlobals(), opts.json === true);
        try {
            const summaries = existsSync(app.dbPath) ? storeSummaries(app.db()) : [];
            const rows = allProviders().map((p) => {
                const s = summaries.find((x) => x.store === p.info.id);
                return { provider: p, summary: s };
            });
            if (opts.json) {
                app.out.json(rows.map(({ provider, summary }) => ({
                    id: provider.info.id,
                    name: provider.info.name,
                    website: provider.info.website,
                    coverage: provider.info.coverage,
                    status: provider.info.unavailable
                        ? 'not working'
                        : provider.info.verified
                            ? 'ready'
                            : 'experimental',
                    ...(provider.info.unavailable ? { problem: provider.info.unavailable } : {}),
                    products: summary?.products ?? 0,
                    lastUpdate: summary?.lastSuccess ?? null,
                })));
                return;
            }
            const { out } = app;
            out.print();
            for (const { provider, summary } of rows) {
                const badge = provider.info.unavailable
                    ? out.c.red('not working')
                    : provider.info.verified
                        ? out.c.green('ready')
                        : out.c.yellow('experimental');
                out.print(`  ${out.c.bold(provider.info.name)} ${out.c.dim(`(${provider.info.id})`)}  ${badge}`);
                out.print(`    ${provider.info.coverage}`);
                if (provider.info.unavailable)
                    out.print(`    ${out.c.red(provider.info.unavailable)}`);
                out.print(out.c.dim(summary && summary.products > 0
                    ? `    In your database: ${formatCount(summary.products)} products · last update ${formatAgo(summary.lastSuccess)}`
                    : `    Not fetched yet: swiss-grocery fetch ${provider.info.id}`));
                out.print();
            }
            out.print(out.c.dim('  "experimental": the store blocked the network this tool was built on, so it is untested.'));
            if (rows.some(({ provider }) => provider.info.unavailable)) {
                out.print(out.c.dim('  "not working": the store changed its website; `fetch all` skips it until it is fixed.'));
            }
            out.print(out.c.dim('  Check any store from your own connection with: swiss-grocery doctor'));
        }
        finally {
            app.close();
        }
    });
    program
        .command('categories')
        .summary("show a store's categories (for fetch --category)")
        .description("Show a store's categories, with the names and ids you can use with `fetch --category`.")
        .argument('<store>', 'migros, coop, denner, aldi or lidl')
        .option('--json', 'machine-readable output')
        .action(async (storeArg, opts, command) => {
        const app = new App(command.optsWithGlobals(), opts.json === true);
        try {
            const [store] = parseStores([storeArg], { allowAll: false });
            if (!store)
                throw new UserError('Please name one store, e.g. swiss-grocery categories aldi');
            const provider = getProvider(store);
            const progress = new ProgressLine(app.out);
            progress.update(`Loading ${provider.info.name} categories…`);
            let categories = loadCategories(app.db(), store);
            let source = 'saved';
            try {
                categories = await provider.categories(providerContext(app, provider));
                saveCategories(app.db(), store, categories, new Date().toISOString());
                source = 'live';
            }
            catch (error) {
                progress.clear();
                if (categories.length === 0)
                    throw error;
                app.out.warn(`Could not load live categories (${explainError(error).message}); showing the saved list.`);
            }
            progress.clear();
            if (opts.json) {
                app.out.json(categories);
                return;
            }
            const { out } = app;
            const food = resolveCategories(provider, categories, ['food']).ids;
            out.print();
            out.print(`  ${out.c.bold(provider.info.name)} · ${categories.length} categories ${out.c.dim(`(${source})`)}`);
            out.print();
            out.table(categories, [
                {
                    header: 'Category',
                    value: (c) => `${'  '.repeat(c.path.length - 1)}${c.name}`,
                    flex: true,
                    style: (t, c) => (c.parentId === null ? out.c.bold(t) : t),
                },
                { header: 'Id', value: (c) => c.id, style: (t) => out.c.dim(t) },
                {
                    header: 'Products',
                    value: (c) => (c.productCount != null ? formatCount(c.productCount) : ''),
                    align: 'right',
                },
            ]);
            out.print();
            const example = categories.find((c) => c.parentId === null)?.name ?? 'food';
            out.print(`  Fetch one: ${out.c.cyan(`swiss-grocery fetch ${store} --category "${example}"`)}`);
            out.print(out.c.dim(`  "${FOOD_ALIASES[0]}" selects the grocery sections: ${categories
                .filter((c) => food.includes(c.id))
                .map((c) => c.name)
                .join(', ') || 'none'}`));
        }
        finally {
            app.close();
        }
    });
}
/** What is in the database: products per store, freshness, completeness. */
export function registerStatusCommand(program) {
    program
        .command('status')
        .summary('what is in your database, how fresh and how complete it is')
        .description('Show what is in your database, when each store was last updated, and data completeness.')
        .option('--json', 'machine-readable output')
        .action((opts, command) => {
        const app = new App(command.optsWithGlobals(), opts.json === true);
        try {
            const db = app.db();
            const summaries = storeSummaries(db);
            const totals = databaseTotals(db);
            const size = existsSync(app.dbPath) ? statSync(app.dbPath).size : 0;
            const cache = cacheSummary(db);
            if (opts.json) {
                app.out.json({
                    database: app.dbPath,
                    sizeBytes: size,
                    ...totals,
                    stores: summaries,
                    savedAnswers: cache,
                });
                return;
            }
            const { out } = app;
            out.print();
            out.print(`  ${out.c.dim('Database')}  ${app.dbPath} (${formatBytes(size)})`);
            out.print(`  ${out.c.dim('Contents')}  ${formatCount(totals.products)} products · ${formatCount(totals.priceObservations)} price periods`);
            out.print();
            out.table(summaries, [
                { header: 'Store', value: (s) => getProvider(s.store).info.name },
                {
                    header: 'Products',
                    value: (s) => (s.products ? formatCount(s.products) : '–'),
                    align: 'right',
                },
                {
                    header: 'On promo',
                    value: (s) => (s.products ? formatCount(s.onPromotion) : '–'),
                    align: 'right',
                },
                {
                    header: 'Gone',
                    value: (s) => (s.removed ? formatCount(s.removed) : '–'),
                    align: 'right',
                },
                { header: 'Last update', value: (s) => formatAgo(s.lastSuccess) },
                { header: 'Price', value: (s) => formatPercent(s.withPrice, s.products), align: 'right' },
                {
                    header: 'Unit price',
                    value: (s) => formatPercent(s.withUnitPrice, s.products),
                    align: 'right',
                },
                { header: 'Brand', value: (s) => formatPercent(s.withBrand, s.products), align: 'right' },
                {
                    header: 'Details',
                    value: (s) => getProvider(s.store).fetchDetails ? formatPercent(s.withDetails, s.products) : 'n/a',
                    align: 'right',
                },
            ]);
            out.print();
            out.print(out.c.dim('  Price / Unit price / Brand / Details: share of products that have them (data completeness).'));
            out.print(out.c.dim('  "Gone": products the store stopped listing (kept for their price history).'));
            for (const s of summaries) {
                if (s.lastRun && s.lastRun.status !== 'completed' && s.lastRun.status !== 'abandoned') {
                    const what = s.lastRun.status === 'interrupted' || s.lastRun.status === 'running'
                        ? 'was interrupted'
                        : 'did not finish';
                    out.warn(`${getProvider(s.store).info.name}: the last ${s.lastRun.kind} ${what} (${formatAgo(s.lastRun.startedAt)}).`);
                    out.hint(`Continue it with: swiss-grocery ${s.lastRun.kind} ${s.store}`);
                }
            }
            if (cache.length > 0) {
                const answers = cache.reduce((sum, g) => sum + g.answers, 0);
                const bytes = cache.reduce((sum, g) => sum + g.bytes, 0);
                const what = cache.map((g) => CACHE_SOURCES[g.source] ?? g.source).join(', ');
                out.print();
                out.print(`  ${out.c.dim('Saved answers')}  ${formatCount(answers)} (${formatBytes(bytes)}): ${what}`);
                out.print(out.c.dim('  Kept so repeated questions are quick and work offline; old ones are removed by themselves.'));
            }
            if (totals.products === 0)
                out.print(`\n  Get started: ${out.c.cyan('swiss-grocery fetch aldi')}`);
            else
                out.print(`\n  Keep prices fresh: ${out.c.cyan('swiss-grocery update')}`);
        }
        finally {
            app.close();
        }
    });
}
/** Checks the setup and tests each store (and the public data sources) from this connection. */
export function registerDoctorCommand(program, { sources = false } = {}) {
    program
        .command('doctor')
        .summary(sources
        ? 'check your setup and whether each store and data source can be reached'
        : 'check your setup and whether each store can be reached')
        .description('Check your setup and test each store from your connection: robots.txt, the category ' +
        'list and one page of products (a handful of requests per store)' +
        (sources ? ', then one small request to each public data source.' : '.'))
        .argument('[stores...]', 'stores to test (default: all)')
        .action(async (storeArgs, _opts, command) => {
        const app = new App(command.optsWithGlobals());
        let healthy = true;
        try {
            const { out } = app;
            out.print();
            out.print(`  ${out.c.bold('Your setup')}`);
            if (nodeVersionOk())
                out.print(`  ${out.c.green('✔')} Node.js ${process.versions.node}`);
            else {
                healthy = false;
                out.print(`  ${out.c.red('✖')} Node.js ${process.versions.node}: version ${MIN_NODE.join('.')} or newer is needed`);
            }
            try {
                const folder = existsSync(app.dbPath) ? app.dbPath : dirname(app.dbPath);
                if (existsSync(folder))
                    accessSync(folder, constants.W_OK);
                app.db();
                out.print(`  ${out.c.green('✔')} Database ${app.dbPath}`);
            }
            catch (error) {
                healthy = false;
                out.print(`  ${out.c.red('✖')} Database ${app.dbPath}: ${error.message}`);
                out.print(`      ${out.c.cyan('→')} choose another location with --db <file> or SWISS_GROCERY_DB`);
            }
            const proxy = process.env.HTTPS_PROXY ||
                process.env.https_proxy ||
                process.env.HTTP_PROXY ||
                process.env.http_proxy;
            out.print(`  ${out.c.green('✔')} Network: ${proxy ? `through the proxy in HTTPS_PROXY` : 'direct (no proxy)'}`);
            const supabase = supabaseConfig();
            if (!supabase) {
                out.print(`  ${out.c.dim('○')} Supabase not configured ${out.c.dim('(optional, only for `sync`)')}`);
            }
            else {
                const check = await checkSupabase(supabase);
                if (!check.ok)
                    healthy = false;
                out.print(`  ${check.ok ? out.c.green('✔') : out.c.red('✖')} Supabase ${supabase.url}: ${check.message}`);
                for (const hint of check.hints)
                    out.print(`      ${out.c.cyan('→')} ${hint}`);
            }
            let firebase = null;
            let firebaseCheck = null;
            try {
                firebase = firebaseConfig();
            }
            catch (error) {
                firebaseCheck = explainFirebaseError(error);
            }
            if (firebase)
                firebaseCheck = await checkFirebase(firebase);
            if (!firebaseCheck) {
                out.print(`  ${out.c.dim('○')} Firebase not configured ${out.c.dim('(optional, only for `sync`)')}`);
            }
            else {
                if (!firebaseCheck.ok)
                    healthy = false;
                const where = firebase ? ` project ${firebase.projectId}` : '';
                out.print(`  ${firebaseCheck.ok ? out.c.green('✔') : out.c.red('✖')} Firebase${where}: ${firebaseCheck.message}`);
                for (const hint of firebaseCheck.hints)
                    out.print(`      ${out.c.cyan('→')} ${hint}`);
            }
            out.print();
            out.print(`  ${out.c.bold('Stores')} ${out.c.dim('(robots.txt, categories, one page of products)')}`);
            const stores = storeArgs.length > 0 ? parseStores(storeArgs) : allProviders().map((p) => p.info.id);
            for (const store of stores) {
                const provider = getProvider(store);
                const progress = new ProgressLine(out);
                progress.update(`Testing ${provider.info.name}…`);
                const started = Date.now();
                try {
                    const ctx = providerContext(app, provider);
                    const categories = await provider.categories(ctx);
                    const [source] = provider.sources(categories, null);
                    if (!source)
                        throw new Error('no catalog sections found');
                    const page = await provider.fetchPage(ctx, source, null);
                    const priced = page.products.filter((p) => p.price != null).length;
                    if (page.products.length === 0)
                        throw new Error('the first page of products was empty');
                    progress.clear();
                    out.print(`  ${out.c.green('✔')} ${provider.info.name.padEnd(12)} works · ${categories.length} categories · ` +
                        `${page.products.length} products on the first page (${priced} with a price) · ${formatDuration(Date.now() - started)}`);
                    if (!provider.info.verified) {
                        out.print(`      ${out.c.cyan('→')} it works from your connection, so you can use it normally`);
                    }
                }
                catch (error) {
                    progress.clear();
                    healthy = false;
                    const { message, hints } = explainError(error, app.options.verbose === true);
                    out.print(`  ${out.c.red('✖')} ${provider.info.name.padEnd(12)} ${message}`);
                    if (hints[0])
                        out.print(`      ${out.c.cyan('→')} ${hints[0]}`);
                }
            }
            if (sources && storeArgs.length === 0) {
                out.print();
                out.print(`  ${out.c.bold('Data sources')} ${out.c.dim('(one small request each)')}`);
                for (const source of DATA_SOURCES) {
                    const progress = new ProgressLine(out);
                    progress.update(`Testing ${source.name}…`);
                    const started = Date.now();
                    try {
                        await sourceClient(app, source.name, {
                            timeoutMs: 30_000,
                        }).getText(source.url);
                        progress.clear();
                        out.print(`  ${out.c.green('✔')} ${source.name.padEnd(28)} ${out.c.dim(`${source.what} · ${formatDuration(Date.now() - started)}`)}`);
                    }
                    catch (error) {
                        progress.clear();
                        healthy = false;
                        const { message, hints } = explainError(error, app.options.verbose === true);
                        out.print(`  ${out.c.red('✖')} ${source.name.padEnd(28)} ${message}`);
                        if (hints[0])
                            out.print(`      ${out.c.cyan('→')} ${hints[0]}`);
                    }
                }
            }
            out.print();
            if (!healthy)
                process.exitCode = 1;
        }
        finally {
            app.close();
        }
    });
}
