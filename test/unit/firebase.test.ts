import { createVerify, generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { HttpError } from '../../src/crawler/errors.js';
import { Database } from '../../src/storage/database.js';
import { saveProducts } from '../../src/storage/products.js';
import {
  explainFirebaseError,
  type FirebaseConfig,
  FirebaseSetupError,
  firebaseConfig,
  signedJwt,
  syncToFirebase,
  toValue,
} from '../../src/sync/firebase.js';
import { createFakeFetch, type FakeCall, type FakeResponse } from '../helpers/fake-fetch.js';
import { makeProduct } from '../helpers/products.js';

const { privateKey, publicKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  publicKeyEncoding: { type: 'spki', format: 'pem' },
});
const config: FirebaseConfig = {
  projectId: 'demo',
  clientEmail: 'sync@demo.iam.gserviceaccount.com',
  privateKey,
  databaseId: '(default)',
};
const T1 = '2026-10-01T08:00:00.000Z';
const T2 = '2026-10-02T08:00:00.000Z';

let db: Database;
beforeEach(() => {
  db = Database.open(':memory:');
});
afterEach(() => db.close());

/** A fake Firestore: answers the login, the emptiness check and commits. */
function firestore(options: { empty?: boolean; failCommit?: number } = {}) {
  const commits: { writes: { update: { name: string; fields: Record<string, unknown> } }[] }[] = [];
  let commitCalls = 0;
  const fake = createFakeFetch((url: string, call: FakeCall): FakeResponse => {
    if (url === 'https://oauth2.googleapis.com/token') {
      return { body: { access_token: 'token-1', expires_in: 3600 } };
    }
    if (url.includes('/documents/stores?pageSize=1')) {
      return { body: options.empty === false ? { documents: [{ name: 'x' }] } : {} };
    }
    if (url.endsWith('/documents:commit')) {
      commitCalls++;
      if (commitCalls === options.failCommit) {
        return {
          status: 403,
          headers: { 'content-type': 'application/json' },
          body: { error: { code: 403, status: 'PERMISSION_DENIED', message: 'denied' } },
        };
      }
      commits.push(JSON.parse(call.body ?? '{}'));
      return { body: {} };
    }
    return { status: 404, body: {} };
  });
  return { fake, commits };
}

describe('Firebase login', () => {
  it('signs a service-account token request that Google can verify', () => {
    const jwt = signedJwt(config, 1_800_000_000);
    const [header, claims, signature] = jwt.split('.') as [string, string, string];
    const verifier = createVerify('RSA-SHA256').update(`${header}.${claims}`);
    expect(verifier.verify(publicKey, Buffer.from(signature, 'base64url'))).toBe(true);
    expect(JSON.parse(Buffer.from(claims, 'base64url').toString())).toEqual({
      iss: config.clientEmail,
      scope: 'https://www.googleapis.com/auth/datastore',
      aud: 'https://oauth2.googleapis.com/token',
      iat: 1_800_000_000,
      exp: 1_800_003_600,
    });
  });

  it('explains a broken private key', () => {
    expect(() => signedJwt({ ...config, privateKey: 'not a key' }, 0)).toThrow(FirebaseSetupError);
  });
});

describe('firebaseConfig', () => {
  it('reads the downloaded key file, or the three variables', () => {
    const dir = mkdtempSync(join(tmpdir(), 'firebase-'));
    const file = join(dir, 'key.json');
    writeFileSync(
      file,
      JSON.stringify({
        project_id: 'p',
        client_email: 'e@p',
        private_key: 'k',
        type: 'service_account',
      }),
    );
    expect(firebaseConfig({ FIREBASE_SERVICE_ACCOUNT: file })).toEqual({
      projectId: 'p',
      clientEmail: 'e@p',
      privateKey: 'k',
      databaseId: '(default)',
    });
    expect(
      firebaseConfig({
        FIREBASE_PROJECT_ID: 'p',
        FIREBASE_CLIENT_EMAIL: 'e@p',
        FIREBASE_PRIVATE_KEY: '-----BEGIN PRIVATE KEY-----\\nabc\\n-----END PRIVATE KEY-----',
        FIREBASE_DATABASE_ID: 'prices',
      }),
    ).toMatchObject({
      privateKey: '-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----',
      databaseId: 'prices',
    });
    expect(firebaseConfig({})).toBeNull();
    expect(() => firebaseConfig({ FIREBASE_PROJECT_ID: 'p' })).toThrow(FirebaseSetupError);
    expect(() => firebaseConfig({ FIREBASE_SERVICE_ACCOUNT: join(dir, 'missing.json') })).toThrow(
      /could not read the service account file/,
    );
    rmSync(dir, { recursive: true, force: true });
  });
});

describe('toValue', () => {
  it('encodes values the way the Firestore REST API expects', () => {
    expect(toValue(3.85)).toEqual({ doubleValue: 3.85 });
    expect(toValue(2)).toEqual({ integerValue: '2' });
    expect(toValue(null)).toEqual({ nullValue: null });
    expect(toValue('Butter', 'name')).toEqual({ stringValue: 'Butter' });
    expect(toValue(T1, 'first_seen_at')).toEqual({ timestampValue: T1 });
    expect(toValue([])).toEqual({ arrayValue: {} });
    expect(toValue({ Fett: '82 g' })).toEqual({
      mapValue: { fields: { Fett: { stringValue: '82 g' } } },
    });
  });
});

describe('syncToFirebase', () => {
  it('sends every product into an empty database, grouped by store', async () => {
    saveProducts(db, [makeProduct(), makeProduct({ store: 'coop', storeProductId: '42' })], T1);
    const { fake, commits } = firestore();
    const result = await syncToFirebase(db, config, { fetch: fake.fetch });
    expect(result).toMatchObject({ products: 2, since: null, resumed: false });

    const names = commits.flatMap((c) =>
      c.writes.map((w) => w.update.name.split('/documents/')[1]),
    );
    expect(names).toEqual([
      'stores/aldi',
      'stores/aldi/products/288415',
      'stores/coop',
      'stores/coop/products/42',
    ]);
    const butter = commits[0]?.writes[1]?.update.fields as Record<string, Record<string, unknown>>;
    expect(butter.name).toEqual({ stringValue: 'Butter' });
    expect(butter.price).toEqual({ doubleValue: 3.85 });
    expect(butter.first_seen_at).toEqual({ timestampValue: T1 });
    expect(butter.price_history?.arrayValue).toMatchObject({ values: [{ mapValue: {} }] });
    const commitCall = fake.calls.find((c) => c.url.endsWith(':commit'));
    expect(commitCall?.headers.Authorization).toBe('Bearer token-1');
  });

  it('afterwards sends only products whose price or details changed', async () => {
    saveProducts(db, [makeProduct(), makeProduct({ storeProductId: '2', name: 'Milch' })], T1);
    await syncToFirebase(db, config, { fetch: firestore().fake.fetch });

    // Seen again, unchanged: nothing to send.
    saveProducts(db, [makeProduct(), makeProduct({ storeProductId: '2', name: 'Milch' })], T2);
    const quiet = firestore({ empty: false });
    expect(await syncToFirebase(db, config, { fetch: quiet.fake.fetch })).toMatchObject({
      products: 0,
    });
    expect(quiet.commits).toHaveLength(0);

    // A new price: only that product, with both price periods.
    const T3 = new Date(Date.now() + 60_000).toISOString();
    saveProducts(
      db,
      [makeProduct({ price: 3.5 }), makeProduct({ storeProductId: '2', name: 'Milch' })],
      T3,
    );
    const changed = firestore({ empty: false });
    const result = await syncToFirebase(db, config, { fetch: changed.fake.fetch });
    expect(result.products).toBe(1);
    const write = changed.commits[0]?.writes.find((w) =>
      w.update.name.endsWith('/products/288415'),
    );
    expect(write?.update.fields.price_history).toMatchObject({
      arrayValue: { values: [{ mapValue: {} }, { mapValue: {} }] },
    });
  });

  it('continues where a stopped sync left off', async () => {
    const products = Array.from({ length: 650 }, (_, i) =>
      makeProduct({ storeProductId: String(100000 + i), name: `Produkt ${i}` }),
    );
    saveProducts(db, products, T1);

    const first = firestore({ failCommit: 2 });
    await expect(syncToFirebase(db, config, { fetch: first.fake.fetch })).rejects.toBeInstanceOf(
      HttpError,
    );
    expect(first.commits).toHaveLength(1); // 300 products made it

    const second = firestore({ empty: false });
    const result = await syncToFirebase(db, config, { fetch: second.fake.fetch });
    expect(result).toMatchObject({ products: 350, resumed: true });
    const sent = second.commits
      .flatMap((c) => c.writes.map((w) => w.update.name))
      .filter((n) => n.includes('/products/'));
    expect(sent).toHaveLength(350);
    expect(sent[0]).toMatch(/products\/100300$/);

    const third = firestore({ empty: false });
    expect(await syncToFirebase(db, config, { fetch: third.fake.fetch })).toMatchObject({
      products: 0,
      resumed: false,
    });
  });

  it('counts without sending in a dry run', async () => {
    saveProducts(db, [makeProduct()], T1);
    const { fake, commits } = firestore();
    expect(await syncToFirebase(db, config, { dryRun: true, fetch: fake.fetch })).toMatchObject({
      products: 1,
      dryRun: true,
    });
    expect(commits).toHaveLength(0);
  });
});

describe('explainFirebaseError', () => {
  const firestoreError = (status: number, body: object) =>
    new HttpError(
      'https://firestore.googleapis.com/v1/x',
      status,
      false,
      null,
      JSON.stringify(body),
    );
  it('turns Google errors into next steps', () => {
    expect(
      explainFirebaseError(
        firestoreError(429, {
          error: { status: 'RESOURCE_EXHAUSTED', message: 'Quota exceeded.' },
        }),
      ).message,
    ).toMatch(/write quota for today/);
    expect(
      explainFirebaseError(
        firestoreError(404, {
          error: { status: 'NOT_FOUND', message: 'The database (default) does not exist' },
        }),
      ).message,
    ).toMatch(/no Firestore database yet/);
    expect(
      explainFirebaseError(
        firestoreError(403, {
          error: {
            status: 'PERMISSION_DENIED',
            message: 'Cloud Firestore API has not been used in project demo',
          },
        }),
      ).message,
    ).toMatch(/not switched on/);
    const login = new HttpError(
      'https://oauth2.googleapis.com/token',
      400,
      false,
      null,
      JSON.stringify({ error: 'invalid_grant', error_description: 'Invalid JWT Signature.' }),
    );
    expect(explainFirebaseError(login).message).toBe(
      'Google rejected the service account key (Invalid JWT Signature.)',
    );
  });
});
