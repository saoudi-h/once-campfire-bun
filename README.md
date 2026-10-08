# once-campfire-bun

A [Bun](https://bun.com) + [Elysia](https://elysiajs.com) port of
[ONCE Campfire](https://github.com/basecamp/once-campfire) (reference
checkout in `reference/`). It keeps the SQLite database, storage
layout, and signed/encrypted cookies, so existing installs keep
their data and sessions.

One Bun process replaces the Ruby/Node stack; `WEB_WORKERS>1` runs a
master (jobs, cable fanout, writer supervision) plus HTTP workers
sharing the port via `SO_REUSEPORT`, with a dedicated SQLite writer
child for message posts.

## Why this exists

Agent-built ports of Campfire were benchmarked per language, with
Rust far ahead — but only the Rust port received a serious
optimization loop. This port asks: how close can JavaScript get with
the same treatment? Measured with the Rust port's own harness
(`bench/run` + `loadgen`), interleaved reps, same seed, same CPUs:

| HTTP req/s, 16 clients (median of 3) | Bun | Rust | Bun adv. |
|---|---|---|---|
| Room page | 23,962 | 18,268 | 1.31x |
| Messages page | 20,961 | 20,132 | 1.04x |
| Sidebar | 19,575 | 16,963 | 1.15x |
| Search | 19,131 | 16,698 | 1.15x |
| Avatar | 106,816 | 137,370 | 0.78x |
| Static CSS | 194,882 | 139,787 | 1.39x |
| Health (`/up`) | 195,754 | 72,856 | 2.69x |
| Post a message | 4,008 | 4,794 | 0.84x |

Action Cable (frames/s delivered): 100 clients 157k vs 262k
(0.60x), 500 clients 180k vs 256k (0.70x), 1000 clients 158k vs
248k (0.63x). Upload 505KB JPEG to thumbnail: 49ms vs 39ms
(0.79x); thumbnail GET alone 1.3ms vs 0.2ms. Writes trail on the
cross-process SQLite writer lock; thumbnail serving hops through
redirects. See `.autonomos/worklogs/` for the full story and
`bin/bench-compare.sh` to reproduce.

## Develop

```bash
bun install
bun bin/test.js   # one bun test process per file (DB isolation)
bun run typecheck
bun src/server.ts # dev server (HTTP_PORT, WEB_WORKERS, BIND)
```

Production image: `docker build -t campfire-bun .` then run with
`SECRET_KEY_BASE`, `VAPID_*` keys and a storage volume at
`CAMPFIRE_STORAGE_PATH` (see `Dockerfile`).

## Benchmark

Prerequisites: Docker, the sibling `once-campfire-rust` checkout
(provides `bench/loadgen` and the seed), and pinned CPUs.

```bash
# One-time: build both production images
docker build -t campfire-bun:bench .
# (rust image) docker build -t campfire-rust:app <rust repo>

# Interleaved compare: fresh seed per run, warmup, alternating order
./bin/bench-compare.sh --reps 3 --suites http --concs "1 16" --out bench/results/<stamp>
./bin/bench-compare.sh --reps 3 --rep-from 1 --suites cable --out bench/results/<stamp>
python3 bin/bench-report.py bench/results/<stamp>

# CPU/RAM scaling, 1 to 8 server threads (loadgen stays put)
./bin/bench-scale.sh --out bench/results/scale-<stamp>
```

Compare ratios on the same host, never absolute numbers across
hosts. Raw JSON lands in `bench/results/` (gitignored); headline
tables are recorded in `.autonomos/worklogs/`.

Tune memory on small servers with `CAMPFIRE_CACHE_MB`
(per-cache `CAMPFIRE_<FRAGMENT|PAGE|GZIP|BODY>_CACHE_MB`);
defaults (32MB each) are the benchmarked performance.

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
