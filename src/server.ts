import { createApp } from "./app.ts";
import { startWorker, stopWorker } from "./jobs.ts";
import { startFanoutServer, connectFanout, fanout } from "./fanout.ts";
import { setFanout } from "./cable.ts";

const port = Number(process.env.HTTP_PORT || 8080);
const bind = process.env.BIND || "0.0.0.0";
const requested = Number(process.env.WEB_WORKERS || "1");
const workers =
  Number.isInteger(requested) && requested >= 1 && requested <= 64
    ? requested
    : 1;
const isWorker = Boolean(process.env.CAMPFIRE_WORKER);

if (workers > 1 && !isWorker) {
  // Master process: mirrors the Express app's node:cluster
  // primary. It runs the job queue, mediates Action Cable
  // fanout between workers, and supervises the HTTP workers.
  // HTTP traffic is balanced by the kernel across workers
  // sharing the port via SO_REUSEPORT.
  let shuttingDown = false;
  await startWorker();
  startFanoutServer();
  const children = new Set<Bun.Subprocess>();
  const spawnWorker = () => {
    if (shuttingDown) return;
    const child = Bun.spawn([process.execPath, import.meta.path], {
      env: { ...process.env, CAMPFIRE_WORKER: "1" },
      stdout: "inherit",
      stderr: "inherit",
    });
    children.add(child);
    child.exited.then(() => {
      children.delete(child);
      if (!shuttingDown) {
        console.error("Campfire HTTP worker exited; restarting");
        spawnWorker();
      }
    });
  };
  for (let i = 0; i < workers; i++) spawnWorker();
  console.log(
    `Campfire Bun master on ${port} with ${workers} workers`,
  );
  const close = () => {
    shuttingDown = true;
    for (const child of children) child.kill();
    stopWorker().finally(() =>
      setTimeout(() => process.exit(0), 100).unref(),
    );
  };
  process.on("SIGTERM", close);
  process.on("SIGINT", close);
} else {
  // Single-process mode, or an HTTP worker spawned by the
  // master. Workers share the listener port with SO_REUSEPORT.
  connectFanout();
  if (isWorker) setFanout(fanout);
  if (!isWorker) await startWorker();
  const app = createApp();
  app.listen({ port, hostname: bind, reusePort: workers > 1 });
  console.log(`Campfire Bun listening on ${port}`);
  const close = async () => {
    await stopWorker();
    (app as any).stop?.();
    setTimeout(() => process.exit(0), 1000).unref();
  };
  process.on("SIGTERM", close);
  process.on("SIGINT", close);
}
