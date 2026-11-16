// githttp.ts — the git smart-HTTP surface.
//
// GET /{owner}/{repo}.git/info/refs advertises refs and capabilities (protocol
// v2 for upload-pack when the client asks, v0 otherwise and always for
// receive-pack). POST git-upload-pack speaks the v2 commands ls-refs and fetch
// (with shallow deepen negotiation) and the v0 fetch fallback. POST
// git-receive-pack parses the command list and the pack, stores the objects,
// enforces fast-forward-only updates per ref, and answers report-status inside
// side-band-64k when the client negotiated it. Objects are stored as the exact
// bytes received, so anything pushed clones back byte for byte.

import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  PKT_FLUSH,
  ZERO_OID,
  collectReachable,
  encodePktLine,
  isAncestor,
  parseCommit,
  parseTag,
  peelToCommit,
  readPack,
  writePack,
  type GitObject,
  type PktPacket,
} from './gitobj.ts';
import type { Repo, Store } from './store.ts';
import { readBody, sendBytes, sendError } from './web.ts';

const AGENT = 'lucky-comet-forge/1.0';
const SIDEBAND_CHUNK = 16384;

// ---------------------------------------------------------------------------------------------
// pkt-line stream helpers
// ---------------------------------------------------------------------------------------------

/** Decode packets from the front of a buffer; answers the packets and the undecoded rest. */
function decodePktPrefix(buffer: Buffer): { packets: PktPacket[]; rest: Buffer } {
  const packets: PktPacket[] = [];
  let offset = 0;
  while (offset < buffer.length) {
    if (offset + 4 > buffer.length) throw new Error('truncated pkt-line header');
    const headerText = buffer.subarray(offset, offset + 4).toString('ascii');
    if (!/^[0-9a-fA-F]{4}$/.test(headerText)) throw new Error(`invalid pkt-line length ${JSON.stringify(headerText)}`);
    const length = Number.parseInt(headerText, 16);
    if (length === 0) {
      packets.push({ kind: 'flush' });
      offset += 4;
      // A flush ends the framed part of a receive-pack request: what follows is the pack.
      return { packets, rest: buffer.subarray(offset) };
    }
    if (length === 1) {
      packets.push({ kind: 'delim' });
      offset += 4;
      continue;
    }
    if (length === 2) {
      packets.push({ kind: 'response-end' });
      offset += 4;
      continue;
    }
    if (length === 3 || length > 65520) throw new Error(`invalid pkt-line length ${length}`);
    if (offset + length > buffer.length) throw new Error('truncated pkt-line payload');
    packets.push({ kind: 'data', payload: buffer.subarray(offset + 4, offset + length) });
    offset += length;
  }
  return { packets, rest: Buffer.alloc(0) };
}

function dataLines(packets: readonly PktPacket[]): string[] {
  const lines: string[] = [];
  for (const packet of packets) {
    if (packet.kind === 'data') lines.push(packet.payload.toString('utf8').replace(/\n$/, ''));
  }
  return lines;
}

/** Frame pack bytes as side-band-64k band-1 packets. */
function sidebandPackets(pack: Buffer): Buffer[] {
  const parts: Buffer[] = [];
  for (let offset = 0; offset < pack.length; offset += SIDEBAND_CHUNK) {
    const chunk = pack.subarray(offset, Math.min(offset + SIDEBAND_CHUNK, pack.length));
    parts.push(encodePktLine(Buffer.concat([Buffer.from([1]), chunk])));
  }
  return parts;
}

// ---------------------------------------------------------------------------------------------
// advertisements
// ---------------------------------------------------------------------------------------------

function sortedRefs(repo: Repo): Array<[string, string]> {
  return [...repo.refs.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
}

/** The v0 ref block: HEAD (or the capabilities^{} pseudo-ref), refs, peeled tag lines. */
function v0RefBlock(store: Store, repo: Repo, capabilities: string): Buffer {
  const parts: Buffer[] = [];
  const refs = sortedRefs(repo);
  const headRef = `refs/heads/${repo.defaultBranch}`;
  const headOid = repo.refs.get(headRef);
  let first = true;
  const line = (text: string): void => {
    parts.push(encodePktLine(first ? `${text}\0${capabilities}\n` : `${text}\n`));
    first = false;
  };
  if (refs.length === 0) {
    line(`${ZERO_OID} capabilities^{}`);
  } else {
    if (headOid !== undefined) line(`${headOid} HEAD`);
    for (const [ref, oid] of refs) {
      line(`${oid} ${ref}`);
      const object = store.getObject(oid);
      if (object && object.type === 'tag') {
        const peeled = peelToCommit(store.objects, oid);
        if (peeled !== null) parts.push(encodePktLine(`${peeled} ${ref}^{}\n`));
      }
    }
  }
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

function advertisementV2(store: Store, res: ServerResponse): void {
  const body = Buffer.concat([
    encodePktLine('version 2\n'),
    encodePktLine(`agent=${AGENT}\n`),
    encodePktLine('ls-refs=unborn\n'),
    encodePktLine('fetch=shallow\n'),
    encodePktLine('object-format=sha1\n'),
    PKT_FLUSH,
  ]);
  sendBytes(store, res, 200, body, 'application/x-git-upload-pack-advertisement');
}

export async function handleInfoRefs(
  store: Store,
  req: IncomingMessage,
  res: ServerResponse,
  repo: Repo,
  query: URLSearchParams,
): Promise<void> {
  const service = query.get('service');
  if (service === 'git-upload-pack') {
    const protocol = req.headers['git-protocol'];
    if (typeof protocol === 'string' && protocol.includes('version=2')) {
      advertisementV2(store, res);
      return;
    }
    const caps = `side-band-64k thin-pack ofs-delta shallow symref=HEAD:refs/heads/${repo.defaultBranch} agent=${AGENT}`;
    const body = Buffer.concat([
      encodePktLine('# service=git-upload-pack\n'),
      PKT_FLUSH,
      v0RefBlock(store, repo, caps),
    ]);
    sendBytes(store, res, 200, body, 'application/x-git-upload-pack-advertisement');
    return;
  }
  if (service === 'git-receive-pack') {
    const caps = `report-status side-band-64k delete-refs ofs-delta agent=${AGENT}`;
    const body = Buffer.concat([
      encodePktLine('# service=git-receive-pack\n'),
      PKT_FLUSH,
      v0RefBlock(store, repo, caps),
    ]);
    sendBytes(store, res, 200, body, 'application/x-git-receive-pack-advertisement');
    return;
  }
  sendError(store, res, 400, 'Unknown service');
}

// ---------------------------------------------------------------------------------------------
// ls-refs (protocol v2)
// ---------------------------------------------------------------------------------------------

function handleLsRefs(store: Store, res: ServerResponse, repo: Repo, args: string[]): void {
  let peel = false;
  let symrefs = false;
  let unborn = false;
  const prefixes: string[] = [];
  for (const arg of args) {
    if (arg === 'peel') peel = true;
    else if (arg === 'symrefs') symrefs = true;
    else if (arg === 'unborn') unborn = true;
    else if (arg.startsWith('ref-prefix ')) prefixes.push(arg.slice('ref-prefix '.length));
  }
  interface Row {
    name: string;
    oid: string;
    symrefTarget?: string;
    peeled?: string;
    unborn?: boolean;
  }
  const rows: Row[] = [];
  const headRef = `refs/heads/${repo.defaultBranch}`;
  const headOid = repo.refs.get(headRef);
  if (headOid !== undefined) {
    rows.push({ name: 'HEAD', oid: headOid, symrefTarget: headRef });
  } else if (unborn) {
    rows.push({ name: 'HEAD', oid: ZERO_OID, symrefTarget: headRef, unborn: true });
  }
  for (const [ref, oid] of sortedRefs(repo)) {
    const row: Row = { name: ref, oid };
    if (peel) {
      const object = store.getObject(oid);
      if (object && object.type === 'tag') {
        const peeled = peelToCommit(store.objects, oid);
        if (peeled !== null) row.peeled = peeled;
      }
    }
    rows.push(row);
  }
  const kept = prefixes.length === 0 ? rows : rows.filter((row) => prefixes.some((prefix) => row.name.startsWith(prefix)));
  const parts: Buffer[] = [];
  for (const row of kept) {
    if (row.unborn) {
      parts.push(encodePktLine(`unborn ${row.name} symref-target:${row.symrefTarget}\n`));
      continue;
    }
    let line = `${row.oid} ${row.name}`;
    if (symrefs && row.symrefTarget !== undefined) line += ` symref-target:${row.symrefTarget}`;
    if (row.peeled !== undefined) line += ` peeled:${row.peeled}`;
    parts.push(encodePktLine(`${line}\n`));
  }
  parts.push(PKT_FLUSH);
  sendBytes(store, res, 200, Buffer.concat(parts), 'application/x-git-upload-pack-result');
}

// ---------------------------------------------------------------------------------------------
// fetch (protocol v2 and v0)
// ---------------------------------------------------------------------------------------------

interface FetchPlan {
  objects: GitObject[];
  shallow: string[];
  unshallow: string[];
}

/**
 * The closure a fetch may treat as already held: everything reachable from the
 * haves, except that a commit the client marks shallow is a boundary — the
 * client holds that commit and its tree, but not its parents, so the walk
 * does not descend past it.
 */
function haveClosureOf(store: Store, haves: readonly string[], shallowIn: readonly string[]): Set<string> {
  if (shallowIn.length === 0) return collectReachable(store.objects, haves);
  const boundary = new Set(shallowIn);
  const seen = new Set<string>();
  const queue: string[] = [...haves];
  while (queue.length > 0) {
    const oid = queue.pop()!;
    if (seen.has(oid)) continue;
    const object = store.getObject(oid);
    if (!object) continue;
    seen.add(oid);
    if (object.type === 'commit') {
      const commit = parseCommit(object.data);
      queue.push(commit.tree);
      if (!boundary.has(oid)) for (const parent of commit.parents) queue.push(parent);
    } else if (object.type === 'tag') {
      queue.push(parseTag(object.data).object);
    } else if (object.type === 'tree') {
      for (const entry of parseTreeEntries(store, oid)) queue.push(entry);
    }
  }
  return seen;
}

/**
 * Work out what a fetch sends: the wants' closure minus the haves' closure, cut
 * at `deepen` commit generations when a depth was negotiated, with the resulting
 * shallow boundary. Tag wants contribute their object plus their commit.
 */
function planFetch(
  store: Store,
  wants: readonly string[],
  haves: readonly string[],
  shallowIn: readonly string[],
  deepen: number | null,
): FetchPlan {
  const haveClosure = haveClosureOf(store, haves, shallowIn);
  if (deepen === null) {
    const wantClosure = collectReachable(store.objects, wants);
    const objects: GitObject[] = [];
    for (const oid of wantClosure) {
      if (haveClosure.has(oid)) continue;
      const object = store.getObject(oid);
      if (object) objects.push(object);
    }
    return { objects, shallow: [], unshallow: [] };
  }

  // Depth-limited: walk commit generations outward from the wants.
  const included = new Set<string>();
  const includedCommits = new Set<string>();
  const includeTreeClosure = (treeOid: string): void => {
    const stack = [treeOid];
    while (stack.length > 0) {
      const oid = stack.pop()!;
      if (included.has(oid)) continue;
      const object = store.getObject(oid);
      if (!object) continue;
      included.add(oid);
      if (object.type === 'tree') {
        for (const entry of parseTreeEntries(store, oid)) stack.push(entry);
      }
    }
  };
  let frontier: string[] = [];
  for (const want of wants) {
    const object = store.getObject(want);
    if (!object) continue;
    if (object.type === 'tag') {
      included.add(want);
      const target = parseTag(object.data).object;
      if (store.getObject(target)?.type === 'commit') frontier.push(target);
    } else if (object.type === 'commit') {
      frontier.push(want);
    }
  }
  let level = 1;
  for (;;) {
    const next: string[] = [];
    for (const oid of frontier) {
      if (includedCommits.has(oid)) continue;
      const object = store.getObject(oid);
      if (!object || object.type !== 'commit') continue;
      includedCommits.add(oid);
      included.add(oid);
      const commit = parseCommit(object.data);
      includeTreeClosure(commit.tree);
      if (level < deepen) next.push(...commit.parents);
    }
    if (level >= deepen || next.length === 0) break;
    frontier = next;
    level += 1;
  }
  const shallow: string[] = [];
  const unshallow: string[] = [];
  for (const oid of includedCommits) {
    const object = store.getObject(oid);
    if (!object || object.type !== 'commit') continue;
    const parents = parseCommit(object.data).parents;
    if (parents.some((parent) => !includedCommits.has(parent) && store.getObject(parent)?.type === 'commit')) {
      shallow.push(oid);
    }
  }
  for (const boundary of shallowIn) {
    if (!includedCommits.has(boundary)) continue;
    const object = store.getObject(boundary);
    if (!object || object.type !== 'commit') continue;
    const parents = parseCommit(object.data).parents;
    if (parents.every((parent) => includedCommits.has(parent))) unshallow.push(boundary);
  }
  const objects: GitObject[] = [];
  for (const oid of included) {
    if (haveClosure.has(oid)) continue;
    const object = store.getObject(oid);
    if (object) objects.push(object);
  }
  return { objects, shallow, unshallow };
}

function parseTreeEntries(store: Store, treeOid: string): string[] {
  const object = store.getObject(treeOid);
  if (!object || object.type !== 'tree') return [];
  const out: string[] = [];
  const data = object.data;
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    const nul = data.indexOf(0x00, space + 1);
    out.push(data.subarray(nul + 1, nul + 21).toString('hex'));
    offset = nul + 21;
  }
  return out;
}

interface FetchArgs {
  wants: string[];
  haves: string[];
  shallow: string[];
  deepen: number | null;
}

function parseFetchArgs(lines: readonly string[]): FetchArgs {
  const args: FetchArgs = { wants: [], haves: [], shallow: [], deepen: null };
  for (const line of lines) {
    if (line.startsWith('want ')) args.wants.push(line.slice(5).trim().split(' ')[0]!);
    else if (line.startsWith('have ')) args.haves.push(line.slice(5).trim());
    else if (line.startsWith('shallow ')) args.shallow.push(line.slice(8).trim());
    else if (line.startsWith('deepen ')) {
      const value = Number.parseInt(line.slice(7).trim(), 10);
      if (Number.isFinite(value) && value > 0) args.deepen = value;
    }
  }
  return args;
}

function handleFetchV2(store: Store, res: ServerResponse, repo: Repo, argLines: string[]): void {
  const args = parseFetchArgs(argLines);
  const plan = planFetch(store, args.wants, args.haves, args.shallow, args.deepen);
  const pack = writePack(plan.objects);
  const parts: Buffer[] = [];
  if (args.deepen !== null) {
    parts.push(encodePktLine('shallow-info\n'));
    for (const oid of plan.shallow) parts.push(encodePktLine(`shallow ${oid}\n`));
    for (const oid of plan.unshallow) parts.push(encodePktLine(`unshallow ${oid}\n`));
    parts.push(PKT_FLUSH);
  }
  if (args.haves.length > 0) {
    parts.push(encodePktLine('acknowledgments\n'));
    parts.push(encodePktLine('NAK\n'));
    parts.push(PKT_FLUSH);
  }
  parts.push(encodePktLine('packfile\n'));
  parts.push(...sidebandPackets(pack));
  parts.push(PKT_FLUSH);
  sendBytes(store, res, 200, Buffer.concat(parts), 'application/x-git-upload-pack-result');
}

function handleFetchV0(store: Store, res: ServerResponse, repo: Repo, packets: PktPacket[]): void {
  // v0: want section, flush, have section, flush. The sections arrive as one
  // packet list because decodePktPrefix stops at the first flush; re-frame the
  // rest leniently by scanning the raw lines in order.
  const args = parseFetchArgs(dataLines(packets));
  const plan = planFetch(store, args.wants, args.haves, args.shallow, args.deepen);
  const pack = writePack(plan.objects);
  const parts: Buffer[] = [];
  if (args.deepen !== null) {
    for (const oid of plan.shallow) parts.push(encodePktLine(`shallow ${oid}\n`));
    for (const oid of plan.unshallow) parts.push(encodePktLine(`unshallow ${oid}\n`));
  }
  parts.push(encodePktLine('NAK\n'));
  parts.push(...sidebandPackets(pack));
  parts.push(PKT_FLUSH);
  sendBytes(store, res, 200, Buffer.concat(parts), 'application/x-git-upload-pack-result');
}

export async function handleUploadPack(store: Store, req: IncomingMessage, res: ServerResponse, repo: Repo): Promise<void> {
  const body = await readBody(req);
  let decoded: { packets: PktPacket[]; rest: Buffer };
  try {
    decoded = decodePktPrefix(body);
  } catch {
    sendError(store, res, 400, 'Malformed pkt-line stream');
    return;
  }
  const protocol = req.headers['git-protocol'];
  const isV2 = typeof protocol === 'string' && protocol.includes('version=2');
  if (!isV2) {
    // A v0 fetch body is framed in two sections; decode the whole body for its lines.
    try {
      const all = decodeAllPackets(body);
      handleFetchV0(store, res, repo, all);
    } catch {
      sendError(store, res, 400, 'Malformed pkt-line stream');
    }
    return;
  }
  // v2: the command line and its capabilities come before the delim; args follow.
  const lines = dataLines(decoded.packets);
  const commandLine = lines[0] ?? '';
  const command = commandLine.startsWith('command=') ? commandLine.slice('command='.length) : '';
  const argLines = lines.slice(1);
  if (command === 'ls-refs') {
    handleLsRefs(store, res, repo, argLines);
    return;
  }
  if (command === 'fetch') {
    handleFetchV2(store, res, repo, argLines);
    return;
  }
  sendError(store, res, 400, `Unknown command ${command}`);
}

/** Decode a whole buffer as pkt-lines (v0 bodies carry no raw tail). */
function decodeAllPackets(buffer: Buffer): PktPacket[] {
  const packets: PktPacket[] = [];
  let offset = 0;
  while (offset < buffer.length) {
    if (offset + 4 > buffer.length) throw new Error('truncated pkt-line header');
    const headerText = buffer.subarray(offset, offset + 4).toString('ascii');
    if (!/^[0-9a-fA-F]{4}$/.test(headerText)) throw new Error('invalid pkt-line length');
    const length = Number.parseInt(headerText, 16);
    if (length === 0) {
      packets.push({ kind: 'flush' });
      offset += 4;
    } else if (length === 1) {
      packets.push({ kind: 'delim' });
      offset += 4;
    } else if (length === 2) {
      packets.push({ kind: 'response-end' });
      offset += 4;
    } else {
      if (length === 3 || length > 65520 || offset + length > buffer.length) throw new Error('invalid pkt-line');
      packets.push({ kind: 'data', payload: buffer.subarray(offset + 4, offset + length) });
      offset += length;
    }
  }
  return packets;
}

// ---------------------------------------------------------------------------------------------
// receive-pack
// ---------------------------------------------------------------------------------------------

interface PushCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}

export async function handleReceivePack(store: Store, req: IncomingMessage, res: ServerResponse, repo: Repo): Promise<void> {
  const body = await readBody(req);
  let decoded: { packets: PktPacket[]; rest: Buffer };
  try {
    decoded = decodePktPrefix(body);
  } catch {
    sendError(store, res, 400, 'Malformed pkt-line stream');
    return;
  }
  const lines = dataLines(decoded.packets);
  let capabilities = '';
  const commands: PushCommand[] = [];
  lines.forEach((rawLine, index) => {
    let line = rawLine;
    if (index === 0) {
      const nul = line.indexOf('\0');
      if (nul >= 0) {
        capabilities = line.slice(nul + 1);
        line = line.slice(0, nul);
      }
    }
    const parts = line.split(' ');
    if (parts.length === 3) commands.push({ oldOid: parts[0]!, newOid: parts[1]!, ref: parts[2]! });
  });

  // Unpack first: the objects land in the store whether or not every ref moves.
  let unpackOk = true;
  let unpackDetail = 'ok';
  const pack = decoded.rest;
  if (pack.length > 0) {
    try {
      const objects = readPack(pack, (oid) => store.getObject(oid));
      for (const object of objects) store.putObject(object.type, object.data);
    } catch (err) {
      unpackOk = false;
      unpackDetail = err instanceof Error ? err.message.replace(/\s+/g, ' ').slice(0, 80) : 'unpacker error';
    }
  }

  const reports: string[] = [`unpack ${unpackOk ? 'ok' : unpackDetail}`];
  for (const command of commands) {
    if (!unpackOk) {
      reports.push(`ng ${command.ref} unpacker error`);
      continue;
    }
    const current = repo.refs.get(command.ref) ?? ZERO_OID;
    if (command.oldOid !== current) {
      reports.push(`ng ${command.ref} reference already exists`);
      continue;
    }
    if (command.newOid === ZERO_OID) {
      repo.refs.delete(command.ref);
      reports.push(`ok ${command.ref}`);
      continue;
    }
    const object = store.getObject(command.newOid);
    if (!object) {
      reports.push(`ng ${command.ref} invalid object`);
      continue;
    }
    if (command.ref.startsWith('refs/heads/')) {
      if (object.type !== 'commit') {
        reports.push(`ng ${command.ref} invalid object`);
        continue;
      }
      if (command.oldOid !== ZERO_OID && !isAncestor(store.objects, command.oldOid, command.newOid)) {
        reports.push(`ng ${command.ref} non-fast-forward`);
        continue;
      }
    }
    repo.refs.set(command.ref, command.newOid);
    reports.push(`ok ${command.ref}`);
  }

  const reportStream = Buffer.concat([...reports.map((line) => encodePktLine(`${line}\n`)), PKT_FLUSH]);
  const caps = new Set(capabilities.split(' ').filter(Boolean));
  let responseBody: Buffer;
  if (caps.has('side-band-64k')) {
    const parts: Buffer[] = [];
    for (let offset = 0; offset < reportStream.length; offset += SIDEBAND_CHUNK) {
      const chunk = reportStream.subarray(offset, Math.min(offset + SIDEBAND_CHUNK, reportStream.length));
      parts.push(encodePktLine(Buffer.concat([Buffer.from([1]), chunk])));
    }
    parts.push(PKT_FLUSH);
    responseBody = Buffer.concat(parts);
  } else {
    responseBody = reportStream;
  }
  sendBytes(store, res, 200, responseBody, 'application/x-git-receive-pack-result');
}
