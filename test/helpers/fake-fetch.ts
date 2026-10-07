import type { FetchLike } from '../../src/crawler/http.js';

export interface FakeResponse {
  status?: number;
  body?: unknown;
  headers?: Record<string, string>;
}

export interface FakeCall {
  url: string;
  method: string;
  body?: string;
  headers: Record<string, string>;
}

type Handler = (
  url: string,
  call: FakeCall,
) => FakeResponse | Error | Promise<FakeResponse | Error>;

/** A scripted `fetch` that records calls. robots.txt answers 404 unless the handler says otherwise. */
export function createFakeFetch(handler: Handler) {
  const calls: FakeCall[] = [];
  const fetch: FetchLike = async (url, init) => {
    const call: FakeCall = {
      url,
      method: init.method,
      headers: init.headers,
      ...(init.body === undefined ? {} : { body: init.body }),
    };
    calls.push(call);
    const result = await handler(url, call);
    if (result instanceof Error) throw result;
    const body = typeof result.body === 'string' ? result.body : JSON.stringify(result.body ?? {});
    return {
      status: result.status ?? 200,
      headers: new Headers(result.headers ?? {}),
      text: async () => body,
    };
  };
  return { fetch, calls, requests: () => calls.filter((c) => !c.url.endsWith('/robots.txt')) };
}

/** A virtual clock: sleeping advances time instantly and is recorded. */
export function createVirtualTime() {
  let now = 0;
  const sleeps: number[] = [];
  return {
    clock: () => now,
    sleep: async (ms: number) => {
      sleeps.push(Math.round(ms));
      now += ms;
    },
    sleeps,
  };
}
