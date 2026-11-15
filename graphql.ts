import {
  resolveRef,
  findMergeBase,
  checkPullConflicts,
  getPullFilesDiff,
  squashMergeCommit,
} from './git.ts';

interface Comment {
  id: number;
  body: string;
}

interface Issue {
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  comments: Comment[];
  createdAt: string;
  updatedAt: string;
}

interface Pull {
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  head: { ref: string; sha: string };
  base: { ref: string; sha: string };
  merged: boolean;
  merged_at: string | null;
  merge_commit_sha: string | null;
  createdAt: string;
  updatedAt: string;
  comments?: Comment[];
}

interface Repo {
  owner: string;
  name: string;
  id: number;
  private: boolean;
  description: string;
  default_branch: string;
  createdAt: string;
  updatedAt: string;
  objects: Map<string, { type: string; data: Buffer }>;
  refs: Map<string, string>;
  issues: Map<number, Issue>;
  prs: Map<number, Pull>;
  generation: number;
  nextIssueNumber: number;
  nextPrNumber: number;
}

let nextCommentId = 1;

// Global ID helpers
function encodeGlobalId(type: string, ...parts: (string | number)[]): string {
  const raw = [type, ...parts].join(':');
  return Buffer.from(raw, 'utf-8').toString('base64');
}

function decodeGlobalId(idStr: string): string[] {
  try {
    const decoded = Buffer.from(idStr, 'base64').toString('utf-8');
    return decoded.split(':');
  } catch (e) {
    return [];
  }
}

// Tokenizer & Parser
type TokenType = 'NAME' | 'INT' | 'FLOAT' | 'STRING' | 'PUNC' | 'EOF';

interface Token {
  type: TokenType;
  value: string;
  start: number;
}

function tokenize(input: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  const len = input.length;

  while (i < len) {
    let c = input[i];

    // Whitespace / comma
    if (c === ' ' || c === '\t' || c === '\r' || c === '\n' || c === ',') {
      i++;
      continue;
    }

    // Comments
    if (c === '#') {
      while (i < len && input[i] !== '\n' && input[i] !== '\r') {
        i++;
      }
      continue;
    }

    // Punctuators: { } ( ) : = [ ] ... $ @
    if (c === '{' || c === '}' || c === '(' || c === ')' || c === ':' || c === '=' || c === '[' || c === ']' || c === '$' || c === '@') {
      tokens.push({ type: 'PUNC', value: c, start: i });
      i++;
      continue;
    }

    if (c === '.' && input.slice(i, i + 3) === '...') {
      tokens.push({ type: 'PUNC', value: '...', start: i });
      i += 3;
      continue;
    }

    // Strings
    if (c === '"') {
      const start = i;
      i++;
      let str = '';
      while (i < len) {
        let ch = input[i];
        if (ch === '"') {
          i++;
          break;
        }
        if (ch === '\\' && i + 1 < len) {
          i++;
          ch = input[i];
          if (ch === 'n') str += '\n';
          else if (ch === 't') str += '\t';
          else if (ch === 'r') str += '\r';
          else str += ch;
          i++;
        } else {
          str += ch;
          i++;
        }
      }
      tokens.push({ type: 'STRING', value: str, start });
      continue;
    }

    // Numbers
    if ((c >= '0' && c <= '9') || c === '-') {
      const start = i;
      let numStr = c;
      i++;
      let isFloat = false;
      while (i < len) {
        const ch = input[i];
        if ((ch >= '0' && ch <= '9') || ch === '.' || ch === 'e' || ch === 'E' || ch === '+' || ch === '-') {
          if (ch === '.') isFloat = true;
          numStr += ch;
          i++;
        } else {
          break;
        }
      }
      tokens.push({ type: isFloat ? 'FLOAT' : 'INT', value: numStr, start });
      continue;
    }

    // Names / Identifiers / Keywords (true, false, null, query, mutation, fragment, on)
    if ((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || c === '_') {
      const start = i;
      let nameStr = c;
      i++;
      while (i < len) {
        const ch = input[i];
        if ((ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z') || (ch >= '0' && ch <= '9') || ch === '_') {
          nameStr += ch;
          i++;
        } else {
          break;
        }
      }
      tokens.push({ type: 'NAME', value: nameStr, start });
      continue;
    }

    // Unknown character, skip or advance
    i++;
  }

  tokens.push({ type: 'EOF', value: '', start: len });
  return tokens;
}

class Parser {
  tokens: Token[];
  pos = 0;

  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }

  peek(): Token {
    return this.tokens[this.pos] || this.tokens[this.tokens.length - 1];
  }

  next(): Token {
    const t = this.peek();
    if (this.pos < this.tokens.length - 1) {
      this.pos++;
    }
    return t;
  }

  is(val: string): boolean {
    return this.peek().value === val;
  }

  match(val: string): boolean {
    if (this.is(val)) {
      this.next();
      return true;
    }
    return false;
  }

  parseDocument() {
    const definitions: any[] = [];
    while (this.peek().type !== 'EOF') {
      if (this.is('fragment')) {
        definitions.push(this.parseFragmentDefinition());
      } else {
        definitions.push(this.parseOperationDefinition());
      }
    }
    return { kind: 'Document', definitions };
  }

  parseOperationDefinition() {
    let operation = 'query';
    let name: string | undefined = undefined;
    let variableDefinitions: any[] = [];

    if (this.peek().type === 'NAME' && (this.peek().value === 'query' || this.peek().value === 'mutation')) {
      operation = this.next().value;
      if (this.peek().type === 'NAME') {
        name = this.next().value;
      }
    }

    if (this.is('(')) {
      variableDefinitions = this.parseVariableDefinitions();
    }

    const selectionSet = this.parseSelectionSet();

    return {
      kind: 'OperationDefinition',
      operation,
      name,
      variableDefinitions,
      selectionSet,
    };
  }

  parseVariableDefinitions() {
    const vars: any[] = [];
    this.next(); // consume '('
    while (!this.is(')') && this.peek().type !== 'EOF') {
      if (this.match('$')) {
        const varName = this.next().value;
        this.match(':');
        const varType = this.parseType();
        let defaultValue: any = undefined;
        if (this.match('=')) {
          defaultValue = this.parseValue();
        }
        vars.push({ name: varName, type: varType, defaultValue });
      } else {
        this.next();
      }
    }
    this.match(')');
    return vars;
  }

  parseType(): string {
    const t = this.next();
    let typeStr = t.value;
    if (this.is('!')) {
      this.next();
      typeStr += '!';
    }
    if (typeStr.startsWith('[') || typeStr.endsWith(']')) {
      // handled
    }
    return typeStr;
  }

  parseSelectionSet() {
    const selections: any[] = [];
    if (this.match('{')) {
      while (!this.is('}') && this.peek().type !== 'EOF') {
        selections.push(this.parseSelection());
      }
      this.match('}');
    }
    return { kind: 'SelectionSet', selections };
  }

  parseSelection() {
    if (this.match('...')) {
      if (this.is('on')) {
        this.next(); // consume 'on'
        const typeCondition = this.next().value;
        const selectionSet = this.parseSelectionSet();
        return {
          kind: 'InlineFragment',
          typeCondition: { kind: 'NamedType', name: typeCondition },
          selectionSet,
        };
      } else {
        const fragName = this.next().value;
        return {
          kind: 'FragmentSpread',
          name: { kind: 'Name', value: fragName },
        };
      }
    }

    let alias: string | undefined = undefined;
    const firstToken = this.next();
    let fieldName = firstToken.value;

    if (this.match(':')) {
      alias = fieldName;
      fieldName = this.next().value;
    }

    let args: any[] = [];
    if (this.is('(')) {
      args = this.parseArguments();
    }

    let selectionSet: any = undefined;
    if (this.is('{')) {
      selectionSet = this.parseSelectionSet();
    }

    return {
      kind: 'Field',
      alias: alias ? { kind: 'Name', value: alias } : undefined,
      name: { kind: 'Name', value: fieldName },
      arguments: args,
      selectionSet,
    };
  }

  parseArguments() {
    const args: any[] = [];
    this.next(); // consume '('
    while (!this.is(')') && this.peek().type !== 'EOF') {
      const argName = this.next().value;
      this.match(':');
      const val = this.parseValue();
      args.push({ name: { kind: 'Name', value: argName }, value: val });
    }
    this.match(')');
    return args;
  }

  parseValue(): any {
    const t = this.peek();
    if (this.match('$')) {
      const varName = this.next().value;
      return { kind: 'Variable', name: { kind: 'Name', value: varName } };
    }
    if (t.type === 'INT') {
      this.next();
      return { kind: 'IntValue', value: parseInt(t.value, 10) };
    }
    if (t.type === 'FLOAT') {
      this.next();
      return { kind: 'FloatValue', value: parseFloat(t.value) };
    }
    if (t.type === 'STRING') {
      this.next();
      return { kind: 'StringValue', value: t.value };
    }
    if (t.type === 'NAME') {
      this.next();
      if (t.value === 'true') return { kind: 'BooleanValue', value: true };
      if (t.value === 'false') return { kind: 'BooleanValue', value: false };
      if (t.value === 'null') return { kind: 'NullValue', value: null };
      return { kind: 'EnumValue', value: t.value };
    }
    if (this.match('[')) {
      const items: any[] = [];
      while (!this.is(']') && this.peek().type !== 'EOF') {
        items.push(this.parseValue());
      }
      this.match(']');
      return { kind: 'ListValue', values: items };
    }
    if (this.match('{')) {
      const fields: any[] = [];
      while (!this.is('}') && this.peek().type !== 'EOF') {
        const k = this.next().value;
        this.match(':');
        const v = this.parseValue();
        fields.push({ name: { kind: 'Name', value: k }, value: v });
      }
      this.match('}');
      return { kind: 'ObjectValue', fields };
    }
    this.next();
    return { kind: 'NullValue', value: null };
  }

  parseFragmentDefinition() {
    this.next(); // consume 'fragment'
    const name = this.next().value;
    this.next(); // consume 'on'
    const typeCondition = this.next().value;
    const selectionSet = this.parseSelectionSet();
    return {
      kind: 'FragmentDefinition',
      name: { kind: 'Name', value: name },
      typeCondition: { kind: 'NamedType', name: typeCondition },
      selectionSet,
    };
  }
}

// Evaluation helpers
function evaluateValue(valNode: any, variables: Record<string, any>): any {
  if (!valNode) return undefined;
  if (valNode.kind === 'Variable') {
    const vName = valNode.name.value;
    return variables[vName];
  }
  if (valNode.kind === 'IntValue' || valNode.kind === 'FloatValue' || valNode.kind === 'StringValue' || valNode.kind === 'BooleanValue' || valNode.kind === 'EnumValue') {
    return valNode.value;
  }
  if (valNode.kind === 'NullValue') {
    return null;
  }
  if (valNode.kind === 'ListValue') {
    return valNode.values.map((v: any) => evaluateValue(v, variables));
  }
  if (valNode.kind === 'ObjectValue') {
    const obj: Record<string, any> = {};
    for (const f of valNode.fields) {
      obj[f.name.value] = evaluateValue(f.value, variables);
    }
    return obj;
  }
  return undefined;
}

// Factory and Handler
export function createGraphQLHandler(deps: { repos: Map<string, Repo>; viewerLogin: string }) {
  const { repos, viewerLogin } = deps;

  function findRepo(owner: string, name: string): Repo | undefined {
    return repos.get(`${owner}/${name}`);
  }

  function findRepoById(idNum: number): Repo | undefined {
    for (const r of repos.values()) {
      if (r.id === idNum) return r;
    }
    return undefined;
  }

  async function executeSelectionSet(
    selectionSet: any,
    object: any,
    typeName: string,
    variables: Record<string, any>,
    errors: any[],
    fragments: Map<string, any>
  ): Promise<any> {
    if (!selectionSet || !selectionSet.selections) return {};
    const result: Record<string, any> = {};

    for (const selection of selectionSet.selections) {
      if (selection.kind === 'FragmentSpread') {
        const fragName = selection.name.value;
        const frag = fragments.get(fragName);
        if (frag) {
          const subRes = await executeSelectionSet(frag.selectionSet, object, frag.typeCondition.name, variables, errors, fragments);
          Object.assign(result, subRes);
        }
        continue;
      }

      if (selection.kind === 'InlineFragment') {
        const condType = selection.typeCondition.name;
        // Check if object matches type condition (or is compatible)
        const matches = condType === typeName || typeName === 'Query' || typeName === 'Mutation' || condType === 'Node';
        if (matches) {
          const subRes = await executeSelectionSet(selection.selectionSet, object, typeName, variables, errors, fragments);
          Object.assign(result, subRes);
        }
        continue;
      }

      if (selection.kind === 'Field') {
        const fieldName = selection.name.value;
        const alias = selection.alias ? selection.alias.value : fieldName;

        if (fieldName === '__typename') {
          result[alias] = typeName;
          continue;
        }

        // Evaluate arguments
        const args: Record<string, any> = {};
        if (selection.arguments) {
          for (const arg of selection.arguments) {
            args[arg.name.value] = evaluateValue(arg.value, variables);
          }
        }

        // Resolve field based on typeName
        let value: any = undefined;
        let nextTypeName = '';
        let resolved = false;

        if (typeName === 'Query') {
          if (fieldName === 'viewer') {
            value = { login: viewerLogin };
            nextTypeName = 'User';
            resolved = true;
          } else if (fieldName === 'repository') {
            const owner = args.owner;
            const name = args.name;
            const repo = findRepo(owner, name);
            value = repo || null;
            nextTypeName = 'Repository';
            resolved = true;
          } else if (fieldName === 'node') {
            const id = args.id;
            const parts = decodeGlobalId(id);
            if (parts.length >= 2) {
              const kind = parts[0];
              if (kind === 'Repository') {
                const repoId = parseInt(parts[1], 10);
                const repo = findRepoById(repoId);
                value = repo || null;
                nextTypeName = 'Repository';
              } else if (kind === 'Issue' && parts.length >= 3) {
                const repoId = parseInt(parts[1], 10);
                const issueNum = parseInt(parts[2], 10);
                const repo = findRepoById(repoId);
                const issue = repo?.issues.get(issueNum);
                value = { issue, repo } || null;
                nextTypeName = 'Issue'; // wait, issue resolver below expects issue object attached with repo info if needed, or we resolve fields directly
              } else if (kind === 'PullRequest' && parts.length >= 3) {
                const repoId = parseInt(parts[1], 10);
                const prNum = parseInt(parts[2], 10);
                const repo = findRepoById(repoId);
                const pr = repo?.prs.get(prNum);
                value = { pr, repo } || null;
                nextTypeName = 'PullRequest';
              }
            } else {
              value = null;
            }
            resolved = true;
          } else if (fieldName === '__schema') {
            value = {};
            nextTypeName = '__Schema';
            resolved = true;
          } else if (fieldName === '__type') {
            value = { name: args.name };
            nextTypeName = '__Type';
            resolved = true;
          }
        } else if (typeName === 'Mutation') {
          if (fieldName === 'createIssue') {
            const input = args.input || {};
            const repoGlobalId = input.repositoryId;
            const parts = decodeGlobalId(repoGlobalId);
            const repoId = parts.length >= 2 ? parseInt(parts[1], 10) : 0;
            const repo = findRepoById(repoId);
            if (!repo) {
              errors.push({ message: 'Repository not found for createIssue' });
              value = null;
            } else {
              const title = input.title;
              const bodyStr = input.body || '';
              const num = repo.nextIssueNumber++;
              const now = new Date().toISOString();
              const issue: Issue = {
                number: num,
                title: typeof title === 'string' ? title : '',
                body: typeof bodyStr === 'string' ? bodyStr : '',
                state: 'open',
                labels: [],
                comments: [],
                createdAt: now,
                updatedAt: now,
              };
              repo.issues.set(num, issue);
              repo.generation++;
              value = { issue };
            }
            nextTypeName = 'CreateIssuePayload';
            resolved = true;
          } else if (fieldName === 'closeIssue') {
            const input = args.input || {};
            const issueGlobalId = input.issueId;
            const parts = decodeGlobalId(issueGlobalId);
            const repoId = parts.length >= 2 ? parseInt(parts[1], 10) : 0;
            const issueNum = parts.length >= 3 ? parseInt(parts[2], 10) : 0;
            const repo = findRepoById(repoId);
            const issue = repo?.issues.get(issueNum);
            if (!issue) {
              errors.push({ message: 'Issue not found for closeIssue' });
              value = null;
            } else {
              issue.state = 'closed';
              issue.updatedAt = new Date().toISOString();
              (issue as any).cachedJsonBuffer = null;
              repo!.generation++;
              value = { issue };
            }
            nextTypeName = 'CloseIssuePayload';
            resolved = true;
          } else if (fieldName === 'createPullRequest') {
            const input = args.input || {};
            const repoGlobalId = input.repositoryId;
            const parts = decodeGlobalId(repoGlobalId);
            const repoId = parts.length >= 2 ? parseInt(parts[1], 10) : 0;
            const repo = findRepoById(repoId);
            if (!repo) {
              errors.push({ message: 'Repository not found for createPullRequest' });
              value = null;
            } else {
              const head = input.headRefName;
              const base = input.baseRefName;
              const headRefKey = head.startsWith('refs/heads/') ? head : `refs/heads/${head}`;
              const baseRefKey = base.startsWith('refs/heads/') ? base : `refs/heads/${base}`;
              const headSha = resolveRef(repo, head) || resolveRef(repo, headRefKey);
              const baseSha = resolveRef(repo, base) || resolveRef(repo, baseRefKey);

              const num = repo.nextPrNumber++;
              const now = new Date().toISOString();
              const pr: Pull = {
                number: num,
                title: input.title || '',
                body: input.body || '',
                state: 'open',
                head: { ref: head, sha: headSha || '' },
                base: { ref: base, sha: baseSha || '' },
                merged: false,
                merged_at: null,
                merge_commit_sha: null,
                createdAt: now,
                updatedAt: now,
              };
              repo.prs.set(num, pr);
              repo.generation++;
              value = { pullRequest: pr, repo };
            }
            nextTypeName = 'CreatePullRequestPayload';
            resolved = true;
          } else if (fieldName === 'mergePullRequest') {
            const input = args.input || {};
            const prGlobalId = input.pullRequestId;
            const parts = decodeGlobalId(prGlobalId);
            const repoId = parts.length >= 2 ? parseInt(parts[1], 10) : 0;
            const prNum = parts.length >= 3 ? parseInt(parts[2], 10) : 0;
            const repo = findRepoById(repoId);
            const pr = repo?.prs.get(prNum);
            if (!repo || !pr) {
              errors.push({ message: 'Pull request not found for mergePullRequest' });
              value = null;
            } else {
              const headTipSha = resolveRef(repo, pr.head.ref) || resolveRef(repo, `refs/heads/${pr.head.ref}`) || pr.head.sha;
              const baseTipSha = resolveRef(repo, pr.base.ref) || resolveRef(repo, `refs/heads/${pr.base.ref}`) || pr.base.sha;
              const mbSha = findMergeBase(repo, headTipSha, baseTipSha);
              if (!mbSha || checkPullConflicts(repo, baseTipSha, headTipSha, mbSha)) {
                errors.push({ message: 'Pull request has merge conflicts.' });
                value = null;
              } else {
                const baseRefKey = pr.base.ref.startsWith('refs/heads/') ? pr.base.ref : `refs/heads/${pr.base.ref}`;
                const mergeRes = squashMergeCommit(repo, baseRefKey, headTipSha, baseTipSha, mbSha, pr.title);
                pr.merged = true;
                pr.state = 'closed';
                pr.merged_at = new Date().toISOString();
                pr.merge_commit_sha = mergeRes.sha;
                pr.updatedAt = pr.merged_at;
                repo.generation++;
                value = { pullRequest: pr, repo };
              }
            }
            nextTypeName = 'MergePullRequestPayload';
            resolved = true;
          } else if (fieldName === 'addComment') {
            const input = args.input || {};
            const subjectId = input.subjectId;
            const commentBody = input.body || '';
            const parts = decodeGlobalId(subjectId);
            const kind = parts[0];
            const repoId = parts.length >= 2 ? parseInt(parts[1], 10) : 0;
            const repo = findRepoById(repoId);
            const num = parts.length >= 3 ? parseInt(parts[2], 10) : 0;

            const newComment: Comment = { id: nextCommentId++, body: commentBody };
            if (kind === 'Issue') {
              const issue = repo?.issues.get(num);
              if (issue) {
                issue.comments.push(newComment);
                (issue as any).cachedJsonBuffer = null;
              }
            } else if (kind === 'PullRequest') {
              const pr = repo?.prs.get(num);
              if (pr) {
                if (!pr.comments) pr.comments = [];
                pr.comments.push(newComment);
              }
            }
            const commentGlobalId = Buffer.from(`IssueComment:${repoId}:${num}:${newComment.id}`, 'utf-8').toString('base64');
            value = { commentEdge: { node: { id: commentGlobalId, body: newComment.body } } };
            nextTypeName = 'AddCommentPayload';
            resolved = true;
          }
        } else if (typeName === 'User') {
          if (fieldName === 'login') {
            value = object.login;
            resolved = true;
          }
        } else if (typeName === 'Repository') {
          const repo = object;
          if (!repo) {
            result[alias] = null;
            continue;
          }
          if (fieldName === 'id') {
            value = encodeGlobalId('Repository', repo.id);
            resolved = true;
          } else if (fieldName === 'databaseId') {
            value = repo.id;
            resolved = true;
          } else if (fieldName === 'name') {
            value = repo.name;
            resolved = true;
          } else if (fieldName === 'nameWithOwner') {
            value = `${repo.owner}/${repo.name}`;
            resolved = true;
          } else if (fieldName === 'owner') {
            value = { login: repo.owner };
            nextTypeName = 'User';
            resolved = true;
          } else if (fieldName === 'defaultBranchRef') {
            value = { name: repo.default_branch };
            nextTypeName = 'Ref';
            resolved = true;
          } else if (fieldName === 'viewerPermission') {
            value = 'ADMIN';
            resolved = true;
          } else if (fieldName === 'hasIssuesEnabled') {
            value = true;
            resolved = true;
          } else if (fieldName === 'issue') {
            const issueNum = args.number;
            value = repo.issues.get(issueNum) || null;
            nextTypeName = 'Issue';
            resolved = true;
          } else if (fieldName === 'issues') {
            let issuesList = [...repo.issues.values()];
            // Filter states
            const states = args.states;
            if (Array.isArray(states) && states.length > 0) {
              issuesList = issuesList.filter(i => states.includes(i.state.toUpperCase()));
            }
            // Order by
            const orderBy = args.orderBy;
            let field = 'NUMBER';
            let direction = 'ASC';
            if (orderBy) {
              field = orderBy.field || orderBy;
              direction = orderBy.direction || 'ASC';
              if (typeof orderBy === 'string') {
                if (orderBy === 'CREATED_AT') field = 'CREATED_AT';
                if (orderBy === 'DESC') direction = 'DESC';
              }
            }
            issuesList.sort((a, b) => {
              let cmp = 0;
              if (field === 'CREATED_AT') {
                cmp = (a.createdAt || '').localeCompare(b.createdAt || '');
                if (cmp === 0) {
                  cmp = a.number - b.number;
                }
              } else {
                cmp = a.number - b.number;
              }
              return direction === 'DESC' ? -cmp : cmp;
            });

            // Pagination
            const first = args.first !== undefined ? args.first : issuesList.length;
            const after = args.after;
            let startIndex = 0;
            if (after) {
              const decodedIdx = parseInt(Buffer.from(after, 'base64').toString('utf-8'), 10);
              if (!isNaN(decodedIdx)) {
                startIndex = decodedIdx + 1;
              }
            }
            const slice = issuesList.slice(startIndex, startIndex + first);
            const edges = slice.map((issue, idx) => {
              const absoluteIdx = startIndex + idx;
              return {
                node: issue,
                cursor: Buffer.from(String(absoluteIdx), 'utf-8').toString('base64'),
              };
            });
            const hasNextPage = startIndex + first < issuesList.length;
            const endCursor = edges.length > 0 ? edges[edges.length - 1].cursor : null;

            value = {
              edges,
              nodes: slice,
              pageInfo: { hasNextPage, endCursor },
              totalCount: issuesList.length,
            };
            nextTypeName = 'IssueConnection';
            resolved = true;
          } else if (fieldName === 'pullRequest') {
            const prNum = args.number;
            const pr = repo.prs.get(prNum);
            value = pr ? { pr, repo } : null;
            nextTypeName = 'PullRequest';
            resolved = true;
          } else if (fieldName === 'pullRequests') {
            let prsList = [...repo.prs.values()];
            const states = args.states;
            if (Array.isArray(states) && states.length > 0) {
              prsList = prsList.filter(p => {
                const st = p.merged ? 'MERGED' : (p.state === 'open' ? 'OPEN' : 'CLOSED');
                return states.includes(st);
              });
            }
            prsList.sort((a, b) => a.number - b.number);

            const first = args.first !== undefined ? args.first : prsList.length;
            const after = args.after;
            let startIndex = 0;
            if (after) {
              const decodedIdx = parseInt(Buffer.from(after, 'base64').toString('utf-8'), 10);
              if (!isNaN(decodedIdx)) {
                startIndex = decodedIdx + 1;
              }
            }
            const slice = prsList.slice(startIndex, startIndex + first);
            const edges = slice.map((pr, idx) => {
              const absoluteIdx = startIndex + idx;
              return {
                node: { pr, repo },
                cursor: Buffer.from(String(absoluteIdx), 'utf-8').toString('base64'),
              };
            });
            const hasNextPage = startIndex + first < prsList.length;
            const endCursor = edges.length > 0 ? edges[edges.length - 1].cursor : null;

            value = {
              edges,
              nodes: slice.map(pr => ({ pr, repo })),
              pageInfo: { hasNextPage, endCursor },
              totalCount: prsList.length,
            };
            nextTypeName = 'PullRequestConnection';
            resolved = true;
          }
        } else if (typeName === 'Issue') {
          const issue = object.issue || object;
          const repo = object.repo; // if passed via node or pull
          if (!issue) {
            result[alias] = null;
            continue;
          }
          if (fieldName === 'id') {
            // Need repo id. If repo not available in object, find repo containing this issue across repos
            let rId = repo?.id;
            if (!rId) {
              for (const r of repos.values()) {
                if (r.issues.has(issue.number)) {
                  rId = r.id;
                  break;
                }
              }
            }
            value = encodeGlobalId('Issue', rId || 1, issue.number);
            resolved = true;
          } else if (fieldName === 'number') {
            value = issue.number;
            resolved = true;
          } else if (fieldName === 'title') {
            value = issue.title;
            resolved = true;
          } else if (fieldName === 'body') {
            value = issue.body;
            resolved = true;
          } else if (fieldName === 'state') {
            value = issue.state === 'open' ? 'OPEN' : 'CLOSED';
            resolved = true;
          } else if (fieldName === 'createdAt') {
            value = issue.createdAt || new Date().toISOString();
            resolved = true;
          } else if (fieldName === 'author') {
            value = { login: viewerLogin };
            nextTypeName = 'User';
            resolved = true;
          }
        } else if (typeName === 'PullRequest') {
          const pr = object.pr || object;
          let repo = object.repo;
          if (!repo) {
            for (const r of repos.values()) {
              if (r.prs.has(pr.number)) {
                repo = r;
                break;
              }
            }
          }
          if (!pr) {
            result[alias] = null;
            continue;
          }
          if (fieldName === 'id') {
            let rId = repo?.id;
            if (!rId) {
              for (const r of repos.values()) {
                if (r.prs.has(pr.number)) {
                  rId = r.id;
                  break;
                }
              }
            }
            value = encodeGlobalId('PullRequest', rId || 1, pr.number);
            resolved = true;
          } else if (fieldName === 'number') {
            value = pr.number;
            resolved = true;
          } else if (fieldName === 'title') {
            value = pr.title;
            resolved = true;
          } else if (fieldName === 'body') {
            value = pr.body;
            resolved = true;
          } else if (fieldName === 'state') {
            value = pr.merged ? 'MERGED' : (pr.state === 'open' ? 'OPEN' : 'CLOSED');
            resolved = true;
          } else if (fieldName === 'merged') {
            value = pr.merged;
            resolved = true;
          } else if (fieldName === 'mergeable') {
            if (!repo) {
              value = 'UNKNOWN';
            } else {
              const headTipSha = resolveRef(repo, pr.head.ref) || resolveRef(repo, `refs/heads/${pr.head.ref}`) || pr.head.sha;
              const baseTipSha = resolveRef(repo, pr.base.ref) || resolveRef(repo, `refs/heads/${pr.base.ref}`) || pr.base.sha;
              const mbSha = findMergeBase(repo, headTipSha, baseTipSha);
              if (!mbSha) {
                value = 'UNKNOWN';
              } else if (checkPullConflicts(repo, baseTipSha, headTipSha, mbSha)) {
                value = 'CONFLICTING';
              } else {
                value = 'MERGEABLE';
              }
            }
            resolved = true;
          } else if (fieldName === 'headRefName') {
            value = pr.head.ref;
            resolved = true;
          } else if (fieldName === 'baseRefName') {
            value = pr.base.ref;
            resolved = true;
          } else if (fieldName === 'files') {
            let filesDiff: any[] = [];
            if (repo) {
              const headTipSha = resolveRef(repo, pr.head.ref) || resolveRef(repo, `refs/heads/${pr.head.ref}`) || pr.head.sha;
              const baseTipSha = resolveRef(repo, pr.base.ref) || resolveRef(repo, `refs/heads/${pr.base.ref}`) || pr.base.sha;
              const rawDiff = getPullFilesDiff(repo, baseTipSha, headTipSha);
              filesDiff = rawDiff.map(d => ({
                path: d.filename,
                additions: d.additions,
                deletions: d.deletions,
                changeType: d.status === 'added' ? 'ADDED' : (d.status === 'removed' ? 'REMOVED' : 'MODIFIED'),
              }));
            }
            value = { nodes: filesDiff };
            nextTypeName = 'PullRequestFilesConnection';
            resolved = true;
          } else if (fieldName === 'author') {
            value = { login: viewerLogin };
            nextTypeName = 'User';
            resolved = true;
          }
        } else if (typeName === 'Ref') {
          if (fieldName === 'name') {
            value = object.name;
            resolved = true;
          }
        } else if (typeName === 'IssueConnection' || typeName === 'PullRequestConnection') {
          if (fieldName === 'edges') {
            value = object.edges;
            nextTypeName = typeName === 'IssueConnection' ? 'IssueEdge' : 'PullRequestEdge';
            resolved = true;
          } else if (fieldName === 'nodes') {
            value = object.nodes;
            nextTypeName = typeName === 'IssueConnection' ? 'Issue' : 'PullRequest';
            resolved = true;
          } else if (fieldName === 'pageInfo') {
            value = object.pageInfo;
            nextTypeName = 'PageInfo';
            resolved = true;
          } else if (fieldName === 'totalCount') {
            value = object.totalCount;
            resolved = true;
          }
        } else if (typeName === 'IssueEdge' || typeName === 'PullRequestEdge') {
          if (fieldName === 'node') {
            value = object.node;
            nextTypeName = typeName === 'IssueEdge' ? 'Issue' : 'PullRequest';
            resolved = true;
          } else if (fieldName === 'cursor') {
            value = object.cursor;
            resolved = true;
          }
        } else if (typeName === 'PageInfo') {
          if (fieldName === 'hasNextPage') {
            value = object.hasNextPage;
            resolved = true;
          } else if (fieldName === 'endCursor') {
            value = object.endCursor;
            resolved = true;
          }
        } else if (typeName === 'PullRequestFilesConnection') {
          if (fieldName === 'nodes') {
            value = object.nodes;
            nextTypeName = 'PullRequestFile';
            resolved = true;
          }
        } else if (typeName === 'PullRequestFile') {
          if (fieldName === 'path') {
            value = object.path;
            resolved = true;
          } else if (fieldName === 'additions') {
            value = object.additions;
            resolved = true;
          } else if (fieldName === 'deletions') {
            value = object.deletions;
            resolved = true;
          } else if (fieldName === 'changeType') {
            value = object.changeType;
            resolved = true;
          }
        } else if (typeName === 'CreateIssuePayload' || typeName === 'CloseIssuePayload') {
          if (fieldName === 'issue') {
            value = object.issue;
            nextTypeName = 'Issue';
            resolved = true;
          }
        } else if (typeName === 'CreatePullRequestPayload' || typeName === 'MergePullRequestPayload') {
          if (fieldName === 'pullRequest') {
            value = object.pullRequest;
            nextTypeName = 'PullRequest';
            resolved = true;
          }
        } else if (typeName === 'AddCommentPayload') {
          if (fieldName === 'commentEdge') {
            value = object.commentEdge;
            nextTypeName = 'CommentEdge';
            resolved = true;
          }
        } else if (typeName === 'CommentEdge') {
          if (fieldName === 'node') {
            value = object.node;
            nextTypeName = 'Comment';
            resolved = true;
          }
        } else if (typeName === 'Comment') {
          if (fieldName === 'id') {
            value = object.id || '';
            resolved = true;
          } else if (fieldName === 'body') {
            value = object.body;
            resolved = true;
          }
        } else if (typeName === '__Schema') {
          if (fieldName === 'types') {
            value = [
              { name: 'Issue' },
              { name: 'PullRequest' },
              { name: 'Repository' },
              { name: 'SearchType' },
              { name: 'User' },
            ];
            nextTypeName = '__Type';
            resolved = true;
          }
        } else if (typeName === '__Type') {
          const tName = object?.name;
          if (fieldName === 'name') {
            value = tName;
            resolved = true;
          } else if (fieldName === 'fields') {
            let fieldNames: string[] = [];
            if (tName === 'Issue') {
              fieldNames = ['id', 'number', 'title', 'state', 'body', 'createdAt'];
            } else if (tName === 'PullRequest') {
              fieldNames = ['id', 'number', 'headRefName', 'baseRefName', 'mergeable', 'state', 'merged', 'files'];
            } else if (tName === 'Repository') {
              fieldNames = ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest'];
            }
            value = fieldNames.map(fn => ({ name: fn }));
            nextTypeName = '__Field';
            resolved = true;
          } else if (fieldName === 'enumValues') {
            let enums: string[] = [];
            if (tName === 'SearchType') {
              enums = ['ISSUE', 'REPOSITORY', 'USER'];
            }
            value = enums.map(e => ({ name: e }));
            nextTypeName = '__EnumValue';
            resolved = true;
          }
        } else if (typeName === '__Field') {
          if (fieldName === 'name') {
            value = object.name;
            resolved = true;
          }
        } else if (typeName === '__EnumValue') {
          if (fieldName === 'name') {
            value = object.name;
            resolved = true;
          }
        }

        if (!resolved) {
          errors.push({
            message: `Cannot query field "${fieldName}" on type "${typeName}".`,
          });
          result[alias] = null;
          continue;
        }

        if (value === null || value === undefined) {
          result[alias] = null;
          continue;
        }

        if (selection.selectionSet) {
          if (Array.isArray(value)) {
            const subResults: any[] = [];
            for (const item of value) {
              subResults.push(await executeSelectionSet(selection.selectionSet, item, nextTypeName, variables, errors, fragments));
            }
            result[alias] = subResults;
          } else {
            result[alias] = await executeSelectionSet(selection.selectionSet, value, nextTypeName, variables, errors, fragments);
          }
        } else {
          result[alias] = value;
        }
      }
    }

    return result;
  }

  async function handleGraphQL(bodyJson: any): Promise<{ status: number; json: unknown }> {
    const isBatch = Array.isArray(bodyJson);
    const requests = isBatch ? bodyJson : [bodyJson];
    const results: any[] = [];

    for (const reqObj of requests) {
      const queryStr = reqObj?.query;
      const variables = reqObj?.variables || {};
      const operationName = reqObj?.operationName;

      if (!queryStr || typeof queryStr !== 'string') {
        results.push({ data: null, errors: [{ message: 'Missing query string' }] });
        continue;
      }

      const tokens = tokenize(queryStr);
      const parser = new Parser(tokens);
      const doc = parser.parseDocument();

      const fragments = new Map<string, any>();
      let targetOp: any = null;

      for (const def of doc.definitions) {
        if (def.kind === 'FragmentDefinition') {
          fragments.set(def.name.value, def);
        } else if (def.kind === 'OperationDefinition') {
          if (!targetOp || (operationName && def.name === operationName)) {
            targetOp = def;
          }
        }
      }

      if (!targetOp) {
        results.push({ data: null, errors: [{ message: 'No operation found' }] });
        continue;
      }

      const errors: any[] = [];
      const rootType = targetOp.operation === 'mutation' ? 'Mutation' : 'Query';
      const data = await executeSelectionSet(targetOp.selectionSet, {}, rootType, variables, errors, fragments);

      const resObj: any = { data };
      if (errors.length > 0) {
        resObj.errors = errors;
      }
      results.push(resObj);
    }

    return {
      status: 200,
      json: isBatch ? results : results[0],
    };
  }

  return { handleGraphQL };
}
