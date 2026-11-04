import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { parseEnv } from 'node:util';
import { LANGS } from './providers/types.js';
export const APP_NAME = 'swiss-grocery';
export const REPOSITORY_URL = 'https://github.com/othmanehousni/swiss-cli';
export const VERSION = createRequire(import.meta.url)('../package.json').version;
/** Loads `.env` from the current folder. Variables already set in the shell win. */
export function loadDotEnv(path = resolve('.env')) {
    if (!existsSync(path))
        return;
    const values = parseEnv(readFileSync(path, 'utf-8'));
    for (const [key, value] of Object.entries(values)) {
        if (process.env[key] === undefined)
            process.env[key] = value;
    }
}
/** Where swiss-grocery keeps its data, following each OS's convention. */
export function dataDirectory() {
    const env = process.env;
    if (process.platform === 'win32') {
        return join(env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local'), APP_NAME);
    }
    if (process.platform === 'darwin') {
        return join(homedir(), 'Library', 'Application Support', APP_NAME);
    }
    return join(env.XDG_DATA_HOME ?? join(homedir(), '.local', 'share'), APP_NAME);
}
export function defaultDatabasePath() {
    return process.env.SWISS_GROCERY_DB?.trim() || join(dataDirectory(), 'grocery.db');
}
export function userAgent() {
    return (process.env.SWISS_GROCERY_USER_AGENT?.trim() || `${APP_NAME}/${VERSION} (+${REPOSITORY_URL})`);
}
export function defaultLang() {
    const lang = process.env.SWISS_GROCERY_LANG?.trim().toLowerCase();
    return LANGS.includes(lang ?? '') ? lang : 'de';
}
export const ACCEPT_LANGUAGE = {
    de: 'de-CH,de;q=0.9,en;q=0.5',
    fr: 'fr-CH,fr;q=0.9,en;q=0.5',
    it: 'it-CH,it;q=0.9,en;q=0.5',
};
