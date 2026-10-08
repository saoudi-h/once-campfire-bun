// Dedicated SQLite writer (ADR-001). One process executes message-
// create transactions so HTTP workers never busy-sleep on the writer
// lock: they await responses instead (the loop keeps serving reads).
// Supervised by server.ts like HTTP workers. Protocol is
// newline-delimited JSON over a unix socket (same framing as
// fanout.ts): {id, op, ...params} -> {id, ok, row?} or
// {id, ok:false, status, message}.
import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import { initialize } from "./db.ts";
import { insertMessage } from "./domain.ts";

export function writerSocketPath(): string {
  const base =
    process.env.CAMPFIRE_STORAGE_PATH ||
    process.env.STORAGE_PATH ||
    "storage";
  return path.resolve(base, "tmp", "campfire-writer.sock");
}

function respond(socket: Bun.Socket, id: unknown, payload: Record<string, unknown>) {
  try {
    socket.write(JSON.stringify({ id, ...payload }) + "\n");
  } catch {
    // Reader gone; nothing to do.
  }
}

function handleLine(socket: Bun.Socket, line: string) {
  let req: any;
  try {
    req = JSON.parse(line);
  } catch {
    return;
  }
  if (!req || typeof req.id === "undefined") return;
  try {
    if (req.op === "message.create") {
      const row = insertMessage(
        Number(req.roomId),
        Number(req.userId),
        String(req.content ?? ""),
        req.clientId ?? randomUUID(),
      );
      respond(socket, req.id, { ok: true, row });
    } else {
      respond(socket, req.id, {
        ok: false,
        status: 400,
        message: "unknown op",
      });
    }
  } catch (error: any) {
    respond(socket, req.id, {
      ok: false,
      status: Number(error?.status) || 500,
      message: String(error?.message || "writer error"),
    });
  }
}

if (import.meta.main) {
  if (!process.env.CAMPFIRE_WRITER) {
    console.error("writer: CAMPFIRE_WRITER not set");
    process.exit(1);
  }
  initialize();
  const file = writerSocketPath();
  mkdirSync(path.dirname(file), { recursive: true });
  try {
    rmSync(file);
  } catch {
    // First boot.
  }
  Bun.listen({
    unix: file,
    socket: {
      open: () => {},
      data: (socket: Bun.Socket, data: Buffer) => {
        const peer = socket as Bun.Socket & { writerBuf?: string };
        peer.writerBuf = (peer.writerBuf || "") + data.toString("utf8");
        let newline = peer.writerBuf.indexOf("\n");
        while (newline >= 0) {
          const line = peer.writerBuf.slice(0, newline);
          peer.writerBuf = peer.writerBuf.slice(newline + 1);
          newline = peer.writerBuf.indexOf("\n");
          if (line) handleLine(socket, line);
        }
      },
      close: () => {},
      error: () => {},
    },
  });
  console.log("Campfire writer listening");
  const close = () => setTimeout(() => process.exit(0), 100).unref();
  process.on("SIGTERM", close);
  process.on("SIGINT", close);
}
