// Cross-process Action Cable fanout.
//
// Workers connect as clients over a unix socket; the master echoes
// every frame to all other workers, so WebSocket clients on any
// worker receive messages published through any other worker.
// (Bun has no cluster module, and BroadcastChannel does not cross
// process boundaries.)
import { deliver } from "./cable.ts";
import { mkdirSync, rmSync } from "node:fs";
import path from "node:path";

interface FanoutFrame {
  stream: string;
  message: unknown;
}

function socketPath(): string {
  const base =
    process.env.CAMPFIRE_STORAGE_PATH ||
    process.env.STORAGE_PATH ||
    "storage";
  return path.resolve(base, "tmp", "cable-fanout.sock");
}

// --- master side: echo every frame to all other workers ---
export function startFanoutServer(): void {
  const file = socketPath();
  mkdirSync(path.dirname(file), { recursive: true });
  try {
    rmSync(file);
  } catch {}
  const peers = new Set<Bun.Socket>();
  const server = Bun.listen({
    unix: file,
    socket: {
      open: (socket: Bun.Socket) => {
        peers.add(socket);
      },
      data: (socket: Bun.Socket, data: Buffer) => {
        for (const peer of peers)
          if (peer !== socket) peer.write(data);
      },
      close: (socket: Bun.Socket) => {
        peers.delete(socket);
      },
    },
  });
  server.unref();
}

// --- worker side: receive frames and deliver locally ---
let channel: Bun.Socket | null = null;
let pending = "";

async function connect(): Promise<void> {
  try {
    channel = await Bun.connect({
      unix: socketPath(),
      socket: {
        data: (socket: Bun.Socket, data: Buffer) => {
          pending += data.toString("utf8");
          let newline = pending.indexOf("\n");
          while (newline >= 0) {
            const line = pending.slice(0, newline);
            pending = pending.slice(newline + 1);
            newline = pending.indexOf("\n");
            if (!line) continue;
            try {
              const frame = JSON.parse(line) as FanoutFrame;
              deliver(frame.stream, frame.message);
            } catch {}
          }
        },
        close: () => {
          channel = null;
          setTimeout(connect, 500).unref();
        },
        error: () => {
          channel = null;
          setTimeout(connect, 500).unref();
        },
      },
    });
  } catch {
    // Master's fanout socket is not up yet; retry.
    setTimeout(connect, 500).unref();
  }
}

// Only spawned workers connect; the single-process mode delivers
// cable frames in-process and needs no fanout.
export function connectFanout(): void {
  if (!process.env.CAMPFIRE_WORKER) return;
  void connect();
}

export function fanout(stream: string, message: unknown): void {
  if (!channel) return;
  try {
    const frame = JSON.stringify({ stream, message }) + "\n";
    channel.write(frame);
  } catch {}
}
