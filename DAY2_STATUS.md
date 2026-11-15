# github-core-clone-01 — Day 2 status

Date: 15 Nov 2026 ~16:00 WIB. Deadline 21 Nov 2026 13:30 WIB (6 days left).

## What was built (Day 2)
- Repo: ~/workspace/makefun/github-core-clone-entry/ (anchor root 5b2d072, drand round 33974318).
- git.ts (1,278 lines, Gemini CLI authored from prose descriptions): object model (SHA-1 ids, parse/build commit/tree/tag, reachability, tree path helpers), pkt-line codec, pack read (PACK header, varint headers, normal objects, OFS/REF deltas, zlib, trailer checksum, memoized recursive delta resolution with depth limit + cycle detection) and pack write v1 (full objects only, deterministic sorted, raw deflate level 1, SHA-1 trailer), contents helpers (commitFile/deleteFile/readFileAtRef, fixed author `Ada Iversen <ada@example.com> 1770000000 +0000`).
- Handlers: handleInfoRefs (v0/v2 advertisement), handleLsRefs (prefix filter, peel, symrefs), handleFetch v2 (wants/haves/shallow/deepen, ack section, shallow-info section, sideband band-1 packfile), handleReceivePack v0 (report-status, side-band-64k, delete-refs, fast-forward enforcement, mixed ok/ng).
- app.ts (+~270 lines wiring): git routes `/{owner}/{repo}.git/info/refs`, `/git-upload-pack`, `/git-receive-pack` (after Bearer auth, raw-body reader for binary packs), contents PUT (201 create / 200 update / 409 stale sha) / GET (file + directory) / DELETE, issue comments POST 201 / GET.
- Commits: 17c698e (Day 2 core), 6e32d89 (sideband fix), e35a119 (deepen fix).

## Bugs found by the local grade and fixed the same day
1. **Receive-pack sideband framing (6e32d89):** the report-status lines were wrapped in a band-1 buffer but pushed WITHOUT the outer pkt-line, so the kit client read `[0x01]['0']['0']['1']` as a length header → `GitProtocolError: invalid pkt-line length`. That one bug broke the setup push every git check depends on (git 1/30, push/clone bench 0). Fix: wrap each band buffer in an outer packet-line. After the fix git went to 28/30 and push/clone bench to 43/46.
2. **Fetch deepen held-set (e35a119):** the depth branch subtracted objects reachable from the haves, but that walk follows commit parents, so a deepen wrongly treated the parent as already held and sent nothing. Fix: in the depth branch subtract only each have commit plus its tree-reachable objects (trees only, never commit parents). After the fix git is 29/30.
3. **Missing import (found by review, fixed before grading):** app.ts called decodePktLines without importing it — a runtime ReferenceError on every git-upload-pack POST.

## Local score after Day 2 (grade-local, practice trial 0, --driver process; verified by two independent runs: 502 and 503)
- **TOTAL: 502** (feature 320, agent 0, perf 182, working 1). Entry exited 0 after ~8 s; replay matched byte for byte. Trial kept at /home/hatch/.makefun/trials/github-core-clone-01/01a1de5b-03dc-75f3-bec4-97ecf7292d54.
- Feature 320/600 (64/120 checks): git 29/30, issues 15/15, protocol 5/5, repos 12/15, pulls 2/20, graphql 1/20, mcp 0/15.
- Agent 0/200 (MCP not implemented).
- Perf 182/200 (perf_p50_us 250,549): read 50/50 (p50 619 ms), clone 44/50 (p50 93 ms), write 46/50 (p50 109 ms), push 42/50 (p50 629 ms). All four workloads now measure; read/write improved vs Day 1 mostly because the VM is no longer running the chess trial alongside.
- Day 1 → Day 2: 111 → 502 (+391).

## Still failing (56 checks)
- git.push-100-files (1): 100-file single-commit push round-trip — NOT yet diagnosed; needs a repro against the kit client in Day 3.
- graphql 19/20, pulls 18/20, repos.branches / repos.commits / repos.pagination (3), mcp 15/15 — not implemented yet (Days 3–5 scope).

## Trajectory reassessment
- Need +438 to reach the ≥940 submit gate. Remaining headroom: feature +280 (56 checks × 5), agent +200 (MCP), perf +~10 (already 182; read maxed at 50, clone/push/write have ~8–13 combined left).
- Perf is DONE at prize level (182 vs ~145 needed) — git packfile perf was the big unknown and it cleared it: push 42–43, clone 44–46.
- The gate now hinges on feature breadth + MCP: EVERYTHING must land (GraphQL 19 + pulls 18 + MCP 15 + repos 3 + git 1) for feature ~600, plus a strong MCP agent score. Realistic Day 6 if GraphQL+MCP land cleanly: feature ~560–600, agent ~120–200, perf ~185–190 → total ~865–990. Better than Day 1's coin flip — git (the algorithmic risk) is solved; the remaining work is more mechanical (REST endpoints, GraphQL documents, MCP tools) — but ≥940 is still not a certainty: it needs near-total feature coverage AND the agent score, whose exact computation is still unverified. The measurement gate stands: submit ONLY if local score ≥940.
- Days 3–6 plan: Day 3 REST branches/commits/refs/labels + push-100-files diagnosis; Day 4 GraphQL v4 (all documents gh + github-mcp-server send); Day 5 MCP (6+ tools, both protocol eras); Day 6 perf tuning + final full grade + submit decision.

## Process notes / flags
- The kit at /tmp/ghclone/kitx/ was WIPED by a runtime restart mid-Day-2. Re-downloaded from https://make.fun/c/github-core-clone-01/kit to the DURABLE location ~/workspace/makefun/ghclone-kit/github-core-clone-01-kit/ (kit.tar.gz kept there too). Fresh kit is byte-identical in check sources to Day 1 (program@99d09372…, bundle_sha256 e20a304d…) — no grading impact.
- Gemini session hygiene: the resumed Day 1 session (1.5 MB) became unusable — each turn took 10–20 min in free-tier quota retries (250k input tokens/min). FRESH Gemini sessions complete the same work in ~60 s. Use fresh sessions per fix; the Day 1 session file is session-2026-11-15T07-06-7aeecf98.jsonl, fix sessions are separate files under ~/.gemini/tmp/github-core-clone-entry/chats/ — pass ALL of them to the bundle command at submit time.
- Gemini CLI workspace restriction: a fresh session can only run shell commands inside the entry repo (it cannot cd to the kit dir); invoke the grader by absolute path from inside the repo.
- GitHub account prerequisite: STILL not confirmed (needed for the public repo at submit time). Do NOT create the public repo yet.
- Submissions used: 0/3. Nothing submitted.
- Node: local grade ran Node v24.22.1; harness runs v22.23.4. Code uses only standard APIs present in both.
