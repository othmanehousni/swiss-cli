import { Option } from 'commander';
import { explainFirebaseError, FirebaseSetupError, firebaseConfig, syncToFirebase, } from '../sync/firebase.js';
import { explainSupabaseError, keyProblem, schemaSql, supabaseConfig, syncToSupabase, } from '../sync/supabase.js';
import { formatCount, formatDateTime } from '../ui/format.js';
import { ProgressLine } from '../ui/output.js';
import { App, UserError } from './shared.js';
const EXAMPLES = `
Setup, Supabase (once):
  1. Create the tables: Supabase dashboard -> SQL Editor -> New query, paste the
     output of \`swiss-grocery sync --print-schema\` and press Run
     (on a Mac, \`swiss-grocery sync --print-schema | pbcopy\` copies it).
  2. In a .env file in the folder you run swiss-grocery from (see .env.example):
       SUPABASE_URL=https://<project>.supabase.co
       SUPABASE_SECRET_KEY=sb_secret_...

Setup, Firebase (once):
  1. Firebase console -> Build -> Firestore Database -> Create database.
  2. Project settings -> Service accounts -> Generate new private key (a .json file).
  3. In the .env file:  FIREBASE_SERVICE_ACCOUNT=./your-key-file.json

Never share or commit these keys.

Examples:
  $ swiss-grocery sync                  send what changed to every target you set up
  $ swiss-grocery sync --to firebase    only to Firebase
  $ swiss-grocery sync --dry-run        only count what would be sent
  $ swiss-grocery sync --full           send everything again
  $ swiss-grocery update && swiss-grocery sync`;
const SETUP_HINTS = {
    supabase: ['Set SUPABASE_URL and SUPABASE_SECRET_KEY in a .env file or your environment.'],
    firebase: [
        'Set FIREBASE_SERVICE_ACCOUNT=./your-key-file.json in a .env file or your environment.',
    ],
};
/** The targets that are set up, or only the one asked for with --to. */
function targets(only) {
    const found = [];
    const supabase = supabaseConfig();
    if (supabase && only !== 'firebase') {
        const problem = keyProblem(supabase.key);
        if (problem)
            throw new UserError(`Sync failed: ${problem.message}.`, problem.hints);
        found.push({ kind: 'supabase', label: supabase.url, config: supabase });
    }
    if (only !== 'supabase') {
        let firebase;
        try {
            firebase = firebaseConfig();
        }
        catch (error) {
            if (!(error instanceof FirebaseSetupError))
                throw error;
            const { message, hints } = explainFirebaseError(error);
            throw new UserError(`Firebase is not set up correctly: ${message}.`, hints);
        }
        if (firebase) {
            found.push({
                kind: 'firebase',
                label: `Firebase project ${firebase.projectId}`,
                config: firebase,
            });
        }
    }
    if (found.length === 0) {
        throw new UserError(only
            ? `${only === 'supabase' ? 'Supabase' : 'Firebase'} is not set up.`
            : 'Nothing to sync to yet.', [
            ...(only ? SETUP_HINTS[only] : [...SETUP_HINTS.supabase, ...SETUP_HINTS.firebase]),
            'Step-by-step setup: swiss-grocery sync --help',
        ]);
    }
    return found;
}
export function registerSyncCommand(program) {
    program
        .command('sync')
        .summary('copy your local database to Supabase and/or Firebase (optional)')
        .description('Copy your local database to Supabase (Postgres) and/or Firebase (Firestore), e.g. to\n' +
        'power a website. Your computer stays the source of truth; only changes are sent.')
        .addOption(new Option('--to <target>', 'only this target (default: every one you set up)').choices([
        'supabase',
        'firebase',
    ]))
        .option('--full', 'send everything, not only what changed since the last sync')
        .option('--dry-run', 'show what would be sent without sending anything')
        .option('--print-schema', 'print the SQL that creates the Supabase tables, then exit')
        .option('--json', 'machine-readable output')
        .addHelpText('after', EXAMPLES)
        .action(async (opts, command) => {
        const app = new App(command.optsWithGlobals(), opts.json === true);
        try {
            if (opts.printSchema) {
                process.stdout.write(schemaSql());
                return;
            }
            const chosen = targets(opts.to);
            const results = [];
            const failures = [];
            for (const target of chosen) {
                const progress = new ProgressLine(app.out);
                progress.update('Preparing…');
                const common = {
                    full: opts.full === true,
                    dryRun: opts.dryRun === true,
                    onProgress: (text) => progress.update(text),
                };
                try {
                    if (target.kind === 'supabase') {
                        const result = await syncToSupabase(app.db(), target.config, common);
                        progress.clear();
                        results.push({ target: 'supabase', url: target.config.url, ...result });
                        const counts = `${formatCount(result.products)} products · ${formatCount(result.prices)} prices · ${formatCount(result.history)} price periods`;
                        report(app, target.label, counts, result.since, result.dryRun, result.requests);
                    }
                    else {
                        const result = await syncToFirebase(app.db(), target.config, common);
                        progress.clear();
                        results.push({ target: 'firebase', project: target.config.projectId, ...result });
                        const counts = `${formatCount(result.products)} products`;
                        report(app, target.label, counts, result.since, result.dryRun, result.requests);
                        if (result.resumed && !result.dryRun) {
                            app.out.hint('This continued a sync that had stopped before the end.');
                        }
                    }
                }
                catch (error) {
                    progress.clear();
                    const diagnosis = target.kind === 'supabase'
                        ? explainSupabaseError(error)
                        : explainFirebaseError(error);
                    failures.push({ target, diagnosis });
                    results.push({ target: target.kind, error: diagnosis.message });
                }
            }
            if (opts.json)
                app.out.json({ results });
            const [only] = failures;
            if (only && chosen.length === 1) {
                throw new UserError(`Sync failed: ${only.diagnosis.message}.`, only.diagnosis.hints, 1);
            }
            for (const { target, diagnosis } of failures) {
                app.out.error(`${target.label}: sync failed: ${diagnosis.message}.`);
                for (const hint of diagnosis.hints)
                    app.out.hint(hint);
            }
            if (failures.length > 0)
                process.exitCode = 1;
        }
        finally {
            app.close();
        }
    });
}
function report(app, label, counts, since, dryRun, requests) {
    const scope = since ? `changes since ${formatDateTime(since)}` : 'everything';
    if (dryRun)
        app.out.info(`Would send ${counts} (${scope}) to ${label}`);
    else
        app.out.success(`Sent ${counts} (${scope}) to ${label} in ${requests} requests`);
}
