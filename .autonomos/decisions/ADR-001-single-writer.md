# ADR-001 — Dedicated writer process for plain message posts

- Status: accepted
- Scope: write path (`POST /rooms/:id/messages` without attachments)
- Provenance: PERF-06 measurements, PERF-10 task
- Related specs: none
- Superseded by: n/a

## Context

`bun:sqlite` is synchronous: all 4 HTTP workers share one SQLite file,
and lock waits happen as blocking busy-sleeps on the event loop.
Measured (fresh seed per run, c=16): 1 worker 2252 rps, 2 workers
2526, 4 workers 2383, p99 14/19/38ms, loops idle ~40% with work
pending. The ceiling is ~1 write-txn, not CPU. The bench write
volume is ~99% plain-text message posts.

## Decision (proposed)

Route attachment-less message POSTs through a dedicated writer child
process over a unix socket (newline-delimited JSON, like `fanout.ts`):

- Worker sanitizes (CPU, no DB), sends `{roomId, userId, content,
  clientId}`, awaits the row (await yields the loop; no busy-sleep).
- Writer executes today's `createMessage` statements unchanged
  (INSERT..SELECT membership fold, rich row, FTS, touches) on its own
  connection and replies with the row JSON (403/422/500 mapped).
- Publish/notify/render stay on the worker. Attachment posts, edits,
  deletes, boosts keep direct access (rare, negligible contention).
- Single-process mode and tests keep local writes (fallback when no
  writer channel); no behavior fork under bench/prod config.
- Master supervises the writer child like HTTP workers (restart on
  exit). Writer death fails plain posts loudly until restart.

Expected: writer loop does txns only (~0.3ms) -> ~3000+ rps ceiling,
FIFO service collapses p99, loops stay free for reads. Unlocks later
group-commit batching at the writer.

## Alternatives considered

- Deferred FTS/unread batcher: rejected, core.test.ts pins
  synchronous FTS after POST.
- Bun.Worker DB threads per process: frees loops but keeps the same
  file-level contention and ceiling.
- Full write-service (all mutations via IPC): same machinery for
  rare paths; deferred until proven necessary.
- Do nothing: accept x1.6 on writes and the p99 tails.

## Consequences

- New process + IPC protocol to supervise and secure (socket file
  permissions, bounded queue, fail-loud on writer death).
- Two write paths (IPC + local fallback); tests cover local, bench
  covers IPC.
- No durability change: same statements, same file, same pragmas.
