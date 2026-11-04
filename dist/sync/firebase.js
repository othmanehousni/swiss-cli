import { createSign } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { userAgent } from '../config.js';
import { HttpError, NetworkError } from '../crawler/errors.js';
import { HttpClient } from '../crawler/http.js';
import { isStoreId } from '../normalization/types.js';
import { getProvider } from '../providers/index.js';
/**
 * Copies the local database to Cloud Firestore (Firebase), as an alternative to
 * Supabase, through Firestore's REST API (no SDK needed). One document per product,
 * grouped by store so that each shop is its own collection in the Firebase console:
 *
 *   stores/{store}                            { store, name }
 *   stores/{store}/products/{product number}  product, current price, price history
 *
 * Firestore bills per document written (the free plan allows 20,000 writes a day),
 * so a sync writes only products that changed since the last one, and a sync that
 * stops (quota, network, Ctrl+C) continues where it stopped next time.
 */
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const SCOPE = 'https://www.googleapis.com/auth/datastore';
/** Products per commit (Firestore allows 500 writes; a few store documents ride along). */
const BATCH_SIZE = 300;
/** The Firebase settings in .env are incomplete or unreadable. */
export class FirebaseSetupError extends Error {
    name = 'FirebaseSetupError';
}
/**
 * Reads the service account from FIREBASE_SERVICE_ACCOUNT (the JSON key file) or
 * from FIREBASE_PROJECT_ID + FIREBASE_CLIENT_EMAIL + FIREBASE_PRIVATE_KEY.
 * Returns null when Firebase is not set up at all.
 */
export function firebaseConfig(env = process.env) {
    const databaseId = env.FIREBASE_DATABASE_ID?.trim() || '(default)';
    const file = env.FIREBASE_SERVICE_ACCOUNT?.trim();
    if (file) {
        let account;
        try {
            account = JSON.parse(readFileSync(resolve(file), 'utf-8'));
        }
        catch (error) {
            throw new FirebaseSetupError(`could not read the service account file ${file} (${error.message})`);
        }
        const { project_id: projectId, client_email: clientEmail, private_key: privateKey } = account;
        if (typeof projectId !== 'string' ||
            typeof clientEmail !== 'string' ||
            typeof privateKey !== 'string') {
            throw new FirebaseSetupError(`${file} is not a service account key (it needs project_id, client_email and private_key)`);
        }
        return { projectId, clientEmail, privateKey, databaseId };
    }
    const projectId = env.FIREBASE_PROJECT_ID?.trim();
    const clientEmail = env.FIREBASE_CLIENT_EMAIL?.trim();
    // In a .env file the key's line breaks are usually written as \n.
    const privateKey = env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n').trim();
    if (!projectId && !clientEmail && !privateKey)
        return null;
    if (!projectId || !clientEmail || !privateKey) {
        throw new FirebaseSetupError('set FIREBASE_PROJECT_ID, FIREBASE_CLIENT_EMAIL and FIREBASE_PRIVATE_KEY together (or FIREBASE_SERVICE_ACCOUNT)');
    }
    return { projectId, clientEmail, privateKey, databaseId };
}
/** The sync_state key of a Firebase project. */
export function firebaseTarget(config) {
    return `firebase:${config.projectId}/${config.databaseId}`;
}
/** A service-account login token request (RFC 7523 JWT bearer grant). */
export function signedJwt(config, nowSeconds) {
    const part = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
    const unsigned = `${part({ alg: 'RS256', typ: 'JWT' })}.${part({
        iss: config.clientEmail,
        scope: SCOPE,
        aud: TOKEN_URL,
        iat: nowSeconds,
        exp: nowSeconds + 3600,
    })}`;
    let signature;
    try {
        signature = createSign('RSA-SHA256').update(unsigned).sign(config.privateKey);
    }
    catch {
        throw new FirebaseSetupError('the private key of the service account is not valid (copy the whole key, BEGIN and END lines included)');
    }
    return `${unsigned}.${signature.toString('base64url')}`;
}
const TIMESTAMP_FIELD = /(_at|^valid_from|^valid_until|^from|^until)$/;
/** A JavaScript value as a Firestore REST value ({"stringValue": "…"} and so on). */
export function toValue(value, key = '') {
    if (value === null || value === undefined)
        return { nullValue: null };
    if (typeof value === 'boolean')
        return { booleanValue: value };
    if (typeof value === 'number') {
        return Number.isInteger(value) ? { integerValue: String(value) } : { doubleValue: value };
    }
    if (typeof value === 'string') {
        return TIMESTAMP_FIELD.test(key) && !Number.isNaN(Date.parse(value))
            ? { timestampValue: value }
            : { stringValue: value };
    }
    if (Array.isArray(value)) {
        return { arrayValue: value.length > 0 ? { values: value.map((v) => toValue(v)) } : {} };
    }
    if (typeof value === 'object')
        return { mapValue: { fields: toFields(value) } };
    return { stringValue: String(value) };
}
export function toFields(object) {
    return Object.fromEntries(Object.entries(object).map(([key, v]) => [key, toValue(v, key)]));
}
/** Talks to one Firestore database with a service-account token. */
class Firestore {
    config;
    http;
    clock;
    token = null;
    constructor(config, http, clock) {
        this.config = config;
        this.http = http;
        this.clock = clock;
    }
    get root() {
        return `projects/${this.config.projectId}/databases/${this.config.databaseId}/documents`;
    }
    docName(path) {
        return `${this.root}/${path}`;
    }
    async headers() {
        if (!this.token || this.clock() > this.token.expiresAt) {
            const now = Math.floor(this.clock() / 1000);
            const response = await this.http.request(TOKEN_URL, {
                method: 'POST',
                body: new URLSearchParams({
                    grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
                    assertion: signedJwt(this.config, now),
                }).toString(),
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            });
            const { access_token: value, expires_in: seconds } = JSON.parse(response.body);
            // Renew five minutes early.
            this.token = { value, expiresAt: this.clock() + ((seconds ?? 3600) - 300) * 1000 };
        }
        return { Authorization: `Bearer ${this.token.value}` };
    }
    /** True when no store document exists yet (a new or emptied database). */
    async isEmpty() {
        const url = `https://firestore.googleapis.com/v1/${this.root}/stores?pageSize=1`;
        const body = await this.http.getJson(url, {
            headers: await this.headers(),
        });
        return (body.documents?.length ?? 0) === 0;
    }
    async commit(writes) {
        await this.http.request(`https://firestore.googleapis.com/v1/${this.root}:commit`, {
            method: 'POST',
            body: JSON.stringify({ writes }),
            headers: { ...(await this.headers()), 'Content-Type': 'application/json' },
        });
    }
}
function client(fetch) {
    return new HttpClient({
        userAgent: userAgent(),
        respectRobots: false,
        requestsPerSecond: 10,
        timeoutMs: 60_000,
        // A used-up daily quota does not come back within minutes: give up quickly.
        retry: { maxAttempts: 3, baseDelayMs: 1_000, maxDelayMs: 10_000, maxRetryAfterMs: 60_000 },
        ...(fetch ? { fetch } : {}),
    });
}
/** The error body Google APIs send: {"error": {"code", "message", "status"}}. */
function googleError(body) {
    try {
        const parsed = JSON.parse(body);
        const text = (value) => (typeof value === 'string' ? value : '');
        return { status: text(parsed.error?.status), message: text(parsed.error?.message) };
    }
    catch {
        // Long bodies are cut off; read what is there.
        return {
            status: /"status":\s*"([A-Z_]+)"/.exec(body)?.[1] ?? '',
            message: /"message":\s*"([^"]*)"/.exec(body)?.[1] ?? '',
        };
    }
}
const KEY_HINT = 'Create a key: Firebase console -> Project settings -> Service accounts -> Generate new private key.';
const DATABASE_HINT = 'Create the database: Firebase console -> Build -> Firestore Database -> Create database.';
export function explainFirebaseError(error) {
    if (error instanceof FirebaseSetupError) {
        return { ok: false, message: error.message, hints: [KEY_HINT] };
    }
    if (error instanceof HttpError) {
        if (error.url.startsWith(TOKEN_URL)) {
            let detail = '';
            try {
                const body = JSON.parse(error.bodySnippet);
                detail = body.error_description ? ` (${body.error_description})` : '';
            }
            catch {
                // not JSON
            }
            return {
                ok: false,
                message: `Google rejected the service account key${detail}`,
                hints: [KEY_HINT, 'Also check that the clock of this computer is right.'],
            };
        }
        const { status, message } = googleError(error.bodySnippet);
        if (error.status === 429 || status === 'RESOURCE_EXHAUSTED') {
            return {
                ok: false,
                message: 'Firestore has used up its write quota for today',
                hints: [
                    'What was sent so far is saved: run the same sync again tomorrow and it continues where it stopped.',
                    'The free plan allows 20,000 writes a day; the Blaze plan has no daily limit.',
                ],
            };
        }
        if (status === 'NOT_FOUND' || /database.*does not exist/i.test(message)) {
            return {
                ok: false,
                message: 'this Firebase project has no Firestore database yet',
                hints: [DATABASE_HINT],
            };
        }
        if (/has not been used|is disabled|SERVICE_DISABLED/i.test(message)) {
            return {
                ok: false,
                message: 'the Firestore API is not switched on for this project',
                hints: [DATABASE_HINT, 'If you just created it, wait a few minutes and try again.'],
            };
        }
        if (status === 'PERMISSION_DENIED' || status === 'UNAUTHENTICATED') {
            return {
                ok: false,
                message: `the service account may not use Firestore${message ? ` (${message})` : ''}`,
                hints: [`Use the Firebase Admin SDK key of this project. ${KEY_HINT}`],
            };
        }
        return {
            ok: false,
            message: `Firestore answered HTTP ${error.status}${message ? `: ${message}` : ''}`,
            hints: [],
        };
    }
    if (error instanceof NetworkError)
        return { ok: false, message: error.message, hints: [] };
    return { ok: false, message: error instanceof Error ? error.message : String(error), hints: [] };
}
export async function checkFirebase(config, fetch) {
    try {
        const empty = await new Firestore(config, client(fetch), Date.now).isEmpty();
        return {
            ok: true,
            message: `connected, Firestore ready${empty ? ' (no data yet)' : ''}`,
            hints: [],
        };
    }
    catch (error) {
        return explainFirebaseError(error);
    }
}
/** Products that changed after `since`: their details, removal, or a new price period. */
const CHANGED = `($since IS NULL OR p.updated_at > $since OR EXISTS (
  SELECT 1 FROM price_history h WHERE h.product_id = p.id AND h.first_seen_at > $since))`;
/**
 * Sends the products that changed since the last sync (all of them with `full`
 * or into an empty database), in batches; after each batch the position is saved,
 * so a stopped sync continues where it stopped.
 */
export async function syncToFirebase(db, config, options = {}) {
    const clock = options.clock ?? Date.now;
    const http = client(options.fetch);
    const firestore = new Firestore(config, http, clock);
    const target = firebaseTarget(config);
    // Always connect first: it checks the key and the database, and an empty
    // database (new, or emptied by hand) gets everything.
    options.onProgress?.('Connecting to Firebase…');
    const remoteEmpty = await firestore.isEmpty();
    let progress = db.get('SELECT since, started_at, after_id FROM sync_progress WHERE target = $target', { target }) ?? null;
    if (options.full || remoteEmpty)
        progress = null;
    const since = progress
        ? progress.since
        : options.full || remoteEmpty
            ? null
            : (db.get('SELECT synced_at FROM sync_state WHERE target = $target', {
                target,
            })?.synced_at ?? null);
    const startedAt = progress?.started_at ?? new Date(clock()).toISOString();
    let after = progress?.after_id ?? null;
    const remaining = db.get(`SELECT COUNT(*) AS n FROM products p WHERE ${CHANGED} AND ($after IS NULL OR p.id > $after)`, { since, after })?.n ?? 0;
    const result = {
        products: remaining,
        since,
        resumed: progress != null,
        requests: 0,
        dryRun: options.dryRun === true,
    };
    if (options.dryRun)
        return result;
    let sent = 0;
    const storesWritten = new Set();
    for (;;) {
        const rows = db.all(`SELECT p.id, p.store, p.store_product_id, p.name, p.brand, p.brand_source, p.brand_key,
         p.category_path, p.size_text,
         p.quantity_amount, p.quantity_unit, p.pack_count, p.labels, p.url, p.image_url, p.gtin,
         p.details, p.details_fetched_at, p.first_seen_at, p.removed_at, p.updated_at,
         pr.price, pr.regular_price, pr.loyalty_price, pr.promo_label, pr.valid_from,
         pr.valid_until, pr.unit_price, pr.unit_price_basis, pr.currency
       FROM products p LEFT JOIN prices pr ON pr.product_id = p.id
       WHERE ${CHANGED} AND ($after IS NULL OR p.id > $after)
       ORDER BY p.id LIMIT $limit`, { since, after, limit: BATCH_SIZE });
        if (rows.length === 0)
            break;
        const first = rows[0]?.id ?? '';
        const last = rows[rows.length - 1]?.id ?? '';
        const history = new Map();
        for (const row of db.all(`SELECT product_id, price, regular_price, loyalty_price, promo_label, valid_until,
         first_seen_at, last_seen_at
       FROM price_history WHERE product_id >= $first AND product_id <= $last
       ORDER BY product_id, first_seen_at`, { first, last })) {
            history.set(row.product_id, [...(history.get(row.product_id) ?? []), row]);
        }
        const writes = [];
        for (const row of rows) {
            if (!storesWritten.has(row.store)) {
                storesWritten.add(row.store);
                const name = isStoreId(row.store) ? getProvider(row.store).info.name : row.store;
                writes.push({
                    update: {
                        name: firestore.docName(`stores/${row.store}`),
                        fields: toFields({ store: row.store, name }),
                    },
                });
            }
            const document = {
                ...row,
                labels: JSON.parse(row.labels),
                details: row.details ? JSON.parse(row.details) : null,
                price_history: (history.get(row.id) ?? []).map((h) => ({
                    price: h.price,
                    regular_price: h.regular_price,
                    loyalty_price: h.loyalty_price,
                    promo_label: h.promo_label,
                    valid_until: h.valid_until,
                    from: h.first_seen_at,
                    until: h.last_seen_at,
                })),
                synced_at: startedAt,
            };
            const path = `stores/${row.store}/products/${encodeURIComponent(row.store_product_id)}`;
            writes.push({ update: { name: firestore.docName(path), fields: toFields(document) } });
        }
        await firestore.commit(writes);
        after = last;
        sent += rows.length;
        db.run(`INSERT INTO sync_progress (target, since, started_at, after_id)
       VALUES ($target, $since, $startedAt, $after)
       ON CONFLICT (target) DO UPDATE SET since = excluded.since,
         started_at = excluded.started_at, after_id = excluded.after_id`, { target, since, startedAt, after });
        options.onProgress?.(`Sending products to Firebase: ${sent}/${remaining}`);
    }
    db.transaction(() => {
        db.run('DELETE FROM sync_progress WHERE target = $target', { target });
        db.run(`INSERT INTO sync_state (target, synced_at) VALUES ($target, $at)
       ON CONFLICT (target) DO UPDATE SET synced_at = excluded.synced_at`, { target, at: startedAt });
    });
    result.products = sent;
    result.requests = http.stats.requests;
    return result;
}
