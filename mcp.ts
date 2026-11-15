import { resolveRef, findMergeBase, checkPullConflicts, squashMergeCommit } from './git.ts';

export interface Label {
  name: string;
  color: string;
}

export interface Comment {
  id: number;
  body: string;
}

export interface Issue {
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  comments: Comment[];
  createdAt: string;
  updatedAt: string;
  cachedJsonBuffer: Buffer | null;
}

export interface Pull {
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
}

export interface Repo {
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
  labels: Map<string, Label>;
  generation: number;
  nextIssueNumber: number;
  nextPrNumber: number;
}

export interface McpDeps {
  repos: Map<string, Repo>;
  viewerLogin: string;
}

function formatRepo(repo: Repo) {
  const open_issues_count = Array.from(repo.issues.values()).filter(i => i.state === 'open').length;
  return {
    id: repo.id,
    node_id: 'R_kgD' + repo.id,
    name: repo.name,
    full_name: repo.owner + '/' + repo.name,
    private: repo.private,
    owner: {
      login: repo.owner,
      id: 1000,
      node_id: 'U_kgD1000',
      type: 'User',
      site_admin: false,
    },
    html_url: '/api/v3/repos/' + repo.owner + '/' + repo.name,
    description: repo.description,
    fork: false,
    url: '/api/v3/repos/' + repo.owner + '/' + repo.name,
    created_at: repo.createdAt,
    updated_at: repo.updatedAt,
    default_branch: repo.default_branch,
    open_issues_count,
  };
}

function formatIssue(owner: string, repoName: string, issue: Issue, viewerLogin: string) {
  return {
    id: issue.number,
    node_id: 'I_kgD' + issue.number,
    number: issue.number,
    title: issue.title,
    user: {
      login: viewerLogin,
      id: 1000,
      type: 'User',
    },
    labels: issue.labels.map(name => ({ name, color: '000000' })),
    state: issue.state,
    locked: false,
    comments: issue.comments.length,
    created_at: issue.createdAt,
    updated_at: issue.updatedAt,
    closed_at: issue.state === 'closed' ? issue.updatedAt : null,
    body: issue.body,
    comments_url: '/api/v3/repos/' + owner + '/' + repoName + '/issues/' + issue.number + '/comments',
    html_url: '/api/v3/repos/' + owner + '/' + repoName + '/issues/' + issue.number,
  };
}

function formatPull(owner: string, repoName: string, pr: Pull, viewerLogin: string) {
  const url = '/api/v3/repos/' + owner + '/' + repoName + '/pulls/' + pr.number;
  return {
    url,
    id: pr.number,
    node_id: 'PR_kgD' + pr.number,
    html_url: url,
    diff_url: url + '.diff',
    patch_url: url + '.patch',
    issue_url: '/api/v3/repos/' + owner + '/' + repoName + '/issues/' + pr.number,
    number: pr.number,
    state: pr.state,
    locked: false,
    title: pr.title,
    user: {
      login: viewerLogin,
      id: 1000,
      type: 'User',
    },
    body: pr.body,
    created_at: pr.createdAt,
    updated_at: pr.updatedAt,
    closed_at: pr.state === 'closed' ? pr.updatedAt : null,
    merged_at: pr.merged_at,
    merge_commit_sha: pr.merge_commit_sha,
    head: { ref: pr.head.ref, sha: pr.head.sha },
    base: { ref: pr.base.ref, sha: pr.base.sha },
    merged: pr.merged,
  };
}

const TOOLS = [
  {
    name: 'create_repo',
    description: 'Create a repository',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Repository name' },
        description: { type: 'string', description: 'Repository description' },
        private: { type: 'boolean', description: 'Whether the repository is private' },
      },
      required: ['name'],
    },
  },
  {
    name: 'get_repo',
    description: 'Get a repository',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner' },
        repo: { type: 'string', description: 'Repository name' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_issue',
    description: 'Create an issue',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner' },
        repo: { type: 'string', description: 'Repository name' },
        title: { type: 'string', description: 'Issue title' },
        body: { type: 'string', description: 'Issue body' },
      },
      required: ['owner', 'repo', 'title'],
    },
  },
  {
    name: 'list_issues',
    description: 'List issues in a repository',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner' },
        repo: { type: 'string', description: 'Repository name' },
        state: { type: 'string', description: 'Issue state filter' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_pull_request',
    description: 'Create a pull request',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner' },
        repo: { type: 'string', description: 'Repository name' },
        title: { type: 'string', description: 'Pull request title' },
        head: { type: 'string', description: 'Head branch' },
        base: { type: 'string', description: 'Base branch' },
        body: { type: 'string', description: 'Pull request body' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner' },
        repo: { type: 'string', description: 'Repository name' },
        pull_number: { type: 'integer', description: 'Pull request number' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
  },
];

function normalizeToolName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]/g, '');
}

export function createMcpHandler(deps: McpDeps) {
  return {
    handleMcp(rawBody: string): { status: number; json: unknown | null } {
      let parsed: any;
      try {
        parsed = JSON.parse(rawBody);
      } catch {
        return {
          status: 400,
          json: {
            jsonrpc: '2.0',
            id: null,
            error: { code: -32700, message: 'Parse error' },
          },
        };
      }

      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || typeof parsed.method !== 'string') {
        return {
          status: 200,
          json: {
            jsonrpc: '2.0',
            id: null,
            error: { code: -32600, message: 'Invalid Request' },
          },
        };
      }

      const hasId = 'id' in parsed;
      const id = hasId ? parsed.id : null;

      if (!hasId) {
        // Notification
        return { status: 202, json: null };
      }

      const method = parsed.method;
      const params = parsed.params || {};

      if (method === 'server/discover') {
        return {
          status: 200,
          json: {
            jsonrpc: '2.0',
            id,
            result: {
              resultType: 'discover',
              supportedVersions: ['2026-07-28', '2025-11-25', '2025-06-18'],
              capabilities: { tools: {} },
              serverInfo: { name: 'github-core-clone', version: '1.0.0' },
              instructions: 'GitHub-compatible git forge: git smart HTTP, REST v3, GraphQL v4, MCP.',
              _meta: {
                'io.modelcontextprotocol/serverInfo': { name: 'github-core-clone', version: '1.0.0' },
              },
            },
          },
        };
      }

      if (method === 'initialize') {
        const allowedVersions = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
        const reqVer = params.protocolVersion;
        const protocolVersion = allowedVersions.includes(reqVer) ? reqVer : '2025-11-25';
        return {
          status: 200,
          json: {
            jsonrpc: '2.0',
            id,
            result: {
              protocolVersion,
              capabilities: { tools: {} },
              serverInfo: { name: 'github-core-clone', version: '1.0.0' },
            },
          },
        };
      }

      if (method === 'tools/list') {
        return {
          status: 200,
          json: {
            jsonrpc: '2.0',
            id,
            result: { tools: TOOLS },
          },
        };
      }

      if (method === 'tools/call') {
        const toolName = params.name;
        const args = params.arguments || {};
        if (typeof toolName !== 'string') {
          return {
            status: 200,
            json: {
              jsonrpc: '2.0',
              id,
              error: { code: -32602, message: 'Invalid tool name' },
            },
          };
        }

        const normReq = normalizeToolName(toolName);
        let matchedTool: any = null;
        // Exact normalized match first, then ends with, then requested ends with tool name
        for (const t of TOOLS) {
          if (normalizeToolName(t.name) === normReq) {
            matchedTool = t;
            break;
          }
        }
        if (!matchedTool) {
          for (const t of TOOLS) {
            if (normalizeToolName(t.name).endsWith(normReq)) {
              matchedTool = t;
              break;
            }
          }
        }
        if (!matchedTool) {
          for (const t of TOOLS) {
            if (normReq.endsWith(normalizeToolName(t.name))) {
              matchedTool = t;
              break;
            }
          }
        }

        if (!matchedTool) {
          return {
            status: 200,
            json: {
              jsonrpc: '2.0',
              id,
              error: { code: -32602, message: 'Unknown tool: ' + toolName },
            },
          };
        }

        const tName = matchedTool.name;
        try {
          let toolResult: any;
          let isError = false;
          let errorMessage = '';

          if (tName === 'create_repo') {
            const name = args.name;
            if (!name || typeof name !== 'string') {
              isError = true;
              errorMessage = 'Repository name is required';
            } else {
              const repoKey = deps.viewerLogin + '/' + name;
              if (deps.repos.has(repoKey)) {
                isError = true;
                errorMessage = 'already exists';
              } else {
                let maxId = 0;
                for (const r of deps.repos.values()) {
                  if (r.id > maxId) maxId = r.id;
                }
                const idNum = maxId + 1;
                const now = new Date().toISOString();
                const newRepo: Repo = {
                  owner: deps.viewerLogin,
                  name,
                  id: idNum,
                  private: typeof args.private === 'boolean' ? args.private : false,
                  description: typeof args.description === 'string' ? args.description : '',
                  default_branch: 'main',
                  createdAt: now,
                  updatedAt: now,
                  objects: new Map(),
                  refs: new Map(),
                  issues: new Map(),
                  prs: new Map(),
                  labels: new Map(),
                  generation: 0,
                  nextIssueNumber: 1,
                  nextPrNumber: 1,
                };
                deps.repos.set(repoKey, newRepo);
                toolResult = formatRepo(newRepo);
              }
            }
          } else if (tName === 'get_repo') {
            const owner = args.owner;
            const repoName = args.repo;
            const repoKey = owner + '/' + repoName;
            const repo = deps.repos.get(repoKey);
            if (!repo) {
              isError = true;
              errorMessage = 'repository not found';
            } else {
              toolResult = formatRepo(repo);
            }
          } else if (tName === 'create_issue') {
            const owner = args.owner;
            const repoName = args.repo;
            const title = args.title;
            const repoKey = owner + '/' + repoName;
            const repo = deps.repos.get(repoKey);
            if (!repo) {
              isError = true;
              errorMessage = 'repository not found';
            } else if (!title || typeof title !== 'string' || !title.trim()) {
              isError = true;
              errorMessage = 'title required';
            } else {
              const number = repo.nextIssueNumber++;
              const now = new Date().toISOString();
              const issue: Issue = {
                number,
                title: title.trim(),
                body: typeof args.body === 'string' ? args.body : '',
                state: 'open',
                labels: [],
                comments: [],
                createdAt: now,
                updatedAt: now,
                cachedJsonBuffer: null,
              };
              repo.issues.set(number, issue);
              repo.generation++;
              toolResult = formatIssue(owner, repoName, issue, deps.viewerLogin);
            }
          } else if (tName === 'list_issues') {
            const owner = args.owner;
            const repoName = args.repo;
            const repoKey = owner + '/' + repoName;
            const repo = deps.repos.get(repoKey);
            if (!repo) {
              isError = true;
              errorMessage = 'repository not found';
            } else {
              const stateArg = args.state;
              const issuesArr = Array.from(repo.issues.values()).filter(i => {
                if (stateArg === 'all') return true;
                if (stateArg === 'closed') return i.state === 'closed';
                return i.state === 'open';
              });
              issuesArr.sort((a, b) => {
                if (b.createdAt !== a.createdAt) {
                  return b.createdAt.localeCompare(a.createdAt);
                }
                return b.number - a.number;
              });
              toolResult = issuesArr.map(i => formatIssue(owner, repoName, i, deps.viewerLogin));
            }
          } else if (tName === 'create_pull_request') {
            const owner = args.owner;
            const repoName = args.repo;
            const title = args.title;
            const head = args.head;
            const base = args.base;
            const repoKey = owner + '/' + repoName;
            const repo = deps.repos.get(repoKey);
            if (!repo) {
              isError = true;
              errorMessage = 'repository not found';
            } else if (!title || !head || !base || typeof title !== 'string' || typeof head !== 'string' || typeof base !== 'string') {
              isError = true;
              errorMessage = 'title, head, and base required';
            } else {
              const headSha = resolveRef(repo, head) || resolveRef(repo, 'refs/heads/' + head);
              const baseSha = resolveRef(repo, base) || resolveRef(repo, 'refs/heads/' + base);
              if (!headSha || !baseSha) {
                isError = true;
                errorMessage = 'head or base branch does not exist';
              } else {
                let existingPrConflict = false;
                for (const pr of repo.prs.values()) {
                  if (pr.state === 'open' && pr.head.ref === head && pr.base.ref === base) {
                    existingPrConflict = true;
                    break;
                  }
                }
                if (existingPrConflict) {
                  isError = true;
                  errorMessage = 'A pull request already exists for these branches.';
                } else {
                  const number = repo.nextPrNumber++;
                  const now = new Date().toISOString();
                  const pr: Pull = {
                    number,
                    title: title.trim(),
                    body: typeof args.body === 'string' ? args.body : '',
                    state: 'open',
                    head: { ref: head, sha: headSha },
                    base: { ref: base, sha: baseSha },
                    merged: false,
                    merged_at: null,
                    merge_commit_sha: null,
                    createdAt: now,
                    updatedAt: now,
                  };
                  repo.prs.set(number, pr);
                  repo.generation++;
                  toolResult = formatPull(owner, repoName, pr, deps.viewerLogin);
                }
              }
            }
          } else if (tName === 'merge_pull_request') {
            const owner = args.owner;
            const repoName = args.repo;
            const pullNumRaw = args.pull_number;
            const repoKey = owner + '/' + repoName;
            const repo = deps.repos.get(repoKey);
            if (!repo) {
              isError = true;
              errorMessage = 'repository not found';
            } else {
              let pullNumber: number;
              if (typeof pullNumRaw === 'number') {
                pullNumber = pullNumRaw;
              } else if (typeof pullNumRaw === 'string' && /^\d+$/.test(pullNumRaw)) {
                pullNumber = parseInt(pullNumRaw, 10);
              } else {
                pullNumber = NaN;
              }

              if (isNaN(pullNumber)) {
                isError = true;
                errorMessage = 'Invalid pull number';
              } else {
                const pr = repo.prs.get(pullNumber);
                if (!pr) {
                  isError = true;
                  errorMessage = 'pull request not found';
                } else {
                  const headTipSha = resolveRef(repo, pr.head.ref) || resolveRef(repo, 'refs/heads/' + pr.head.ref) || pr.head.sha;
                  const baseTipSha = resolveRef(repo, pr.base.ref) || resolveRef(repo, 'refs/heads/' + pr.base.ref) || pr.base.sha;
                  const mergeBaseSha = findMergeBase(repo, headTipSha, baseTipSha);
                  if (!mergeBaseSha || checkPullConflicts(repo, baseTipSha, headTipSha, mergeBaseSha)) {
                    isError = true;
                    errorMessage = 'Pull request is conflicted';
                  } else {
                    const baseRefKey = pr.base.ref.startsWith('refs/heads/') ? pr.base.ref : 'refs/heads/' + pr.base.ref;
                    const mergeRes = squashMergeCommit(repo, baseRefKey, headTipSha, baseTipSha, mergeBaseSha, pr.title);
                    const now = new Date().toISOString();
                    pr.merged = true;
                    pr.state = 'closed';
                    pr.merged_at = now;
                    pr.merge_commit_sha = mergeRes.sha;
                    pr.updatedAt = now;
                    repo.generation++;
                    toolResult = formatPull(owner, repoName, pr, deps.viewerLogin);
                  }
                }
              }
            }
          }

          if (isError) {
            return {
              status: 200,
              json: {
                jsonrpc: '2.0',
                id,
                result: {
                  content: [{ type: 'text', text: errorMessage }],
                  isError: true,
                },
              },
            };
          }

          return {
            status: 200,
            json: {
              jsonrpc: '2.0',
              id,
              result: {
                content: [{ type: 'text', text: JSON.stringify(toolResult) }],
                structuredContent: toolResult,
                isError: false,
              },
            },
          };
        } catch (err: any) {
          return {
            status: 200,
            json: {
              jsonrpc: '2.0',
              id,
              result: {
                content: [{ type: 'text', text: err.message || 'Internal tool error' }],
                isError: true,
              },
            },
          };
        }
      }

      return {
        status: 200,
        json: {
          jsonrpc: '2.0',
          id,
          error: { code: -32601, message: 'Method not found: ' + method },
        },
      };
    },
  };
}
