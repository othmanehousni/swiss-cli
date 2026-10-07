import { readFileSync } from 'node:fs';
import { HttpClient } from '../../src/crawler/http.js';
import type { Lang, ProviderContext } from '../../src/providers/types.js';
import { createFakeFetch } from './fake-fetch.js';

export function fixture<T = unknown>(name: string): T {
  return JSON.parse(readFileSync(new URL(`../fixtures/${name}`, import.meta.url), 'utf-8')) as T;
}

/** A provider context whose HTTP requests are answered by `handler`. */
export function fakeContext(handler: Parameters<typeof createFakeFetch>[0], lang: Lang = 'de') {
  const fake = createFakeFetch(handler);
  const http = new HttpClient({
    userAgent: 'test',
    requestsPerSecond: 1000,
    respectRobots: false,
    fetch: fake.fetch,
    sleep: async () => {},
  });
  const ctx: ProviderContext = { http, lang, debug: () => {} };
  return { ctx, fake };
}
