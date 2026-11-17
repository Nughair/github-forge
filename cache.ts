// cache.ts — serialized-response memoization for GET answers.
//
// The read workload asks for the same issue 2,000 times on one connection.
// Building that answer is pure: for a fixed store state, a GET's status,
// headers and body bytes are a function of the request line alone. So the
// forge memoizes the exact bytes of GET answers, keyed by the store's state
// version (store.ts): the version is bumped after every mutating request
// completes, which makes every entry taken under an older state unreachable,
// and new entries are only taken while no mutation is in flight, so an entry
// can never capture a half-applied write. A cache hit replays the captured
// bytes verbatim, with one exception: the X-GitHub-Request-Id header is
// always minted fresh, exactly as an uncached answer mints it.

import type { ServerResponse } from 'node:http';
import type { Store } from './store.ts';

export interface CachedResponse {
  status: number;
  headers: Record<string, string>;
  body: Buffer;
}

/** Bounds that keep the memo a cache, not a second store. */
const MAX_ENTRIES = 1024;
const MAX_BODY_BYTES = 1 << 20;

const entries = new Map<string, CachedResponse>();

/** The memo key for one GET: the state version plus everything the answer may depend on. */
export function responseKey(store: Store, url: string, host: string, authorized: boolean): string {
  return `${store.version}\n${authorized ? 'a' : 'u'}\n${host}\n${url}`;
}

export function lookupResponse(key: string): CachedResponse | null {
  return entries.get(key) ?? null;
}

export function storeResponse(key: string, entry: CachedResponse): void {
  if (entry.body.length > MAX_BODY_BYTES) return;
  if (!entries.has(key) && entries.size >= MAX_ENTRIES) {
    const oldest = entries.keys().next().value;
    if (oldest !== undefined) entries.delete(oldest);
  }
  entries.set(key, entry);
}

/** Replay a memoized answer, minting its request id fresh like any other reply. */
export function serveResponse(store: Store, res: ServerResponse, entry: CachedResponse): void {
  res.writeHead(entry.status, { ...entry.headers, 'x-github-request-id': store.nextRequestId() });
  res.end(entry.body);
}

/**
 * Wrap a response so the first full answer written through it can be taken as
 * a memo entry. The forge's helpers (web.ts) always answer with one
 * writeHead(status, headers) followed by one end(body), which is exactly the
 * shape captured here; anything else simply takes nothing.
 */
export function captureResponse(res: ServerResponse): () => CachedResponse | null {
  const writeHead = res.writeHead.bind(res);
  const end = res.end.bind(res);
  let status = 0;
  let headers: Record<string, string> | null = null;
  let body: Buffer | null = null;
  let ended = false;

  res.writeHead = ((code: number, ...rest: unknown[]) => {
    status = code;
    const given = rest.find((part) => part !== null && typeof part === 'object' && !Array.isArray(part)) as
      | Record<string, string>
      | undefined;
    if (given !== undefined) {
      headers = {};
      for (const [name, value] of Object.entries(given)) {
        if (name.toLowerCase() !== 'x-github-request-id') headers[name] = String(value);
      }
    }
    return (writeHead as (...args: unknown[]) => ServerResponse)(code, ...rest);
  }) as ServerResponse['writeHead'];

  res.end = ((...args: unknown[]) => {
    if (!ended) {
      ended = true;
      const chunk = args[0];
      if (typeof chunk === 'string') body = Buffer.from(chunk, 'utf8');
      else if (Buffer.isBuffer(chunk)) body = chunk;
      else if (chunk instanceof Uint8Array) body = Buffer.from(chunk);
      else body = Buffer.alloc(0);
    }
    return (end as (...args: unknown[]) => ServerResponse)(...args);
  }) as ServerResponse['end'];

  return () => {
    if (status === 0 || body === null) return null;
    return { status, headers: headers ?? {}, body };
  };
}
