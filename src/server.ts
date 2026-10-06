import { createApp } from "./app.ts";
import { startWorker, stopWorker } from "./jobs.ts";

const port = Number(process.env.HTTP_PORT || 8080);
const bind = process.env.BIND || "0.0.0.0";
await startWorker();
const app = createApp();
app.listen({ port, hostname: bind });
console.log(`Campfire Bun listening on ${port}`);
const close = async () => {
  await stopWorker();
  (app as any).stop?.();
  setTimeout(() => process.exit(0), 1000).unref();
};
process.on("SIGTERM", close);
process.on("SIGINT", close);
