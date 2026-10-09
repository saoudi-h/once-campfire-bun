# once-campfire-bun

A [Bun](https://bun.com) + [Elysia](https://elysiajs.com) port of
[ONCE Campfire](https://github.com/basecamp/once-campfire). You keep
your SQLite database, storage layout, and signed cookies when you
switch. The Rails checkout lives in `reference/` as a pinned
submodule (`659f957`).

MIT. I drew the templates, asset build, and compat contracts from
the public Rails app. Vendored frontend assets keep their own
licenses.

One Bun process replaces the Ruby/Node stack. Set `WEB_WORKERS`
above 1 and you get a master (jobs, cable fanout, writer
supervision) plus HTTP workers on one port through `SO_REUSEPORT`,
with a dedicated SQLite writer child for message posts.

## Status

With Basecamp's shared harness, on the same seed and machine
(numbers below), this port matches Rust on sidebar, search,
avatar, and the static and health routes. The room page runs at
0.76x Rust and the messages page at 0.52x: both ship ~500KB of
rendered HTML per request, which costs more in JS than in Rust.
Posts run at 0.71x behind the single-writer SQLite design
(ADR-001).

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

## Benchmarks (official harness)

Basecamp's shared harness (`basecamp/once-campfire-verification`)
produced these: official seed `4bf9d0eb`, 3 rounds of 8s at 16
clients, server pinned to CPUs 8-11 and loadgen to 12-15, both apps
on one machine, medians. Compare within a run; the host sets the
absolute numbers.

| route | rust rps | elysia rps | elysia / rust |
|---|---|---|---|
| room_show | 35122 | 26718 | 0.76x |
| messages_page | 33952 | 17520 | 0.52x |
| sidebar | 38523 | 33355 | 0.87x |
| search | 33777 | 33466 | 0.99x |
| avatar | 139373 | 117972 | 0.85x |
| static_css | 150494 | 249698 | 1.66x |
| up | 59563 | 269202 | 4.5x |
| post_message | 2590 | 1836 | 0.71x |

Sidebar and search match Rust with the whole-response cache: a
read-only `PRAGMA data_version` observer bumps a generation on any
commit, page keys carry that generation, and the route handlers
skip the version queries they used to run per lookup. Room and
messages pages trail because each request ships ~500KB of rendered
HTML. The write path runs at 0.71x because `bun:sqlite` holds one
synchronous connection per process, capping writes at ~1
transaction, so plain posts route through a dedicated writer
child. `static_css` and `up` measure the framework floor, not app
code.

To reproduce: clone this repo next to `once-campfire-verification`,
build the seed with `bin/seed`, build the image, and run
`compare.rb --apps rust,elysia` with `WEB_WORKERS=4` in
`ELYSIA_BENCH_ENV`. For the local interleaved A/B protocol and
CPU/RAM scaling scripts, see `docs/BENCHMARKS.md`. The adapter for
this port is proposed upstream in
[verification#5](https://github.com/basecamp/once-campfire-verification/pull/5).
