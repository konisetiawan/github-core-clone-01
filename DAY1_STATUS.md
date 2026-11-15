# github-core-clone-01 — Day 1 status

Date: 15 Nov 2026 ~14:15 WIB. Deadline 21 Nov 2026 13:30 WIB (6 days left).

## What was built (Day 1)
- Repo: ~/workspace/makefun/github-core-clone-entry/ (fresh; anchor root 5b2d072, drand round 33974318).
- main.ts (99 lines, Gemini CLI authored from a description; anchor echoed before any write): lifecycle — bind ephemeral port, POST /register, poll /done, exit 0. Kept as the entrypoint.
- app.ts (601 lines, Gemini CLI authored in a resumed session): in-memory store (repos Map; per repo: objects, refs, issues, prs, labels Maps + generation counter + nextIssueNumber/nextPrNumber), auth (Bearer MAKEFUN_SHOP_TOKEN; viewer login adaiversen, deterministic from the fixed scenario seed 0x6a09e667f3bcc909), REST routes (healthz, api root, meta, user, create/get/patch/delete repo, list repos with Link pagination, create/list/get/patch issue, create label), protocol (JSON everywhere, X-GitHub-Request-Id per reply, JSON 404, 400 on malformed JSON), perf levers (pre-serialized JSON Buffers for single-issue GETs, direct string routing, no generic dispatch).
- package.json, tsconfig.json, LICENSE (MIT). Committed as d661abd.

## Local score after Day 1 (grade-local, practice trial 0, --driver process)
- TOTAL: 111 (feature 40, agent 0, perf 71, working 1). Entry exited 0 after 8.2 s; replay matched byte for byte.
- Feature 40/600 (8/120 checks): repos 5/15 (create, foreign-token, meta, not-found, root), protocol 2/5 (malformed-body-400, unknown-route-json-404), graphql 1/20 (unauthenticated). git 0/30, issues 0/15, pulls 0/20, mcp 0/15 — not implemented yet. Issues checks fail at fixture setup (PUT /contents not implemented yet).
- Agent 0/200 (MCP not implemented).
- Perf 71/200:
  - read 37/50 — p50 1449.786 ms vs T_ref 2759.715 ms (1.9x faster than reference). Pre-serialized Buffer cache works.
  - write 34/50 — p50 212.689 ms vs T_ref 348.965 ms (1.64x faster than reference).
  - push 0/50 — git receive-pack not implemented (404 on info/refs).
  - clone 0/50 — git upload-pack not implemented (404 on info/refs).
  - perf_p50_us 555296 (reference geometric mean ~805899).

## Trajectory assessment
- To reach >=940 (the submit gate) need: feature 600 (+560, all surfaces), agent 200 (+200, MCP), perf ~145+ (+74, push+clone must match the REST level ~35-40 each).
- REST perf is already at prize level (37/34). IF git push/clone reach ~35-40 each, perf lands ~141-145 and total ~941-945 — exactly at the prize bar. Plausible but tight; git packfile perf is the biggest unknown (zlib + SHA-1 + pack generation under concurrency).
- Realistic Day 6 outcome if the full surface lands cleanly: ~900-945. The >=940 gate is a coin flip, not a certainty. The measurement gate stands: submit ONLY if local score >=940.
- Remaining work (Days 2-6): git smart HTTP (upload-pack v2 + receive-pack v0, packfile read/write, pkt-line, zlib), REST contents/branches/commits/refs/labels/comments, GraphQL v4 (all documents gh + github-mcp-server send), MCP (6+ tools + protocol eras), then perf tuning (clone-response cache, shared-promise dedup) and a final full grade.

## Prerequisites / flags
- GitHub account: NOT yet confirmed. The submit needs a public GitHub repo owned by the user's own GitHub account, created after the competition opened, OSI license, main.ts in root, plus AI transcripts. Do NOT create the public repo yet — flag for the parent to confirm the account.
- Kit version: the kit copy is level 12, make.fun is at level 13 (makefun init warned). The local grade used this kit; a fresh kit download may change checks. Flag for the parent.
- Node version: local grade ran on Node v24.22.1; the server harness runs v22.23.4. Code uses only standard APIs present in both.
- Submissions used: 0/3 (real cap 3 per competition). Nothing submitted.
