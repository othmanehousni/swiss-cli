import {
  ACCEPT_LANGUAGE,
  defaultDatabasePath,
  defaultLang,
  REPOSITORY_URL,
  userAgent,
} from '../config.js';
import { StoreBusyError } from '../crawler/crawler.js';
import {
  BlockedError,
  HttpError,
  NetworkError,
  RobotsDisallowedError,
  RobotsUnavailableError,
  UnexpectedResponseError,
} from '../crawler/errors.js';
import { HttpClient } from '../crawler/http.js';
import { RetryAfterTooLongError } from '../crawler/retry.js';
import { PlaceNotFoundError } from '../modules/places/resolve.js';
import { editDistance } from '../normalization/text.js';
import { isStoreId, STORE_IDS, type StoreId } from '../normalization/types.js';
import { getProvider } from '../providers/index.js';
import { LANGS, type Lang, type Provider, type ProviderContext } from '../providers/types.js';
import { type BrandRefresh, brandsNeedRefresh, refreshBrands } from '../storage/brands.js';
import { Database } from '../storage/database.js';
import { Output } from '../ui/output.js';

/** A mistake in how the command was used; shown without a stack trace. */
export class UserError extends Error {
  constructor(
    message: string,
    readonly hints: string[] = [],
    readonly exitCode = 2,
  ) {
    super(message);
    this.name = 'UserError';
  }
}

export interface GlobalOptions {
  db?: string;
  /** Only set when --lang is given on the command line. */
  lang?: Lang;
  verbose?: boolean;
  quiet?: boolean;
  color?: boolean;
}

/** What every command needs: output, settings and (lazily) the database. */
export class App {
  readonly out: Output;
  readonly dbPath: string;
  private database: Database | null = null;

  constructor(
    readonly options: GlobalOptions,
    json = false,
  ) {
    this.out = new Output({
      quiet: options.quiet === true,
      verbose: options.verbose === true,
      color: options.color !== false,
      json,
    });
    this.dbPath = options.db ?? defaultDatabasePath();
  }

  /**
   * The language to read a store in: --lang if given, else the store's own setting
   * (e.g. SWISS_GROCERY_MIGROS_LANG=fr), else SWISS_GROCERY_LANG, else German.
   * Without a store: --lang, else SWISS_GROCERY_LANG, else German.
   */
  langFor(store?: StoreId): Lang {
    if (this.options.lang) return this.options.lang;
    if (!store) return defaultLang();
    const name = `SWISS_GROCERY_${store.toUpperCase()}_LANG`;
    const value = process.env[name]?.trim().toLowerCase();
    if (!value) return defaultLang();
    if (!(LANGS as readonly string[]).includes(value)) {
      throw new UserError(`${name} must be one of ${LANGS.join(', ')} (it is "${value}").`, [
        'Change it in your .env file or your environment.',
      ]);
    }
    return value as Lang;
  }

  db(): Database {
    if (!this.database) {
      this.database = Database.open(this.dbPath);
      // After an upgrade, existing products get their brand keys and recognised brands.
      const { upgradedFrom } = this.database;
      if ((upgradedFrom !== null && upgradedFrom < 3) || brandsNeedRefresh(this.database)) {
        this.refreshBrands();
      }
    }
    return this.database;
  }

  /** Recomputes brands from what every store publishes (after a crawl). */
  refreshBrands(): BrandRefresh {
    const stores = STORE_IDS.map((id) => {
      const { name, brandInName } = getProvider(id).info;
      return { id, name, brandInName: brandInName === true };
    });
    return refreshBrands(this.db(), stores, new Date().toISOString());
  }

  close(): void {
    this.database?.close();
    this.database = null;
  }
}

const STORE_ALIASES: Record<string, StoreId> = {
  'aldi-suisse': 'aldi',
  aldisuisse: 'aldi',
  'lidl-suisse': 'lidl',
  lidlsuisse: 'lidl',
};

/** `--brand "coca-cola,rivella"` -> ["coca-cola", "rivella"]. */
export function parseBrands(value: string): string[] {
  const brands = value
    .split(',')
    .map((b) => b.trim())
    .filter(Boolean);
  if (brands.length === 0) {
    throw new UserError('--brand needs a brand name, e.g. --brand lindt.', [
      'See the brands in your database with: swiss-grocery brands',
    ]);
  }
  return brands;
}

/** Parses store names: "migros", "aldi,lidl", "all". Suggests a fix for typos. */
export function parseStores(values: string[], { allowAll = true } = {}): StoreId[] {
  const names = values
    .flatMap((v) => v.split(','))
    .map((v) => v.trim().toLowerCase())
    .filter(Boolean);
  const stores: StoreId[] = [];
  for (const name of names) {
    if (name === 'all' && allowAll) return [...STORE_IDS];
    const store = STORE_ALIASES[name] ?? name;
    if (!isStoreId(store)) {
      const closest = [...STORE_IDS].sort(
        (a, b) => editDistance(name, a) - editDistance(name, b),
      )[0];
      throw new UserError(`Unknown store "${name}".`, [
        `Did you mean "${closest}"?`,
        `Stores: ${STORE_IDS.join(', ')}${allowAll ? ', or "all"' : ''}. See: swiss-grocery stores`,
      ]);
    }
    if (!stores.includes(store)) stores.push(store);
  }
  return stores;
}

export function parsePositiveInt(value: string, name: string): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0)
    throw new UserError(`${name} must be a whole number above 0 (got "${value}").`);
  return n;
}

export function parsePositiveNumber(value: string, name: string): number {
  const n = Number(value);
  if (!(n > 0)) throw new UserError(`${name} must be a number above 0 (got "${value}").`);
  return n;
}

/**
 * An HTTP client for a public data source (MeteoSwiss, transport.opendata.ch, ...):
 * robots.txt, a polite request rate, retries, and --verbose logging.
 */
export function sourceClient(
  app: App,
  source: string,
  options: { requestsPerSecond?: number; timeoutMs?: number; signal?: AbortSignal } = {},
): HttpClient {
  return new HttpClient({
    userAgent: userAgent(),
    acceptLanguage: ACCEPT_LANGUAGE[app.langFor()],
    requestsPerSecond: options.requestsPerSecond ?? 2,
    ...(options.timeoutMs ? { timeoutMs: options.timeoutMs } : {}),
    ...(options.signal ? { signal: options.signal } : {}),
    onEvent: (event) => {
      if (event.type === 'retry') {
        app.out.debug(
          `${source}: ${event.reason}, retrying in ${Math.ceil(event.delayMs / 1000)}s (attempt ${event.attempt + 1})`,
        );
      } else if (event.type === 'request') {
        app.out.debug(`${source}: ${event.url}`);
      }
    },
  });
}

export function providerContext(
  app: App,
  provider: Provider,
  options: { rate?: number; signal?: AbortSignal; onRetry?: (text: string) => void } = {},
): ProviderContext {
  const http = new HttpClient({
    userAgent: userAgent(),
    acceptLanguage: ACCEPT_LANGUAGE[app.langFor(provider.info.id)],
    requestsPerSecond: options.rate ?? provider.info.requestsPerSecond,
    ...(options.signal ? { signal: options.signal } : {}),
    onEvent: (event) => {
      if (event.type === 'retry') {
        const text = `${provider.info.name}: ${event.reason}, retrying in ${Math.ceil(event.delayMs / 1000)}s (attempt ${event.attempt + 1})`;
        options.onRetry?.(text);
        app.out.debug(text);
      } else if (event.type === 'throttled') {
        app.out.debug(
          `${provider.info.name} asked us to slow down: now ${event.requestsPerSecond.toFixed(2)} requests/s`,
        );
      } else {
        app.out.debug(`GET/POST ${event.url}`);
      }
    },
  });
  return {
    http,
    lang: app.langFor(provider.info.id),
    debug: (message) => app.out.debug(`${provider.info.id}: ${message}`),
  };
}

/**
 * Runs `task` with Ctrl+C handling: the first Ctrl+C stops gracefully (progress
 * is saved), a second one quits immediately.
 */
export async function withInterrupt<T>(
  app: App,
  task: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  const onSigint = () => {
    if (controller.signal.aborted) process.exit(130);
    controller.abort();
    app.out.warn('Stopping… progress is being saved. Press Ctrl+C again to quit immediately.');
  };
  process.on('SIGINT', onSigint);
  try {
    return await task(controller.signal);
  } finally {
    process.off('SIGINT', onSigint);
  }
}

/** Explains an error in plain words, with what to do next. */
export function explainError(
  error: unknown,
  verbose = false,
): { message: string; hints: string[] } {
  if (error instanceof UserError) return { message: error.message, hints: error.hints };
  if (error instanceof PlaceNotFoundError) {
    return {
      message: error.message,
      hints: [
        'Use a postcode (8001), a municipality or place (Lausanne, Davos Platz) or an address.',
      ],
    };
  }
  if (error instanceof BlockedError) {
    return {
      message: error.message,
      hints: [
        'Wait a while, then try again from a home or mobile connection (not a VPN or cloud server).',
        'Anything fetched so far is saved; running the same command again continues where it stopped.',
        'Check a store any time with: swiss-grocery doctor',
      ],
    };
  }
  if (error instanceof RobotsDisallowedError) {
    return {
      message: error.message,
      hints: ['swiss-grocery follows robots.txt rules, so it skips what a store disallows.'],
    };
  }
  if (error instanceof RobotsUnavailableError) return { message: error.message, hints: [] };
  if (error instanceof RetryAfterTooLongError) {
    return {
      message: error.message,
      hints: ['Progress is saved. Run the same command again later to continue.'],
    };
  }
  if (error instanceof NetworkError) {
    return {
      message: error.message,
      hints: [
        'Check your internet connection.',
        'Behind a company proxy? Set HTTPS_PROXY (e.g. HTTPS_PROXY=http://proxy:8080).',
      ],
    };
  }
  if (error instanceof UnexpectedResponseError) {
    return {
      message: error.message,
      hints: [
        `The store probably changed its website. Please report it so it can be fixed: ${REPOSITORY_URL}/issues`,
      ],
    };
  }
  if (error instanceof HttpError) {
    return {
      message: error.message,
      hints:
        error.status >= 500
          ? ['The store has a problem on its side. Try again later.']
          : ['Run with --verbose for details.'],
    };
  }
  if (error instanceof StoreBusyError) return { message: error.message, hints: [] };
  const fsError = error as NodeJS.ErrnoException;
  if (fsError?.code && fsError.syscall) {
    const path = fsError.path ?? 'the file';
    const known: Record<string, { message: string; hints: string[] }> = {
      ENOENT: {
        message: `Not found: ${path}`,
        hints: ['Check the path, or choose another location.'],
      },
      EACCES: {
        message: `No permission to use ${path}`,
        hints: ['Choose a location in your own folders, e.g. your Documents.'],
      },
      EPERM: {
        message: `No permission to use ${path}`,
        hints: ['Choose a location in your own folders, e.g. your Documents.'],
      },
      EISDIR: { message: `${path} is a folder`, hints: ['Give a file name, e.g. products.csv'] },
      ENOSPC: { message: 'The disk is full.', hints: ['Free some space and try again.'] },
      EROFS: { message: `${path} is read-only`, hints: ['Choose another location.'] },
    };
    if (known[fsError.code]) return known[fsError.code] as { message: string; hints: string[] };
  }
  const message = error instanceof Error ? error.message : String(error);
  return {
    message: `Unexpected error: ${message}`,
    hints: verbose
      ? [error instanceof Error && error.stack ? error.stack : message]
      : [
          'Run the command again with --verbose to see details.',
          `If it keeps happening, please report it: ${REPOSITORY_URL}/issues`,
        ],
  };
}
