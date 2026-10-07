/** Errors raised while talking to a store. Each carries a message written for end users. */

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

export class HttpError extends Error {
  constructor(
    readonly url: string,
    readonly status: number,
    readonly retryable: boolean,
    readonly retryAfterMs: number | null,
    readonly bodySnippet: string,
  ) {
    super(`${hostOf(url)} answered HTTP ${status}`);
    this.name = 'HttpError';
  }
}

/** The store's bot protection refused the request. Retrying immediately makes it worse. */
export class BlockedError extends Error {
  constructor(
    readonly url: string,
    readonly protection: string,
    readonly status: number,
  ) {
    super(
      `${hostOf(url)} blocked the request (HTTP ${status}, ${protection} bot protection). ` +
        'This usually happens on cloud/VPN/datacenter networks or after too many requests.',
    );
    this.name = 'BlockedError';
  }
}

export class NetworkError extends Error {
  constructor(
    readonly url: string,
    override readonly cause: unknown,
  ) {
    const reason =
      cause instanceof Error
        ? cause.name === 'TimeoutError'
          ? 'request timed out'
          : ((cause.cause as { code?: string } | undefined)?.code ?? cause.message)
        : String(cause);
    super(`Could not reach ${hostOf(url)} (${reason})`);
    this.name = 'NetworkError';
  }
}

export class RobotsDisallowedError extends Error {
  constructor(readonly url: string) {
    super(
      `${hostOf(url)}'s robots.txt does not allow automated access to ${new URL(url).pathname}`,
    );
    this.name = 'RobotsDisallowedError';
  }
}

export class RobotsUnavailableError extends Error {
  constructor(
    readonly origin: string,
    override readonly cause: unknown,
  ) {
    super(
      `Could not read ${origin}/robots.txt, so crawling is paused for this store (RFC 9309). Try again later.`,
    );
    this.name = 'RobotsUnavailableError';
  }
}

/** The store answered, but not with the data we expect (its API probably changed). */
export class UnexpectedResponseError extends Error {
  constructor(
    readonly url: string,
    readonly detail: string,
  ) {
    super(`Unexpected response from ${hostOf(url)}: ${detail}`);
    this.name = 'UnexpectedResponseError';
  }
}
