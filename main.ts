// main.ts — the forge's entrypoint: boot contract and routing.
//
// Boot: bind an ephemeral port, POST {"port": N} to $MAKEFUN_ENV_URL/register,
// then long-poll GET $MAKEFUN_ENV_URL/done and exit 0 when the suite is done.
// GET /healthz answers without auth. Every other surface first checks
// Authorization: Bearer $MAKEFUN_SHOP_TOKEN (401 without it), then routes:
// /api/v3/* to REST, /api/graphql to GraphQL, /mcp to MCP, and
// /{owner}/{repo}.git/* to git smart HTTP. One Store instance backs them all.
// The transport is the hand-rolled HTTP/1.1 server in rawhttp.ts: its
// request/response shims carry exactly the Node surface the handlers use,
// so the routing below is unchanged from the node:http era.

import type { IncomingMessage, ServerResponse } from 'node:http';
import { asIncomingMessage, asServerResponse, createRawServer } from './rawhttp.ts';
import { captureResponse, lookupResponse, responseKey, serveResponse, storeResponse } from './cache.ts';
import { handleGraphQL } from './graphql.ts';
import { handleInfoRefs, handleReceivePack, handleUploadPack } from './githttp.ts';
import { handleMcp } from './mcp.ts';
import { handleRest } from './rest.ts';
import { Store } from './store.ts';
import { sendError, sendJson } from './web.ts';

const store = new Store();
const token = process.env.MAKEFUN_SHOP_TOKEN ?? '';
const envUrl = (process.env.MAKEFUN_ENV_URL ?? '').replace(/\/+$/, '');

function authorized(req: IncomingMessage): boolean {
  return token !== '' && req.headers.authorization === `Bearer ${token}`;
}

function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

/**
 * The request wrapper every surface runs inside. A non-GET request is a
 * potential mutation: it is counted in flight while it runs, and the store's
 * state version is bumped once it completes, which retires every GET answer
 * memoized under the older state (cache.ts). A GET first asks the memo; on a
 * miss its answer is captured and memoized, but only when no mutation is in
 * flight, so a memoized body always reflects one whole, completed state.
 */
async function route(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const method = req.method ?? 'GET';
  if (method !== 'GET') {
    store.mutationsInFlight += 1;
    try {
      await dispatch(req, res);
    } finally {
      store.mutationsInFlight -= 1;
      store.version += 1;
    }
    return;
  }
  const key = responseKey(store, req.url ?? '/', req.headers.host ?? '', authorized(req));
  const hit = lookupResponse(key);
  if (hit !== null) {
    serveResponse(store, res, hit);
    return;
  }
  const take = captureResponse(res);
  await dispatch(req, res);
  const entry = take();
  if (entry !== null && entry.status < 500 && store.mutationsInFlight === 0) storeResponse(key, entry);
}

async function dispatch(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://forge');
  const path = url.pathname;

  if (path === '/healthz') {
    sendJson(store, res, 200, { ok: true });
    return;
  }

  const segments = path.split('/').filter((segment) => segment !== '').map(decodeSegment);

  if (segments[0] === 'api' && segments[1] === 'v3') {
    if (!authorized(req)) {
      sendError(store, res, 401, 'Bad credentials');
      return;
    }
    await handleRest(store, req, res, segments.slice(2), url.searchParams);
    return;
  }

  if (path === '/api/graphql') {
    if (!authorized(req)) {
      sendError(store, res, 401, 'Bad credentials');
      return;
    }
    if ((req.method ?? 'GET') !== 'POST') {
      sendError(store, res, 404, 'Not Found');
      return;
    }
    await handleGraphQL(store, req, res);
    return;
  }

  if (path === '/mcp') {
    if (!authorized(req)) {
      sendError(store, res, 401, 'Bad credentials');
      return;
    }
    if ((req.method ?? 'GET') !== 'POST') {
      sendError(store, res, 405, 'Method Not Allowed');
      return;
    }
    await handleMcp(store, req, res);
    return;
  }

  // Git smart HTTP: /{owner}/{repo}.git/<tail>
  if (segments.length >= 3 && segments[1]!.endsWith('.git')) {
    if (!authorized(req)) {
      sendError(store, res, 401, 'Bad credentials');
      return;
    }
    const owner = segments[0]!;
    const repoName = segments[1]!.slice(0, -'.git'.length);
    const repo = store.findRepo(owner, repoName);
    if (repo === null) {
      sendError(store, res, 404, 'Not Found');
      return;
    }
    const tail = segments.slice(2).join('/');
    if (tail === 'info/refs' && (req.method ?? 'GET') === 'GET') {
      await handleInfoRefs(store, req, res, repo, url.searchParams);
      return;
    }
    if (tail === 'git-upload-pack' && (req.method ?? 'GET') === 'POST') {
      await handleUploadPack(store, req, res, repo);
      return;
    }
    if (tail === 'git-receive-pack' && (req.method ?? 'GET') === 'POST') {
      await handleReceivePack(store, req, res, repo);
      return;
    }
    sendError(store, res, 404, 'Not Found');
    return;
  }

  sendError(store, res, 404, 'Not Found');
}

const server = createRawServer((rawReq, rawRes) => {
  const req = asIncomingMessage(rawReq);
  const res = asServerResponse(rawRes);
  return route(req, res).catch(() => {
    // A handler failure must never take the server down (the suite probes this).
    try {
      if (!res.headersSent) sendError(store, res, 500, 'Internal error');
      else if (!res.writableEnded) res.end();
    } catch {
      // The peer is gone; nothing more to do.
    }
  });
});
server.on('error', () => undefined);

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function registerAndWait(port: number): Promise<void> {
  if (envUrl === '') {
    process.stderr.write(`[forge] listening on ${port} (no MAKEFUN_ENV_URL: serving standalone)\n`);
    return;
  }
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      const response = await fetch(`${envUrl}/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ port }),
      });
      if (response.ok || response.status === 409) break;
    } catch {
      // The env may still be coming up; keep trying inside the boot budget.
    }
    await sleep(200);
  }
  for (;;) {
    await sleep(250);
    try {
      const response = await fetch(`${envUrl}/done`);
      const body = (await response.json()) as { done?: unknown };
      if (body.done === true) {
        server.close();
        process.exit(0);
      }
    } catch {
      // A transient poll failure is not the end of the trial; keep polling.
    }
  }
}

server.listen(0, () => {
  const address = server.address();
  const port = address !== null && typeof address === 'object' ? address.port : 0;
  void registerAndWait(port);
});
