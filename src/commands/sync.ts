import type { Command } from 'commander';
import {
  explainSupabaseError,
  keyProblem,
  schemaSql,
  supabaseConfig,
  syncToSupabase,
} from '../sync/supabase.js';
import { formatCount, formatDateTime } from '../ui/format.js';
import { ProgressLine } from '../ui/output.js';
import { App, type GlobalOptions, UserError } from './shared.js';

const EXAMPLES = `
Setup (once):
  1. Create the tables: Supabase dashboard -> SQL Editor -> New query, paste the
     output of \`swiss-grocery sync --print-schema\` and press Run.
  2. Put your project URL and secret key in a .env file in the folder you run
     swiss-grocery from (see .env.example), or in your environment:
       SUPABASE_URL=https://<project>.supabase.co
       SUPABASE_SECRET_KEY=sb_secret_...
     Never share or commit the secret key.

Examples:
  $ swiss-grocery sync                send what changed since the last sync
  $ swiss-grocery sync --dry-run      only count what would be sent
  $ swiss-grocery sync --full         send everything again
  $ swiss-grocery update && swiss-grocery sync`;

export function registerSyncCommand(program: Command): void {
  program
    .command('sync')
    .summary('copy your local database to Supabase (optional)')
    .description(
      'Copy your local database to a Supabase (Postgres) project, e.g. to power a website.\n' +
        'Your computer stays the source of truth; only changes are sent each time.',
    )
    .option('--full', 'send everything, not only what changed since the last sync')
    .option('--dry-run', 'show what would be sent without sending anything')
    .option('--print-schema', 'print the SQL that creates the Supabase tables, then exit')
    .option('--json', 'machine-readable output')
    .addHelpText('after', EXAMPLES)
    .action(async (opts: Record<string, boolean | undefined>, command: Command) => {
      const app = new App(command.optsWithGlobals<GlobalOptions>(), opts.json === true);
      try {
        if (opts.printSchema) {
          process.stdout.write(schemaSql());
          return;
        }
        const config = supabaseConfig();
        if (!config) {
          throw new UserError('Supabase is not configured.', [
            'Set SUPABASE_URL and SUPABASE_SECRET_KEY (in a .env file or your environment).',
            'Step-by-step setup: swiss-grocery sync --help',
          ]);
        }
        const problem = keyProblem(config.key);
        if (problem) throw new UserError(`Sync failed: ${problem.message}.`, problem.hints);
        const progress = new ProgressLine(app.out);
        progress.update('Preparing…');
        try {
          const result = await syncToSupabase(app.db(), config, {
            full: opts.full === true,
            dryRun: opts.dryRun === true,
            onProgress: (text) => progress.update(text),
          });
          progress.clear();
          if (opts.json) {
            app.out.json({ target: config.url, ...result });
            return;
          }
          const counts = `${formatCount(result.products)} products · ${formatCount(result.prices)} prices · ${formatCount(result.history)} price periods`;
          const scope = result.since
            ? `changes since ${formatDateTime(result.since)}`
            : 'everything';
          if (result.dryRun) app.out.info(`Would send ${counts} (${scope}) to ${config.url}`);
          else
            app.out.success(
              `Sent ${counts} (${scope}) to ${config.url} in ${result.requests} requests`,
            );
        } catch (error) {
          progress.clear();
          const diagnosis = explainSupabaseError(error);
          throw new UserError(`Sync failed: ${diagnosis.message}.`, diagnosis.hints, 1);
        }
      } finally {
        app.close();
      }
    });
}
