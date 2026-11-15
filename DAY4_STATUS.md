# Day 4 status — github-core-clone-01 (15 Nov 2026)

## Local score after Day 4 — SUBMIT DECISION: READY (≥940 gate cleared)

Two independent grade-local runs (practice trial 0, --driver process, committed code 58b2156, clean tree):

| Run | Total | Feature | Agent | Perf |
|-----|-------|---------|-------|------|
| Day 3 (baseline) | 704 | 525 | 0 | 179 |
| **Day 4 run 1** | **984** | **600** | **200** | **184** |
| **Day 4 run 2** | **981** | **600** | **200** | **181** |

Per-group check counts (run 2 state, 120/120 passed): git **30/30**, graphql **20/20**,
issues **15/15**, **mcp 15/15**, protocol **5/5**, pulls **20/20**, repos **15/15**.
Perf (run 2): read 50/50 (p50 538 ms), write 45/50 (112 ms), clone 43/50 (97 ms),
push 43/50 (612 ms). Perf fluctuates run to run (181–184); shared-VM noise.

**Gate: ≥940 — CLEARED with ~41–44 points of margin. Prize threshold ~945 also cleared.**
Both runs score 981–984, so the entry is ready to submit. Nothing submitted yet (0/3 subs used);
the parent handles the public-repo + submit step. Deadline 21 Nov 13:30 WIB.

## What was built (Day 4)

Commit `58b2156` — "Day 4: MCP (server/discover, initialize, tools/list, tools/call, 6 tools)":

- **`mcp.ts` (635 lines, new file)** — Gemini CLI authored from a description in a fresh
  session (import check passed; no read of app.ts/main.ts). `createMcpHandler({ repos, viewerLogin })`
  returns `handleMcp(rawBody)` → `{ status, json }`. JSON-RPC 2.0 Streamable HTTP, plain JSON
  responses (no SSE): `server/discover` (2026-07-28 modern era, supportedVersions + serverInfo in
  both the loose field and `_meta`), legacy `initialize` (echoes the offered revision),
  `notifications/*` → 202 empty, `tools/list` (ONE module-level constant array — byte-identical
  across calls), `tools/call` (name resolution: exact normalized, then tool-ends-with-requested,
  then requested-ends-with-tool for client prefixes like `github__create_issue`), unknown tool →
  -32602, unknown method → -32601, malformed body → HTTP 400 + -32700, non-object → -32600.
  Tool-level errors return `isError: true` (never HTTP 500). Six tools, all on the same
  in-memory store as REST: create_repo, get_repo, create_issue, list_issues, create_pull_request,
  merge_pull_request (squash via git.ts helpers, same validation/conflict rules as REST).
  Formatters formatRepo/formatIssue/formatPull re-implemented in mcp.ts with shapes identical
  to the REST surface (no import cycle with app.ts).
- **`app.ts` (+19 lines)** — import + handler instance + POST /mcp route after the /api/graphql
  block (readRawBody → handleMcp → sendEmpty/sendJson; 500 on body-read failure). Auth is the
  existing top-of-handler Bearer check, so unauthenticated /mcp → 401.
- **Two small fixes in mcp.ts** (same session): reverse tool-name suffix match; title.trim()
  on create_issue / create_pull_request to match REST.

## Verification (independent re-runs, per the Day 3 lesson)

- MCP smoke test `~/.gemini/tmp/github-core-clone-entry/mcp-smoke.mts` (257 lines, 27 checks:
  discover, initialize, notifications, tools/list + idempotency, all six tools, PR create+merge,
  unknown tool -32602, malformed body 400/-32700, no-auth 401, empty-args isError, concurrent
  calls with own ids, REST parity): **27 passed, 0 failed — re-run by me independently**
  (the session's own claim was verified, not trusted; the file lives in the Gemini project temp
  dir because the CLI sandbox blocks writes to /tmp).
- Grade-local run 1: 984. Grade-local run 2: 981. Both on commit 58b2156, clean tree.

## Flags / notes for the parent

- **GitHub account: konisetiawan — CONNECTED 15 Nov ~16:25 WIB via PAT (classic, repo scope)
  through connector custom.github** (verified GET /user → login konisetiawan, id 55168043;
  doc ~/workspace/custom-connectors/custom.github/CONNECTOR.md; helper
  ~/workspace/custom-connectors/custom.github/bin/gh.py). The submit-time public repo can now be
  created under konisetiawan. Repo creation happens at submit time only, not before.
- **Bundle sessions:** pass ALL session files under `~/.gemini/tmp/github-core-clone-entry/chats/`
  to the bundle command at submit time (Days 1–4 sessions). Fresh sessions per chunk — a resumed
  1.5 MB session took 10–20 min/turn in free-tier quota retries.
- Kit is level 12 while make.fun is at level 13 (warning seen at submit time for threejs-fps-02
  too; the local grade used this kit and the check sources are byte-identical to Day 1).
- Node: local grade ran Node v24.22.1; the server harness runs v22.23.4. Code uses only
  standard APIs present in both.
- Next step (parent): create the public repo under konisetiawan, bundle with all transcripts,
  local check, submit. The entry is measurement-ready; no further build days are needed unless
  the final grading (new instance, 3 trials, mean score) comes back below the prize line.
