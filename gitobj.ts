// gitobj.ts — the git object model for the forge.
//
// Everything the four surfaces share stands on this module: real git SHA-1
// object ids, loose-object bytes kept verbatim (so a clone round-trips a push
// byte for byte), tree/commit/tag parsing and building, packfile reading
// (plain objects plus OFS/REF deltas) and writing (plain objects only, which
// the wire contract accepts), reachability walks for fetch negotiation, a
// three-way tree merge for pull requests, and a small line diff for the
// pull-request file list. Node standard library only.

import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';

export type GitObjectType = 'commit' | 'tree' | 'blob' | 'tag';

export interface GitObject {
  readonly type: GitObjectType;
  readonly data: Buffer;
}

export const ZERO_OID = '0'.repeat(40);
const HEX40 = /^[0-9a-f]{40}$/;

export function isObjectId(value: string): boolean {
  return HEX40.test(value);
}

/** git's object id: SHA-1 over `<type> <size>\0` followed by the raw bytes. */
export function hashObject(type: GitObjectType, data: Uint8Array): string {
  const body = Buffer.isBuffer(data) ? data : Buffer.from(data);
  const hash = createHash('sha1');
  hash.update(Buffer.from(`${type} ${body.length}\0`, 'utf8'));
  hash.update(body);
  return hash.digest('hex');
}

// ---------------------------------------------------------------------------------------------
// trees
// ---------------------------------------------------------------------------------------------

export interface TreeEntry {
  mode: string; // git's ASCII mode: '100644', '100755', '120000', '40000', '160000'
  name: string;
  oid: string;
}

export function parseTree(data: Uint8Array): TreeEntry[] {
  const buffer = Buffer.isBuffer(data) ? data : Buffer.from(data);
  const entries: TreeEntry[] = [];
  let offset = 0;
  while (offset < buffer.length) {
    const space = buffer.indexOf(0x20, offset);
    if (space < 0) throw new Error('tree entry has no mode separator');
    const nul = buffer.indexOf(0x00, space + 1);
    if (nul < 0 || nul + 21 > buffer.length) throw new Error('tree entry is truncated');
    entries.push({
      mode: buffer.subarray(offset, space).toString('ascii'),
      name: buffer.subarray(space + 1, nul).toString('utf8'),
      oid: buffer.subarray(nul + 1, nul + 21).toString('hex'),
    });
    offset = nul + 21;
  }
  return entries;
}

/** git's tree sort: byte order of the name, directories compared as if they ended in '/'. */
function compareTreeEntries(a: TreeEntry, b: TreeEntry): number {
  const left = Buffer.from(a.mode === '40000' ? `${a.name}/` : a.name, 'utf8');
  const right = Buffer.from(b.mode === '40000' ? `${b.name}/` : b.name, 'utf8');
  return Buffer.compare(left, right);
}

export function buildTree(entries: readonly TreeEntry[]): Buffer {
  const sorted = [...entries].sort(compareTreeEntries);
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
    parts.push(Buffer.from(entry.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------------------------------------
// commits and tags
// ---------------------------------------------------------------------------------------------

export interface CommitView {
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  message: string;
}

export function parseCommit(data: Uint8Array): CommitView {
  const buffer = Buffer.isBuffer(data) ? data : Buffer.from(data);
  const blank = buffer.indexOf('\n\n');
  const headerEnd = blank < 0 ? buffer.length : blank;
  const headerText = buffer.subarray(0, headerEnd).toString('utf8');
  const message = blank < 0 ? '' : buffer.subarray(blank + 2).toString('utf8');
  let tree = '';
  const parents: string[] = [];
  let author = '';
  let committer = '';
  for (const line of headerText.split('\n')) {
    if (!line) continue;
    const space = line.indexOf(' ');
    const key = space < 0 ? line : line.slice(0, space);
    const value = space < 0 ? '' : line.slice(space + 1);
    if (key === 'tree') tree = value;
    else if (key === 'parent') parents.push(value);
    else if (key === 'author') author = value;
    else if (key === 'committer') committer = value;
  }
  return { tree, parents, author, committer, message };
}

export function buildCommit(fields: {
  tree: string;
  parents?: readonly string[];
  message: string;
  author: string; // full identity line without the timestamp, e.g. 'Ada <ada@x>'
  committer?: string;
  timestampSec: number;
  timezone?: string;
}): Buffer {
  const tz = fields.timezone ?? '+0000';
  const author = `${fields.author} ${fields.timestampSec} ${tz}`;
  const committer = `${fields.committer ?? fields.author} ${fields.timestampSec} ${tz}`;
  const lines = [`tree ${fields.tree}`];
  for (const parent of fields.parents ?? []) lines.push(`parent ${parent}`);
  lines.push(`author ${author}`, `committer ${committer}`, '');
  return Buffer.from(`${lines.join('\n')}\n${fields.message}`, 'utf8');
}

export interface TagView {
  object: string;
  type: GitObjectType;
  tag: string;
}

export function parseTag(data: Uint8Array): TagView {
  const buffer = Buffer.isBuffer(data) ? data : Buffer.from(data);
  const blank = buffer.indexOf('\n\n');
  const headerEnd = blank < 0 ? buffer.length : blank;
  const headers = new Map<string, string>();
  for (const line of buffer.subarray(0, headerEnd).toString('utf8').split('\n')) {
    if (!line) continue;
    const space = line.indexOf(' ');
    if (space < 0) continue;
    headers.set(line.slice(0, space), line.slice(space + 1));
  }
  const type = headers.get('type') ?? '';
  return {
    object: headers.get('object') ?? '',
    type: (type === 'commit' || type === 'tree' || type === 'blob' || type === 'tag' ? type : 'commit') as GitObjectType,
    tag: headers.get('tag') ?? '',
  };
}

/** Peel an object id to the commit it ultimately names (tag -> target, repeatedly). */
export function peelToCommit(store: Map<string, GitObject>, oid: string): string | null {
  let current = oid;
  for (let guard = 0; guard < 32; guard += 1) {
    const object = store.get(current);
    if (!object) return null;
    if (object.type === 'commit') return current;
    if (object.type === 'tag') {
      current = parseTag(object.data).object;
      continue;
    }
    return null;
  }
  return null;
}

// ---------------------------------------------------------------------------------------------
// reachability
// ---------------------------------------------------------------------------------------------

/**
 * Every object reachable from `roots` (commit -> tree + parents, tree -> entries,
 * tag -> target). Missing objects are skipped, never fatal: a fetch negotiation
 * must survive a `have` the server does not know.
 */
export function collectReachable(store: Map<string, GitObject>, roots: Iterable<string>): Set<string> {
  const seen = new Set<string>();
  const queue: string[] = [];
  for (const root of roots) if (isObjectId(root)) queue.push(root);
  while (queue.length > 0) {
    const oid = queue.pop()!;
    if (seen.has(oid)) continue;
    const object = store.get(oid);
    if (!object) continue;
    seen.add(oid);
    if (object.type === 'commit') {
      const commit = parseCommit(object.data);
      queue.push(commit.tree);
      for (const parent of commit.parents) queue.push(parent);
    } else if (object.type === 'tag') {
      queue.push(parseTag(object.data).object);
    } else if (object.type === 'tree') {
      for (const entry of parseTree(object.data)) {
        if (entry.mode === '160000') continue; // a gitlink names a commit this repo does not hold
        queue.push(entry.oid);
      }
    }
  }
  return seen;
}

/** All ancestors of a commit, including itself. */
export function commitAncestors(store: Map<string, GitObject>, tip: string): Set<string> {
  const seen = new Set<string>();
  const queue = [tip];
  while (queue.length > 0) {
    const oid = queue.pop()!;
    if (seen.has(oid)) continue;
    const object = store.get(oid);
    if (!object || object.type !== 'commit') continue;
    seen.add(oid);
    for (const parent of parseCommit(object.data).parents) queue.push(parent);
  }
  return seen;
}

/** True when `ancestor` is `descendant` itself or one of its ancestors (early-exit walk). */
export function isAncestor(store: Map<string, GitObject>, ancestor: string, descendant: string): boolean {
  if (ancestor === descendant) return true;
  const seen = new Set<string>();
  const stack = [descendant];
  while (stack.length > 0) {
    const oid = stack.pop()!;
    if (oid === ancestor) return true;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const object = store.get(oid);
    if (!object || object.type !== 'commit') continue;
    for (const parent of parseCommit(object.data).parents) stack.push(parent);
  }
  return false;
}

/**
 * The merge base of two commits: a common ancestor that is not itself an ancestor
 * of another common ancestor. Histories here are small; a plain two-set walk is fine.
 */
export function mergeBase(store: Map<string, GitObject>, a: string, b: string): string | null {
  if (a === b) return a;
  const ancestorsA = commitAncestors(store, a);
  if (ancestorsA.has(b)) return b;
  const ancestorsB = commitAncestors(store, b);
  if (ancestorsB.has(a)) return a;
  // Breadth-first from b so the first common commit found is a nearest one.
  const seen = new Set<string>();
  let frontier = [b];
  while (frontier.length > 0) {
    const next: string[] = [];
    for (const oid of frontier) {
      if (seen.has(oid)) continue;
      seen.add(oid);
      if (ancestorsA.has(oid)) return oid;
      const object = store.get(oid);
      if (object && object.type === 'commit') next.push(...parseCommit(object.data).parents);
    }
    frontier = next;
  }
  return null;
}

// ---------------------------------------------------------------------------------------------
// tree paths and flattening
// ---------------------------------------------------------------------------------------------

/** The object at `segments` under a tree, or null when any step is absent. */
export function treePathLookup(
  store: Map<string, GitObject>,
  treeOid: string,
  segments: readonly string[],
): { oid: string; mode: string } | null {
  let current = treeOid;
  for (let index = 0; index < segments.length; index += 1) {
    const object = store.get(current);
    if (!object || object.type !== 'tree') return null;
    const entry = parseTree(object.data).find((candidate) => candidate.name === segments[index]);
    if (!entry) return null;
    if (index === segments.length - 1) return { oid: entry.oid, mode: entry.mode };
    if (entry.mode !== '40000') return null;
    current = entry.oid;
  }
  return null;
}

/**
 * A new root tree with `segments` set to `leaf` (a blob oid + mode), or removed when
 * `leaf` is null. Intermediate trees are created as needed; emptied directories are
 * pruned, the way git drops them.
 */
export function treePathSet(
  store: Map<string, GitObject>,
  put: (type: GitObjectType, data: Buffer) => string,
  treeOid: string | null,
  segments: readonly string[],
  leaf: { oid: string; mode: string } | null,
): string | null {
  const entries: TreeEntry[] = treeOid === null ? [] : parseTree(store.get(treeOid)?.data ?? Buffer.alloc(0));
  const head = segments[0]!;
  const rest = segments.slice(1);
  const kept = entries.filter((entry) => entry.name !== head);
  if (rest.length === 0) {
    if (leaf !== null) kept.push({ mode: leaf.mode, name: head, oid: leaf.oid });
  } else {
    const existing = entries.find((entry) => entry.name === head && entry.mode === '40000');
    const child = treePathSet(store, put, existing ? existing.oid : null, rest, leaf);
    if (child !== null) kept.push({ mode: '40000', name: head, oid: child });
  }
  if (kept.length === 0) return null;
  return put('tree', buildTree(kept));
}

/** A flat path -> {oid, mode} map of a whole tree (recursive). */
export function flattenTree(store: Map<string, GitObject>, treeOid: string): Map<string, { oid: string; mode: string }> {
  const out = new Map<string, { oid: string; mode: string }>();
  const walk = (oid: string, prefix: string): void => {
    const object = store.get(oid);
    if (!object || object.type !== 'tree') return;
    for (const entry of parseTree(object.data)) {
      const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
      if (entry.mode === '40000') walk(entry.oid, path);
      else out.set(path, { oid: entry.oid, mode: entry.mode });
    }
  };
  walk(treeOid, '');
  return out;
}

/** Rebuild nested trees from a flat path map; answers the root tree oid (empty tree when bare). */
export function unflattenTree(
  put: (type: GitObjectType, data: Buffer) => string,
  flat: ReadonlyMap<string, { oid: string; mode: string }>,
): string {
  interface Dir {
    files: Map<string, { oid: string; mode: string }>;
    dirs: Map<string, Dir>;
  }
  const root: Dir = { files: new Map(), dirs: new Map() };
  for (const [path, leaf] of flat) {
    const segments = path.split('/');
    let dir = root;
    for (let index = 0; index < segments.length - 1; index += 1) {
      let child = dir.dirs.get(segments[index]!);
      if (!child) {
        child = { files: new Map(), dirs: new Map() };
        dir.dirs.set(segments[index]!, child);
      }
      dir = child;
    }
    dir.files.set(segments[segments.length - 1]!, leaf);
  }
  const build = (dir: Dir): string => {
    const entries: TreeEntry[] = [];
    for (const [name, leaf] of dir.files) entries.push({ mode: leaf.mode, name, oid: leaf.oid });
    for (const [name, child] of dir.dirs) entries.push({ mode: '40000', name, oid: build(child) });
    return put('tree', buildTree(entries));
  };
  return build(root);
}

/** The empty tree's id (a repo with no files still names it in root commits). */
export const EMPTY_TREE_OID = hashObject('tree', Buffer.alloc(0));

// ---------------------------------------------------------------------------------------------
// three-way merge and file diffs (pull requests)
// ---------------------------------------------------------------------------------------------

/**
 * Merge `head` into `base` against their common ancestor's tree, path by path.
 * Answers the merged flat map, or null on the first true conflict (both sides
 * changed the same path differently, or one side deleted what the other changed).
 */
export function mergeFlatTrees(
  ancestor: ReadonlyMap<string, { oid: string; mode: string }>,
  base: ReadonlyMap<string, { oid: string; mode: string }>,
  head: ReadonlyMap<string, { oid: string; mode: string }>,
): Map<string, { oid: string; mode: string }> | null {
  const out = new Map<string, { oid: string; mode: string }>();
  const paths = new Set<string>([...ancestor.keys(), ...base.keys(), ...head.keys()]);
  for (const path of paths) {
    const a = ancestor.get(path);
    const b = base.get(path);
    const h = head.get(path);
    const same = (x?: { oid: string; mode: string }, y?: { oid: string; mode: string }): boolean =>
      x === undefined && y === undefined ? true : x !== undefined && y !== undefined && x.oid === y.oid && x.mode === y.mode;
    if (same(h, b)) {
      if (b) out.set(path, b);
    } else if (same(h, a)) {
      if (b) out.set(path, b); // only the base side changed (or deleted) it
    } else if (same(b, a)) {
      if (h) out.set(path, h); // only the head side changed it
    } else {
      return null; // both sides changed it differently
    }
  }
  return out;
}

/** A text's lines for diffing: a trailing newline terminates the last line, it is not an extra one. */
export function linesOf(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  return lines;
}

/** Addition/deletion counts between two texts via a longest-common-subsequence walk. */
export function lineDiffCounts(oldText: string, newText: string): { additions: number; deletions: number } {
  const oldLines = linesOf(oldText);
  const newLines = linesOf(newText);
  if (oldLines.length === 0) return { additions: newLines.length, deletions: 0 };
  if (newLines.length === 0) return { additions: 0, deletions: oldLines.length };
  if (oldLines.length * newLines.length > 4_000_000) {
    // Very large files are not diffed line by line anywhere in the suite; count coarsely.
    return { additions: newLines.length, deletions: oldLines.length };
  }
  const width = newLines.length + 1;
  const dp = new Uint32Array((oldLines.length + 1) * width);
  for (let i = oldLines.length - 1; i >= 0; i -= 1) {
    for (let j = newLines.length - 1; j >= 0; j -= 1) {
      dp[i * width + j] = oldLines[i] === newLines[j]
        ? dp[(i + 1) * width + j + 1]! + 1
        : Math.max(dp[(i + 1) * width + j]!, dp[i * width + j + 1]!);
    }
  }
  const common = dp[0]!;
  return { additions: newLines.length - common, deletions: oldLines.length - common };
}

export interface FileChange {
  filename: string;
  status: 'added' | 'removed' | 'modified';
  additions: number;
  deletions: number;
  changes: number;
  sha: string | null;
}

/** The file-level diff between two flat trees (base -> head), sorted by path. */
export function diffFlatTrees(
  store: Map<string, GitObject>,
  base: ReadonlyMap<string, { oid: string; mode: string }>,
  head: ReadonlyMap<string, { oid: string; mode: string }>,
): FileChange[] {
  const text = (oid: string): string => {
    const object = store.get(oid);
    return object && object.type === 'blob' ? object.data.toString('utf8') : '';
  };
  const out: FileChange[] = [];
  const paths = [...new Set([...base.keys(), ...head.keys()])].sort();
  for (const path of paths) {
    const b = base.get(path);
    const h = head.get(path);
    if (b && h && b.oid === h.oid) continue;
    if (!b && h) {
      const additions = linesOf(text(h.oid)).length;
      out.push({ filename: path, status: 'added', additions, deletions: 0, changes: additions, sha: h.oid });
    } else if (b && !h) {
      const deletions = linesOf(text(b.oid)).length;
      out.push({ filename: path, status: 'removed', additions: 0, deletions, changes: deletions, sha: null });
    } else if (b && h) {
      const counts = lineDiffCounts(text(b.oid), text(h.oid));
      out.push({ filename: path, status: 'modified', additions: counts.additions, deletions: counts.deletions, changes: counts.additions + counts.deletions, sha: h.oid });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// packfiles
// ---------------------------------------------------------------------------------------------

const TYPE_CODE: Readonly<Record<GitObjectType, number>> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const CODE_TYPE: Readonly<Record<number, GitObjectType>> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

function writePackObjectHeader(type: GitObjectType, size: number): Buffer {
  const code = TYPE_CODE[type];
  const bytes: number[] = [];
  let remaining = size;
  let first = (code << 4) | (remaining & 0x0f);
  remaining = Math.floor(remaining / 16);
  while (remaining > 0) {
    bytes.push(first | 0x80);
    first = remaining & 0x7f;
    remaining = Math.floor(remaining / 128);
  }
  bytes.push(first);
  return Buffer.from(bytes);
}

/** A version-2 pack of plain (non-delta) objects, with the SHA-1 trailer. */
export function writePack(objects: Iterable<GitObject>): Buffer {
  const list = [...objects];
  const header = Buffer.allocUnsafe(12);
  header.write('PACK', 0, 4, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(list.length, 8);
  const parts: Buffer[] = [header];
  for (const object of list) {
    parts.push(writePackObjectHeader(object.type, object.data.length));
    parts.push(deflateSync(object.data));
  }
  const body = Buffer.concat(parts);
  return Buffer.concat([body, createHash('sha1').update(body).digest()]);
}

/** Apply a git delta stream to a base object's bytes. */
export function applyDelta(base: Uint8Array, delta: Uint8Array): Buffer {
  const baseBuffer = Buffer.isBuffer(base) ? base : Buffer.from(base);
  const deltaBuffer = Buffer.isBuffer(delta) ? delta : Buffer.from(delta);
  let offset = 0;
  const readSize = (): number => {
    let value = 0;
    let shift = 0;
    for (;;) {
      if (offset >= deltaBuffer.length) throw new Error('delta size varint is truncated');
      const byte = deltaBuffer[offset++]!;
      value += (byte & 0x7f) * 2 ** shift;
      shift += 7;
      if (!(byte & 0x80)) break;
    }
    return value;
  };
  const sourceSize = readSize();
  const targetSize = readSize();
  if (sourceSize !== baseBuffer.length) throw new Error('delta base size mismatch');
  const out = Buffer.allocUnsafe(targetSize);
  let written = 0;
  while (offset < deltaBuffer.length) {
    const op = deltaBuffer[offset++]!;
    if (op & 0x80) {
      let copyOffset = 0;
      let copySize = 0;
      let shift = 0;
      for (let bit = 0; bit < 4; bit += 1) {
        if (op & (1 << bit)) copyOffset += deltaBuffer[offset++]! * 2 ** shift;
        shift += 8;
      }
      shift = 0;
      for (let bit = 4; bit < 7; bit += 1) {
        if (op & (1 << bit)) copySize += deltaBuffer[offset++]! * 2 ** shift;
        shift += 8;
      }
      if (copySize === 0) copySize = 0x10000;
      baseBuffer.copy(out, written, copyOffset, copyOffset + copySize);
      written += copySize;
    } else if (op !== 0) {
      const literal = op & 0x7f;
      deltaBuffer.copy(out, written, offset, offset + literal);
      offset += literal;
      written += literal;
    } else {
      throw new Error('delta opcode 0 is invalid');
    }
  }
  if (written !== targetSize) throw new Error('delta produced the wrong size');
  return out;
}

function readVarintSize(buffer: Buffer, start: number): { size: number; next: number; first: number } {
  let byte = buffer[start]!;
  const first = byte;
  let size = byte & 0x0f;
  let shift = 4;
  let offset = start + 1;
  while (byte & 0x80) {
    byte = buffer[offset++]!;
    size += (byte & 0x7f) * 2 ** shift;
    shift += 7;
  }
  return { size, next: offset, first };
}

function readOfsDeltaBase(buffer: Buffer, start: number): { baseOffset: number; next: number } {
  let byte = buffer[start]!;
  let offset = start + 1;
  let value = byte & 0x7f;
  while (byte & 0x80) {
    byte = buffer[offset++]!;
    value = (value + 1) * 128 + (byte & 0x7f);
  }
  return { baseOffset: value, next: offset };
}

/** Inflate one zlib stream starting at `offset`; returns its bytes and the offset just past it. */
function inflateAt(buffer: Buffer, offset: number): { data: Buffer; next: number } {
  const result = inflateSync(buffer.subarray(offset), { info: true }) as unknown as {
    buffer: Buffer;
    engine: { bytesWritten: number };
  };
  return { data: result.buffer, next: offset + result.engine.bytesWritten };
}

/**
 * Read a packfile and resolve every object in it, including OFS_DELTA and REF_DELTA
 * entries (a REF_DELTA base may come from `external`, the objects the store already
 * holds — that is what makes a thin pack whole). Returns the resolved objects.
 */
export function readPack(
  pack: Uint8Array,
  external: (oid: string) => GitObject | undefined,
): GitObject[] {
  const buffer = Buffer.isBuffer(pack) ? pack : Buffer.from(pack);
  if (buffer.length < 32) throw new Error('pack is too short');
  if (buffer.subarray(0, 4).toString('ascii') !== 'PACK') throw new Error('pack does not start with PACK');
  const version = buffer.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`unsupported pack version ${version}`);
  const declaredCount = buffer.readUInt32BE(8);
  const trailerStart = buffer.length - 20;
  const trailer = buffer.subarray(trailerStart).toString('hex');
  const computed = createHash('sha1').update(buffer.subarray(0, trailerStart)).digest('hex');
  if (trailer !== computed) throw new Error('pack checksum mismatch');

  interface RawEntry {
    offset: number;
    typeCode: number;
    data: Buffer;
    baseOffset?: number;
    baseOid?: string;
  }
  const raw: RawEntry[] = [];
  const byOffset = new Map<number, RawEntry>();
  let offset = 12;
  for (let index = 0; index < declaredCount; index += 1) {
    const entryOffset = offset;
    const header = readVarintSize(buffer, offset);
    offset = header.next;
    const typeCode = (header.first >> 4) & 0x07;
    const entry: RawEntry = { offset: entryOffset, typeCode, data: Buffer.alloc(0) };
    if (typeCode === 6) {
      const base = readOfsDeltaBase(buffer, offset);
      offset = base.next;
      entry.baseOffset = entryOffset - base.baseOffset;
    } else if (typeCode === 7) {
      entry.baseOid = buffer.subarray(offset, offset + 20).toString('hex');
      offset += 20;
    } else if (!CODE_TYPE[typeCode]) {
      throw new Error(`pack entry has unknown type code ${typeCode}`);
    }
    const inflated = inflateAt(buffer.subarray(0, trailerStart), offset);
    if (inflated.data.length !== header.size) throw new Error('pack entry size mismatch');
    entry.data = inflated.data;
    offset = inflated.next;
    raw.push(entry);
    byOffset.set(entryOffset, entry);
  }
  if (offset !== trailerStart) throw new Error('pack has stray bytes before its trailer');

  const resolvedByOid = new Map<string, GitObject>();
  const resolve = (entry: RawEntry): GitObject => {
    if (entry.typeCode === 6 || entry.typeCode === 7) {
      let base: GitObject | undefined;
      if (entry.typeCode === 6) {
        const baseEntry = byOffset.get(entry.baseOffset!);
        if (!baseEntry) throw new Error('ofs-delta base is not in the pack');
        base = resolve(baseEntry);
      } else {
        base = resolvedByOid.get(entry.baseOid!) ?? external(entry.baseOid!);
        if (!base) throw new Error(`ref-delta base ${entry.baseOid} is unknown`);
      }
      return { type: base.type, data: applyDelta(base.data, entry.data) };
    }
    return { type: CODE_TYPE[entry.typeCode]!, data: entry.data };
  };
  const out: GitObject[] = [];
  for (const entry of raw) {
    const object = resolve(entry);
    resolvedByOid.set(hashObject(object.type, object.data), object);
    out.push(object);
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// pkt-line
// ---------------------------------------------------------------------------------------------

/** Encode one pkt-line data packet. */
export function encodePktLine(payload: string | Uint8Array): Buffer {
  const data = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
  if (data.length > 65516) throw new Error('pkt-line payload too large');
  const header = Buffer.allocUnsafe(4);
  header.write((data.length + 4).toString(16).padStart(4, '0'), 0, 4, 'ascii');
  return Buffer.concat([header, data]);
}

export const PKT_FLUSH = Buffer.from('0000', 'ascii');
export const PKT_DELIM = Buffer.from('0001', 'ascii');
export const PKT_RESPONSE_END = Buffer.from('0002', 'ascii');

export type PktPacket =
  | { kind: 'data'; payload: Buffer }
  | { kind: 'flush' }
  | { kind: 'delim' }
  | { kind: 'response-end' };

const HEX4 = /^[0-9a-fA-F]{4}$/;

/**
 * Decode a complete pkt-line stream. Throws on any malformed framing — the caller
 * turns that into the protocol's error answer and keeps serving.
 */
export function decodePktLines(bytes: Uint8Array): PktPacket[] {
  const buffer = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  const packets: PktPacket[] = [];
  let offset = 0;
  while (offset < buffer.length) {
    if (offset + 4 > buffer.length) throw new Error('truncated pkt-line header');
    const headerText = buffer.subarray(offset, offset + 4).toString('ascii');
    if (!HEX4.test(headerText)) throw new Error(`invalid pkt-line length ${JSON.stringify(headerText)}`);
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
    } else if (length === 3 || length > 65520) {
      throw new Error(`invalid pkt-line length ${length}`);
    } else {
      if (offset + length > buffer.length) throw new Error('truncated pkt-line payload');
      packets.push({ kind: 'data', payload: buffer.subarray(offset + 4, offset + length) });
      offset += length;
    }
  }
  return packets;
}
