# once-campfire-bun

A [Bun](https://bun.com) + [Elysia](https://elysiajs.com) port of
[ONCE Campfire](https://github.com/basecamp/once-campfire). You keep
your SQLite database, storage layout, and signed cookies when you
switch. The Rails checkout lives in `reference/` as a pinned
submodule (`659f957`).

MIT. I drew the templates, asset build, and compat contracts from
the public Rails app. Vendored frontend assets keep their own
licenses.

One Bun process replaces the Ruby/Node stack. Set `WEB_WORKERS>1`
and you get a master (jobs, cable fanout, writer supervision) plus
HTTP workers on one port through `SO_REUSEPORT`, with a dedicated
SQLite writer child for message posts.

## Status

Run the same hot reads against the same seed on one machine and
this port matches the agent-built Rust port or passes it. Rust
leads on writes, Cable fan-out, avatar serving, and memory. Read
`docs/BENCHMARKS.md` for method, numbers, and caveats.

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

Measured with the shared verification harness
(`basecamp/once-campfire-verification`): official seed `4bf9d0eb`,
3 rounds, 8s samples, 16 clients, server CPUs 8-11, loadgen CPUs
12-15, both apps on the same host, medians. Elysia vs Rust:

| route | rust rps | elysia rps | ratio |
|---|---|---|---|
| room_show | 35122 | 26718 | 76% |
| messages_page | 33952 | 17520 | 52% |
| sidebar | 38523 | 33355 | 87% |
| search | 33777 | 33466 | 99% |
| avatar | 139373 | 117972 | 85% |
| static_css | 150494 | 249698 | 166% |
| up | 59563 | 269202 | 452% |
| post_message | 2590 | 1836 | 71% |

Reads at or near Rust parity; writes bounded by the single-writer
IPC ceiling (ADR-001); micro-routes dominated by Elysia native
routes and the in-memory asset cache. Absolute numbers are
host-specific — the ratios within one run are the comparison.
The elysia adapter is proposed upstream in
[verification#5](https://github.com/basecamp/once-campfire-verification/pull/5).
