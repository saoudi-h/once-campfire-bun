# once-campfire-bun

[ONCE Campfire](https://github.com/basecamp/once-campfire) is
Basecamp's chat application, open source: Ruby on Rails, one SQLite
database, Hotwire/Turbo for the UI, Active Storage for uploads, and
Action Cable for live updates.

This repo rebuilds that application in [Bun](https://bun.com) +
[Elysia](https://elysiajs.com). It reads the same SQLite file, the
same storage directory, and the same signed session cookies, so you
can point it at an existing Campfire database and use the app: rooms,
messages, search, uploads, and live streaming over the Action Cable
protocol.

The port answers one question: how close does a JavaScript stack get
to a Rust implementation of the same application? An AI agent built
a Rust port of Campfire as the target, and both were measured with
Basecamp's shared benchmark harness, on the same seed database and
the same machine. The results are below.

## Benchmarks

Basecamp's shared harness (`basecamp/once-campfire-verification`)
produced these numbers: an official seed database, 3 rounds of 8s
each at 16 concurrent clients, the server pinned to CPUs 8-11 and
the load generator to 12-15, both applications running on one
machine, with medians taken across the rounds.

| route | rust rps | this port | ratio |
|---|---|---|---|
| room_show | 35122 | 26718 | 0.76x |
| messages_page | 33952 | 17520 | 0.52x |
| sidebar | 38523 | 33355 | 0.87x |
| search | 33777 | 33466 | 0.99x |
| avatar | 139373 | 117972 | 0.85x |
| static_css | 150494 | 249698 | 1.66x |
| up | 59563 | 269202 | 4.5x |
| post_message | 2590 | 1836 | 0.71x |

`room_show` and `messages_page` ship the heaviest responses in the
app (~500KB of HTML each), and moving that many bytes costs more in
JS than in Rust. Sidebar and search match Rust because of the
whole-response cache: a read-only `PRAGMA data_version` observer
bumps a generation counter on any database commit, page cache keys
carry that generation, and the route handlers skip the version
queries they used to run per lookup. `post_message` runs at 0.71x
because `bun:sqlite` holds one synchronous connection per process,
capping writes at a single transaction, so plain posts route through
a dedicated writer child. `static_css` and `up` measure the
framework floor rather than application code: Elysia's native routes
and an in-memory asset cache answer them.

Compare ratios within a single run. The machine sets the absolute
numbers, and those change between runs.

The harness validates every response against route contracts while
it measures, so a completed run also means this port answered with
the same bytes, statuses, and database writes as the reference
application.

To reproduce: clone this repo next to `once-campfire-verification`,
build the seed with `bin/seed`, build the image, and run
`compare.rb --apps rust,elysia` with `WEB_WORKERS=4` in
`ELYSIA_BENCH_ENV`. The local interleaved A/B protocol and the
CPU/RAM scaling scripts live in `docs/BENCHMARKS.md`. The adapter
for this port is proposed upstream in
[verification#5](https://github.com/basecamp/once-campfire-verification/pull/5).

## What runs

The suite in `test/` mirrors the Express port's suite: 61 tests
across 8 files, one process per file for database isolation.
`bun bin/test.js` and `bun run typecheck` are the two gates.

Hot reads, message writes, Turbo streams, Action Cable, uploads and
image variants, full-text search, and the Rails cookie and signing
protocols all run on the port. The items at the bottom list what
does not.

## Develop

```bash
git clone --recurse-submodules <this-repo>
bun install
bun bin/test.js   # one bun test process per file (DB isolation)
bun run typecheck
bun src/server.ts # dev server (HTTP_PORT, WEB_WORKERS, BIND)
```

Build the production image with `docker build -t campfire-bun .`,
then run it with `SECRET_KEY_BASE`, `VAPID_*` keys, and a storage
volume at `CAMPFIRE_STORAGE_PATH` (see `Dockerfile`).

Small servers: cap memory with `CAMPFIRE_CACHE_MB`
(per-cache `CAMPFIRE_<FRAGMENT|PAGE|GZIP|BODY>_CACHE_MB`).
32MB per cache is the default. I benchmarked with defaults.

## Layout

| Path | What |
|---|---|
| `src/app.ts` | Elysia wiring, compat pipeline, native fast routes |
| `src/routes.ts` | All screens and API routes (the core) |
| `src/domain.ts` | Models and message lifecycle |
| `src/cable.ts` | Action Cable server (indexed fanout, shared frames) |
| `src/rendering.ts` | Nunjucks screens, fragment + page caches |
| `src/db.ts` | `bun:sqlite` boundary (WAL + NORMAL, no auto-checkpoint) |
| `src/checkpoint*.ts` | Background WAL checkpointer thread |
| `src/writer.ts` + `src/write-client.ts` | Dedicated write IPC (ADR-001) |
| `src/jobs.ts` | Background jobs (best-effort queue, own SQLite file) |
| `src/compat.ts`, `src/rails.ts` | Express facade, Rails crypto/signing compat |
| `templates/pages.html` | All screens |
| `test/` | Suite mirroring the Express port |
| `.autonomos/` | Agent protocol: tasks, worklogs, decisions |

## Known tradeoffs

- Queued push/webhook jobs may lose their tail on a hard crash
  (same posture as the Rust port's in-memory queues).
- Banned/deactivated users are disconnected and room removals prune
  subscriptions; per-message re-authorization was removed for
  broadcast speed (Rust parity).
- `bun:sqlite` is synchronous with one connection per process:
  write throughput is ~1 transaction; plain posts go through the
  single writer (see `.autonomos/decisions/ADR-001-*`).
- Bench numbers come from one machine; the ratios are the
  comparison, the absolute rps is not portable.

The Rails checkout lives in `reference/` as a pinned submodule
(`659f957`); the templates, asset build, and compat contracts were
drawn from it. MIT. Vendored frontend assets keep their own
licenses.
