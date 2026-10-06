import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { initialize, run, get, now } from "../src/db.ts";
import { cableWs, publish } from "../src/cable.ts";
import { signCookie, signStream, stream } from "../src/rails.ts";
let app: any, base: string, storage: string;
const room = { id: 1, type: "Rooms::Open" };
before(async () => {
  mkdirSync("tmp", { recursive: true });
  storage = mkdtempSync("tmp/cable-");
  process.env.DATABASE_PATH = storage + "/app.sqlite3";
  process.env.SECRET_KEY_BASE = "native-cable-tests-only";
  initialize();
  const t = now();
  for (const id of [1, 2])
    run(
      "INSERT INTO users(id,name,role,status,created_at,updated_at) VALUES(?,?,0,0,?,?)",
      id,
      "User" + id,
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
  run(
    "INSERT INTO memberships(room_id,user_id,created_at,updated_at) VALUES(1,1,?,?)",
    t,
    t,
  );
  run(
    "INSERT INTO sessions(id,user_id,token,last_active_at,created_at,updated_at) VALUES(1,1,?,?,?,?)",
    "socket-token",
    t,
    t,
    t,
  );
  const { Elysia } = await import("elysia");
  const { websocket } = await import("elysia/websocket");
  app = new Elysia({ aot: false })
    .use(websocket())
    .ws("/cable", cableWs)
    .listen({ port: 0, hostname: "127.0.0.1" });
  await new Promise((r) => setTimeout(r, 100));
  base = `ws://127.0.0.1:${(app.server as any).port}/cable`;
});
after(() => {
  try { app?.stop(); } catch {}
  rmSync(storage, { recursive: true, force: true });
});
type Frame = any;
async function connect(): Promise<{ ws: WebSocket; frames: Frame[] }> {
  const ws = new WebSocket(base, {
    headers: {
      cookie:
        "session_token=" +
        encodeURIComponent(signCookie("session_token", "socket-token")),
    },
    protocols: ["actioncable-v1-json"],
  } as any);
  const frames: Frame[] = [];
  const opened = new Promise<void>((resolve, reject) => {
    ws.onopen = () => resolve();
    ws.onerror = () => reject(new Error("socket error"));
  });
  ws.onmessage = (e) => frames.push(JSON.parse(String(e.data)));
  await opened;
  return { ws, frames };
}
function closePromise(ws: WebSocket): Promise<unknown> {
  return new Promise((resolve) => ws.addEventListener("close", resolve, { once: true }));
}
async function wait(predicate: () => boolean) {
  const end = Date.now() + 1500;
  while (!predicate()) {
    if (Date.now() > end) throw new Error("socket timeout");
    await new Promise((r) => setTimeout(r, 5));
  }
}
const id = () =>
  JSON.stringify({
    channel: "RoomMessagesChannel",
    signed_stream_name: signStream(stream(room)),
  });
test("Action Cable authenticates, subscribes and delivers native publications", async () => {
  const { ws, frames } = await connect();
  const identifier = id();
  ws.send(JSON.stringify({ command: "subscribe", identifier }));
  await wait(() => frames.some((f) => f.type === "confirm_subscription"));
  publish(stream(room), "<turbo-stream>actual message</turbo-stream>");
  await wait(() => frames.some((f) => f.message?.includes?.("actual message")));
  assert.equal(frames[0].type, "welcome");
  const closed = closePromise(ws);
  ws.close();
  await closed;
});
test("Action Cable rejects forged signed streams and revoked membership", async () => {
  const { ws, frames } = await connect();
  const forged = JSON.stringify({
    channel: "RoomMessagesChannel",
    signed_stream_name: "forged",
  });
  ws.send(JSON.stringify({ command: "subscribe", identifier: forged }));
  await wait(() => frames.some((f) => f.type === "reject_subscription"));
  const identifier = id();
  ws.send(JSON.stringify({ command: "subscribe", identifier }));
  await wait(() => frames.some((f) => f.type === "confirm_subscription"));
  run("DELETE FROM memberships WHERE room_id=1 AND user_id=1");
  publish(stream(room), "private-after-revoke");
  await wait(() =>
    frames.some(
      (f) => f.type === "reject_subscription" && f.identifier === identifier,
    ),
  );
  assert(!frames.some((f) => f.message === "private-after-revoke"));
  const t = now();
  run(
    "INSERT INTO memberships(room_id,user_id,created_at,updated_at) VALUES(1,1,?,?)",
    t,
    t,
  );
  const closed = closePromise(ws);
  ws.close();
  await closed;
});
test("Presence refresh supports simultaneous tabs and uses room_id reads", async () => {
  const a = await connect(),
    b = await connect();
  const identifier = JSON.stringify({ channel: "PresenceChannel", room_id: 1 });
  for (const c of [a, b])
    c.ws.send(JSON.stringify({ command: "subscribe", identifier }));
  await wait(
    () =>
      get("SELECT connections FROM memberships WHERE room_id=1 AND user_id=1")
        .connections === 2,
  );
  a.ws.send(
    JSON.stringify({
      command: "message",
      identifier,
      data: JSON.stringify({ action: "refresh" }),
    }),
  );
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(
    get("SELECT connections FROM memberships WHERE room_id=1 AND user_id=1")
      .connections,
    2,
  );
  const closedA = closePromise(a.ws);
  a.ws.close();
  await closedA;
  await wait(
    () =>
      get("SELECT connections FROM memberships WHERE room_id=1 AND user_id=1")
        .connections === 1,
  );
  const closedB = closePromise(b.ws);
  b.ws.close();
  await closedB;
  await wait(
    () =>
      get("SELECT connections FROM memberships WHERE room_id=1 AND user_id=1")
        .connections === 0,
  );
});
test("Logout immediately prevents further delivery to an existing socket", async () => {
  const { ws, frames } = await connect();
  ws.send(JSON.stringify({ command: "subscribe", identifier: id() }));
  await wait(() => frames.some((f) => f.type === "confirm_subscription"));
  run("DELETE FROM sessions WHERE id=1");
  const closed = closePromise(ws);
  publish(stream(room), "after-logout");
  await closed;
  assert(!frames.some((f) => f.message === "after-logout"));
  assert(frames.some((f) => f.type === "disconnect" && f.reconnect === false));
  // Restore the session so later runs (shared process) stay independent.
  const t = now();
  run(
    "INSERT INTO sessions(id,user_id,token,last_active_at,created_at,updated_at) VALUES(1,1,?,?,?,?)",
    "socket-token",
    t,
    t,
    t,
  );
});
test("Unauthenticated sockets are denied before upgrade", async () => {
  const ws = new WebSocket(base, ["actioncable-v1-json"] as any);
  const settled = new Promise<void>((resolve) => {
    ws.onerror = () => resolve();
    ws.onopen = () => resolve();
  });
  await settled;
  assert.equal(ws.readyState, WebSocket.CLOSED);
});
