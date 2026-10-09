---
name: "once-campfire-bun"
type: "project"
status: "active"
---

# AGENT CONTEXT: once-campfire-bun

## 🧠 Context & Objectives

Bun + Elysia port of ONCE Campfire (Basecamp chat; Rails reference in
`reference/`, read-only). The goal is not the app itself: prove
Bun+Elysia competitive with the agent-built Rust port by measuring with
the same harness (`../once-campfire-rust/bench/`: `run` + `loadgen`)
and porting Rust's optimizations. Room/messages/search already match
Rust; sidebar/post/cable remain (see `.autonomos/TASKS.md`).

## ⚙️ Workflow & Preferences

- **Runtime:** Bun only (`bun <file>`, `bun test`, `bun install`). Never
  `node`, `npm`, `npx`, dotenv (Bun loads `.env`). Verify the runtime
  with `bun --revision`: bare `bun --version` prints `1.4.3` even for
  canary builds (e.g. `1.4.3-canary.1`).
- **Tests:** `bun bin/test.js` (one `bun test` process per file: each
  sets its own `process.env.DATABASE_PATH`). Single file:
  `bun test test/<name>.test.ts`. Full green + `bun run typecheck`
  (strict, `noUncheckedIndexedAccess`) required before benching.
- **Commits:** Conventional Commits (`perf(db): …`). Commit only when
  asked. Never commit secrets.
- **Bench:** production image `campfire-bun:bench`, fresh seed copy per
  app (`parity/.seed/default`), server CPUs `8-11`, loadgen CPUs
  `12-15`, `--network host`, warmup `c=4/2s` then measure. Compare
  ratios vs Rust on the same host, never absolute numbers across hosts.
- **Language:** English for artifacts, French with the user.
- **Protocol:** Autonomos (`.autonomos/PROTOCOL.md`). TASKS.md owns task
  state; worklog per session work; `/task` plan before code.

## 🏗 Stack & Architecture

- **Tech:** Bun, Elysia 2, `bun:sqlite` (ONE synchronous connection —
  the event loop blocks on every query), nunjucks (`templates/`),
  sharp, web-push. Multi-process (`WEB_WORKERS`, SO_REUSEPORT) with
  unix-socket cable fanout (`src/fanout.ts`).
- **Patterns:** Express-style `CompatReq/CompatRes` facade over Elysia
  (`src/compat.ts`); Rails cookie/crypto compat (`src/rails.ts`);
  version-keyed LRU caches, each 32MB like Rails MemoryStore:
  message fragments + page cache (`src/rendering.ts`), gzip responses
  (`src/app.ts`).
- **SQLite:** WAL + NORMAL + `wal_autocheckpoint=0` (main + jobs DBs);
  background `Bun.Worker` does PASSIVE past 1000 WAL pages, RESTART
  past 10000 (`src/checkpoint*.ts`, started by `src/server.ts` only —
  tests never load it). Jobs queue is best-effort (may lose tail on
  crash, like Rust's in-memory queues). Composite index
  `messages(room_id, created_at)` added at boot for old DBs.
- **Writes:** attachment-less message POSTs go through the dedicated
  writer child over a unix socket (`src/writer.ts` + `src/write-client.ts`,
  ADR-001) in multi-worker mode; single-process and tests use local
  writes. All other mutations write directly. Never add a second
  writer path without updating the ADR.
- **Cache sizes:** fragment/page/gzip/body caches default 32MB each
  (per worker); tune via `CAMPFIRE_<FRAGMENT|PAGE|GZIP|BODY>_CACHE_MB`
  or `CAMPFIRE_CACHE_MB` for all. Smaller caps cut memory with no
  loss on concentrated workloads but evict more on large working
  sets — keep defaults for benchmarked performance.

## 📁 Key Directories

| Path | Description |
|------|-------------|
| `src/` | Port source (`routes.ts` is the core, `cable.ts` WebSocket) |
| `test/` | Mirrors express-suite, `helper.ts` boots app on ephemeral port |
| `templates/pages.html` | All screens/macros (nunjucks) |
| `assets/generated/` | Built assets (memoized at runtime, build-time only) |
| `reference/` | Pinned Rails app + bench docs. Never edit |
| `.autonomos/` | Agent Protocol files (TASKS.md, worklogs, PROTOCOL.md) |
| `bin/` | `test.js`, `build-assets.js`, `backup.js` (online API), `restore.js` |

## ⚠️ Known Constraints

- Single sync SQLite connection per process: the cross-process writer
  lock caps write throughput (~1/txn). Keep write transactions minimal
  (sanitize/parse outside, batch statements, skip no-ops).
- `maskCsrf` re-pads randomly per request: cache keys must use the
  stable `session._csrf_token`, never the masked token.
- Pages embed per-session CSRF: whole-page cache is per-session;
  only session-independent fragments (message lists) are shared.
- POST bodies carry fresh ids: gzip cache is GET/HEAD only.
- Broadcasts never touch the DB: auth at subscribe, active prune on
  ban/deactivate/room-member-removal/room-delete, liveness via
  3s sweep (`sweepCable`).
- Bench seed uses fixed `SECRET_KEY_BASE` (`parity/.env.reference`).
