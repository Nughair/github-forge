// store.ts — the one shared store behind all four surfaces.
//
// A single in-memory state: the git object map, the repositories with their
// refs, labels, issues, pull requests and comments. REST, git smart HTTP,
// GraphQL and MCP all read and write here, so an object or an id means the
// same thing on every surface. Ids and timestamps come from deterministic
// counters and a logical clock seeded by MAKEFUN_TRIAL_NOW, never from the
// wall clock, so a replayed trial produces the same check outcomes.

import {
  EMPTY_TREE_OID,
  buildCommit,
  diffFlatTrees,
  flattenTree,
  hashObject,
  mergeBase,
  mergeFlatTrees,
  parseCommit,
  treePathLookup,
  treePathSet,
  unflattenTree,
  type FileChange,
  type GitObject,
  type GitObjectType,
} from './gitobj.ts';

/** The token owner's identity — the scenario viewer every surface answers for. */
export const VIEWER = {
  login: 'adaiversen',
  id: 1000,
  name: 'ada iversen',
  email: 'adaiversen@example.invalid',
} as const;

export interface LabelRec {
  name: string;
  color: string;
}

export interface CommentRec {
  id: number; // per-repository comment id, an integer >= 1
  body: string;
  createdSeq: number;
}

export interface IssueRec {
  kind: 'issue';
  dbId: number; // the REST `id`: a store-wide database id, stable across reads
  number: number; // the per-repository number, shared with pull requests
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  comments: CommentRec[];
  createdSeq: number;
}

export interface PullRec {
  kind: 'pull';
  dbId: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  merged: boolean;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  headRef: string;
  baseRef: string;
  headSha: string; // snapshot at creation, the fallback when the branch is gone
  baseSha: string;
  createdSeq: number;
}

export type ItemRec = IssueRec | PullRec;

export interface Repo {
  dbId: number;
  owner: string;
  name: string;
  private: boolean;
  description: string;
  defaultBranch: string;
  refs: Map<string, string>; // full ref name -> object id
  labels: Map<string, LabelRec>;
  items: Map<number, ItemRec>;
  nextNumber: number;
  nextCommentId: number;
  createdSeq: number;
}

export class Store {
  readonly objects = new Map<string, GitObject>();
  readonly repos = new Map<string, Repo>(); // key: lowercased "owner/name"
  readonly reposByDbId = new Map<number, Repo>();
  private repoSeq = 0;
  private itemSeq = 0;
  private seq = 0; // one logical clock tick per mutation, shared by every record
  private requestSeq = 0;
  /**
   * State version for the GET response memo (cache.ts): bumped once a mutating
   * request has fully completed, so a body memoized under a version is only
   * ever served while the store is still in exactly the state that produced
   * it. `mutationsInFlight` counts mutating requests being handled right now;
   * new memo entries are only taken while it is 0, so an entry can never
   * capture a half-applied mutation.
   */
  version = 0;
  mutationsInFlight = 0;
  private readonly baseTimeMs: number;

  constructor() {
    const trialNow = process.env.MAKEFUN_TRIAL_NOW;
    const parsed = trialNow ? Date.parse(trialNow) : Number.NaN;
    this.baseTimeMs = Number.isFinite(parsed) ? parsed : Date.parse('2025-01-01T00:00:00Z');
    // The empty tree is a real object in every git store.
    this.putObject('tree', Buffer.alloc(0));
  }

  /** The next logical timestamp as an ISO string (base time + one second per tick). */
  nowIso(): string {
    this.seq += 1;
    return new Date(this.baseTimeMs + this.seq * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');
  }

  /** The ISO timestamp of a logical tick (records carry their creation tick). */
  isoOf(seq: number): string {
    return new Date(this.baseTimeMs + seq * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');
  }

  /** The current logical tick, for ordering records created in sequence. */
  tick(): number {
    this.seq += 1;
    return this.seq;
  }

  /** Unix seconds on the logical clock, for git commit timestamps. */
  nowSec(): number {
    return Math.floor(this.baseTimeMs / 1000) + this.seq;
  }

  /** A deterministic request id for the X-GitHub-Request-Id header. */
  nextRequestId(): string {
    this.requestSeq += 1;
    return `req-${this.requestSeq.toString(36).padStart(6, '0')}`;
  }

  /** Store one git object and answer its id (idempotent). */
  putObject(type: GitObjectType, data: Buffer): string {
    const oid = hashObject(type, data);
    if (!this.objects.has(oid)) this.objects.set(oid, { type, data });
    return oid;
  }

  getObject(oid: string): GitObject | undefined {
    return this.objects.get(oid);
  }

  // -------------------------------------------------------------------------------------------
  // repositories
  // -------------------------------------------------------------------------------------------

  static key(owner: string, name: string): string {
    return `${owner}/${name}`.toLowerCase();
  }

  findRepo(owner: string, name: string): Repo | null {
    // A repository belongs to the token's login: any other owner is a 404, never a 403.
    if (owner.toLowerCase() !== VIEWER.login) return null;
    return this.repos.get(Store.key(owner, name)) ?? null;
  }

  createRepo(name: string, init: { private?: boolean; description?: string }): Repo {
    this.repoSeq += 1;
    const repo: Repo = {
      dbId: this.repoSeq,
      owner: VIEWER.login,
      name,
      private: init.private ?? false,
      description: init.description ?? '',
      defaultBranch: 'main',
      refs: new Map(),
      labels: new Map(),
      items: new Map(),
      nextNumber: 1,
      nextCommentId: 1,
      createdSeq: this.tick(),
    };
    this.repos.set(Store.key(repo.owner, repo.name), repo);
    this.reposByDbId.set(repo.dbId, repo);
    return repo;
  }

  deleteRepo(repo: Repo): void {
    this.repos.delete(Store.key(repo.owner, repo.name));
    this.reposByDbId.delete(repo.dbId);
  }

  listRepos(): Repo[] {
    return [...this.repos.values()].sort((a, b) => a.dbId - b.dbId);
  }

  /** The tip commit of a branch, or null when the branch is unborn or absent. */
  branchTip(repo: Repo, branch: string): string | null {
    return repo.refs.get(`refs/heads/${branch}`) ?? null;
  }

  /** The tree oid a commit names. */
  commitTree(commitOid: string): string | null {
    const object = this.objects.get(commitOid);
    if (!object || object.type !== 'commit') return null;
    return parseCommit(object.data).tree;
  }

  // -------------------------------------------------------------------------------------------
  // issues and pull requests
  // -------------------------------------------------------------------------------------------

  createIssue(repo: Repo, init: { title: string; body: string; labels?: string[] }): IssueRec {
    this.itemSeq += 1;
    const issue: IssueRec = {
      kind: 'issue',
      dbId: this.itemSeq,
      number: repo.nextNumber,
      title: init.title,
      body: init.body,
      state: 'open',
      labels: [...(init.labels ?? [])],
      comments: [],
      createdSeq: this.tick(),
    };
    repo.nextNumber += 1;
    repo.items.set(issue.number, issue);
    return issue;
  }

  createPull(
    repo: Repo,
    init: { title: string; body: string; headRef: string; baseRef: string; headSha: string; baseSha: string },
  ): PullRec {
    this.itemSeq += 1;
    const pull: PullRec = {
      kind: 'pull',
      dbId: this.itemSeq,
      number: repo.nextNumber,
      title: init.title,
      body: init.body,
      state: 'open',
      merged: false,
      mergedAt: null,
      mergeCommitSha: null,
      headRef: init.headRef,
      baseRef: init.baseRef,
      headSha: init.headSha,
      baseSha: init.baseSha,
      createdSeq: this.tick(),
    };
    repo.nextNumber += 1;
    repo.items.set(pull.number, pull);
    return pull;
  }

  addComment(repo: Repo, issue: IssueRec, body: string): CommentRec {
    const comment: CommentRec = { id: repo.nextCommentId, body, createdSeq: this.tick() };
    repo.nextCommentId += 1;
    issue.comments.push(comment);
    return comment;
  }

  /** The live tip of a pull request's head/base branch, falling back to the creation snapshot. */
  pullHeadSha(repo: Repo, pull: PullRec): string {
    return this.branchTip(repo, pull.headRef) ?? pull.headSha;
  }

  pullBaseSha(repo: Repo, pull: PullRec): string {
    return this.branchTip(repo, pull.baseRef) ?? pull.baseSha;
  }

  /** The changed files of a pull request: merge-base tree -> head tree. */
  pullFiles(repo: Repo, pull: PullRec): FileChange[] {
    const headSha = this.pullHeadSha(repo, pull);
    const baseSha = this.pullBaseSha(repo, pull);
    const headTree = this.commitTree(headSha);
    if (headTree === null) return [];
    const base = mergeBase(this.objects, baseSha, headSha) ?? baseSha;
    const baseTree = this.commitTree(base) ?? EMPTY_TREE_OID;
    return diffFlatTrees(this.objects, flattenTree(this.objects, baseTree), flattenTree(this.objects, headTree));
  }

  /** Whether a pull request merges cleanly right now. */
  pullMergeable(repo: Repo, pull: PullRec): boolean {
    return this.computeMerge(repo, pull) !== null;
  }

  /** The merged flat tree for a pull request, or null on conflict. */
  private computeMerge(repo: Repo, pull: PullRec): Map<string, { oid: string; mode: string }> | null {
    const headSha = this.pullHeadSha(repo, pull);
    const baseSha = this.pullBaseSha(repo, pull);
    const headTree = this.commitTree(headSha);
    const baseTree = this.commitTree(baseSha);
    if (headTree === null || baseTree === null) return null;
    const ancestorSha = mergeBase(this.objects, baseSha, headSha);
    const ancestorTree = ancestorSha === null ? EMPTY_TREE_OID : (this.commitTree(ancestorSha) ?? EMPTY_TREE_OID);
    return mergeFlatTrees(
      flattenTree(this.objects, ancestorTree),
      flattenTree(this.objects, baseTree),
      flattenTree(this.objects, headTree),
    );
  }

  /**
   * Merge a pull request into its base branch. `squash` lands one single-parent
   * commit; `merge` lands a two-parent merge commit. Answers the new commit's sha,
   * or null when the merge conflicts. The base ref moves; the pull closes as merged.
   */
  mergePull(repo: Repo, pull: PullRec, method: 'squash' | 'merge'): string | null {
    const mergedFlat = this.computeMerge(repo, pull);
    if (mergedFlat === null) return null;
    const headSha = this.pullHeadSha(repo, pull);
    const baseSha = this.pullBaseSha(repo, pull);
    const tree = unflattenTree((type, data) => this.putObject(type, data), mergedFlat);
    const identity = `${VIEWER.name} <${VIEWER.email}>`;
    const timestampSec = this.nowSec();
    let data: Buffer;
    if (method === 'merge') {
      data = buildCommit({
        tree,
        parents: [baseSha, headSha],
        message: `Merge pull request #${pull.number} from ${pull.headRef}\n\n${pull.title}\n`,
        author: identity,
        timestampSec,
      });
    } else {
      const body = pull.body ? `\n\n${pull.body}` : '';
      data = buildCommit({
        tree,
        parents: [baseSha],
        message: `${pull.title} (#${pull.number})${body}\n`,
        author: identity,
        timestampSec,
      });
    }
    const sha = this.putObject('commit', data);
    repo.refs.set(`refs/heads/${pull.baseRef}`, sha);
    pull.state = 'closed';
    pull.merged = true;
    pull.mergedAt = this.nowIso();
    pull.mergeCommitSha = sha;
    return sha;
  }

  // -------------------------------------------------------------------------------------------
  // contents commits (the REST contents API writes real git history)
  // -------------------------------------------------------------------------------------------

  /**
   * Write `content` at `path` on `branch` as a new commit. Answers the new blob and
   * commit ids, or null when the path is unusable. A missing branch is created from
   * the default branch's tip (or as a root commit on an empty repository).
   */
  writeFile(
    repo: Repo,
    branch: string,
    path: string,
    content: Buffer,
    message: string,
  ): { blobSha: string; commitSha: string; created: boolean } | null {
    const segments = path.split('/').filter((segment) => segment !== '' && segment !== '.' && segment !== '..');
    if (segments.length === 0 || segments.join('/') !== path) return null;
    let tip = this.branchTip(repo, branch);
    if (tip === null && branch !== repo.defaultBranch) tip = this.branchTip(repo, repo.defaultBranch);
    const oldTree = tip === null ? null : this.commitTree(tip);
    const existing = oldTree === null ? null : treePathLookup(this.objects, oldTree, segments);
    const blobSha = this.putObject('blob', content);
    const newTree = treePathSet(
      this.objects,
      (type, data) => this.putObject(type, data),
      oldTree,
      segments,
      { oid: blobSha, mode: '100644' },
    );
    if (newTree === null) return null;
    const identity = `${VIEWER.name} <${VIEWER.email}>`;
    const commitSha = this.putObject(
      'commit',
      buildCommit({
        tree: newTree,
        parents: tip === null ? [] : [tip],
        message,
        author: identity,
        timestampSec: this.nowSec(),
      }),
    );
    repo.refs.set(`refs/heads/${branch}`, commitSha);
    return { blobSha, commitSha, created: existing === null };
  }

  /** Delete `path` on `branch` as a new commit; answers the commit id, or null when absent. */
  deleteFile(repo: Repo, branch: string, path: string, message: string): { commitSha: string } | null {
    const segments = path.split('/').filter((segment) => segment !== '' && segment !== '.' && segment !== '..');
    if (segments.length === 0 || segments.join('/') !== path) return null;
    const tip = this.branchTip(repo, branch);
    if (tip === null) return null;
    const oldTree = this.commitTree(tip);
    if (oldTree === null) return null;
    if (treePathLookup(this.objects, oldTree, segments) === null) return null;
    const newTree = treePathSet(this.objects, (type, data) => this.putObject(type, data), oldTree, segments, null);
    const identity = `${VIEWER.name} <${VIEWER.email}>`;
    const commitSha = this.putObject(
      'commit',
      buildCommit({
        tree: newTree ?? EMPTY_TREE_OID,
        parents: [tip],
        message,
        author: identity,
        timestampSec: this.nowSec(),
      }),
    );
    repo.refs.set(`refs/heads/${branch}`, commitSha);
    return { commitSha };
  }
}

// ---------------------------------------------------------------------------------------------
// global (Relay-style) ids for GraphQL: opaque, stable, and decodable by this server only
// ---------------------------------------------------------------------------------------------

function encodeGlobalId(payload: string): string {
  return Buffer.from(payload, 'utf8').toString('base64');
}

export function repoGlobalId(repo: Repo): string {
  return encodeGlobalId(`Repository:${repo.dbId}`);
}

export function issueGlobalId(repo: Repo, issue: IssueRec): string {
  return encodeGlobalId(`Issue:${repo.dbId}:${issue.number}`);
}

export function pullGlobalId(repo: Repo, pull: PullRec): string {
  return encodeGlobalId(`PullRequest:${repo.dbId}:${pull.number}`);
}

export function commentGlobalId(repo: Repo, comment: CommentRec): string {
  return encodeGlobalId(`IssueComment:${repo.dbId}:${comment.id}`);
}

export function userGlobalId(): string {
  return encodeGlobalId(`User:${VIEWER.id}`);
}

/** Decode a global id into its kind and numeric parts, or null when it is not one of ours. */
export function decodeGlobalId(id: string): { kind: string; parts: number[] } | null {
  try {
    const text = Buffer.from(id, 'base64').toString('utf8');
    const match = /^([A-Za-z]+):([0-9]+(?::[0-9]+)*)$/.exec(text);
    if (!match) return null;
    return { kind: match[1]!, parts: match[2]!.split(':').map((part) => Number.parseInt(part, 10)) };
  } catch {
    return null;
  }
}
