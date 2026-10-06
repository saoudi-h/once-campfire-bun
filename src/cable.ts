import { get, run, now, transaction } from "./db.ts";
import * as rails from "./rails.ts";
// Keep the socket module independent from the HTTP router to avoid import cycles.

// Per-socket Action Cable client state. The identity fields
// (session_id/user_id/name) come from the verified session cookie.
interface CableClient {
  session_id: number;
  user_id: number;
  name: string;
  // Bun/Elysia WebSocket; only close/send/readyState/
  // getBufferedAmount are exercised here.
  ws: any;
  subscriptions: Map<string, CableSubscription>;
}

interface CableSubscription {
  channel: string;
  room: number;
  stream: string;
  present?: boolean;
}

function identity(header = "") {
  try {
    const part = header
      .split(";")
      .find((p) => p.trim().startsWith("session_token="));
    if (!part) return null;
    const raw = part.trim().slice("session_token=".length),
      token = rails.verifyCookie("session_token", raw) as string;
    return get(
      "SELECT s.id AS session_id,u.id AS user_id,u.name FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token=? AND u.status=0 AND u.role<>2",
      token,
    );
  } catch {
    return null;
  }
}
const clients = new Set<CableClient>();
const wsClients = new WeakMap<object, CableClient>();
function alive(client: CableClient) {
  return Boolean(
    get(
      "SELECT s.id FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.id=? AND s.user_id=? AND u.status=0 AND u.role<>2",
      client.session_id,
      client.user_id,
    ),
  );
}
function authorize(client: CableClient, identifier: string): CableSubscription | null {
  try {
    if (!alive(client)) return null;
    const p = JSON.parse(identifier);
    if (!p || typeof p !== "object" || Array.isArray(p)) return null;
    const channel = p.channel;
    let room = 0,
      stream = "";
    if (["ApplicationCable::Channel", "HeartbeatChannel"].includes(channel)) {
    } else if (["ReadRoomsChannel", "UnreadRoomsChannel"].includes(channel))
      stream = `user_${client.user_id}_${channel === "ReadRoomsChannel" ? "reads" : "unreads"}`;
    else if (channel === "RoomMessagesChannel") {
      stream = rails.verifyStream(p.signed_stream_name) as string;
      if (typeof stream !== "string") return null;
      const [encoded, suffix, ...rest] = stream.split(":");
      if (suffix !== "messages" || rest.length) return null;
      const m = rails
        .decode64(encoded)
        .toString()
        .match(
          /^gid:\/\/campfire\/(Room|Rooms::Open|Rooms::Closed|Rooms::Direct)\/(\d+)$/,
        );
      if (!m) return null;
      room = Number(m[2]);
      const r = get(
        "SELECT r.* FROM rooms r JOIN memberships m ON m.room_id=r.id WHERE r.id=? AND m.user_id=?",
        room,
        client.user_id,
      );
      if (!r || !["Room", r.type].includes(m[1])) return null;
    } else if (
      ["RoomChannel", "PresenceChannel", "TypingNotificationsChannel"].includes(
        channel,
      )
    ) {
      room = Number(p.room_id);
      if (
        !Number.isSafeInteger(room) ||
        !get(
          "SELECT id FROM memberships WHERE room_id=? AND user_id=?",
          room,
          client.user_id,
        )
      )
        return null;
      stream = channel + ":" + room;
    } else if (channel === "Turbo::StreamsChannel") {
      stream = rails.verifyStream(p.signed_stream_name) as string;
      const own =
        Buffer.from(`gid://campfire/User/${client.user_id}`)
          .toString("base64")
          .replace(/=+$/, "") + ":rooms";
      if (!["rooms", own].includes(stream)) return null;
    } else return null;
    return { channel, room, stream };
  } catch {
    return null;
  }
}
export const OPEN = 1;
function bufferedAmount(ws: any): number {
  try {
    if (typeof ws.getBufferedAmount === "function") return ws.getBufferedAmount();
    return (ws as any).bufferedAmount || 0;
  } catch { return 0; }
}
export function closeSocket(ws: any, code = 1000) {
  try {
    if (typeof ws.close === "function") ws.close(code);
  } catch {}
}
function isOpen(ws: any): boolean {
  try {
    if (typeof ws.readyState === "number") return ws.readyState === OPEN;
    return true;
  } catch { return false; }
}
function frame(client: CableClient, value: unknown) {
  if (!isOpen(client.ws)) return;
  if (bufferedAmount(client.ws) > 1024 * 1024) {
    try { client.ws.close(1013, "slow consumer"); } catch {}
    return;
  }
  try { client.ws.send(JSON.stringify(value)); } catch {}
}
export function deliver(stream: string, message: unknown) {
  for (const client of clients) {
    if (!alive(client)) {
      frame(client, {
        type: "disconnect",
        reason: "unauthorized",
        reconnect: false,
      });
      closeSocket(client.ws, 1008);
      continue;
    }
    for (const [identifier, sub] of client.subscriptions) {
      if (sub.stream !== stream) continue;
      if (!authorize(client, identifier)) {
        client.subscriptions.delete(identifier);
        frame(client, { type: "reject_subscription", identifier });
        continue;
      }
      frame(client, { identifier, message });
    }
  }
}
// Fanout hook: single-process Bun delivers directly. Multi-worker fanout
// is wired in server.ts via a shared BroadcastChannel/redis if enabled.
export let fanout: ((stream: string, message: unknown) => void) | null = null;
export function setFanout(fn: ((stream: string, message: unknown) => void) | null) {
  fanout = fn;
}
export function publish(stream: string, message: unknown) {
  deliver(stream, message);
  try { fanout?.(stream, message); } catch {}
}
function presence(user: number, room: number, action: string) {
  transaction(() => {
    const m = get(
      "SELECT * FROM memberships WHERE user_id=? AND room_id=?",
      user,
      room,
    );
    if (!m) return;
    const active =
      m.connected_at &&
      new Date(m.connected_at.replace(" ", "T") + "Z").getTime() >=
        Date.now() - 60000;
    if (["present", "refresh"].includes(action)) {
      const count = active
        ? action === "present"
          ? Number(m.connections) + 1
          : Number(m.connections)
        : 1;
      run(
        "UPDATE memberships SET connections=?,connected_at=?,unread_at=NULL,updated_at=? WHERE id=?",
        count,
        now(),
        now(),
        m.id,
      );
    } else {
      const count = active ? Math.max(0, Number(m.connections) - 1) : 0;
      run(
        "UPDATE memberships SET connections=?,connected_at=?,updated_at=? WHERE id=?",
        count,
        count ? m.connected_at : null,
        now(),
        m.id,
      );
    }
  });
  if (action === "present") publish(`user_${user}_reads`, { room_id: room });
}

function dropClient(client: CableClient) {
  clients.delete(client);
  try {
    for (const sub of client.subscriptions.values())
      if (sub.channel === "PresenceChannel" && sub.present)
        presence(client.user_id, sub.room, "absent");
  } catch {}
}

// raw is a WebSocket text frame (or an Elysia pre-parsed
// JSON object re-stringified by the caller): genuinely dynamic.
function handleSocketMessage(client: CableClient, raw: any, isBinary: boolean) {
  const ws = client.ws;
  if (isBinary) {
    closeSocket(ws, 1003);
    return;
  }
  try {
    const msg = JSON.parse(Buffer.isBuffer(raw) ? raw.toString() : String(raw));
    const identifier = msg.identifier;
    if (typeof identifier !== "string" || identifier.length > 8192)
      return closeSocket(ws, 1008);
    if (msg.command === "subscribe") {
      if (client.subscriptions.size >= 32 && !client.subscriptions.has(identifier))
        return closeSocket(ws, 1008);
      const sub = authorize(client, identifier);
      if (!sub) {
        frame(client, { type: "reject_subscription", identifier });
        return;
      }
      if (sub.channel === "PresenceChannel") {
        const existing = client.subscriptions.get(identifier);
        sub.present = existing ? existing.present : true;
        if (!existing) presence(client.user_id, sub.room, "present");
      }
      client.subscriptions.set(identifier, sub);
      frame(client, { type: "confirm_subscription", identifier });
    } else if (msg.command === "unsubscribe") {
      const sub = client.subscriptions.get(identifier);
      if (sub?.channel === "PresenceChannel" && sub.present)
        presence(client.user_id, sub.room, "absent");
      client.subscriptions.delete(identifier);
    } else if (msg.command === "message" && client.subscriptions.has(identifier)) {
      const sub = authorize(client, identifier);
      if (!sub) return;
      const body = JSON.parse(msg.data);
      if (sub.channel === "PresenceChannel") {
        // The enclosing branch already checked has(identifier).
        const stored = client.subscriptions.get(identifier)!;
        if (body.action === "refresh" && stored.present)
          presence(client.user_id, sub.room, "refresh");
        else if (body.action === "absent" && stored.present) {
          presence(client.user_id, sub.room, "absent");
          stored.present = false;
        } else if (body.action === "present" && !stored.present) {
          presence(client.user_id, sub.room, "present");
          stored.present = true;
        }
      } else if (
        sub.channel === "TypingNotificationsChannel" &&
        ["start", "stop"].includes(body.action)
      )
        publish(sub.stream, {
          action: body.action,
          user: { id: client.user_id, name: client.name },
        });
    }
  } catch {
    closeSocket(ws, 1008);
  }
}

export function cableUpgradeCheck(ctx: any): { ok: boolean; status?: number; identity?: any } {
  const headers: Record<string, string> = {};
  try {
    (ctx.request as Request).headers.forEach((v: string, k: string) => (headers[k.toLowerCase()] = v));
  } catch {}
  const origin = headers["origin"];
  const host = headers["host"] || new URL(ctx.request.url).host;
  const remote = String((ctx as any).server?.requestIP?.(ctx.request)?.address || "").replace(/^::ffff:/, "");
  const trusted = (process.env.TRUSTED_PROXIES || "").split(",").includes(remote);
  const forwarded = trusted && (headers["x-forwarded-proto"] as string);
  const protocol = forwarded === "https" ? "https" : "http";
  if (origin && origin !== protocol + "://" + host) return { ok: false, status: 403 };
  const id = identity(headers["cookie"]);
  const proto = (headers["sec-websocket-protocol"] || "").split(",").map((x: string) => x.trim());
  if (!id || !proto.includes("actioncable-v1-json")) return { ok: false, status: 401 };
  return { ok: true, identity: id };
}

export const cableWs: any = {
  maxPayloadLength: 64 * 1024,
  beforeHandle: (ctx: any) => {
    const check = cableUpgradeCheck(ctx);
    if (!check.ok) return new Response(check.status === 403 ? "Forbidden" : "Unauthorized", { status: check.status });
    (ctx as any).cableIdentity = check.identity;
  },
  open: (ws: any) => {
    const id = (ws.data as any)?.cableIdentity ?? (ws.data as any)?.elysia?.cableIdentity ?? (ws as any).data?.cableIdentity;
    if (!id) {
      try { ws.close(1008); } catch {}
      return;
    }
    const client = { ...id, ws, subscriptions: new Map() };
    wsClients.set(ws, client);
    try { (ws.data as any).cableClient = client; } catch {}
    clients.add(client);
    frame(client, { type: "welcome" });
  },
  message: (ws: any, message: any) => {
    const client = wsClients.get(ws) ?? (ws.data as any)?.cableClient ?? (ws.data as any)?.elysia?.cableClient;
    if (!client) return;
    // Elysia pre-parses JSON text frames into objects; normalize back.
    if (message !== null && typeof message === "object" && !(message instanceof ArrayBuffer) && !(message instanceof Uint8Array) && !Buffer.isBuffer(message)) {
      handleSocketMessage(client, JSON.stringify(message), false);
      return;
    }
    const isBinary = message instanceof ArrayBuffer || message instanceof Uint8Array || Buffer.isBuffer(message);
    handleSocketMessage(client, message, isBinary);
  },
  close: (ws: any) => {
    const client = wsClients.get(ws) ?? (ws.data as any)?.cableClient ?? (ws.data as any)?.elysia?.cableClient;
    if (client) dropClient(client);
  },
};

let pingTimer: ReturnType<typeof setInterval> | null = null;
export function startCablePing() {
  if (pingTimer) return;
  pingTimer = setInterval(() => {
    for (const client of [...clients]) {
      if (!alive(client)) {
        frame(client, { type: "disconnect", reason: "unauthorized", reconnect: false });
        closeSocket(client.ws, 1008);
        dropClient(client);
      } else frame(client, { type: "ping", message: Math.floor(Date.now() / 1000) });
    }
  }, 3000);
  (pingTimer as any).unref?.();
}
export function stopCablePing() {
  if (pingTimer) clearInterval(pingTimer);
  pingTimer = null;
}
