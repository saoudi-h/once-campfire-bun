// Background WAL checkpoint management. SQLite's auto-checkpoint (and
// Rails keeps the default: every ~1,000 WAL pages) runs inside the
// committing transaction on the writer — on bun:sqlite that is the
// event loop thread, so every ~64 posts stalls ~12ms in fsyncs. The
// main connection disables it (see db.ts); this module runs PASSIVE
// checkpoints on a worker thread instead (Rust Checkpoints port).
import { resolve, join } from "node:path";

let worker: Worker | null = null;

function databaseFiles(): string[] {
  const storage =
    process.env.CAMPFIRE_STORAGE_PATH ||
    process.env.STORAGE_PATH ||
    "storage";
  const main =
    process.env.DATABASE_PATH || join(storage, "db/production.sqlite3");
  const jobs =
    process.env.JOBS_DATABASE_PATH || join(storage, "db/jobs.sqlite3");
  return [main, jobs].filter(
    (file, i, all) => file !== ":memory:" && all.indexOf(file) === i,
  );
}

export function startCheckpointer(): void {
  if (worker) return;
  const files = databaseFiles().map((file) => resolve(file));
  if (!files.length) return;
  try {
    worker = new Worker(new URL("./checkpoint-worker.ts", import.meta.url));
    worker.postMessage({ paths: files });
    worker.unref();
  } catch {
    worker = null;
  }
}

export function stopCheckpointer(): void {
  const w = worker;
  worker = null;
  try {
    w?.postMessage("stop");
  } catch {
    // Already gone.
  }
}
