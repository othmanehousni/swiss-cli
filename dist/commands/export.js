import { once } from 'node:events';
import { createWriteStream, mkdirSync, statSync } from 'node:fs';
import { dirname, extname, resolve } from 'node:path';
import { databaseTotals, iteratePriceHistory, iterateProducts, } from '../storage/queries.js';
import { formatBytes, formatCount } from '../ui/format.js';
import { DEFAULT_EXPORT_FIELDS, parseFields } from './fields.js';
import { App, parseBrands, parseStores, UserError } from './shared.js';
const FORMATS = {
    '.csv': 'csv',
    '.json': 'json',
    '.jsonl': 'jsonl',
    '.ndjson': 'jsonl',
};
/** Quotes a CSV cell (RFC 4180) and neutralizes spreadsheet formulas in untrusted text. */
export function csvCell(value, delimiter) {
    if (value == null)
        return '';
    let text = String(value);
    if (typeof value === 'string' && (/^[=+@\t\r]/.test(text) || /^-(?![\d.,%\s])/.test(text))) {
        text = `'${text}`; // stops Excel/Sheets from running a product name as a formula
    }
    return text.includes(delimiter) || /["\r\n]/.test(text) || text !== text.trim()
        ? `"${text.replace(/"/g, '""')}"`
        : text;
}
async function write(stream, chunk) {
    if (!stream.write(chunk))
        await once(stream, 'drain');
}
async function writeRows(stream, format, header, rows, options) {
    let count = 0;
    if (format === 'csv') {
        await write(stream, `${options.bom ? '\uFEFF' : ''}${header.map((h) => csvCell(h, options.delimiter)).join(options.delimiter)}\r\n`);
        for (const row of rows) {
            await write(stream, `${header.map((h) => csvCell(row[h] ?? null, options.delimiter)).join(options.delimiter)}\r\n`);
            count++;
        }
    }
    else if (format === 'jsonl') {
        for (const row of rows) {
            await write(stream, `${JSON.stringify(row)}\n`);
            count++;
        }
    }
    else {
        await write(stream, '[');
        for (const row of rows) {
            await write(stream, `${count === 0 ? '\n' : ',\n'}  ${JSON.stringify(row)}`);
            count++;
        }
        await write(stream, count === 0 ? ']\n' : '\n]\n');
    }
    return count;
}
const EXAMPLES = `
Examples:
  $ swiss-grocery export products.csv                       all products (opens in Excel)
  $ swiss-grocery export migros.json --store migros
  $ swiss-grocery export deals.csv --promo                  only promotions
  $ swiss-grocery export lindt.csv --brand lindt            only one brand
  $ swiss-grocery export full.csv --fields all              every field, incl. ingredients
  $ swiss-grocery export history.csv --history              the full price history
  $ swiss-grocery export - --format jsonl | head            to the terminal / another program

Excel tips:
  • Umlauts look wrong? Keep the default (a UTF-8 marker is written for Excel).
  • Everything lands in one column? Your Excel expects semicolons: add --delimiter ";"`;
export function registerExportCommand(program) {
    program
        .command('export')
        .summary('save products or price history to CSV, JSON or JSON Lines')
        .description('Save products (or the price history) from your database to a file.')
        .argument('<file>', 'output file: .csv, .json or .jsonl (use - for the terminal)')
        .option('--format <format>', 'csv, json or jsonl (default: from the file name)')
        .option('-s, --store <stores>', 'only these stores, comma-separated')
        .option('-p, --promo', 'only products on promotion')
        .option('-c, --category <text>', 'only products whose category contains this text')
        .option('-b, --brand <brands>', 'only these brands, comma-separated (see `brands`)')
        .option('-f, --fields <list>', `columns to include (default: ${DEFAULT_EXPORT_FIELDS.join(',')}) or "all"`)
        .option('--history', 'export the price history (one row per price period) instead of products')
        .option('--include-removed', 'include products the store no longer lists')
        .option('--delimiter <char>', 'CSV separator; use ";" for Excel with Swiss/German settings', ',')
        .option('--no-bom', 'do not write the UTF-8 marker Excel needs for umlauts')
        .addHelpText('after', EXAMPLES)
        .action(async (file, opts, command) => {
        const app = new App(command.optsWithGlobals());
        try {
            const format = (opts.format
                ? String(opts.format).toLowerCase()
                : (FORMATS[extname(file).toLowerCase()] ?? 'csv'));
            if (!['csv', 'json', 'jsonl'].includes(format)) {
                throw new UserError(`Unknown format "${format}".`, ['Use csv, json or jsonl.']);
            }
            const delimiter = String(opts.delimiter ?? ',').replace('\\t', '\t');
            if (delimiter.length !== 1)
                throw new UserError('--delimiter must be a single character, e.g. "," or ";".');
            const db = app.db();
            if (databaseTotals(db).products === 0) {
                throw new UserError('Your database is empty, so there is nothing to export yet.', [
                    'Fetch a store first: swiss-grocery fetch aldi',
                ]);
            }
            const filter = {
                ...(opts.store ? { stores: parseStores([String(opts.store)]) } : {}),
                onlyPromotions: opts.promo === true,
                includeRemoved: opts.includeRemoved === true,
                ...(opts.category ? { category: String(opts.category) } : {}),
                ...(opts.brand ? { brands: parseBrands(String(opts.brand)) } : {}),
            };
            const toStdout = file === '-';
            const path = toStdout ? null : resolve(file);
            if (path)
                mkdirSync(dirname(path), { recursive: true });
            const stream = toStdout ? process.stdout : createWriteStream(path);
            let count;
            let what;
            if (opts.history) {
                const header = [
                    'product_id',
                    'store',
                    'name',
                    'price',
                    'regular_price',
                    'loyalty_price',
                    'promo_label',
                    'valid_until',
                    'first_seen_at',
                    'last_seen_at',
                ];
                count = await writeRows(stream, format, header, iteratePriceHistory(db, filter), {
                    delimiter,
                    bom: opts.bom !== false,
                });
                what = 'price periods';
            }
            else {
                const fields = parseFields(opts.fields ? String(opts.fields) : undefined, DEFAULT_EXPORT_FIELDS);
                const rows = (function* () {
                    for (const row of iterateProducts(db, filter)) {
                        yield Object.fromEntries(fields.map((f) => [f.key, f.value(row)]));
                    }
                })();
                count = await writeRows(stream, format, fields.map((f) => f.key), rows, { delimiter, bom: opts.bom !== false });
                what = 'products';
            }
            if (!toStdout) {
                stream.end();
                await once(stream, 'finish');
                app.out.success(`Exported ${formatCount(count)} ${what} to ${file} (${formatBytes(statSync(path).size)})`);
                if (format === 'csv' && delimiter === ',') {
                    app.out.hint('Opening in Excel and everything is in one column? Re-export with --delimiter ";"');
                }
            }
        }
        finally {
            app.close();
        }
    });
}
