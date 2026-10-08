// WAL checkpointer: runs on its own thread (Bun.Worker) with its own
// SQLite connections so fsyncs never stall the event loop. Woken with
// the database paths, then checkpoints passively once a WAL passes
// ~1,000 pages (SQLite's default autocheckpoint, which Rails keeps)
// and restarts it past ~10,000 pages to reclaim the file — PASSIVE
// never truncates, so without RESTART the file would grow forever
// (Rust Checkpoints port: passive in the background, restart at the
// WAL limit).
import { Database } from "bun:sqlite";
import { statSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

const scope = globalThis as unknown & {
  onmessage: ((event: { data: unknown }) => void) | null;
};

const PAGE_BYTES = 4096;
const PASSIVE_BYTES_TRIGGER = 1000 * PAGE_BYTES;
const RESTART_BYTES_TRIGGER = 10000 * PAGE_BYTES;
const FAST_MS = 100;
const SLOW_TICKS = 50;

let dbs = new Map<string, Database>();
let timer: ReturnType<typeof setInterval> | null = null;
let ticks = 0;

function walBytes(path: string): number {
  try {
    const st = statSync(path + "-wal", { throwIfNoEntry: false });
    if (typeof st === "object" && st !== null)
      return (st as { size: number }).size;
  } catch {
    // Missing WAL or raced deletion: nothing to do.
  }
  return 0;
}

function checkpoint(
  db: Database | undefined,
  mode: "PASSIVE" | "RESTART",
): boolean {
  try {
    const row = db
      ?.query(`PRAGMA wal_checkpoint(${mode})`)
      .get() as { busy?: number } | null | undefined;
    return row?.busy === 0;
  } catch {
    return false;
  }
}

function maybeCheckpoint(paths: string[]) {
  ticks++;
  for (const path of paths) {
    const size = walBytes(path);
    if (size < PASSIVE_BYTES_TRIGGER && ticks % SLOW_TICKS !== 0) continue;
    if (size >= RESTART_BYTES_TRIGGER) {
      // Reclaim the file; busy (readers/writer active) just retries
      // next tick — the writer never blocks on us.
      if (checkpoint(dbs.get(path), "RESTART")) continue;
    }
    checkpoint(dbs.get(path), "PASSIVE");
  }
}

scope.onmessage = (event: { data: unknown }) => {
  const msg = event.data;
  if (msg === "stop") {
    if (timer) clearInterval(timer);
    timer = null;
    for (const db of dbs.values()) {
      try {
        db.close();
      } catch {
        // Already closed.
      }
    }
    dbs = new Map();
    return;
  }
  const raw =
    msg !== null && typeof msg === "object"
      ? ((msg as { paths?: unknown }).paths ??
        ((msg as { path?: unknown }).path !== undefined
          ? [(msg as { path: string }).path]
          : []))
      : [];
  if (Array.isArray(raw) && dbs.size === 0) {
    for (const path of raw) {
      if (typeof path !== "string") continue;
      try {
        mkdirSync(dirname(path), { recursive: true });
        const db = new Database(path);
        db.exec("PRAGMA busy_timeout=10000;");
        dbs.set(path, db);
      } catch {
        // Unusable path: skip it.
      }
    }
    if (dbs.size > 0)
      timer = setInterval(() => maybeCheckpoint([...dbs.keys()]), FAST_MS);
  }
};
