#!/usr/bin/env node
import { Command, Option } from 'commander';
import { registerCrawlCommands } from './commands/crawl.js';
import { registerExportCommand } from './commands/export.js';
import { registerInfoCommands } from './commands/info.js';
import { registerQueryCommands } from './commands/query.js';
import { explainError, UserError } from './commands/shared.js';
import { registerSyncCommand } from './commands/sync.js';
import { loadDotEnv, VERSION } from './config.js';
import { LANGS } from './providers/types.js';
import { Output } from './ui/output.js';

const QUICK_START = `
Quick start:
  1. swiss-grocery fetch aldi          download Aldi Suisse's products (about a minute)
  2. swiss-grocery search "milch"      find products and compare prices
  3. swiss-grocery update              later on: refresh prices and promotions

Everything is stored on your computer (see where with: swiss-grocery status).
Help for any command: swiss-grocery <command> --help`;

// `swiss-grocery search milch | head` closes the pipe early; that is not an error.
for (const stream of [process.stdout, process.stderr]) {
  stream.on('error', (error: NodeJS.ErrnoException) => {
    if (error.code === 'EPIPE') process.exit(0);
    throw error;
  });
}

loadDotEnv();

const program = new Command()
  .name('swiss-grocery')
  .description(
    'Migros, Coop, Denner, Aldi Suisse and Lidl Suisse in one place:\n' +
      'download their products and prices into a local database, then search, compare and export.',
  )
  .version(VERSION, '-v, --version', 'show the version')
  .helpOption('-h, --help', 'show help')
  .option(
    '--db <file>',
    'database file to use (default: your user data folder, or $SWISS_GROCERY_DB)',
  )
  .addOption(
    new Option(
      '--lang <language>',
      'language for product names and descriptions (default: $SWISS_GROCERY_<STORE>_LANG, $SWISS_GROCERY_LANG or de)',
    ).choices([...LANGS]),
  )
  .option('--verbose', 'show each request and full error details')
  .option('-q, --quiet', 'print only results and errors')
  .option('--no-color', 'turn off colors')
  .showHelpAfterError('(run with --help to see how to use it)')
  .addHelpText('after', QUICK_START);

registerCrawlCommands(program);
registerQueryCommands(program);
registerExportCommand(program);
registerInfoCommands(program);
registerSyncCommand(program);

try {
  await program.parseAsync(process.argv);
} catch (error) {
  const options = program.opts<{ verbose?: boolean; color?: boolean }>();
  const out = new Output({
    quiet: false,
    verbose: options.verbose === true,
    color: options.color !== false,
    json: false,
  });
  const { message, hints } = explainError(error, options.verbose === true);
  out.error(message);
  for (const hint of hints) out.hint(hint);
  process.exitCode = error instanceof UserError ? error.exitCode : 1;
}
