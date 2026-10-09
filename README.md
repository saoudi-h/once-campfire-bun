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
the same machine. This port passes Rust on the sidebar and search
routes, reaches 0.95x on the room page, and writes at 0.64x. The
results are below.

## Benchmarks

Basecamp's shared harness (`basecamp/once-campfire-verification`)
produced these numbers: official seed `4bf9d0eb`, 3 rounds of 8s
each at 16 concurrent clients, the server pinned to CPUs 8-11 and
the load generator to 12-15, both applications running on one
machine, with medians taken across the rounds.

| route | rust rps | this port | ratio |
|---|---|---|---|
| room_show | 34278 | 32726 | 0.95x |
| messages_page | 33076 | 23908 | 0.72x |
| sidebar | 38810 | 43393 | 1.12x |
| search | 38848 | 41926 | 1.08x |
| avatar | 151234 | 115830 | 0.77x |
| static_css | 132788 | 223929 | 1.69x |
| up | 57080 | 273850 | 4.80x |
| post_message | 3086 | 1960 | 0.64x |

This port passes Rust on sidebar and search, sits at 0.95x on the
room page and 0.72x on messages, and writes at 0.64x. The
whole-response cache does the reading work: a read-only
`PRAGMA data_version` observer bumps a generation counter on any
database commit, page cache keys carry that generation, and the
route handlers skip the version queries they used to run per
lookup. A per-process session cache, invalidated by the same
observer, removes the cookie verification and the auth SELECTs
from the request path. The room and messages pages still trail
because each response ships ~500KB of rendered HTML, which costs
more in JS than in Rust.

`post_message` runs at 0.64x because `bun:sqlite` holds one
synchronous connection per process, capping writes at a single
transaction, so plain posts route through a dedicated writer
child (ADR-001). `static_css`, `up` and `avatar` are native
Elysia routes that never enter the compat pipeline; they measure
the framework floor rather than application code.

Compare ratios within a single run. The machine sets the absolute
numbers, and those change between runs.

The harness validates every response against route contracts while
it measures, so a completed run also means this port answered with
the same bytes, statuses, and database writes as the reference
application.

To reproduce the numbers:

```bash
git clone https://github.com/basecamp/once-campfire-verification.git
git clone https://github.com/saoudi-h/once-campfire-bun.git ../once-campfire-elysia
cd once-campfire-verification
bin/seed
docker build -t once-campfire-elysia:app ../once-campfire-elysia
ELYSIA_BENCH_ENV='{"WEB_WORKERS":"4"}' bench/compare.rb \
  --apps rust,elysia --rounds 3 --duration 8 \
  --concurrencies 16 --cpus 8-11 --client-cpus 12-15
```

The local interleaved A/B protocol and the CPU/RAM scaling scripts
live in `docs/BENCHMARKS.md`. The adapter for this port is proposed
upstream in
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

The project builds and tests on the Bun canary channel
(1.4.3-canary at the time of writing). Bun 1.4.2 stable breaks
`Bun.spawn` child stdout when compiling, which the writer IPC and
worker processes rely on. Install canary with
`bun upgrade --canary`.

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
