# Benchmarks

Compare two deployments on one host with these numbers. Do not
compare absolutes across hosts.

## Method

I use the Rust port's own tooling: `bench/run` essentials plus
`bench/loadgen` (a plain HTTP/1.1 and Action Cable client that
prints one JSON object per command). My wrapper
`bin/bench-compare.sh` follows the same protocol: fresh seed copy
per run, pinned CPUs (server `8-11`, loadgen `12-15`),
`--network host`, warmup then measure, alternating Bun/Rust order
per rep. `bin/bench-report.py` reduces a results dir to median
[min-max] per app.

```bash
# One-time: build both production images (pass the revision so env.txt
# ties the report to an exact checkout)
docker build --build-arg REVISION=$(git rev-parse --short HEAD) -t campfire-bun:bench .
# (rust image) docker build --build-arg GIT_REVISION=$(git -C <rust repo> rev-parse HEAD) -t campfire-rust:app <rust repo>

# Interleaved compare: fresh seed per run, warmup, alternating order
./bin/bench-compare.sh --reps 3 --suites http --concs "1 16" --out bench/results/<stamp>
./bin/bench-compare.sh --reps 3 --rep-from 1 --suites cable --out bench/results/<stamp>
python3 bin/bench-report.py bench/results/<stamp>

# CPU/RAM scaling, 1 to 8 server threads (loadgen stays put)
./bin/bench-scale.sh --out bench/results/scale-<stamp>
```

Raw JSON lands in `bench/results/` (gitignored); headline tables
live in `.autonomos/worklogs/`. Each run writes `env.txt` with
date, host, CPU pinning, bench parameters, image digests, and both
checkouts' revisions (Bun `HEAD`, Rust `HEAD` plus the Rust image's
baked `GIT_REVISION`).

The tooling guards the proof: each rep aborts on any HTTP error,
non-2xx status, incomplete cable subscription, or empty upload run;
the report lists errors from all reps; a "Response sizes" section
compares average wire bytes per route and flags non-equivalent
comparisons.

## Scope

The workload hits the same URLs with the same account against warm
caches. You measure these hot responses. You learn nothing about
cold caches, many distinct users, or reads mixed with writes.

Two architecture notes before you read the table:

- `/up` skips my compat pipeline while Rust answers through its
  front server. The gap describes the two deployments I tested.
- The apps serve different CSS byte counts (see below), so that row
  compares throughput on different payloads.

## Results (3 reps, median)

HTTP req/s at 16 concurrent connections, Bun `WEB_WORKERS=4` vs
Rust nominal, one host, one seed. Full per-rep tables with
min-max: `.autonomos/worklogs/2026-10-08-PUBLISH-03.md`.

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
(0.79x); thumbnail GET alone 1.3ms vs 0.2ms.

Latency sits next to throughput: at 16 connections, POST p99 runs
~12ms for Bun vs ~6ms for Rust; the messages page p99 runs ~2.7ms
vs ~1.5ms.

Memory is the gap on small servers: idle ~160MB vs ~18MB at 4
CPUs, peak ~690MB vs ~140MB under load. Each worker carries a Bun
runtime baseline plus its own caches. Cap them with
`CAMPFIRE_CACHE_MB`
(per-cache `CAMPFIRE_<FRAGMENT|PAGE|GZIP|BODY>_CACHE_MB`); smaller
caps evict more on large working sets. I benchmarked with the 32MB
defaults.

## Response-size caveats

Wire bytes (gzip negotiated) from the same runs:

| Route (c=16) | Bun bytes | Rust bytes | Reading |
|---|---|---|---|
| Room page | 24,280 | 24,231 | Like-for-like |
| Messages page | 14,711 | 16,158 | Close, review before claiming |
| Sidebar | 1,903 | 5,910 | Pre-parity data, see below |
| Search | 10,804 | 9,766 | ~10% apart, review before claiming |
| Avatar | 4,004 | 3,368 | Different encodings served |
| Static CSS | 1,218 | 654 | Different byte counts |
| Post a message | 1,883 | 1,993 | Like-for-like |

The sidebar size predates the AUDIT-01 parity fix (I restored
placeholders, render the full page on plain GET, re-measured
19,575 vs 16,963 i.e. 1.15x;
`.autonomos/worklogs/2026-10-08-AUDIT-01.md`). The sidebar
throughput above is the post-fix number; its size row needs a
fresh run.

## Reproducing and refreshing

Rebuild both images with revision args and run a fresh full 3-rep
before you quote these numbers anywhere. You refresh the sidebar
sizes post-AUDIT-01 and you tie `env.txt` to exact checkouts. The
current `campfire-bun:bench` image predates revision labels
(`revision=local`).

Two gaps stay open: mixed multi-account read/write load (the
loadgen takes one cookie per call, so you need a new suite, not a
flag) and direct thumbnail serving (PERF-16: 1.3ms vs 0.2ms on
thumbnail GET alone through my redirect chain).
