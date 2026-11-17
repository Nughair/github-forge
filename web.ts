// web.ts — the HTTP plumbing every surface shares.
//
// Every response the forge sends goes through these helpers, which is what
// guarantees the wire contract's universal rules: a JSON content type and a
// non-empty X-GitHub-Request-Id on every reply, errors as {"message": ...},
// and no HTML-looking body anywhere.

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Store } from './store.ts';

/** Read a request body whole. Bodies in this suite are small; a generous cap guards the loop. */
export async function readBody(req: IncomingMessage): Promise<Buffer> {
  // The raw transport (rawhttp.ts) assembles the whole body before dispatch
  // and exposes it as rawBody: take it directly — no async-iterator setup and
  // no copying Buffer.concat on every POST.
  const preassembled = (req as unknown as { rawBody?: Buffer }).rawBody;
  if (preassembled !== undefined) {
    if (preassembled.length > 64 * 1024 * 1024) throw new Error('request body too large');
    return preassembled;
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = chunk as Buffer;
    size += buffer.length;
    if (size > 64 * 1024 * 1024) throw new Error('request body too large');
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

/** Send a JSON reply with the universal headers. */
export function sendJson(
  store: Store,
  res: ServerResponse,
  status: number,
  value: unknown,
  extraHeaders: Readonly<Record<string, string>> = {},
): void {
  sendText(store, res, status, JSON.stringify(value) ?? 'null', extraHeaders);
}

/**
 * Send a JSON reply whose body the caller already serialized. The hot REST
 * paths build their bytes with templates (rest.ts) instead of allocating an
 * object graph for JSON.stringify to walk; the wire bytes are the same.
 * Content-Length is stated outright: the body is complete in one end() call,
 * and a stated length is cheaper for keep-alive clients than chunked framing.
 */
export function sendText(
  store: Store,
  res: ServerResponse,
  status: number,
  text: string,
  extraHeaders: Readonly<Record<string, string>> = {},
): void {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'x-github-request-id': store.nextRequestId(),
    'content-length': Buffer.byteLength(text),
    ...extraHeaders,
  });
  res.end(text);
}

/** Send an error reply: always a JSON object with a non-empty message. */
export function sendError(store: Store, res: ServerResponse, status: number, message: string): void {
  sendJson(store, res, status, { message });
}

/** Send a bodyless reply (204), still carrying the request id header. */
export function sendEmpty(store: Store, res: ServerResponse, status: number): void {
  res.writeHead(status, { 'x-github-request-id': store.nextRequestId() });
  res.end();
}

/** Send raw bytes with an explicit content type (the git smart-HTTP answers). */
export function sendBytes(
  store: Store,
  res: ServerResponse,
  status: number,
  body: Buffer,
  contentType: string,
): void {
  res.writeHead(status, {
    'content-type': contentType,
    'x-github-request-id': store.nextRequestId(),
    'content-length': body.length,
  });
  res.end(body);
}

/** Parse a JSON request body; answers null after sending the 400 when it is malformed. */
export async function readJsonBody(store: Store, req: IncomingMessage, res: ServerResponse): Promise<unknown | null> {
  const raw = await readBody(req);
  if (raw.length === 0) return {};
  try {
    return JSON.parse(raw.toString('utf8')) as unknown;
  } catch {
    sendError(store, res, 400, 'Problems parsing JSON');
    return null;
  }
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** A string field of a JSON body, or undefined when absent or not a string. */
export function stringField(body: Record<string, unknown>, name: string): string | undefined {
  const value = body[name];
  return typeof value === 'string' ? value : undefined;
}
