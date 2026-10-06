// Multi-process cable fanout: boots the real server with
// WEB_WORKERS=2, distributes WebSocket clients across the
// SO_REUSEPORT workers, publishes through the HTTP bot
// endpoint, and asserts every client receives the frame —
// proving the master's fanout socket reaches clients
// connected to a different worker than the publisher.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initialize, run, now } from "../src/db.ts";
import { signCookie, signStream, stream } from "../src/rails.ts";

let storage: string, server: Bun.Subprocess, port: number;
const room = { id: 1, type: "Rooms::Open" };

before(() => {
  storage = mkdtempSync(join(tmpdir(), "campfire-fanout-"));
  process.env.DATABASE_PATH = join(storage, "app.sqlite3");
  process.env.CAMPFIRE_STORAGE_PATH = storage;
  process.env.SECRET_KEY_BASE = "fanout-test-secret";
  port = 20000 + (process.pid % 20000);
  initialize();
  const t = now();
  for (const id of [1, 2])
    run(
      "INSERT INTO users(id,name,role,status,bot_token,created_at,updated_at) VALUES(?,?,?,0,?,?,?)",
      id,
      "User" + id,
      id === 2 ? 2 : 0,
      id === 2 ? "fanout-bot-token" : null,
      t,
      t,
    );
  run(
    "INSERT INTO rooms(id,name,type,creator_id,created_at,updated_at) VALUES(1,?, ?,1,?,?)",
    "Public",
    room.type,
    t,
    t,
  );
  for (const id of [1, 2])
    run(
      "INSERT INTO memberships(room_id,user_id,created_at,updated_at) VALUES(1,?,?,?)",
      id,
      t,
      t,
    );
  run(
    "INSERT INTO sessions(id,user_id,token,last_active_at,created_at,updated_at) VALUES(1,1,?,?,?,?)",
    "fanout-token",
    t,
    t,
    t,
  );
  server = Bun.spawn([process.execPath, "src/server.ts"], {
    cwd: import.meta.dir + "/..",
    env: {
      ...process.env,
      HTTP_PORT: String(port),
      BIND: "127.0.0.1",
      WEB_WORKERS: "2",
    },
    stdout: "ignore",
    stderr: "ignore",
  });
});

after(() => {
  server.kill();
  rmSync(storage, { recursive: true, force: true });
});

async function wait(predicate: () => boolean | Promise<boolean>, ms = 10000) {
  const end = Date.now() + ms;
  while (!(await predicate())) {
    if (Date.now() > end) throw new Error("fanout test timeout");
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

test("cable frames published on one worker reach clients on every worker", async () => {
  const base = `http://127.0.0.1:${port}`;
  const cookie =
    "session_token=" +
    encodeURIComponent(signCookie("session_token", "fanout-token"));
  await wait(async () => {
    try {
      const res = await fetch(base + "/rooms/1", {
        headers: { cookie },
        redirect: "manual",
      });
      return res.status < 500;
    } catch {
      return false;
    }
  });

  const identifier = JSON.stringify({
    channel: "RoomMessagesChannel",
    signed_stream_name: signStream(stream(room)),
  });
  type Client = { ws: WebSocket; frames: any[] };
  const clients: Client[] = [];
  for (let i = 0; i < 6; i++) {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/cable`, {
      headers: { cookie },
      protocols: ["actioncable-v1-json"],
    } as any);
    const frames: any[] = [];
    const opened = new Promise<void>((resolve, reject) => {
      ws.onopen = () => resolve();
      ws.onerror = () => reject(new Error("socket error"));
    });
    ws.onmessage = (e) => frames.push(JSON.parse(String(e.data)));
    await opened;
    ws.send(JSON.stringify({ command: "subscribe", identifier }));
    clients.push({ ws, frames });
  }
  try {
    await wait(() =>
      clients.every((c) =>
        c.frames.some((f) => f.type === "confirm_subscription"),
      ),
    );
    const res = await fetch(
      base + "/rooms/1/2-fanout-bot-token/messages",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ body: "fanout-test-message" }),
      },
    );
    assert.equal(res.status, 201);
    await wait(() =>
      clients.every((c) =>
        c.frames.some((f) => f.message?.includes?.("fanout-test-message")),
      ),
    );
    for (const client of clients)
      assert(
        client.frames.some((f) => f.message?.includes?.("fanout-test-message")),
        "client missed the cross-worker publication",
      );
  } finally {
    for (const client of clients) client.ws.close();
  }
});
