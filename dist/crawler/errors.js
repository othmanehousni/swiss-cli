/** Errors raised while talking to a store. Each carries a message written for end users. */
function hostOf(url) {
    try {
        return new URL(url).host;
    }
    catch {
        return url;
    }
}
/** Path and query of a URL (the query shortened): which request failed, e.g. "/x?slug=y". */
function pathOf(url) {
    try {
        const { pathname, search } = new URL(url);
        return pathname + (search.length > 80 ? `${search.slice(0, 79)}…` : search);
    }
    catch {
        return '';
    }
}
/** The explanation an API put in its JSON error body, e.g. {"message": "Invalid API key"}. */
export function apiErrorMessage(body) {
    try {
        const parsed = JSON.parse(body);
        for (const key of ['message', 'error_description', 'error', 'title', 'detail']) {
            const value = parsed?.[key];
            if (typeof value === 'string' && value.trim())
                return value.trim().slice(0, 200);
        }
    }
    catch {
        // not JSON
    }
    return null;
}
export class HttpError extends Error {
    url;
    status;
    retryable;
    retryAfterMs;
    bodySnippet;
    constructor(url, status, retryable, retryAfterMs, bodySnippet) {
        // The path tells which request failed, which matters when a store changes its API.
        const detail = apiErrorMessage(bodySnippet);
        super(`${hostOf(url)} answered HTTP ${status} for ${pathOf(url)}${detail ? ` (${detail})` : ''}`);
        this.url = url;
        this.status = status;
        this.retryable = retryable;
        this.retryAfterMs = retryAfterMs;
        this.bodySnippet = bodySnippet;
        this.name = 'HttpError';
    }
}
/** The store's bot protection refused the request. Retrying immediately makes it worse. */
export class BlockedError extends Error {
    url;
    protection;
    status;
    constructor(url, protection, status) {
        super(`${hostOf(url)} blocked the request (HTTP ${status}, ${protection} bot protection). ` +
            'This usually happens on cloud/VPN/datacenter networks or after too many requests.');
        this.url = url;
        this.protection = protection;
        this.status = status;
        this.name = 'BlockedError';
    }
}
export class NetworkError extends Error {
    url;
    cause;
    constructor(url, cause) {
        const reason = cause instanceof Error
            ? cause.name === 'TimeoutError'
                ? 'request timed out'
                : (cause.cause?.code ?? cause.message)
            : String(cause);
        super(`Could not reach ${hostOf(url)} (${reason})`);
        this.url = url;
        this.cause = cause;
        this.name = 'NetworkError';
    }
}
export class RobotsDisallowedError extends Error {
    url;
    constructor(url) {
        super(`${hostOf(url)}'s robots.txt does not allow automated access to ${new URL(url).pathname}`);
        this.url = url;
        this.name = 'RobotsDisallowedError';
    }
}
export class RobotsUnavailableError extends Error {
    origin;
    cause;
    constructor(origin, cause) {
        super(`Could not read ${origin}/robots.txt, so crawling is paused for this store (RFC 9309). Try again later.`);
        this.origin = origin;
        this.cause = cause;
        this.name = 'RobotsUnavailableError';
    }
}
/** The store answered, but not with the data we expect (its API probably changed). */
export class UnexpectedResponseError extends Error {
    url;
    detail;
    constructor(url, detail) {
        super(`Unexpected response from ${hostOf(url)}: ${detail}`);
        this.url = url;
        this.detail = detail;
        this.name = 'UnexpectedResponseError';
    }
}
