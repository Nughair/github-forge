// rest.ts — the REST v3 surface.
//
// Routes under /api/v3 exactly as the wire contract lists them: the root and
// meta documents, the viewer, repository CRUD with Link-header pagination,
// the contents API (whose writes are real git commits), git refs, branches,
// the commit walk, labels, issues with comments, and pull requests with a
// squash/merge endpoint. Every handler answers through web.ts, so the JSON
// content type, the request-id header and the {"message"} error shape hold
// for every reply, including 404s for unknown routes.

import type { IncomingMessage, ServerResponse } from 'node:http';
import { EMPTY_TREE_OID, parseCommit, parseTree, peelToCommit, treePathLookup } from './gitobj.ts';
import {
  VIEWER,
  type IssueRec,
  type PullRec,
  type Repo,
  type Store,
} from './store.ts';
import { isRecord, readJsonBody, sendEmpty, sendError, sendJson, stringField } from './web.ts';

const NOT_FOUND = 'Not Found';

// ---------------------------------------------------------------------------------------------
// JSON shapes
// ---------------------------------------------------------------------------------------------

function userJson(): Record<string, unknown> {
  return { login: VIEWER.login, id: VIEWER.id, type: 'User', name: VIEWER.name, email: VIEWER.email };
}

export function repoJson(store: Store, repo: Repo): Record<string, unknown> {
  return {
    id: repo.dbId,
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    private: repo.private,
    description: repo.description,
    default_branch: repo.defaultBranch,
    owner: { login: repo.owner, id: VIEWER.id, type: 'User' },
    created_at: store.isoOf(repo.createdSeq),
    updated_at: store.isoOf(repo.createdSeq),
  };
}

export function issueJson(store: Store, repo: Repo, issue: IssueRec): Record<string, unknown> {
  return {
    id: issue.dbId,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((name) => {
      const label = repo.labels.get(name);
      return { name, color: label?.color ?? '000000', default: false };
    }),
    user: { login: VIEWER.login, id: VIEWER.id, type: 'User' },
    comments: issue.comments.length,
    created_at: store.isoOf(issue.createdSeq),
    updated_at: store.isoOf(issue.createdSeq),
  };
}

export function pullJson(store: Store, repo: Repo, pull: PullRec): Record<string, unknown> {
  return {
    id: pull.dbId,
    number: pull.number,
    state: pull.state,
    title: pull.title,
    body: pull.body,
    merged: pull.merged,
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeCommitSha,
    head: {
      ref: pull.headRef,
      sha: store.pullHeadSha(repo, pull),
      label: `${repo.owner}:${pull.headRef}`,
    },
    base: {
      ref: pull.baseRef,
      sha: store.pullBaseSha(repo, pull),
      label: `${repo.owner}:${pull.baseRef}`,
    },
    user: { login: VIEWER.login, id: VIEWER.id, type: 'User' },
    created_at: store.isoOf(pull.createdSeq),
    updated_at: store.isoOf(pull.createdSeq),
  };
}

function commentJson(store: Store, comment: { id: number; body: string; createdSeq: number }): Record<string, unknown> {
  return {
    id: comment.id,
    body: comment.body,
    user: { login: VIEWER.login, id: VIEWER.id, type: 'User' },
    created_at: store.isoOf(comment.createdSeq),
    updated_at: store.isoOf(comment.createdSeq),
  };
}

// ---------------------------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------------------------

interface Page {
  perPage: number;
  page: number;
}

function pageOf(query: URLSearchParams): Page {
  const perPageRaw = Number.parseInt(query.get('per_page') ?? '', 10);
  const pageRaw = Number.parseInt(query.get('page') ?? '', 10);
  return {
    perPage: Number.isFinite(perPageRaw) && perPageRaw > 0 ? Math.min(perPageRaw, 100) : 30,
    page: Number.isFinite(pageRaw) && pageRaw > 0 ? pageRaw : 1,
  };
}

function slicePage<T>(items: T[], page: Page): T[] {
  return items.slice((page.page - 1) * page.perPage, page.page * page.perPage);
}

/** Parse a git identity line ("Name <email> 1700000000 +0000") for the commit JSON. */
function identityJson(line: string): { name: string; email: string; date: string } {
  const match = /^(.*?) <(.*?)> (\d+) [+-]\d{4}$/.exec(line);
  if (!match) return { name: line, email: '', date: '1970-01-01T00:00:00Z' };
  return {
    name: match[1]!,
    email: match[2]!,
    date: new Date(Number.parseInt(match[3]!, 10) * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z'),
  };
}

/** Resolve a ref-ish value (branch name or commit sha) to a commit oid in a repo. */
function resolveCommit(store: Store, repo: Repo, ref: string): string | null {
  const branchTip = store.branchTip(repo, ref);
  if (branchTip !== null) return branchTip;
  const tagOid = repo.refs.get(`refs/tags/${ref}`);
  if (tagOid !== undefined) return peelToCommit(store.objects, tagOid);
  if (/^[0-9a-f]{40}$/.test(ref)) {
    const object = store.getObject(ref);
    if (object && object.type === 'commit') return ref;
    if (object && object.type === 'tag') return peelToCommit(store.objects, ref);
  }
  return null;
}

// ---------------------------------------------------------------------------------------------
// the router
// ---------------------------------------------------------------------------------------------

/**
 * Handle one /api/v3 request. The caller has already authenticated it. Answers
 * true when the route was this surface's (every /api/v3 path is, known or not:
 * an unknown one is the contract's JSON 404).
 */
export async function handleRest(
  store: Store,
  req: IncomingMessage,
  res: ServerResponse,
  segments: string[],
  query: URLSearchParams,
): Promise<boolean> {
  const method = req.method ?? 'GET';
  const [head, ...rest] = segments;

  if (segments.length === 0) {
    if (method === 'GET') {
      sendJson(store, res, 200, {
        current_user_url: '/api/v3/user',
        repository_url: '/api/v3/repos/{owner}/{repo}',
        issue_search_url: '/api/v3/search/issues',
      }, { 'x-oauth-scopes': 'repo, read:org' });
      return true;
    }
    return notFound(store, res);
  }

  if (head === 'meta' && segments.length === 1) {
    if (method === 'GET') {
      sendJson(store, res, 200, {
        installed_version: '1.0.0-lucky-comet',
        verifiable_password_authentication: false,
        ssh_key_fingerprints: {},
        hooks: [],
        api: ['v3'],
      });
      return true;
    }
    return notFound(store, res);
  }

  if (head === 'user') return handleUser(store, req, res, method, rest, query);
  if (head === 'repos') return handleRepo(store, req, res, method, rest, query);
  return notFound(store, res);
}

function notFound(store: Store, res: ServerResponse): boolean {
  sendError(store, res, 404, NOT_FOUND);
  return true;
}

async function handleUser(
  store: Store,
  req: IncomingMessage,
  res: ServerResponse,
  method: string,
  segments: string[],
  query: URLSearchParams,
): Promise<boolean> {
  if (segments.length === 0) {
    if (method === 'GET') {
      sendJson(store, res, 200, userJson());
      return true;
    }
    return notFound(store, res);
  }
  if (segments[0] === 'repos' && segments.length === 1) {
    if (method === 'GET') {
      const page = pageOf(query);
      const all = store.listRepos().map((repo) => repoJson(store, repo));
      const items = slicePage(all, page);
      const headers: Record<string, string> = {};
      if (page.page * page.perPage < all.length) {
        const host = req.headers.host ?? 'localhost';
        const next = `http://${host}/api/v3/user/repos?per_page=${page.perPage}&page=${page.page + 1}`;
        const last = `http://${host}/api/v3/user/repos?per_page=${page.perPage}&page=${Math.ceil(all.length / page.perPage)}`;
        headers.link = `<${next}>; rel="next", <${last}>; rel="last"`;
      }
      sendJson(store, res, 200, items, headers);
      return true;
    }
    if (method === 'POST') {
      const body = await readJsonBody(store, req, res);
      if (body === null) return true;
      if (!isRecord(body)) {
        sendError(store, res, 422, 'Validation Failed: name is required');
        return true;
      }
      const name = stringField(body, 'name');
      if (name === undefined || name === '') {
        sendError(store, res, 422, 'Validation Failed: name is required');
        return true;
      }
      if (store.findRepo(VIEWER.login, name) !== null) {
        sendError(store, res, 422, `Validation Failed: name already exists on this account (${name})`);
        return true;
      }
      const repo = store.createRepo(name, {
        private: body.private === true,
        description: stringField(body, 'description') ?? '',
      });
      sendJson(store, res, 201, repoJson(store, repo));
      return true;
    }
  }
  return notFound(store, res);
}

async function handleRepo(
  store: Store,
  req: IncomingMessage,
  res: ServerResponse,
  method: string,
  segments: string[],
  query: URLSearchParams,
): Promise<boolean> {
  const owner = segments[0];
  const name = segments[1];
  if (owner === undefined || name === undefined) return notFound(store, res);
  const repo = store.findRepo(owner, name);
  const tail = segments.slice(2);

  if (tail.length === 0) {
    if (repo === null) return notFound(store, res);
    if (method === 'GET') {
      sendJson(store, res, 200, repoJson(store, repo));
      return true;
    }
    if (method === 'PATCH') {
      const body = await readJsonBody(store, req, res);
      if (body === null) return true;
      if (isRecord(body)) {
        const description = stringField(body, 'description');
        if (description !== undefined) repo.description = description;
        if (typeof body.private === 'boolean') repo.private = body.private;
      }
      sendJson(store, res, 200, repoJson(store, repo));
      return true;
    }
    if (method === 'DELETE') {
      store.deleteRepo(repo);
      sendEmpty(store, res, 204);
      return true;
    }
    return notFound(store, res);
  }

  if (repo === null) return notFound(store, res);
  const [section, ...sub] = tail;
  switch (section) {
    case 'contents':
      return handleContents(store, req, res, method, repo, sub, query);
    case 'git':
      return handleGitData(store, req, res, method, repo, sub);
    case 'branches':
      return handleBranches(store, res, method, repo, sub);
    case 'commits':
      if (method === 'GET' && sub.length === 0) return listCommits(store, res, repo, query);
      return notFound(store, res);
    case 'labels':
      return handleLabels(store, req, res, method, repo, sub);
    case 'issues':
      return handleIssues(store, req, res, method, repo, sub, query);
    case 'pulls':
      return handlePulls(store, req, res, method, repo, sub, query);
    default:
      return notFound(store, res);
  }
}

// ---------------------------------------------------------------------------------------------
// contents
// ---------------------------------------------------------------------------------------------

async function handleContents(
  store: Store,
  req: IncomingMessage,
  res: ServerResponse,
  method: string,
  repo: Repo,
  segments: string[],
  query: URLSearchParams,
): Promise<boolean> {
  const path = segments.join('/');

  if (method === 'GET') {
    const ref = query.get('ref') ?? repo.defaultBranch;
    const commit = resolveCommit(store, repo, ref);
    if (commit === null) return notFound(store, res);
    const tree = store.commitTree(commit) ?? EMPTY_TREE_OID;
    if (path === '') {
      sendJson(store, res, 200, listTreeLevel(store, repo, tree, ''));
      return true;
    }
    const found = treePathLookup(store.objects, tree, path.split('/'));
    if (found === null) return notFound(store, res);
    if (found.mode === '40000') {
      sendJson(store, res, 200, listTreeLevel(store, repo, found.oid, path));
      return true;
    }
    const blob = store.getObject(found.oid);
    if (!blob || blob.type !== 'blob') return notFound(store, res);
    sendJson(store, res, 200, {
      type: 'file',
      name: path.split('/').pop(),
      path,
      sha: found.oid,
      size: blob.data.length,
      encoding: 'base64',
      content: blob.data.toString('base64'),
    });
    return true;
  }

  if (method === 'PUT') {
    const body = await readJsonBody(store, req, res);
    if (body === null) return true;
    if (!isRecord(body)) {
      sendError(store, res, 422, 'Validation Failed: content is required');
      return true;
    }
    const contentBase64 = stringField(body, 'content');
    if (contentBase64 === undefined) {
      sendError(store, res, 422, 'Validation Failed: content is required');
      return true;
    }
    const branch = stringField(body, 'branch') ?? repo.defaultBranch;
    const message = stringField(body, 'message') ?? `Update ${path}`;
    // The sha precondition is judged against the target branch's current tree.
    const tip = store.branchTip(repo, branch) ?? (branch === repo.defaultBranch ? null : store.branchTip(repo, repo.defaultBranch));
    const tree = tip === null ? null : store.commitTree(tip);
    const existing = tree === null ? null : treePathLookup(store.objects, tree, path.split('/'));
    const sha = stringField(body, 'sha');
    if (existing !== null) {
      if (sha === undefined) {
        sendError(store, res, 422, 'Validation Failed: sha is required when updating a file');
        return true;
      }
      if (sha !== existing.oid) {
        sendError(store, res, 409, 'Conflict: the file has changed since the given sha');
        return true;
      }
    } else if (sha !== undefined) {
      sendError(store, res, 422, 'Validation Failed: sha does not match any file at this path');
      return true;
    }
    const content = Buffer.from(contentBase64.replace(/\s+/g, ''), 'base64');
    const written = store.writeFile(repo, branch, path, content, message);
    if (written === null) {
      sendError(store, res, 422, `Validation Failed: the path ${path} is not usable`);
      return true;
    }
    sendJson(store, res, written.created ? 201 : 200, {
      content: {
        type: 'file',
        name: path.split('/').pop(),
        path,
        sha: written.blobSha,
        size: content.length,
        encoding: 'base64',
      },
      commit: { sha: written.commitSha, message },
    });
    return true;
  }

  if (method === 'DELETE') {
    const body = await readJsonBody(store, req, res);
    if (body === null) return true;
    if (!isRecord(body)) {
      sendError(store, res, 422, 'Validation Failed: sha is required');
      return true;
    }
    const branch = stringField(body, 'branch') ?? repo.defaultBranch;
    const message = stringField(body, 'message') ?? `Delete ${path}`;
    const tip = store.branchTip(repo, branch);
    const tree = tip === null ? null : store.commitTree(tip);
    const existing = tree === null ? null : treePathLookup(store.objects, tree, path.split('/'));
    if (existing === null) return notFound(store, res);
    const sha = stringField(body, 'sha');
    if (sha === undefined) {
      sendError(store, res, 422, 'Validation Failed: sha is required');
      return true;
    }
    if (sha !== existing.oid) {
      sendError(store, res, 409, 'Conflict: the file has changed since the given sha');
      return true;
    }
    const deleted = store.deleteFile(repo, branch, path, message);
    if (deleted === null) return notFound(store, res);
    sendJson(store, res, 200, { content: null, commit: { sha: deleted.commitSha, message } });
    return true;
  }

  return notFound(store, res);
}

function listTreeLevel(store: Store, repo: Repo, treeOid: string, prefix: string): Record<string, unknown>[] {
  const object = store.getObject(treeOid);
  if (!object || object.type !== 'tree') return [];
  void repo;
  return parseTree(object.data).map((entry) => ({
    type: entry.mode === '40000' ? 'dir' : 'file',
    name: entry.name,
    path: prefix === '' ? entry.name : `${prefix}/${entry.name}`,
    sha: entry.oid,
  }));
}

// ---------------------------------------------------------------------------------------------
// git data: refs, branches, commits
// ---------------------------------------------------------------------------------------------

async function handleGitData(
  store: Store,
  req: IncomingMessage,
  res: ServerResponse,
  method: string,
  repo: Repo,
  segments: string[],
): Promise<boolean> {
  if (segments[0] === 'refs') {
    if (method === 'POST' && segments.length === 1) {
      const body = await readJsonBody(store, req, res);
      if (body === null) return true;
      if (!isRecord(body)) {
        sendError(store, res, 422, 'Validation Failed: ref and sha are required');
        return true;
      }
      const ref = stringField(body, 'ref');
      const sha = stringField(body, 'sha');
      if (ref === undefined || !ref.startsWith('refs/') || sha === undefined) {
        sendError(store, res, 422, 'Validation Failed: ref must be a full ref name and sha an object id');
        return true;
      }
      const object = store.getObject(sha);
      if (!object) {
        sendError(store, res, 422, `Validation Failed: object ${sha} does not exist`);
        return true;
      }
      if (repo.refs.has(ref)) {
        sendError(store, res, 422, 'Validation Failed: Reference already exists');
        return true;
      }
      repo.refs.set(ref, sha);
      sendJson(store, res, 201, { ref, object: { sha, type: object.type } });
      return true;
    }
    if (method === 'GET') {
      if (segments.length === 1) {
        const all = [...repo.refs.entries()]
          .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
          .map(([ref, sha]) => ({ ref, object: { sha, type: store.getObject(sha)?.type ?? 'commit' } }));
        sendJson(store, res, 200, all);
        return true;
      }
      const ref = `refs/${segments.slice(1).join('/')}`;
      const sha = repo.refs.get(ref);
      if (sha === undefined) return notFound(store, res);
      sendJson(store, res, 200, { ref, object: { sha, type: store.getObject(sha)?.type ?? 'commit' } });
      return true;
    }
  }
  return notFound(store, res);
}

function handleBranches(store: Store, res: ServerResponse, method: string, repo: Repo, segments: string[]): boolean {
  if (method !== 'GET') return notFound(store, res);
  if (segments.length === 0) {
    const branches = [...repo.refs.entries()]
      .filter(([ref]) => ref.startsWith('refs/heads/'))
      .map(([ref, sha]) => ({ name: ref.slice('refs/heads/'.length), commit: { sha }, protected: false }))
      .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    sendJson(store, res, 200, branches);
    return true;
  }
  const branch = segments.join('/');
  const sha = store.branchTip(repo, branch);
  if (sha === null) return notFound(store, res);
  sendJson(store, res, 200, { name: branch, commit: { sha }, protected: false });
  return true;
}

function listCommits(store: Store, res: ServerResponse, repo: Repo, query: URLSearchParams): boolean {
  const ref = query.get('sha') ?? repo.defaultBranch;
  const start = resolveCommit(store, repo, ref);
  if (start === null) {
    sendJson(store, res, 200, []);
    return true;
  }
  const page = pageOf(query);
  const seen = new Set<string>();
  const ordered: string[] = [];
  const stack = [start];
  while (stack.length > 0) {
    const oid = stack.pop()!;
    if (seen.has(oid)) continue;
    const object = store.getObject(oid);
    if (!object || object.type !== 'commit') continue;
    seen.add(oid);
    ordered.push(oid);
    const parents = parseCommit(object.data).parents;
    // Push parents reversed so the first parent is walked first (newest history first).
    for (let index = parents.length - 1; index >= 0; index -= 1) stack.push(parents[index]!);
  }
  const items = slicePage(ordered, page).map((oid) => {
    const commit = parseCommit(store.getObject(oid)!.data);
    return {
      sha: oid,
      commit: {
        message: commit.message,
        author: identityJson(commit.author),
        committer: identityJson(commit.committer),
        tree: { sha: commit.tree },
      },
      parents: commit.parents.map((parent) => ({ sha: parent })),
    };
  });
  sendJson(store, res, 200, items);
  return true;
}

// ---------------------------------------------------------------------------------------------
// labels
// ---------------------------------------------------------------------------------------------

async function handleLabels(
  store: Store,
  req: IncomingMessage,
  res: ServerResponse,
  method: string,
  repo: Repo,
  segments: string[],
): Promise<boolean> {
  if (segments.length !== 0) return notFound(store, res);
  if (method === 'GET') {
    sendJson(store, res, 200, [...repo.labels.values()].map((label) => ({ name: label.name, color: label.color, default: false })));
    return true;
  }
  if (method === 'POST') {
    const body = await readJsonBody(store, req, res);
    if (body === null) return true;
    if (!isRecord(body)) {
      sendError(store, res, 422, 'Validation Failed: name is required');
      return true;
    }
    const name = stringField(body, 'name');
    if (name === undefined || name === '') {
      sendError(store, res, 422, 'Validation Failed: name is required');
      return true;
    }
    if (repo.labels.has(name)) {
      sendError(store, res, 422, `Validation Failed: name already exists (${name})`);
      return true;
    }
    const color = (stringField(body, 'color') ?? '000000').replace(/^#/, '');
    repo.labels.set(name, { name, color });
    sendJson(store, res, 201, { name, color, default: false });
    return true;
  }
  return notFound(store, res);
}

// ---------------------------------------------------------------------------------------------
// issues and comments
// ---------------------------------------------------------------------------------------------

async function handleIssues(
  store: Store,
  req: IncomingMessage,
  res: ServerResponse,
  method: string,
  repo: Repo,
  segments: string[],
  query: URLSearchParams,
): Promise<boolean> {
  if (segments.length === 0) {
    if (method === 'POST') {
      const body = await readJsonBody(store, req, res);
      if (body === null) return true;
      if (!isRecord(body)) {
        sendError(store, res, 422, 'Validation Failed: title is required');
        return true;
      }
      const title = stringField(body, 'title');
      if (title === undefined || title === '') {
        sendError(store, res, 422, 'Validation Failed: title is required');
        return true;
      }
      const labels = Array.isArray(body.labels) ? body.labels.filter((x): x is string => typeof x === 'string') : [];
      for (const label of labels) {
        if (!repo.labels.has(label)) {
          sendError(store, res, 422, `Validation Failed: label "${label}" does not exist in this repository`);
          return true;
        }
      }
      const issue = store.createIssue(repo, { title, body: stringField(body, 'body') ?? '', labels });
      sendJson(store, res, 201, issueJson(store, repo, issue));
      return true;
    }
    if (method === 'GET') {
      const state = query.get('state') ?? 'open';
      const direction = query.get('direction') ?? 'desc';
      let issues = [...repo.items.values()].filter((item): item is IssueRec => item.kind === 'issue');
      if (state === 'open' || state === 'closed') issues = issues.filter((issue) => issue.state === state);
      issues.sort((a, b) => (a.createdSeq - b.createdSeq) || (a.number - b.number));
      if (direction !== 'asc') issues.reverse();
      const page = pageOf(query);
      const paged = query.has('per_page') ? slicePage(issues, page) : issues;
      sendJson(store, res, 200, paged.map((issue) => issueJson(store, repo, issue)));
      return true;
    }
    return notFound(store, res);
  }

  const number = Number.parseInt(segments[0]!, 10);
  const item = Number.isInteger(number) ? repo.items.get(number) : undefined;
  const issue = item !== undefined && item.kind === 'issue' ? item : undefined;

  if (segments.length === 1) {
    if (issue === undefined) return notFound(store, res);
    if (method === 'GET') {
      sendJson(store, res, 200, issueJson(store, repo, issue));
      return true;
    }
    if (method === 'PATCH') {
      const body = await readJsonBody(store, req, res);
      if (body === null) return true;
      if (isRecord(body)) {
        const state = stringField(body, 'state');
        if (state !== undefined) {
          if (state !== 'open' && state !== 'closed') {
            sendError(store, res, 422, `Validation Failed: state "${state}" is not valid`);
            return true;
          }
          issue.state = state;
        }
        const title = stringField(body, 'title');
        if (title !== undefined) issue.title = title;
        const text = stringField(body, 'body');
        if (text !== undefined) issue.body = text;
        if (Array.isArray(body.labels)) {
          const labels = body.labels.filter((x): x is string => typeof x === 'string');
          for (const label of labels) {
            if (!repo.labels.has(label)) {
              sendError(store, res, 422, `Validation Failed: label "${label}" does not exist in this repository`);
              return true;
            }
          }
          issue.labels = labels;
        }
      }
      sendJson(store, res, 200, issueJson(store, repo, issue));
      return true;
    }
    return notFound(store, res);
  }

  if (segments.length === 2 && segments[1] === 'comments') {
    if (issue === undefined) return notFound(store, res);
    if (method === 'GET') {
      sendJson(store, res, 200, issue.comments.map((comment) => commentJson(store, comment)));
      return true;
    }
    if (method === 'POST') {
      const body = await readJsonBody(store, req, res);
      if (body === null) return true;
      if (!isRecord(body) || stringField(body, 'body') === undefined) {
        sendError(store, res, 422, 'Validation Failed: body is required');
        return true;
      }
      const comment = store.addComment(repo, issue, stringField(body, 'body')!);
      sendJson(store, res, 201, commentJson(store, comment));
      return true;
    }
  }
  return notFound(store, res);
}

// ---------------------------------------------------------------------------------------------
// pull requests
// ---------------------------------------------------------------------------------------------

/** A head/base value may arrive as "owner:branch"; the branch is what names a ref here. */
function branchNameOf(value: string): string {
  const colon = value.indexOf(':');
  return colon >= 0 ? value.slice(colon + 1) : value;
}

async function handlePulls(
  store: Store,
  req: IncomingMessage,
  res: ServerResponse,
  method: string,
  repo: Repo,
  segments: string[],
  query: URLSearchParams,
): Promise<boolean> {
  if (segments.length === 0) {
    if (method === 'POST') {
      const body = await readJsonBody(store, req, res);
      if (body === null) return true;
      if (!isRecord(body)) {
        sendError(store, res, 422, 'Validation Failed: title, head and base are required');
        return true;
      }
      const title = stringField(body, 'title');
      const headRaw = stringField(body, 'head');
      const baseRaw = stringField(body, 'base');
      if (title === undefined || headRaw === undefined || baseRaw === undefined) {
        sendError(store, res, 422, 'Validation Failed: title, head and base are required');
        return true;
      }
      const head = branchNameOf(headRaw);
      const base = branchNameOf(baseRaw);
      const headSha = store.branchTip(repo, head);
      const baseSha = store.branchTip(repo, base);
      if (headSha === null) {
        sendError(store, res, 422, `Validation Failed: head "${head}" does not name a branch`);
        return true;
      }
      if (baseSha === null) {
        sendError(store, res, 422, `Validation Failed: base "${base}" does not name a branch`);
        return true;
      }
      if (head === base || headSha === baseSha) {
        sendError(store, res, 422, 'Validation Failed: no commits between the head and the base');
        return true;
      }
      const existing = [...repo.items.values()].find(
        (item): item is PullRec => item.kind === 'pull' && item.state === 'open' && item.headRef === head && item.baseRef === base,
      );
      if (existing !== undefined) {
        sendError(store, res, 422, `Validation Failed: a pull request already exists for ${head} into ${base}`);
        return true;
      }
      const pull = store.createPull(repo, {
        title,
        body: stringField(body, 'body') ?? '',
        headRef: head,
        baseRef: base,
        headSha,
        baseSha,
      });
      sendJson(store, res, 201, pullJson(store, repo, pull));
      return true;
    }
    if (method === 'GET') {
      const state = query.get('state') ?? 'open';
      let pulls = [...repo.items.values()].filter((item): item is PullRec => item.kind === 'pull');
      if (state === 'open' || state === 'closed') pulls = pulls.filter((pull) => pull.state === state);
      pulls.sort((a, b) => b.number - a.number);
      const page = pageOf(query);
      const paged = query.has('per_page') ? slicePage(pulls, page) : pulls;
      sendJson(store, res, 200, paged.map((pull) => pullJson(store, repo, pull)));
      return true;
    }
    return notFound(store, res);
  }

  const number = Number.parseInt(segments[0]!, 10);
  const item = Number.isInteger(number) ? repo.items.get(number) : undefined;
  const pull = item !== undefined && item.kind === 'pull' ? item : undefined;
  if (pull === undefined) return notFound(store, res);

  if (segments.length === 1 && method === 'GET') {
    sendJson(store, res, 200, pullJson(store, repo, pull));
    return true;
  }
  if (segments.length === 2 && segments[1] === 'files' && method === 'GET') {
    const files = store.pullFiles(repo, pull).map((file) => ({
      sha: file.sha,
      filename: file.filename,
      status: file.status,
      additions: file.additions,
      deletions: file.deletions,
      changes: file.changes,
    }));
    sendJson(store, res, 200, files);
    return true;
  }
  if (segments.length === 2 && segments[1] === 'merge' && method === 'PUT') {
    const body = await readJsonBody(store, req, res);
    if (body === null) return true;
    const methodField = isRecord(body) ? stringField(body, 'merge_method') : undefined;
    const mergeMethod = methodField ?? 'merge';
    if (mergeMethod !== 'squash' && mergeMethod !== 'merge' && mergeMethod !== 'rebase') {
      sendError(store, res, 422, `Validation Failed: merge_method "${mergeMethod}" is not supported`);
      return true;
    }
    if (pull.state !== 'open') {
      sendError(store, res, 405, 'Pull Request is not mergeable: it is not open');
      return true;
    }
    const sha = store.mergePull(repo, pull, mergeMethod === 'merge' ? 'merge' : 'squash');
    if (sha === null) {
      sendError(store, res, 405, 'Pull Request is not mergeable: the head conflicts with the base');
      return true;
    }
    sendJson(store, res, 200, { sha, merged: true, message: 'Pull Request successfully merged' });
    return true;
  }
  return notFound(store, res);
}
