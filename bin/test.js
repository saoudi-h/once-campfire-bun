#!/usr/bin/env bun
import { spawnSync } from "node:child_process";
import { mkdirSync, readdirSync } from "node:fs";
import path from "node:path";
const scratch = path.resolve("tmp/tests");
mkdirSync(scratch, { recursive: true });
const files = readdirSync("test")
  .filter((name) => name.endsWith(".test.ts"))
  .sort()
  .map((name) => "test/" + name);
// One Bun process per file, mirroring `node --test` isolation: each test file
// initializes its own SQLite database via process.env.DATABASE_PATH.
let status = 0;
for (const file of files) {
  const result = spawnSync(process.execPath, ["test", file], {
    stdio: "inherit",
    env: { ...process.env, TMPDIR: scratch },
  });
  if (result.error) throw result.error;
  if (result.status !== 0) status = result.status ?? 1;
}
process.exit(status);
