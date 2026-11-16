// mcp.ts — the Model Context Protocol surface at /mcp.
//
// JSON-RPC 2.0 over Streamable HTTP, speaking the current revision
// (2026-07-28: server/discover, no handshake, no session) and the legacy
// initialize handshake for older revisions. The six tools the contract
// names — create_repo, get_repo, create_issue, list_issues,
// create_pull_request, merge_pull_request — act on the same store as every
// other surface, and their results carry the REST JSON shapes, so an object
// created here is the same object REST reads. Error semantics follow the
// rules exactly: -32700 with HTTP 400 for a body that is not JSON, -32602
// for an unknown tool or a missing required argument, -32601 for an unknown
// method, tool failures as isError results.

import type { IncomingMessage, ServerResponse } from 'node:http';
import { issueJson, pullJson, repoJson } from './rest.ts';
import { VIEWER, type IssueRec, type Repo, type Store } from './store.ts';
import { isRecord, readBody, sendEmpty, sendJson } from './web.ts';

const SERVER_INFO = { name: 'lucky-comet-forge', version: '1.0.0' } as const;
const SUPPORTED_VERSIONS = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'] as const;

interface ToolDef {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, { type: string; description: string }>;
    required: string[];
  };
}

function tool(name: string, description: string, properties: Record<string, string>, required: string[]): ToolDef {
  const props: Record<string, { type: string; description: string }> = {};
  for (const [key, type] of Object.entries(properties)) {
    props[key] = { type, description: `The ${key} argument` };
  }
  return { name, description, inputSchema: { type: 'object', properties: props, required } };
}

/** The tool list: a constant, so two tools/list answers are byte-identical. */
const TOOLS: readonly ToolDef[] = [
  tool('create_repo', 'Create a new repository owned by the authenticated user', { name: 'string', description: 'string', private: 'boolean' }, ['name']),
  tool('get_repo', 'Get a repository by owner and name', { owner: 'string', repo: 'string' }, ['owner', 'repo']),
  tool('create_issue', 'Create an issue in a repository', { owner: 'string', repo: 'string', title: 'string', body: 'string' }, ['owner', 'repo', 'title']),
  tool('list_issues', 'List the issues of a repository, optionally filtered by state', { owner: 'string', repo: 'string', state: 'string' }, ['owner', 'repo']),
  tool('create_pull_request', 'Open a pull request from a head branch into a base branch', { owner: 'string', repo: 'string', title: 'string', body: 'string', head: 'string', base: 'string' }, ['owner', 'repo', 'title', 'head', 'base']),
  tool('merge_pull_request', 'Merge a pull request by number', { owner: 'string', repo: 'string', pull_number: 'integer' }, ['owner', 'repo', 'pull_number']),
];

const TOOL_BY_NAME = new Map(TOOLS.map((def) => [def.name, def]));

// ---------------------------------------------------------------------------------------------
// tool implementations
// ---------------------------------------------------------------------------------------------

type ToolOutcome = { ok: true; value: unknown } | { ok: false; message: string };

function repoArg(store: Store, args: Record<string, unknown>): Repo | null {
  const owner = typeof args.owner === 'string' ? args.owner : '';
  const repo = typeof args.repo === 'string' ? args.repo : '';
  return store.findRepo(owner, repo);
}

function runTool(store: Store, name: string, args: Record<string, unknown>): ToolOutcome {
  switch (name) {
    case 'create_repo': {
      const repoName = args.name as string;
      const existing = store.findRepo(VIEWER.login, repoName);
      if (existing !== null) return { ok: true, value: repoJson(store, existing) };
      const repo = store.createRepo(repoName, {
        private: args.private === true,
        description: typeof args.description === 'string' ? args.description : '',
      });
      return { ok: true, value: repoJson(store, repo) };
    }
    case 'get_repo': {
      const repo = repoArg(store, args);
      if (repo === null) return { ok: false, message: 'Repository not found' };
      return { ok: true, value: repoJson(store, repo) };
    }
    case 'create_issue': {
      const repo = repoArg(store, args);
      if (repo === null) return { ok: false, message: 'Repository not found' };
      const issue = store.createIssue(repo, {
        title: args.title as string,
        body: typeof args.body === 'string' ? args.body : '',
      });
      return { ok: true, value: issueJson(store, repo, issue) };
    }
    case 'list_issues': {
      const repo = repoArg(store, args);
      if (repo === null) return { ok: false, message: 'Repository not found' };
      const state = typeof args.state === 'string' ? args.state : 'open';
      let issues = [...repo.items.values()].filter((item): item is IssueRec => item.kind === 'issue');
      if (state === 'open' || state === 'closed') issues = issues.filter((issue) => issue.state === state);
      issues.sort((a, b) => a.number - b.number);
      return { ok: true, value: issues.map((issue) => issueJson(store, repo, issue)) };
    }
    case 'create_pull_request': {
      const repo = repoArg(store, args);
      if (repo === null) return { ok: false, message: 'Repository not found' };
      const head = args.head as string;
      const base = args.base as string;
      const headSha = store.branchTip(repo, head);
      const baseSha = store.branchTip(repo, base);
      if (headSha === null) return { ok: false, message: `Head branch ${head} does not exist` };
      if (baseSha === null) return { ok: false, message: `Base branch ${base} does not exist` };
      const pull = store.createPull(repo, {
        title: args.title as string,
        body: typeof args.body === 'string' ? args.body : '',
        headRef: head,
        baseRef: base,
        headSha,
        baseSha,
      });
      return { ok: true, value: pullJson(store, repo, pull) };
    }
    case 'merge_pull_request': {
      const repo = repoArg(store, args);
      if (repo === null) return { ok: false, message: 'Repository not found' };
      const number = typeof args.pull_number === 'number' ? args.pull_number : Number.parseInt(String(args.pull_number ?? ''), 10);
      const item = Number.isInteger(number) ? repo.items.get(number) : undefined;
      if (item === undefined || item.kind !== 'pull') return { ok: false, message: `Pull request ${String(args.pull_number)} not found` };
      if (item.state !== 'open') return { ok: false, message: `Pull request #${item.number} is not open` };
      const sha = store.mergePull(repo, item, 'squash');
      if (sha === null) return { ok: false, message: `Pull request #${item.number} has conflicts with the base` };
      return { ok: true, value: pullJson(store, repo, item) };
    }
    default:
      return { ok: false, message: `Unknown tool ${name}` };
  }
}

// ---------------------------------------------------------------------------------------------
// JSON-RPC dispatch
// ---------------------------------------------------------------------------------------------

interface RpcError {
  code: number;
  message: string;
}

function dispatch(store: Store, method: string, params: Record<string, unknown>): { result?: unknown; error?: RpcError } {
  switch (method) {
    case 'server/discover':
      return {
        result: {
          supportedVersions: [...SUPPORTED_VERSIONS],
          capabilities: { tools: {} },
          serverInfo: { ...SERVER_INFO },
        },
      };
    case 'initialize': {
      const requested = typeof params.protocolVersion === 'string' ? params.protocolVersion : '';
      const protocolVersion = (SUPPORTED_VERSIONS as readonly string[]).includes(requested) ? requested : '2025-11-25';
      return { result: { protocolVersion, capabilities: { tools: {} }, serverInfo: { ...SERVER_INFO } } };
    }
    case 'ping':
      return { result: {} };
    case 'tools/list':
      return { result: { tools: TOOLS } };
    case 'tools/call': {
      const name = typeof params.name === 'string' ? params.name : '';
      const def = TOOL_BY_NAME.get(name);
      if (def === undefined) return { error: { code: -32602, message: `Unknown tool: ${name}` } };
      const args = isRecord(params.arguments) ? params.arguments : {};
      for (const required of def.inputSchema.required) {
        if (args[required] === undefined || args[required] === null) {
          return { error: { code: -32602, message: `Missing required argument: ${required}` } };
        }
      }
      const outcome = runTool(store, name, args);
      if (!outcome.ok) {
        return {
          result: {
            content: [{ type: 'text', text: outcome.message }],
            isError: true,
          },
        };
      }
      return {
        result: {
          content: [{ type: 'text', text: JSON.stringify(outcome.value) }],
          structuredContent: outcome.value,
          isError: false,
        },
      };
    }
    default:
      return { error: { code: -32601, message: `Method not found: ${method}` } };
  }
}

/** Handle one POST /mcp (the caller has already authenticated the request). */
export async function handleMcp(store: Store, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const raw = await readBody(req);
  let body: unknown;
  try {
    body = JSON.parse(raw.toString('utf8')) as unknown;
  } catch {
    sendJson(store, res, 400, {
      jsonrpc: '2.0',
      id: null,
      error: { code: -32700, message: 'Parse error: the body is not valid JSON' },
    });
    return;
  }
  const handleOne = (entry: unknown): Record<string, unknown> | null => {
    if (!isRecord(entry) || typeof entry.method !== 'string') {
      return { jsonrpc: '2.0', id: isRecord(entry) && 'id' in entry ? entry.id : null, error: { code: -32600, message: 'Invalid Request' } };
    }
    const params = isRecord(entry.params) ? entry.params : {};
    const outcome = dispatch(store, entry.method, params);
    if (!('id' in entry)) return null; // a notification: no response body
    if (outcome.error !== undefined) return { jsonrpc: '2.0', id: entry.id, error: outcome.error };
    return { jsonrpc: '2.0', id: entry.id, result: outcome.result ?? null };
  };
  if (Array.isArray(body)) {
    const responses = body.map(handleOne).filter((entry) => entry !== null);
    sendJson(store, res, 200, responses);
    return;
  }
  const response = handleOne(body);
  if (response === null) {
    sendEmpty(store, res, 202);
    return;
  }
  sendJson(store, res, 200, response);
}
