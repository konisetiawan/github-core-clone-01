import http, { IncomingMessage, ServerResponse } from 'node:http';
import {
  commitFile,
  deleteFile,
  readFileAtRef,
  handleInfoRefs,
  handleLsRefs,
  handleFetch,
  handleReceivePack,
  decodePktLines,
  resolveRef,
  parseCommit,
  findMergeBase,
  getPullFilesDiff,
  checkPullConflicts,
  squashMergeCommit,
} from './git.ts';
import { createGraphQLHandler } from './graphql.ts';
import { createMcpHandler } from './mcp.ts';

const VIEWER_LOGIN = 'adaiversen';

interface Label {
  name: string;
  color: string;
}

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
  cachedJsonBuffer: Buffer | null;
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
  labels: Map<string, Label>;
  generation: number;
  nextIssueNumber: number;
  nextPrNumber: number;
}

const repos = new Map<string, Repo>();
let requestIdCounter = 1;
let nextCommentId = 1;

function sendJson(res: ServerResponse, status: number, data: any, headers?: Record<string, string>) {
  const requestId = `req-${requestIdCounter++}`;
  const jsonStr = data === undefined || data === null ? '' : JSON.stringify(data);
  const bodyBuf = Buffer.from(jsonStr, 'utf-8');

  const h: Record<string, string> = {
    'Content-Type': 'application/json; charset=utf-8',
    'X-GitHub-Request-Id': requestId,
    'Content-Length': String(bodyBuf.length),
    ...(headers || {}),
  };

  res.writeHead(status, h);
  res.end(bodyBuf);
}

function sendEmpty(res: ServerResponse, status: number, headers?: Record<string, string>) {
  const requestId = `req-${requestIdCounter++}`;
  const h: Record<string, string> = {
    'Content-Type': 'application/json; charset=utf-8',
    'X-GitHub-Request-Id': requestId,
    'Content-Length': '0',
    ...(headers || {}),
  };
  res.writeHead(status, h);
  res.end();
}

function formatRepo(repo: Repo) {
  let open_issues_count = 0;
  for (const issue of repo.issues.values()) {
    if (issue.state === 'open') open_issues_count++;
  }
  return {
    id: repo.id,
    node_id: `R_kgD${repo.id}`,
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    private: repo.private,
    owner: {
      login: repo.owner,
      id: 1000,
      node_id: 'U_kgD1000',
      type: 'User',
      site_admin: false,
    },
    html_url: `/api/v3/repos/${repo.owner}/${repo.name}`,
    description: repo.description,
    fork: false,
    url: `/api/v3/repos/${repo.owner}/${repo.name}`,
    created_at: repo.createdAt,
    updated_at: repo.updatedAt,
    default_branch: repo.default_branch,
    open_issues_count,
  };
}

function formatIssue(owner: string, repoName: string, issue: Issue) {
  return {
    id: issue.number,
    node_id: `I_kgD${issue.number}`,
    number: issue.number,
    title: issue.title,
    user: {
      login: VIEWER_LOGIN,
      id: 1000,
      type: 'User',
    },
    labels: issue.labels.map(l => ({ name: l, color: '000000' })),
    state: issue.state,
    locked: false,
    comments: issue.comments.length,
    created_at: issue.createdAt,
    updated_at: issue.updatedAt,
    closed_at: issue.state === 'closed' ? issue.updatedAt : null,
    body: issue.body,
    comments_url: `/api/v3/repos/${owner}/${repoName}/issues/${issue.number}/comments`,
    html_url: `/api/v3/repos/${owner}/${repoName}/issues/${issue.number}`,
  };
}

function formatPull(owner: string, repoName: string, pr: Pull) {
  return {
    url: `/api/v3/repos/${owner}/${repoName}/pulls/${pr.number}`,
    id: pr.number,
    node_id: `PR_kgD${pr.number}`,
    html_url: `/api/v3/repos/${owner}/${repoName}/pulls/${pr.number}`,
    diff_url: `/api/v3/repos/${owner}/${repoName}/pulls/${pr.number}.diff`,
    patch_url: `/api/v3/repos/${owner}/${repoName}/pulls/${pr.number}.patch`,
    issue_url: `/api/v3/repos/${owner}/${repoName}/issues/${pr.number}`,
    number: pr.number,
    state: pr.state,
    locked: false,
    title: pr.title,
    user: {
      login: VIEWER_LOGIN,
      id: 1000,
      type: 'User',
    },
    body: pr.body,
    created_at: pr.createdAt,
    updated_at: pr.updatedAt,
    closed_at: pr.state === 'closed' ? pr.updatedAt : null,
    merged_at: pr.merged_at,
    merge_commit_sha: pr.merge_commit_sha,
    head: pr.head,
    base: pr.base,
    merged: pr.merged,
  };
}

async function readBody(req: IncomingMessage): Promise<any> {
  return new Promise((resolve, reject) => {
    let chunks: Buffer[] = [];
    let totalLength = 0;
    const MAX_SIZE = 10 * 1024 * 1024; // 10 MB

    req.on('data', (chunk: Buffer) => {
      totalLength += chunk.length;
      if (totalLength > MAX_SIZE) {
        req.destroy();
        reject(new Error('PAYLOAD_TOO_LARGE'));
        return;
      }
      chunks.push(chunk);
    });

    req.on('end', () => {
      if (chunks.length === 0) {
        resolve({});
        return;
      }
      const full = Buffer.concat(chunks).toString('utf-8');
      if (!full.trim()) {
        resolve({});
        return;
      }
      try {
        const parsed = JSON.parse(full);
        resolve(parsed);
      } catch (e) {
        reject(new Error('INVALID_JSON'));
      }
    });

    req.on('error', (err) => {
      reject(err);
    });
  });
}

async function readRawBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    let chunks: Buffer[] = [];
    let totalLength = 0;
    const MAX_SIZE = 50 * 1024 * 1024; // 50 MB for git packs

    req.on('data', (chunk: Buffer) => {
      totalLength += chunk.length;
      if (totalLength > MAX_SIZE) {
        req.destroy();
        reject(new Error('PAYLOAD_TOO_LARGE'));
        return;
      }
      chunks.push(chunk);
    });

    req.on('end', () => {
      resolve(Buffer.concat(chunks));
    });

    req.on('error', (err) => {
      reject(err);
    });
  });
}

const graphqlHandler = createGraphQLHandler({ repos, viewerLogin: VIEWER_LOGIN });
const mcpHandler = createMcpHandler({ repos, viewerLogin: VIEWER_LOGIN });

export function createApp(): http.Server {
  const expectedToken = process.env.MAKEFUN_SHOP_TOKEN;

  const server = http.createServer(async (req: IncomingMessage, res: ServerResponse) => {
    try {
      const urlObj = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
      const rawPath = urlObj.pathname;
      let pathname = rawPath;
      try {
        pathname = decodeURIComponent(rawPath);
      } catch (e) {
        // ignore decoding errors
      }

      // Check healthz (no auth)
      if (pathname === '/healthz' && req.method === 'GET') {
        sendJson(res, 200, { ok: true });
        return;
      }

      // Check Auth for all other routes
      const authHeader = req.headers['authorization'];
      if (expectedToken && expectedToken.trim() !== '') {
        if (!authHeader || authHeader !== `Bearer ${expectedToken}`) {
          sendJson(res, 401, { message: 'Unauthorized' });
          return;
        }
      } else {
        if (!authHeader || !authHeader.startsWith('Bearer ')) {
          sendJson(res, 401, { message: 'Unauthorized' });
          return;
        }
      }

      const method = req.method || 'GET';
      const host = req.headers.host || 'localhost';
      const protocol = 'http';

      if (pathname === '/api/graphql' && method === 'POST') {
        let body: any;
        try {
          body = await readBody(req);
        } catch (err: any) {
          if (err.message === 'PAYLOAD_TOO_LARGE') {
            sendJson(res, 413, { message: 'Payload Too Large' });
            return;
          }
          sendJson(res, 400, { message: 'Bad Request' });
          return;
        }
        const resObj = await graphqlHandler.handleGraphQL(body);
        sendJson(res, resObj.status, resObj.json);
        return;
      }

      if (pathname === '/mcp' && method === 'POST') {
        let raw: Buffer;
        try {
          raw = await readRawBody(req);
        } catch (err: any) {
          sendJson(res, 500, { message: 'Internal Server Error' });
          return;
        }
        const resObj = mcpHandler.handleMcp(raw.toString('utf-8'));
        if (resObj.json === null) {
          sendEmpty(res, resObj.status);
        } else {
          sendJson(res, resObj.status, resObj.json);
        }
        return;
      }

      // Git Smart-HTTP routes: /{owner}/{repo}.git/...
      if (pathname.includes('.git/')) {
        const gitIndex = pathname.indexOf('.git/');
        const repoPathPart = pathname.slice(0, gitIndex);
        const subGit = pathname.slice(gitIndex + 5);
        const parts = repoPathPart.split('/').filter(Boolean);
        if (parts.length >= 2) {
          const owner = parts[parts.length - 2];
          const repoName = parts[parts.length - 1];
          const repoKey = `${owner}/${repoName}`;
          const repo = repos.get(repoKey);

          if (!repo) {
            sendJson(res, 404, { message: 'Not Found' });
            return;
          }

          if (subGit === 'info/refs' && method === 'GET') {
            const service = urlObj.searchParams.get('service') || '';
            const protoHeader = req.headers['git-protocol'] || '';
            const isProtoV2 = typeof protoHeader === 'string' && protoHeader.includes('version=2');
            const hRes = handleInfoRefs(repo, service, isProtoV2, Buffer.alloc(0));
            const requestId = `req-${requestIdCounter++}`;
            res.writeHead(hRes.status, {
              'Content-Type': hRes.contentType,
              'X-GitHub-Request-Id': requestId,
              'Content-Length': String(hRes.body.length),
            });
            res.end(hRes.body);
            return;
          }

          if (subGit === 'git-upload-pack' && method === 'POST') {
            const raw = await readRawBody(req);
            const { packets } = decodePktLines(raw);
            let isFetch = false;
            let isLsRefs = false;
            for (const pkt of packets) {
              if (pkt.type === 'data' && pkt.data) {
                const line = pkt.data.toString('utf-8').trim();
                if (line.startsWith('command=fetch')) isFetch = true;
                if (line.startsWith('command=ls-refs')) isLsRefs = true;
              }
            }

            let hRes: { status: number; contentType: string; body: Buffer };
            if (isLsRefs) {
              hRes = handleLsRefs(repo, raw);
            } else if (isFetch) {
              hRes = handleFetch(repo, raw);
            } else {
              sendJson(res, 400, { message: 'Bad Request' });
              return;
            }

            const requestId = `req-${requestIdCounter++}`;
            res.writeHead(hRes.status, {
              'Content-Type': hRes.contentType,
              'X-GitHub-Request-Id': requestId,
              'Content-Length': String(hRes.body.length),
            });
            res.end(hRes.body);
            return;
          }

          if (subGit === 'git-receive-pack' && method === 'POST') {
            const raw = await readRawBody(req);
            const hRes = handleReceivePack(repo, raw);
            const requestId = `req-${requestIdCounter++}`;
            res.writeHead(hRes.status, {
              'Content-Type': hRes.contentType,
              'X-GitHub-Request-Id': requestId,
              'Content-Length': String(hRes.body.length),
            });
            res.end(hRes.body);
            return;
          }
        }
      }

      // Route matching
      if (pathname === '/api/v3' || pathname === '/api/v3/') {
        if (method === 'GET') {
          sendJson(res, 200, {
            current_user_url: '/api/v3/user',
            rate_limit_url: '/api/v3/rate_limit',
          }, {
            'X-OAuth-Scopes': 'repo, read:org',
          });
          return;
        }
      }

      if (pathname === '/api/v3/meta' && method === 'GET') {
        sendJson(res, 200, { installed_version: '1.0.0' });
        return;
      }

      if (pathname === '/api/v3/user' && method === 'GET') {
        sendJson(res, 200, {
          login: VIEWER_LOGIN,
          id: 1000,
          node_id: 'U_kgD1000',
          type: 'User',
          name: 'Ada Iversen',
          email: 'ada@example.com',
        });
        return;
      }

      if (pathname === '/api/v3/user/repos') {
        if (method === 'GET') {
          const page = Math.max(1, parseInt(urlObj.searchParams.get('page') || '1', 10) || 1);
          const per_page = Math.min(100, Math.max(1, parseInt(urlObj.searchParams.get('per_page') || '30', 10) || 30));

          const userRepos: Repo[] = [];
          for (const r of repos.values()) {
            if (r.owner === VIEWER_LOGIN) {
              userRepos.push(r);
            }
          }
          userRepos.sort((a, b) => a.id - b.id);

          const start = (page - 1) * per_page;
          const slice = userRepos.slice(start, start + per_page);
          const formatted = slice.map(formatRepo);

          const baseUrl = `${protocol}://${host}/api/v3/user/repos`;
          let linkParts: string[] = [];
          if (start + per_page < userRepos.length) {
            linkParts.push(`<${baseUrl}?page=${page + 1}&per_page=${per_page}>; rel="next"`);
          }
          if (page > 1) {
            linkParts.push(`<${baseUrl}?page=${page - 1}&per_page=${per_page}>; rel="prev"`);
          }
          const headers: Record<string, string> = {};
          if (linkParts.length > 0) {
            headers['Link'] = linkParts.join(', ');
          }

          sendJson(res, 200, formatted, headers);
          return;
        }

        if (method === 'POST') {
          let body: any;
          try {
            body = await readBody(req);
          } catch (err: any) {
            if (err.message === 'PAYLOAD_TOO_LARGE') {
              sendJson(res, 413, { message: 'Payload Too Large' });
              return;
            }
            sendJson(res, 400, { message: 'Bad Request' });
            return;
          }

          const name = body?.name;
          if (!name || typeof name !== 'string' || !name.trim()) {
            sendJson(res, 422, { message: 'Validation Failed' });
            return;
          }

          const trimmedName = name.trim();
          const key = `${VIEWER_LOGIN}/${trimmedName}`;
          if (repos.has(key)) {
            sendJson(res, 422, { message: 'already exists' });
            return;
          }

          let nextRepoId = repos.size + 1;
          for (const r of repos.values()) {
            if (r.id >= nextRepoId) nextRepoId = r.id + 1;
          }

          const now = new Date().toISOString();
          const newRepo: Repo = {
            owner: VIEWER_LOGIN,
            name: trimmedName,
            id: nextRepoId,
            private: !!body.private,
            description: typeof body.description === 'string' ? body.description : '',
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
          repos.set(key, newRepo);

          sendJson(res, 201, formatRepo(newRepo));
          return;
        }
      }

      // /api/v3/repos/{owner}/{repo} and subpaths
      const repoPrefix = '/api/v3/repos/';
      if (pathname.startsWith(repoPrefix)) {
        const sub = pathname.slice(repoPrefix.length);
        const parts = sub.split('/');
        const owner = parts[0];
        const repoName = parts[1];

        if (owner && repoName) {
          const repoKey = `${owner}/${repoName}`;
          const repo = repos.get(repoKey);

          if (!repo) {
            sendJson(res, 404, { message: 'Not Found' });
            return;
          }

          const rest = parts.slice(2).join('/');

          // GET /api/v3/repos/{owner}/{repo}
          if (rest === '' && method === 'GET') {
            sendJson(res, 200, formatRepo(repo));
            return;
          }

          // PATCH /api/v3/repos/{owner}/{repo}
          if (rest === '' && method === 'PATCH') {
            let body: any;
            try {
              body = await readBody(req);
            } catch (err: any) {
              if (err.message === 'PAYLOAD_TOO_LARGE') {
                sendJson(res, 413, { message: 'Payload Too Large' });
                return;
              }
              sendJson(res, 400, { message: 'Bad Request' });
              return;
            }

            if (body && typeof body.description === 'string') {
              repo.description = body.description;
            }
            repo.updatedAt = new Date().toISOString();
            repo.generation++;

            sendJson(res, 200, formatRepo(repo));
            return;
          }

          // DELETE /api/v3/repos/{owner}/{repo}
          if (rest === '' && method === 'DELETE') {
            repos.delete(repoKey);
            sendEmpty(res, 204);
            return;
          }

          // GIT REFS: POST /api/v3/repos/{owner}/{repo}/git/refs
          if (rest === 'git/refs' && method === 'POST') {
            let body: any;
            try {
              body = await readBody(req);
            } catch (e) {
              sendJson(res, 400, { message: 'Bad Request' });
              return;
            }

            const ref = body?.ref;
            const sha = body?.sha;
            if (!ref || typeof ref !== 'string' || !ref.startsWith('refs/heads/')) {
              sendJson(res, 422, { message: 'Validation Failed: invalid ref' });
              return;
            }
            const branchName = ref.slice('refs/heads/'.length);
            if (!branchName.trim()) {
              sendJson(res, 422, { message: 'Validation Failed: empty branch name' });
              return;
            }
            if (!sha || typeof sha !== 'string' || sha.length !== 40 || !repo.objects.has(sha)) {
              sendJson(res, 422, { message: 'Validation Failed: invalid or missing sha' });
              return;
            }
            if (repo.refs.has(ref)) {
              sendJson(res, 422, { message: 'Reference already exists' });
              return;
            }

            repo.refs.set(ref, sha);
            repo.generation++;
            sendJson(res, 201, {
              ref,
              object: { sha },
            });
            return;
          }

          // BRANCHES: GET /api/v3/repos/{owner}/{repo}/branches
          if (rest === 'branches' && method === 'GET') {
            const branches: Array<{ name: string; commit: { sha: string } }> = [];
            // Ensure default branch is included even if refs entry is missing or stored differently
            const defaultBranch = repo.default_branch || 'main';
            const defaultRefKey = `refs/heads/${defaultBranch}`;
            const defaultTip = resolveRef(repo, defaultRefKey) || resolveRef(repo, defaultBranch);
            if (defaultTip && !repo.refs.has(defaultRefKey)) {
              repo.refs.set(defaultRefKey, defaultTip);
            }

            for (const [refName, sha] of repo.refs.entries()) {
              if (refName.startsWith('refs/heads/')) {
                const name = refName.slice('refs/heads/'.length);
                if (!branches.some(b => b.name === name)) {
                  branches.push({ name, commit: { sha } });
                }
              }
            }
            branches.sort((a, b) => a.name.localeCompare(b.name));
            sendJson(res, 200, branches);
            return;
          }

          // COMMITS: GET /api/v3/repos/{owner}/{repo}/commits
          if (rest === 'commits' && method === 'GET') {
            const refParam = urlObj.searchParams.get('sha') || repo.default_branch || 'main';
            const commitId = resolveRef(repo, refParam);
            if (!commitId || !repo.objects.has(commitId)) {
              sendJson(res, 404, { message: 'Commit not found' });
              return;
            }

            const commits: Array<{ sha: string; commit: { message: string } }> = [];
            let currentId: string | undefined = commitId;
            const visited = new Set<string>();

            while (currentId && commits.length < 200) {
              if (visited.has(currentId)) break;
              visited.add(currentId);

              const obj = repo.objects.get(currentId);
              if (!obj || obj.type !== 'commit') break;

              const commitData = parseCommit(obj.data);
              commits.push({
                sha: currentId,
                commit: {
                  message: commitData.message,
                },
              });

              // First-parent walk: follow parents[0] only
              currentId = commitData.parents.length > 0 ? commitData.parents[0] : undefined;
            }

            sendJson(res, 200, commits);
            return;
          }

          // PULL REQUESTS: /api/v3/repos/{owner}/{repo}/pulls
          if (rest === 'pulls') {
            if (method === 'GET') {
              const stateParam = urlObj.searchParams.get('state') || 'open';
              const page = Math.max(1, parseInt(urlObj.searchParams.get('page') || '1', 10) || 1);
              const per_page = Math.min(100, Math.max(1, parseInt(urlObj.searchParams.get('per_page') || '30', 10) || 30));

              let list: Pull[] = [];
              for (const pr of repo.prs.values()) {
                if (stateParam === 'all' || pr.state === stateParam || (stateParam === 'closed' && (pr.state === 'closed' || pr.merged))) {
                  list.push(pr);
                }
              }

              list.sort((a, b) => a.number - b.number);

              const start = (page - 1) * per_page;
              const slice = list.slice(start, start + per_page);
              const formatted = slice.map(p => formatPull(owner, repoName, p));

              const baseUrl = `${protocol}://${host}/api/v3/repos/${owner}/${repoName}/pulls`;
              let linkParts: string[] = [];
              if (start + per_page < list.length) {
                linkParts.push(`<${baseUrl}?page=${page + 1}&per_page=${per_page}&state=${stateParam}>; rel="next"`);
              }
              if (page > 1) {
                linkParts.push(`<${baseUrl}?page=${page - 1}&per_page=${per_page}&state=${stateParam}>; rel="prev"`);
              }
              const headers: Record<string, string> = {};
              if (linkParts.length > 0) {
                headers['Link'] = linkParts.join(', ');
              }

              sendJson(res, 200, formatted, headers);
              return;
            }

            if (method === 'POST') {
              let body: any;
              try {
                body = await readBody(req);
              } catch (e) {
                sendJson(res, 400, { message: 'Bad Request' });
                return;
              }

              const title = body?.title;
              const head = body?.head;
              const base = body?.base;

              if (!title || typeof title !== 'string' || !title.trim()) {
                sendJson(res, 422, { message: 'Validation Failed: title required' });
                return;
              }
              if (!head || typeof head !== 'string') {
                sendJson(res, 422, { message: 'Validation Failed: head branch required' });
                return;
              }
              if (!base || typeof base !== 'string') {
                sendJson(res, 422, { message: 'Validation Failed: base branch required' });
                return;
              }

              const headRefKey = head.startsWith('refs/heads/') ? head : `refs/heads/${head}`;
              const baseRefKey = base.startsWith('refs/heads/') ? base : `refs/heads/${base}`;

              const headSha = resolveRef(repo, head) || resolveRef(repo, headRefKey);
              const baseSha = resolveRef(repo, base) || resolveRef(repo, baseRefKey);

              if (!headSha || !baseSha) {
                sendJson(res, 422, { message: 'Validation Failed: head or base branch does not exist' });
                return;
              }

              // Check if open PR already exists from same head to same base
              for (const existingPr of repo.prs.values()) {
                if (existingPr.state === 'open' && existingPr.head.ref === head && existingPr.base.ref === base) {
                  sendJson(res, 422, { message: 'A pull request already exists for these branches.' });
                  return;
                }
              }

              const num = repo.nextPrNumber++;
              const now = new Date().toISOString();
              const pr: Pull = {
                number: num,
                title: title.trim(),
                body: typeof body.body === 'string' ? body.body : '',
                state: 'open',
                head: { ref: head, sha: headSha },
                base: { ref: base, sha: baseSha },
                merged: false,
                merged_at: null,
                merge_commit_sha: null,
                createdAt: now,
                updatedAt: now,
              };

              repo.prs.set(num, pr);
              repo.generation++;

              sendJson(res, 201, formatPull(owner, repoName, pr));
              return;
            }
          }

          // SINGLE PULL REQUEST SUBPATHS: pulls/{n} or pulls/{n}/...
          const pullsPrefix = 'pulls/';
          if (rest.startsWith(pullsPrefix)) {
            const prRest = rest.slice(pullsPrefix.length);
            const prParts = prRest.split('/');
            const numStr = prParts[0];
            const prNum = parseInt(numStr, 10);

            if (!isNaN(prNum)) {
              const pr = repo.prs.get(prNum);
              if (!pr) {
                sendJson(res, 404, { message: 'Not Found' });
                return;
              }

              const prSub = prParts.slice(1).join('/');

              // GET /api/v3/repos/{owner}/{repo}/pulls/{n}
              if (prSub === '' && method === 'GET') {
                sendJson(res, 200, formatPull(owner, repoName, pr));
                return;
              }

              // GET /api/v3/repos/{owner}/{repo}/pulls/{n}/files
              if (prSub === 'files' && method === 'GET') {
                const headTipSha = resolveRef(repo, pr.head.ref) || resolveRef(repo, `refs/heads/${pr.head.ref}`) || pr.head.sha;
                const baseTipSha = resolveRef(repo, pr.base.ref) || resolveRef(repo, `refs/heads/${pr.base.ref}`) || pr.base.sha;
                const filesDiff = getPullFilesDiff(repo, baseTipSha, headTipSha);
                sendJson(res, 200, filesDiff);
                return;
              }

              // PUT /api/v3/repos/{owner}/{repo}/pulls/{n}/merge
              if (prSub === 'merge' && method === 'PUT') {
                let body: any;
                try {
                  body = await readBody(req);
                } catch (e) {
                  body = {};
                }

                const mergeMethod = body?.merge_method || 'squash';
                if (mergeMethod !== 'squash') {
                  sendJson(res, 422, { message: 'Unsupported merge method' });
                  return;
                }

                const headTipSha = resolveRef(repo, pr.head.ref) || resolveRef(repo, `refs/heads/${pr.head.ref}`) || pr.head.sha;
                const baseTipSha = resolveRef(repo, pr.base.ref) || resolveRef(repo, `refs/heads/${pr.base.ref}`) || pr.base.sha;

                const mbSha = findMergeBase(repo, headTipSha, baseTipSha);
                if (!mbSha || checkPullConflicts(repo, baseTipSha, headTipSha, mbSha)) {
                  sendJson(res, 405, { message: 'Pull request is conflicted' });
                  return;
                }

                const baseRefKey = pr.base.ref.startsWith('refs/heads/') ? pr.base.ref : `refs/heads/${pr.base.ref}`;
                const mergeRes = squashMergeCommit(repo, baseRefKey, headTipSha, baseTipSha, mbSha, pr.title);

                pr.merged = true;
                pr.state = 'closed';
                pr.merged_at = new Date().toISOString();
                pr.merge_commit_sha = mergeRes.sha;
                pr.updatedAt = pr.merged_at;
                repo.generation++;

                sendJson(res, 200, {
                  merged: true,
                  sha: mergeRes.sha,
                  message: 'Pull request successfully merged',
                });
                return;
              }
            }
          }

          // CONTENTS: /api/v3/repos/{owner}/{repo}/contents/{path}
          const contentsPrefix = 'contents/';
          if (rest.startsWith(contentsPrefix)) {
            const filePath = rest.slice(contentsPrefix.length);
            const branchParam = urlObj.searchParams.get('ref') || undefined;

            if (method === 'GET') {
              try {
                const readRes = readFileAtRef(repo, branchParam, filePath);
                if (readRes.type === 'file') {
                  sendJson(res, 200, {
                    type: 'file',
                    encoding: 'base64',
                    content: readRes.data.toString('base64'),
                    sha: readRes.id,
                    size: readRes.size,
                    name: filePath.split('/').pop() || filePath,
                    path: filePath,
                  });
                  return;
                } else {
                  const formattedEntries = readRes.entries.map(e => ({
                    type: e.type,
                    name: e.name,
                    path: e.fullPath.replace(/^\//, ''),
                    sha: e.id,
                  }));
                  sendJson(res, 200, formattedEntries);
                  return;
                }
              } catch (e) {
                sendJson(res, 404, { message: 'Not Found' });
                return;
              }
            }

            if (method === 'PUT') {
              let body: any;
              try {
                body = await readBody(req);
              } catch (e) {
                sendJson(res, 400, { message: 'Bad Request' });
                return;
              }

              const message = body?.message || 'Update file';
              const contentBase64 = body?.content;
              const branch = body?.branch || branchParam || repo.default_branch || 'main';
              const expectedSha = body?.sha;

              if (typeof contentBase64 !== 'string') {
                sendJson(res, 422, { message: 'Validation Failed' });
                return;
              }

              const contentBytes = Buffer.from(contentBase64, 'base64');

              let existed = false;
              try {
                const existing = readFileAtRef(repo, branch, filePath);
                if (existing && existing.type === 'file') {
                  existed = true;
                }
              } catch (e) {
                existed = false;
              }

              try {
                const { blobId, commitId } = commitFile(repo, branch, filePath, contentBytes, message, expectedSha);
                sendJson(res, existed ? 200 : 201, {
                  content: {
                    name: filePath.split('/').pop() || filePath,
                    path: filePath,
                    sha: blobId,
                    size: contentBytes.length,
                    encoding: 'base64',
                  },
                  commit: {
                    sha: commitId,
                  },
                });
                return;
              } catch (e: any) {
                if (e?.message && e.message.startsWith('Conflict')) {
                  sendJson(res, 409, { message: e.message });
                  return;
                }
                sendJson(res, 404, { message: e?.message || 'Not Found' });
                return;
              }
            }

            if (method === 'DELETE') {
              let body: any;
              try {
                body = await readBody(req);
              } catch (e) {
                sendJson(res, 400, { message: 'Bad Request' });
                return;
              }

              const message = body?.message || 'Delete file';
              const branch = branchParam || repo.default_branch || 'main';

              try {
                const commitId = deleteFile(repo, branch, filePath, message);
                sendJson(res, 200, {
                  commit: {
                    sha: commitId,
                  },
                });
                return;
              } catch (e) {
                sendJson(res, 404, { message: 'Not Found' });
                return;
              }
            }
          }

          // LABELS: /api/v3/repos/{owner}/{repo}/labels
          if (rest === 'labels' && method === 'POST') {
            let body: any;
            try {
              body = await readBody(req);
            } catch (err: any) {
              if (err.message === 'PAYLOAD_TOO_LARGE') {
                sendJson(res, 413, { message: 'Payload Too Large' });
                return;
              }
              sendJson(res, 400, { message: 'Bad Request' });
              return;
            }

            const labelName = body?.name;
            if (!labelName || typeof labelName !== 'string') {
              sendJson(res, 422, { message: 'Validation Failed' });
              return;
            }
            const color = typeof body?.color === 'string' ? body.color : '000000';
            const label: Label = { name: labelName, color };
            repo.labels.set(labelName, label);
            sendJson(res, 201, label);
            return;
          }

          // ISSUES: /api/v3/repos/{owner}/{repo}/issues
          if (rest === 'issues') {
            if (method === 'POST') {
              let body: any;
              try {
                body = await readBody(req);
              } catch (err: any) {
                if (err.message === 'PAYLOAD_TOO_LARGE') {
                  sendJson(res, 413, { message: 'Payload Too Large' });
                  return;
                }
                sendJson(res, 400, { message: 'Bad Request' });
                return;
              }

              const title = body?.title;
              if (!title || typeof title !== 'string' || !title.trim()) {
                sendJson(res, 422, { message: 'Validation Failed' });
                return;
              }

              const labelNames: string[] = [];
              if (Array.isArray(body.labels)) {
                for (const l of body.labels) {
                  let lName = typeof l === 'string' ? l : l?.name;
                  if (lName && repo.labels.has(lName)) {
                    labelNames.push(lName);
                  } else {
                    sendJson(res, 422, { message: 'Validation Failed' });
                    return;
                  }
                }
              }

              const num = repo.nextIssueNumber++;
              const now = new Date().toISOString();
              const issue: Issue = {
                number: num,
                title: title.trim(),
                body: typeof body.body === 'string' ? body.body : '',
                state: 'open',
                labels: labelNames,
                comments: [],
                createdAt: now,
                updatedAt: now,
                cachedJsonBuffer: null,
              };

              repo.issues.set(num, issue);
              repo.generation++;

              sendJson(res, 201, formatIssue(owner, repoName, issue));
              return;
            }

            if (method === 'GET') {
              const stateParam = urlObj.searchParams.get('state') || 'open';
              const sortParam = urlObj.searchParams.get('sort') || 'created';
              const dirParam = urlObj.searchParams.get('direction') || 'desc';
              const page = Math.max(1, parseInt(urlObj.searchParams.get('page') || '1', 10) || 1);
              const per_page = Math.min(100, Math.max(1, parseInt(urlObj.searchParams.get('per_page') || '30', 10) || 30));

              let list: Issue[] = [];
              for (const issue of repo.issues.values()) {
                if (stateParam === 'all' || issue.state === stateParam) {
                  list.push(issue);
                }
              }

              list.sort((a, b) => {
                let cmp = 0;
                if (sortParam === 'updated') {
                  cmp = a.updatedAt.localeCompare(b.updatedAt);
                } else if (sortParam === 'comments') {
                  cmp = a.comments.length - b.comments.length;
                } else {
                  cmp = a.createdAt.localeCompare(b.createdAt);
                }
                if (cmp === 0) {
                  cmp = a.number - b.number;
                }
                return dirParam === 'asc' ? cmp : -cmp;
              });

              const start = (page - 1) * per_page;
              const slice = list.slice(start, start + per_page);
              const formatted = slice.map(i => formatIssue(owner, repoName, i));

              const baseUrl = `${protocol}://${host}/api/v3/repos/${owner}/${repoName}/issues`;
              let linkParts: string[] = [];
              if (start + per_page < list.length) {
                linkParts.push(`<${baseUrl}?page=${page + 1}&per_page=${per_page}&state=${stateParam}&sort=${sortParam}&direction=${dirParam}>; rel="next"`);
              }
              if (page > 1) {
                linkParts.push(`<${baseUrl}?page=${page - 1}&per_page=${per_page}&state=${stateParam}&sort=${sortParam}&direction=${dirParam}>; rel="prev"`);
              }
              const headers: Record<string, string> = {};
              if (linkParts.length > 0) {
                headers['Link'] = linkParts.join(', ');
              }

              sendJson(res, 200, formatted, headers);
              return;
            }
          }

          // Single issue subpath: issues/{number} or issues/{number}/...
          const issuesPrefix = 'issues/';
          if (rest.startsWith(issuesPrefix)) {
            const issueRest = rest.slice(issuesPrefix.length);
            const issueParts = issueRest.split('/');
            const numStr = issueParts[0];
            const issueNum = parseInt(numStr, 10);

            if (!isNaN(issueNum)) {
              const issue = repo.issues.get(issueNum);
              if (!issue) {
                sendJson(res, 404, { message: 'Not Found' });
                return;
              }

              const issueSub = issueParts.slice(1).join('/');

              // GET /api/v3/repos/{owner}/{repo}/issues/{number}
              if (issueSub === '' && method === 'GET') {
                if (!issue.cachedJsonBuffer) {
                  const formatted = formatIssue(owner, repoName, issue);
                  const jsonStr = JSON.stringify(formatted);
                  issue.cachedJsonBuffer = Buffer.from(jsonStr, 'utf-8');
                }

                const requestId = `req-${requestIdCounter++}`;
                res.writeHead(200, {
                  'Content-Type': 'application/json; charset=utf-8',
                  'X-GitHub-Request-Id': requestId,
                  'Content-Length': String(issue.cachedJsonBuffer.length),
                });
                res.end(issue.cachedJsonBuffer);
                return;
              }

              // PATCH /api/v3/repos/{owner}/{repo}/issues/{number}
              if (issueSub === '' && method === 'PATCH') {
                let body: any;
                try {
                  body = await readBody(req);
                } catch (err: any) {
                  if (err.message === 'PAYLOAD_TOO_LARGE') {
                    sendJson(res, 413, { message: 'Payload Too Large' });
                    return;
                  }
                  sendJson(res, 400, { message: 'Bad Request' });
                  return;
                }

                if (body && (body.state === 'open' || body.state === 'closed')) {
                  issue.state = body.state;
                }
                if (body && typeof body.title === 'string' && body.title.trim()) {
                  issue.title = body.title.trim();
                }
                if (body && typeof body.body === 'string') {
                  issue.body = body.body;
                }

                issue.updatedAt = new Date().toISOString();
                issue.cachedJsonBuffer = null;
                repo.generation++;

                sendJson(res, 200, formatIssue(owner, repoName, issue));
                return;
              }

              // COMMENTS: /api/v3/repos/{owner}/{repo}/issues/{number}/comments
              if (issueSub === 'comments') {
                if (method === 'GET') {
                  sendJson(res, 200, issue.comments);
                  return;
                }

                if (method === 'POST') {
                  let body: any;
                  try {
                    body = await readBody(req);
                  } catch (e) {
                    sendJson(res, 400, { message: 'Bad Request' });
                    return;
                  }

                  const commentBody = body?.body;
                  if (typeof commentBody !== 'string') {
                    sendJson(res, 422, { message: 'Validation Failed' });
                    return;
                  }

                  const newComment: Comment = {
                    id: nextCommentId++,
                    body: commentBody,
                  };
                  issue.comments.push(newComment);
                  issue.updatedAt = new Date().toISOString();
                  issue.cachedJsonBuffer = null;
                  repo.generation++;

                  sendJson(res, 201, newComment);
                  return;
                }
              }
            }
          }
        }
      }

      // Default 404
      sendJson(res, 404, { message: 'Not Found' });
    } catch (err: any) {
      sendJson(res, 500, { message: err?.message || 'Internal Server Error' });
    }
  });

  return server;
}
