// graphql.ts — the GraphQL v4 surface at /api/graphql.
//
// gh and github-mcp-server speak a specific dialect: viewer and repository
// reads, __type introspection probes, issue/pull-request connections with
// cursor pagination, and the createIssue / closeIssue / createPullRequest /
// mergePullRequest / addComment mutations. This module implements exactly
// that dialect with a small hand-written lexer, parser and executor over the
// shared store — no GraphQL library, Node standard library only. Unknown
// fields are GraphQL errors in a 200 (naming the field), an unknown
// repository is data.repository = null, and a JSON array body is operation
// batching answered in order.

import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  VIEWER,
  commentGlobalId,
  decodeGlobalId,
  issueGlobalId,
  pullGlobalId,
  repoGlobalId,
  userGlobalId,
  type IssueRec,
  type PullRec,
  type Repo,
  type Store,
} from './store.ts';
import { readBody, sendJson } from './web.ts';

// ---------------------------------------------------------------------------------------------
// lexer
// ---------------------------------------------------------------------------------------------

type Token =
  | { kind: 'name'; value: string }
  | { kind: 'int'; value: string }
  | { kind: 'float'; value: string }
  | { kind: 'string'; value: string }
  | { kind: 'punct'; value: string }
  | { kind: 'eof' };

function lex(source: string): Token[] {
  const tokens: Token[] = [];
  let index = 0;
  const isNameStart = (ch: string): boolean => /[_A-Za-z]/.test(ch);
  const isNameChar = (ch: string): boolean => /[_0-9A-Za-z]/.test(ch);
  while (index < source.length) {
    const ch = source[index]!;
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === ',' || ch === '\uFEFF') {
      index += 1;
      continue;
    }
    if (ch === '#') {
      while (index < source.length && source[index] !== '\n') index += 1;
      continue;
    }
    if (source.startsWith('...', index)) {
      tokens.push({ kind: 'punct', value: '...' });
      index += 3;
      continue;
    }
    if ('!$():=@[]{}|'.includes(ch)) {
      tokens.push({ kind: 'punct', value: ch });
      index += 1;
      continue;
    }
    if (ch === '"') {
      if (source.startsWith('"""', index)) {
        const end = source.indexOf('"""', index + 3);
        if (end < 0) throw new Error('unterminated block string');
        tokens.push({ kind: 'string', value: source.slice(index + 3, end) });
        index = end + 3;
        continue;
      }
      let value = '';
      index += 1;
      while (index < source.length && source[index] !== '"') {
        const current = source[index]!;
        if (current === '\\') {
          const escape = source[index + 1]!;
          if (escape === 'n') value += '\n';
          else if (escape === 't') value += '\t';
          else if (escape === 'r') value += '\r';
          else if (escape === 'b') value += '\b';
          else if (escape === 'f') value += '\f';
          else if (escape === '/') value += '/';
          else if (escape === '\\') value += '\\';
          else if (escape === '"') value += '"';
          else if (escape === 'u') {
            value += String.fromCharCode(Number.parseInt(source.slice(index + 2, index + 6), 16));
            index += 4;
          } else {
            value += escape;
          }
          index += 2;
          continue;
        }
        value += current;
        index += 1;
      }
      if (index >= source.length) throw new Error('unterminated string');
      index += 1;
      tokens.push({ kind: 'string', value });
      continue;
    }
    if (isNameStart(ch)) {
      let end = index + 1;
      while (end < source.length && isNameChar(source[end]!)) end += 1;
      tokens.push({ kind: 'name', value: source.slice(index, end) });
      index = end;
      continue;
    }
    if (/[-0-9]/.test(ch)) {
      let end = index;
      if (source[end] === '-') end += 1;
      while (end < source.length && /[0-9]/.test(source[end]!)) end += 1;
      let kind: 'int' | 'float' = 'int';
      if (source[end] === '.') {
        kind = 'float';
        end += 1;
        while (end < source.length && /[0-9]/.test(source[end]!)) end += 1;
      }
      if (source[end] === 'e' || source[end] === 'E') {
        kind = 'float';
        end += 1;
        if (source[end] === '+' || source[end] === '-') end += 1;
        while (end < source.length && /[0-9]/.test(source[end]!)) end += 1;
      }
      tokens.push({ kind, value: source.slice(index, end) });
      index = end;
      continue;
    }
    throw new Error(`unexpected character ${JSON.stringify(ch)}`);
  }
  tokens.push({ kind: 'eof' });
  return tokens;
}

// ---------------------------------------------------------------------------------------------
// parser
// ---------------------------------------------------------------------------------------------

type ValueNode =
  | { kind: 'variable'; name: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'string'; value: string }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'null' }
  | { kind: 'enum'; value: string }
  | { kind: 'list'; values: ValueNode[] }
  | { kind: 'object'; fields: Array<{ name: string; value: ValueNode }> };

interface FieldNode {
  kind: 'field';
  alias: string | null;
  name: string;
  args: Array<{ name: string; value: ValueNode }>;
  selectionSet: SelectionNode[] | null;
}

type SelectionNode =
  | FieldNode
  | { kind: 'inline'; typeCondition: string | null; selectionSet: SelectionNode[] }
  | { kind: 'spread'; name: string };

interface OperationNode {
  type: 'query' | 'mutation';
  name: string | null;
  selectionSet: SelectionNode[];
}

interface DocumentNode {
  operations: OperationNode[];
  fragments: Map<string, SelectionNode[]>;
}

class Parser {
  private tokens: Token[];
  private pos = 0;

  constructor(source: string) {
    this.tokens = lex(source);
  }

  private peek(): Token {
    return this.tokens[this.pos]!;
  }

  private next(): Token {
    const token = this.tokens[this.pos]!;
    this.pos += 1;
    return token;
  }

  private expectPunct(value: string): void {
    const token = this.next();
    if (token.kind !== 'punct' || token.value !== value) throw new Error(`expected ${value}`);
  }

  private skipPunct(value: string): boolean {
    const token = this.peek();
    if (token.kind === 'punct' && token.value === value) {
      this.pos += 1;
      return true;
    }
    return false;
  }

  private expectName(): string {
    const token = this.next();
    if (token.kind !== 'name') throw new Error('expected a name');
    return token.value;
  }

  parseDocument(): DocumentNode {
    const operations: OperationNode[] = [];
    const fragments = new Map<string, SelectionNode[]>();
    while (this.peek().kind !== 'eof') {
      const token = this.peek();
      if (token.kind === 'punct' && token.value === '{') {
        operations.push({ type: 'query', name: null, selectionSet: this.parseSelectionSet() });
        continue;
      }
      if (token.kind !== 'name') throw new Error('expected a definition');
      if (token.value === 'query' || token.value === 'mutation' || token.value === 'subscription') {
        const type = token.value === 'mutation' ? 'mutation' : 'query';
        this.next();
        let name: string | null = null;
        if (this.peek().kind === 'name') name = this.next().value as string;
        if (this.peek().kind === 'punct' && this.peek().value === '(') this.parseVariableDefinitions();
        this.skipDirectives();
        operations.push({ type, name, selectionSet: this.parseSelectionSet() });
        continue;
      }
      if (token.value === 'fragment') {
        this.next();
        const fragmentName = this.expectName();
        const on = this.expectName();
        if (on !== 'on') throw new Error('expected "on" in a fragment definition');
        this.expectName(); // the type condition
        this.skipDirectives();
        fragments.set(fragmentName, this.parseSelectionSet());
        continue;
      }
      throw new Error(`unexpected definition ${token.value}`);
    }
    return { operations, fragments };
  }

  private parseVariableDefinitions(): void {
    this.expectPunct('(');
    while (!this.skipPunct(')')) {
      this.expectPunct('$');
      this.expectName();
      this.expectPunct(':');
      this.parseType();
      if (this.skipPunct('=')) this.parseValue();
      this.skipDirectives();
    }
  }

  private parseType(): void {
    if (this.skipPunct('[')) {
      this.parseType();
      this.expectPunct(']');
    } else {
      this.expectName();
    }
    this.skipPunct('!');
  }

  private skipDirectives(): void {
    while (this.peek().kind === 'punct' && this.peek().value === '@') {
      this.next();
      this.expectName();
      if (this.peek().kind === 'punct' && this.peek().value === '(') this.parseArguments();
    }
  }

  private parseArguments(): Array<{ name: string; value: ValueNode }> {
    const args: Array<{ name: string; value: ValueNode }> = [];
    this.expectPunct('(');
    while (!this.skipPunct(')')) {
      const name = this.expectName();
      this.expectPunct(':');
      args.push({ name, value: this.parseValue() });
    }
    return args;
  }

  private parseSelectionSet(): SelectionNode[] {
    this.expectPunct('{');
    const selections: SelectionNode[] = [];
    while (!this.skipPunct('}')) {
      selections.push(this.parseSelection());
    }
    return selections;
  }

  private parseSelection(): SelectionNode {
    const token = this.peek();
    if (token.kind === 'punct' && token.value === '...') {
      this.next();
      const nextToken = this.peek();
      if (nextToken.kind === 'name' && nextToken.value === 'on') {
        this.next();
        const typeCondition = this.expectName();
        this.skipDirectives();
        return { kind: 'inline', typeCondition, selectionSet: this.parseSelectionSet() };
      }
      const name = this.expectName();
      this.skipDirectives();
      return { kind: 'spread', name };
    }
    let name = this.expectName();
    let alias: string | null = null;
    if (this.skipPunct(':')) {
      alias = name;
      name = this.expectName();
    }
    let args: Array<{ name: string; value: ValueNode }> = [];
    if (this.peek().kind === 'punct' && this.peek().value === '(') args = this.parseArguments();
    this.skipDirectives();
    let selectionSet: SelectionNode[] | null = null;
    if (this.peek().kind === 'punct' && this.peek().value === '{') selectionSet = this.parseSelectionSet();
    return { kind: 'field', alias, name, args, selectionSet };
  }

  private parseValue(): ValueNode {
    const token = this.next();
    if (token.kind === 'punct' && token.value === '$') return { kind: 'variable', name: this.expectName() };
    if (token.kind === 'int') return { kind: 'int', value: Number.parseInt(token.value, 10) };
    if (token.kind === 'float') return { kind: 'float', value: Number.parseFloat(token.value) };
    if (token.kind === 'string') return { kind: 'string', value: token.value };
    if (token.kind === 'punct' && token.value === '[') {
      const values: ValueNode[] = [];
      while (!this.skipPunct(']')) values.push(this.parseValue());
      return { kind: 'list', values };
    }
    if (token.kind === 'punct' && token.value === '{') {
      const fields: Array<{ name: string; value: ValueNode }> = [];
      while (!this.skipPunct('}')) {
        const name = this.expectName();
        this.expectPunct(':');
        fields.push({ name, value: this.parseValue() });
      }
      return { kind: 'object', fields };
    }
    if (token.kind === 'name') {
      if (token.value === 'true') return { kind: 'boolean', value: true };
      if (token.value === 'false') return { kind: 'boolean', value: false };
      if (token.value === 'null') return { kind: 'null' };
      return { kind: 'enum', value: token.value };
    }
    throw new Error('unexpected value');
  }
}

// ---------------------------------------------------------------------------------------------
// schema: the field lists introspection reports, and the enum values
// ---------------------------------------------------------------------------------------------

const TYPE_FIELDS: Readonly<Record<string, readonly string[]>> = {
  Query: ['viewer', 'repository', 'node', 'nodes', '__type', '__schema'],
  Mutation: ['createIssue', 'closeIssue', 'createPullRequest', 'mergePullRequest', 'addComment'],
  User: ['id', 'login', 'name', 'email', 'url'],
  Repository: [
    'id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission',
    'hasIssuesEnabled', 'issue', 'issues', 'pullRequest', 'pullRequests', 'description', 'isPrivate',
    'createdAt', 'updatedAt', 'url',
  ],
  Issue: ['id', 'number', 'title', 'state', 'body', 'author', 'labels', 'comments', 'createdAt', 'updatedAt', 'url', 'repository'],
  PullRequest: [
    'id', 'number', 'title', 'body', 'state', 'merged', 'mergeable', 'headRefName', 'baseRefName',
    'files', 'author', 'createdAt', 'updatedAt', 'mergedAt', 'mergeCommit', 'url', 'repository',
  ],
  IssueConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  PullRequestConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  PullRequestChangedFileConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  PullRequestChangedFile: ['path', 'additions', 'deletions', 'changeType'],
  PageInfo: ['hasNextPage', 'hasPreviousPage', 'startCursor', 'endCursor'],
  Label: ['id', 'name', 'color'],
  LabelConnection: ['nodes', 'pageInfo', 'totalCount'],
  IssueComment: ['id', 'body', 'author', 'createdAt', 'updatedAt'],
  IssueCommentConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  Ref: ['name', 'target', 'repository'],
  Commit: ['id', 'oid', 'message', 'committedDate'],
  CreateIssuePayload: ['issue', 'clientMutationId'],
  CloseIssuePayload: ['issue', 'clientMutationId'],
  CreatePullRequestPayload: ['pullRequest', 'clientMutationId'],
  MergePullRequestPayload: ['pullRequest', 'clientMutationId'],
  AddCommentPayload: ['commentEdge', 'subject', 'clientMutationId'],
  IssueCommentEdge: ['node', 'cursor'],
  __Type: ['name', 'kind', 'description', 'fields', 'enumValues', 'possibleTypes', 'inputFields', 'interfaces', 'ofType'],
  __Field: ['name', 'description', 'type', 'args', 'isDeprecated', 'deprecationReason'],
  __EnumValue: ['name', 'description', 'isDeprecated', 'deprecationReason'],
  __Schema: ['queryType', 'mutationType', 'types', 'directives'],
};

const ENUM_VALUES: Readonly<Record<string, readonly string[]>> = {
  SearchType: ['ISSUE', 'USER', 'REPOSITORY', 'DISCUSSION'],
  IssueState: ['OPEN', 'CLOSED'],
  PullRequestState: ['OPEN', 'CLOSED', 'MERGED'],
  MergeableState: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'],
  PullRequestMergeMethod: ['MERGE', 'SQUASH', 'REBASE'],
  RepositoryPermission: ['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ'],
  IssueOrderField: ['CREATED_AT', 'UPDATED_AT', 'COMMENTS'],
  OrderDirection: ['ASC', 'DESC'],
  FileChangeType: ['ADDED', 'MODIFIED', 'DELETED', 'RENAMED', 'COPIED', 'CHANGED'],
};

// ---------------------------------------------------------------------------------------------
// executor
// ---------------------------------------------------------------------------------------------

type GObject = Record<string, unknown> & { __typename: string };

interface ExecCtx {
  store: Store;
  variables: Record<string, unknown>;
  fragments: Map<string, SelectionNode[]>;
  errors: Array<{ message: string }>;
}

type Resolver = (ctx: ExecCtx, source: GObject, args: Record<string, unknown>) => unknown;

function dataResolvers(typeName: string): Record<string, Resolver> {
  const out: Record<string, Resolver> = {};
  for (const field of TYPE_FIELDS[typeName] ?? []) {
    out[field] = (_ctx, source) => source[field] ?? null;
  }
  return out;
}

function userObject(): GObject {
  return { __typename: 'User', id: userGlobalId(), login: VIEWER.login, name: VIEWER.name, email: VIEWER.email, url: '' };
}

function repoObject(repo: Repo): GObject {
  return { __typename: 'Repository', repo };
}

function issueObject(repo: Repo, issue: IssueRec): GObject {
  return { __typename: 'Issue', repo, issue };
}

function pullObject(repo: Repo, pull: PullRec): GObject {
  return { __typename: 'PullRequest', repo, pull };
}

function pageInfoObject(hasNextPage: boolean, endCursor: string | null): GObject {
  return { __typename: 'PageInfo', hasNextPage, hasPreviousPage: false, startCursor: null, endCursor };
}

function encodeCursor(number: number): string {
  return Buffer.from(`cursor:${number}`, 'utf8').toString('base64');
}

function decodeCursor(cursor: unknown): number | null {
  if (typeof cursor !== 'string') return null;
  try {
    const text = Buffer.from(cursor, 'base64').toString('utf8');
    const match = /^cursor:(\d+)$/.exec(text);
    return match ? Number.parseInt(match[1]!, 10) : null;
  } catch {
    return null;
  }
}

/** Order issues the way the connection promises: by creation, ties by number, direction applied. */
function orderIssues(issues: IssueRec[], orderBy: unknown): IssueRec[] {
  const sorted = [...issues].sort((a, b) => (a.createdSeq - b.createdSeq) || (a.number - b.number));
  let direction = 'DESC';
  if (orderBy !== null && typeof orderBy === 'object' && !Array.isArray(orderBy)) {
    const dir = (orderBy as Record<string, unknown>).direction;
    if (typeof dir === 'string') direction = dir;
  }
  if (direction !== 'ASC') sorted.reverse();
  return sorted;
}

function connectionPage<T extends { number: number }>(
  ordered: T[],
  args: Record<string, unknown>,
): { page: T[]; hasNextPage: boolean; endCursor: string | null } {
  let start = 0;
  const after = decodeCursor(args.after);
  if (after !== null) {
    const index = ordered.findIndex((item) => item.number === after);
    if (index >= 0) start = index + 1;
  }
  const first = typeof args.first === 'number' && Number.isFinite(args.first) ? Math.max(0, Math.trunc(args.first)) : 100;
  const page = ordered.slice(start, start + first);
  return {
    page,
    hasNextPage: start + page.length < ordered.length,
    endCursor: page.length > 0 ? encodeCursor(page[page.length - 1]!.number) : (typeof args.after === 'string' ? args.after : null),
  };
}

const RESOLVERS: Record<string, Record<string, Resolver>> = {
  Query: {
    viewer: () => userObject(),
    repository: (ctx, _source, args) => {
      const owner = typeof args.owner === 'string' ? args.owner : '';
      const name = typeof args.name === 'string' ? args.name : '';
      const repo = ctx.store.findRepo(owner, name);
      return repo === null ? null : repoObject(repo);
    },
    node: (ctx, _source, args) => {
      if (typeof args.id !== 'string') return null;
      const decoded = decodeGlobalId(args.id);
      if (decoded === null) return null;
      if (decoded.kind === 'Repository') {
        const repo = ctx.store.reposByDbId.get(decoded.parts[0]!);
        return repo ? repoObject(repo) : null;
      }
      if (decoded.kind === 'Issue' || decoded.kind === 'PullRequest') {
        const repo = ctx.store.reposByDbId.get(decoded.parts[0]!);
        const item = repo?.items.get(decoded.parts[1]!);
        if (!repo || !item) return null;
        return item.kind === 'issue' ? issueObject(repo, item) : pullObject(repo, item);
      }
      if (decoded.kind === 'User') return userObject();
      return null;
    },
    __type: (_ctx, _source, args) => {
      const name = typeof args.name === 'string' ? args.name : '';
      if (TYPE_FIELDS[name] === undefined && ENUM_VALUES[name] === undefined) return null;
      return { __typename: '__Type', name };
    },
    __schema: () => ({
      __typename: '__Schema',
      queryType: { __typename: '__Type', name: 'Query' },
      mutationType: { __typename: '__Type', name: 'Mutation' },
      types: [],
      directives: [],
    }),
  },
  Mutation: {
    createIssue: (ctx, _source, args) => {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const repo = repoFromGlobalId(ctx, input.repositoryId);
      if (repo === null) throw new Error('createIssue: the repository id does not name a repository');
      const issue = ctx.store.createIssue(repo, {
        title: typeof input.title === 'string' ? input.title : '',
        body: typeof input.body === 'string' ? input.body : '',
      });
      return { __typename: 'CreateIssuePayload', issue: issueObject(repo, issue), clientMutationId: null };
    },
    closeIssue: (ctx, _source, args) => {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const found = itemFromGlobalId(ctx, input.issueId, 'issue');
      if (found === null) throw new Error('closeIssue: the issue id does not name an issue');
      found.item.state = 'closed';
      return { __typename: 'CloseIssuePayload', issue: issueObject(found.repo, found.item), clientMutationId: null };
    },
    createPullRequest: (ctx, _source, args) => {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const repo = repoFromGlobalId(ctx, input.repositoryId);
      if (repo === null) throw new Error('createPullRequest: the repository id does not name a repository');
      const headRefName = typeof input.headRefName === 'string' ? input.headRefName : '';
      const baseRefName = typeof input.baseRefName === 'string' ? input.baseRefName : '';
      const headSha = ctx.store.branchTip(repo, headRefName);
      const baseSha = ctx.store.branchTip(repo, baseRefName);
      if (headSha === null) throw new Error(`createPullRequest: head branch ${headRefName} does not exist`);
      if (baseSha === null) throw new Error(`createPullRequest: base branch ${baseRefName} does not exist`);
      const pull = ctx.store.createPull(repo, {
        title: typeof input.title === 'string' ? input.title : '',
        body: typeof input.body === 'string' ? input.body : '',
        headRef: headRefName,
        baseRef: baseRefName,
        headSha,
        baseSha,
      });
      return { __typename: 'CreatePullRequestPayload', pullRequest: pullObject(repo, pull), clientMutationId: null };
    },
    mergePullRequest: (ctx, _source, args) => {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const found = itemFromGlobalId(ctx, input.pullRequestId, 'pull');
      if (found === null) throw new Error('mergePullRequest: the pull request id does not name a pull request');
      const method = typeof input.mergeMethod === 'string' ? input.mergeMethod : 'SQUASH';
      const sha = ctx.store.mergePull(found.repo, found.item, method === 'MERGE' ? 'merge' : 'squash');
      if (sha === null) throw new Error('mergePullRequest: the pull request has conflicts with the base');
      return { __typename: 'MergePullRequestPayload', pullRequest: pullObject(found.repo, found.item), clientMutationId: null };
    },
    addComment: (ctx, _source, args) => {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const found = itemFromGlobalId(ctx, input.subjectId, 'issue');
      if (found === null) throw new Error('addComment: the subject id does not name an issue');
      const comment = ctx.store.addComment(found.repo, found.item, typeof input.body === 'string' ? input.body : '');
      const node: GObject = {
        __typename: 'IssueComment',
        id: commentGlobalId(found.repo, comment),
        body: comment.body,
        author: userObject(),
        createdAt: ctx.store.isoOf(comment.createdSeq),
        updatedAt: ctx.store.isoOf(comment.createdSeq),
      };
      return {
        __typename: 'AddCommentPayload',
        commentEdge: { __typename: 'IssueCommentEdge', node, cursor: encodeCursor(comment.id) },
        subject: issueObject(found.repo, found.item),
        clientMutationId: null,
      };
    },
  },
  User: dataResolvers('User'),
  Repository: {
    id: (_ctx, source) => repoGlobalId(source.repo as Repo),
    databaseId: (_ctx, source) => (source.repo as Repo).dbId,
    name: (_ctx, source) => (source.repo as Repo).name,
    nameWithOwner: (_ctx, source) => {
      const repo = source.repo as Repo;
      return `${repo.owner}/${repo.name}`;
    },
    owner: () => userObject(),
    description: (_ctx, source) => (source.repo as Repo).description,
    isPrivate: (_ctx, source) => (source.repo as Repo).private,
    viewerPermission: () => 'ADMIN',
    hasIssuesEnabled: () => true,
    createdAt: (ctx, source) => ctx.store.isoOf((source.repo as Repo).createdSeq),
    updatedAt: (ctx, source) => ctx.store.isoOf((source.repo as Repo).createdSeq),
    url: () => '',
    defaultBranchRef: (ctx, source) => {
      const repo = source.repo as Repo;
      const tip = ctx.store.branchTip(repo, repo.defaultBranch);
      if (tip === null) return null;
      return {
        __typename: 'Ref',
        name: repo.defaultBranch,
        target: { __typename: 'Commit', id: tip, oid: tip, message: '', committedDate: '' },
        repository: repoObject(repo),
      };
    },
    issue: (_ctx, source, args) => {
      const repo = source.repo as Repo;
      const item = typeof args.number === 'number' ? repo.items.get(args.number) : undefined;
      return item !== undefined && item.kind === 'issue' ? issueObject(repo, item) : null;
    },
    issues: (_ctx, source, args) => {
      const repo = source.repo as Repo;
      let issues = [...repo.items.values()].filter((item): item is IssueRec => item.kind === 'issue');
      if (Array.isArray(args.states)) {
        const states = new Set(args.states.map((state) => String(state).toUpperCase()));
        issues = issues.filter((issue) => states.has(issue.state.toUpperCase()));
      }
      const ordered = orderIssues(issues, args.orderBy);
      const { page, hasNextPage, endCursor } = connectionPage(ordered, args);
      return {
        __typename: 'IssueConnection',
        nodes: page.map((issue) => issueObject(repo, issue)),
        pageInfo: pageInfoObject(hasNextPage, endCursor),
        totalCount: ordered.length,
      };
    },
    pullRequest: (_ctx, source, args) => {
      const repo = source.repo as Repo;
      const item = typeof args.number === 'number' ? repo.items.get(args.number) : undefined;
      return item !== undefined && item.kind === 'pull' ? pullObject(repo, item) : null;
    },
    pullRequests: (_ctx, source, args) => {
      const repo = source.repo as Repo;
      let pulls = [...repo.items.values()].filter((item): item is PullRec => item.kind === 'pull');
      if (Array.isArray(args.states)) {
        const states = new Set(args.states.map((state) => String(state).toUpperCase()));
        pulls = pulls.filter((pull) => (pull.merged ? 'MERGED' : pull.state.toUpperCase()) === '' || states.has(pull.merged ? 'MERGED' : pull.state.toUpperCase()));
      }
      pulls.sort((a, b) => (b.createdSeq - a.createdSeq) || (b.number - a.number));
      const { page, hasNextPage, endCursor } = connectionPage(pulls, args);
      return {
        __typename: 'PullRequestConnection',
        nodes: page.map((pull) => pullObject(repo, pull)),
        pageInfo: pageInfoObject(hasNextPage, endCursor),
        totalCount: pulls.length,
      };
    },
  },
  Issue: {
    id: (_ctx, source) => issueGlobalId(source.repo as Repo, source.issue as IssueRec),
    number: (_ctx, source) => (source.issue as IssueRec).number,
    title: (_ctx, source) => (source.issue as IssueRec).title,
    body: (_ctx, source) => (source.issue as IssueRec).body,
    state: (_ctx, source) => (source.issue as IssueRec).state.toUpperCase(),
    author: () => userObject(),
    createdAt: (ctx, source) => ctx.store.isoOf((source.issue as IssueRec).createdSeq),
    updatedAt: (ctx, source) => ctx.store.isoOf((source.issue as IssueRec).createdSeq),
    url: () => '',
    repository: (_ctx, source) => repoObject(source.repo as Repo),
    labels: (_ctx, source) => {
      const repo = source.repo as Repo;
      const issue = source.issue as IssueRec;
      return {
        __typename: 'LabelConnection',
        nodes: issue.labels.map((name) => ({
          __typename: 'Label',
          id: Buffer.from(`Label:${repo.dbId}:${name}`, 'utf8').toString('base64'),
          name,
          color: repo.labels.get(name)?.color ?? '000000',
        })),
        pageInfo: pageInfoObject(false, null),
        totalCount: issue.labels.length,
      };
    },
    comments: (ctx, source) => {
      const repo = source.repo as Repo;
      const issue = source.issue as IssueRec;
      return {
        __typename: 'IssueCommentConnection',
        nodes: issue.comments.map((comment) => ({
          __typename: 'IssueComment',
          id: commentGlobalId(repo, comment),
          body: comment.body,
          author: userObject(),
          createdAt: ctx.store.isoOf(comment.createdSeq),
          updatedAt: ctx.store.isoOf(comment.createdSeq),
        })),
        pageInfo: pageInfoObject(false, null),
        totalCount: issue.comments.length,
      };
    },
  },
  PullRequest: {
    id: (_ctx, source) => pullGlobalId(source.repo as Repo, source.pull as PullRec),
    number: (_ctx, source) => (source.pull as PullRec).number,
    title: (_ctx, source) => (source.pull as PullRec).title,
    body: (_ctx, source) => (source.pull as PullRec).body,
    state: (_ctx, source) => {
      const pull = source.pull as PullRec;
      return pull.merged ? 'MERGED' : pull.state.toUpperCase();
    },
    merged: (_ctx, source) => (source.pull as PullRec).merged,
    mergeable: (ctx, source) => {
      const repo = source.repo as Repo;
      const pull = source.pull as PullRec;
      if (pull.merged) return 'UNKNOWN';
      return ctx.store.pullMergeable(repo, pull) ? 'MERGEABLE' : 'CONFLICTING';
    },
    headRefName: (_ctx, source) => (source.pull as PullRec).headRef,
    baseRefName: (_ctx, source) => (source.pull as PullRec).baseRef,
    author: () => userObject(),
    createdAt: (ctx, source) => ctx.store.isoOf((source.pull as PullRec).createdSeq),
    updatedAt: (ctx, source) => ctx.store.isoOf((source.pull as PullRec).createdSeq),
    mergedAt: (_ctx, source) => (source.pull as PullRec).mergedAt,
    mergeCommit: (_ctx, source) => {
      const pull = source.pull as PullRec;
      return pull.mergeCommitSha === null
        ? null
        : { __typename: 'Commit', id: pull.mergeCommitSha, oid: pull.mergeCommitSha, message: '', committedDate: '' };
    },
    url: () => '',
    repository: (_ctx, source) => repoObject(source.repo as Repo),
    files: (ctx, source, args) => {
      const repo = source.repo as Repo;
      const pull = source.pull as PullRec;
      const changes = ctx.store.pullFiles(repo, pull);
      const first = typeof args.first === 'number' ? Math.max(0, Math.trunc(args.first)) : changes.length;
      return {
        __typename: 'PullRequestChangedFileConnection',
        nodes: changes.slice(0, first).map((change) => ({
          __typename: 'PullRequestChangedFile',
          path: change.filename,
          additions: change.additions,
          deletions: change.deletions,
          changeType: change.status === 'added' ? 'ADDED' : change.status === 'removed' ? 'DELETED' : 'MODIFIED',
        })),
        pageInfo: pageInfoObject(false, null),
        totalCount: changes.length,
      };
    },
  },
  IssueConnection: dataResolvers('IssueConnection'),
  PullRequestConnection: dataResolvers('PullRequestConnection'),
  PullRequestChangedFileConnection: dataResolvers('PullRequestChangedFileConnection'),
  PullRequestChangedFile: dataResolvers('PullRequestChangedFile'),
  PageInfo: dataResolvers('PageInfo'),
  Label: dataResolvers('Label'),
  LabelConnection: dataResolvers('LabelConnection'),
  IssueComment: dataResolvers('IssueComment'),
  IssueCommentConnection: dataResolvers('IssueCommentConnection'),
  Ref: dataResolvers('Ref'),
  Commit: dataResolvers('Commit'),
  CreateIssuePayload: dataResolvers('CreateIssuePayload'),
  CloseIssuePayload: dataResolvers('CloseIssuePayload'),
  CreatePullRequestPayload: dataResolvers('CreatePullRequestPayload'),
  MergePullRequestPayload: dataResolvers('MergePullRequestPayload'),
  AddCommentPayload: dataResolvers('AddCommentPayload'),
  IssueCommentEdge: dataResolvers('IssueCommentEdge'),
  __Schema: dataResolvers('__Schema'),
  __Type: {
    name: (_ctx, source) => source.name as string,
    kind: (_ctx, source) => (ENUM_VALUES[source.name as string] !== undefined ? 'ENUM' : 'OBJECT'),
    description: () => null,
    fields: (_ctx, source) => {
      const fields = TYPE_FIELDS[source.name as string];
      if (fields === undefined) return null;
      return fields.map((name) => ({ __typename: '__Field', name, description: null, isDeprecated: false, deprecationReason: null }));
    },
    enumValues: (_ctx, source) => {
      const values = ENUM_VALUES[source.name as string];
      if (values === undefined) return null;
      return values.map((name) => ({ __typename: '__EnumValue', name, description: null, isDeprecated: false, deprecationReason: null }));
    },
    possibleTypes: () => null,
    inputFields: () => null,
    interfaces: () => [],
    ofType: () => null,
  },
  __Field: dataResolvers('__Field'),
  __EnumValue: dataResolvers('__EnumValue'),
};

function repoFromGlobalId(ctx: ExecCtx, id: unknown): Repo | null {
  if (typeof id !== 'string') return null;
  const decoded = decodeGlobalId(id);
  if (decoded === null || decoded.kind !== 'Repository') return null;
  return ctx.store.reposByDbId.get(decoded.parts[0]!) ?? null;
}

function itemFromGlobalId<T extends ItemRec['kind']>(
  ctx: ExecCtx,
  id: unknown,
  kind: T,
): { repo: Repo; item: Extract<ItemRec, { kind: T }> } | null {
  if (typeof id !== 'string') return null;
  const decoded = decodeGlobalId(id);
  if (decoded === null) return null;
  const repo = ctx.store.reposByDbId.get(decoded.parts[0]!);
  if (!repo) return null;
  const item = repo.items.get(decoded.parts[1]!);
  if (!item || item.kind !== kind) return null;
  return { repo, item: item as Extract<ItemRec, { kind: T }> };
}

type ItemRec = IssueRec | PullRec;

function evalValue(node: ValueNode, variables: Record<string, unknown>): unknown {
  switch (node.kind) {
    case 'variable':
      return variables[node.name];
    case 'int':
    case 'float':
    case 'string':
    case 'boolean':
      return node.value;
    case 'null':
      return null;
    case 'enum':
      return node.value;
    case 'list':
      return node.values.map((value) => evalValue(value, variables));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const field of node.fields) out[field.name] = evalValue(field.value, variables);
      return out;
    }
  }
}

function evalArgs(field: FieldNode, variables: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const arg of field.args) out[arg.name] = evalValue(arg.value, variables);
  return out;
}

function executeSelectionSet(
  ctx: ExecCtx,
  source: GObject,
  typeName: string,
  selections: readonly SelectionNode[],
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const selection of selections) {
    if (selection.kind === 'inline') {
      if (selection.typeCondition === null || selection.typeCondition === typeName) {
        Object.assign(out, executeSelectionSet(ctx, source, typeName, selection.selectionSet));
      }
      continue;
    }
    if (selection.kind === 'spread') {
      const fragment = ctx.fragments.get(selection.name);
      if (fragment) Object.assign(out, executeSelectionSet(ctx, source, typeName, fragment));
      continue;
    }
    const responseKey = selection.alias ?? selection.name;
    if (selection.name === '__typename') {
      out[responseKey] = typeName;
      continue;
    }
    const resolver = RESOLVERS[typeName]?.[selection.name];
    if (resolver === undefined) {
      ctx.errors.push({ message: `Field '${selection.name}' doesn't exist on type '${typeName}'` });
      out[responseKey] = null;
      continue;
    }
    let value: unknown;
    try {
      value = resolver(ctx, source, evalArgs(selection, ctx.variables));
    } catch (err) {
      ctx.errors.push({ message: err instanceof Error ? err.message : String(err) });
      out[responseKey] = null;
      continue;
    }
    out[responseKey] = completeValue(ctx, value, selection.selectionSet);
  }
  return out;
}

function completeValue(ctx: ExecCtx, value: unknown, selectionSet: SelectionNode[] | null): unknown {
  if (value === null || value === undefined) return null;
  if (Array.isArray(value)) return value.map((entry) => completeValue(ctx, entry, selectionSet));
  if (typeof value === 'object') {
    const typename = (value as GObject).__typename;
    if (typeof typename === 'string') {
      if (selectionSet === null) return null;
      return executeSelectionSet(ctx, value as GObject, typename, selectionSet);
    }
    return value;
  }
  return value;
}

/** Execute one operation document; answers the {data, errors?} envelope. */
export function executeGraphQL(
  store: Store,
  document: string,
  variables: Record<string, unknown>,
  operationName: string | null,
): { data: Record<string, unknown> | null; errors?: Array<{ message: string }> } {
  let parsed: DocumentNode;
  try {
    parsed = new Parser(document).parseDocument();
  } catch (err) {
    return { data: null, errors: [{ message: `Syntax error: ${err instanceof Error ? err.message : String(err)}` }] };
  }
  let operation: OperationNode | undefined;
  if (operationName !== null) operation = parsed.operations.find((op) => op.name === operationName);
  else if (parsed.operations.length === 1) operation = parsed.operations[0];
  else operation = parsed.operations[0];
  if (operation === undefined) {
    return { data: null, errors: [{ message: 'No operation to execute' }] };
  }
  const ctx: ExecCtx = { store, variables, fragments: parsed.fragments, errors: [] };
  const rootType = operation.type === 'mutation' ? 'Mutation' : 'Query';
  const root: GObject = { __typename: rootType };
  const data = executeSelectionSet(ctx, root, rootType, operation.selectionSet);
  const envelope: { data: Record<string, unknown> | null; errors?: Array<{ message: string }> } = { data };
  if (ctx.errors.length > 0) envelope.errors = ctx.errors;
  return envelope;
}

// ---------------------------------------------------------------------------------------------
// the HTTP endpoint
// ---------------------------------------------------------------------------------------------

/** Handle POST /api/graphql (the caller has already authenticated the request). */
export async function handleGraphQL(store: Store, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const raw = await readBody(req);
  let body: unknown;
  try {
    body = JSON.parse(raw.toString('utf8')) as unknown;
  } catch {
    sendJson(store, res, 400, { errors: [{ message: 'The request body is not valid JSON' }] });
    return;
  }
  const runOne = (entry: unknown): { data: Record<string, unknown> | null; errors?: Array<{ message: string }> } => {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
      return { data: null, errors: [{ message: 'Each operation must be an object with a query' }] };
    }
    const record = entry as Record<string, unknown>;
    const query = typeof record.query === 'string' ? record.query : '';
    const variables = record.variables !== null && typeof record.variables === 'object' && !Array.isArray(record.variables)
      ? (record.variables as Record<string, unknown>)
      : {};
    const operationName = typeof record.operationName === 'string' ? record.operationName : null;
    if (query === '') return { data: null, errors: [{ message: 'The operation has no query document' }] };
    return executeGraphQL(store, query, variables, operationName);
  };
  if (Array.isArray(body)) {
    sendJson(store, res, 200, body.map(runOne));
    return;
  }
  sendJson(store, res, 200, runOne(body));
}
