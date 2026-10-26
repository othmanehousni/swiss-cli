import { Command, Option } from 'commander';
import { registerBrandsCommand } from './commands/brands.js';
import { registerCrawlCommands } from './commands/crawl.js';
import { registerExportCommand } from './commands/export.js';
import {
  registerDoctorCommand,
  registerInfoCommands,
  registerStatusCommand,
  registerStoreCommands,
} from './commands/info.js';
import { registerQueryCommands } from './commands/query.js';
import { explainError, UserError } from './commands/shared.js';
import { registerSyncCommand } from './commands/sync.js';
import { loadDotEnv, VERSION } from './config.js';
import { registerMobilityCommands } from './modules/mobility/command.js';
import { registerPremiumsCommand } from './modules/premiums/command.js';
import { registerTransportCommands } from './modules/transport/command.js';
import { registerWeatherCommand } from './modules/weather/command.js';
import { LANGS } from './providers/types.js';
import { Output } from './ui/output.js';

const GROCERY_QUICK_START = `
Quick start:
  1. swiss-grocery fetch aldi          download Aldi Suisse's products (about a minute)
  2. swiss-grocery search "lait"       find products and compare prices
  3. swiss-grocery update              later on: refresh prices and promotions

Product names come in German unless you choose: for French, put SWISS_GROCERY_LANG=fr
in your .env file (or add --lang fr), then search in French as above.
Everything is stored on your computer (see where with: swiss-grocery status).
Help for any command: swiss-grocery <command> --help
More Swiss data (health insurance premiums...): swiss --help`;

const SWISS_QUICK_START = `
Examples:
  $ swiss grocery search lait                  compare shop prices (fetch a shop first)
  $ swiss premiums 8001 --age 34               health insurance premiums of every insurer
  $ swiss train Lausanne "Zürich HB"           next connections, with delays and platforms
  $ swiss departures Bern                      departure board
  $ swiss weather 3920                         MeteoSwiss forecast for Zermatt
  $ swiss charge near "Lausanne gare"          EV charging stations, live availability
  $ swiss sharing near Bern                    shared bikes, e-scooters and cars

Places can be a postcode (8001), a municipality (Lausanne) or an address.
Help for any command: swiss <command> --help`;

/** Options every command understands. */
function addGlobalOptions(program: Command): Command {
  return program
    .version(VERSION, '-v, --version', 'show the version')
    .helpOption('-h, --help', 'show help')
    .option(
      '--db <file>',
      'database file to use (default: your user data folder, or $SWISS_GROCERY_DB)',
    )
    .addOption(
      new Option(
        '--lang <language>',
        'language of names and texts (default: $SWISS_GROCERY_<STORE>_LANG, $SWISS_GROCERY_LANG or de)',
      ).choices([...LANGS]),
    )
    .option('--verbose', 'show each request and full error details')
    .option('-q, --quiet', 'print only results and errors')
    .option('--no-color', 'turn off colors')
    .showHelpAfterError('(run with --help to see how to use it)');
}

/** The shop commands: fetch, update, search, show, brands, export, stores, ... */
function registerGroceryCommands(program: Command): void {
  registerCrawlCommands(program);
  registerQueryCommands(program);
  registerBrandsCommand(program);
  registerExportCommand(program);
}

/** `swiss-grocery`: the shop price database on its own (as it always was). */
export function groceryProgram(): Command {
  const program = addGlobalOptions(
    new Command()
      .name('swiss-grocery')
      .description(
        'Migros, Coop, Denner, Aldi Suisse, Lidl Suisse and more in one place:\n' +
          'download their products and prices into a local database, then search, compare and export.',
      ),
  ).addHelpText('after', GROCERY_QUICK_START);
  registerGroceryCommands(program);
  registerInfoCommands(program);
  registerSyncCommand(program);
  return program;
}

/** `swiss`: Swiss data from the command line, the shops being one part of it. */
export function swissProgram(): Command {
  const program = addGlobalOptions(
    new Command()
      .name('swiss')
      .description(
        'Swiss data from the command line: shop prices, health insurance premiums, public ' +
          'transport, weather, charging stations and shared mobility. ' +
          'Only official and public sources, used politely.',
      ),
  ).addHelpText('after', SWISS_QUICK_START);

  const grocery = program
    .command('grocery')
    .alias('shops')
    .summary('shop prices: Migros, Coop, Denner, Aldi, Lidl')
    .description(
      'The shop price database: fetch the shops, then search, compare and export.\n' +
        'Same as the swiss-grocery command.',
    );
  registerGroceryCommands(grocery);
  registerStoreCommands(grocery);
  registerStatusCommand(grocery);
  registerDoctorCommand(grocery);
  registerSyncCommand(grocery);

  registerPremiumsCommand(program);
  registerTransportCommands(program);
  registerWeatherCommand(program);
  registerMobilityCommands(program);

  registerStatusCommand(program);
  registerDoctorCommand(program);
  registerSyncCommand(program);
  return program;
}

/** Parses the command line and prints errors once, with hints. */
export async function run(program: Command): Promise<void> {
  // `swiss grocery search lait | head` closes the pipe early; that is not an error.
  for (const stream of [process.stdout, process.stderr]) {
    stream.on('error', (error: NodeJS.ErrnoException) => {
      if (error.code === 'EPIPE') process.exit(0);
      throw error;
    });
  }
  loadDotEnv();
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
}
