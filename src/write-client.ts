// Client side of the dedicated writer (ADR-001). HTTP workers send
// message-create transactions here and await the row: awaiting yields
// the event loop, unlike busy-sleeping on the SQLite writer lock.
// When no writer is reachable (tests, direct createApp use) the
// channel stays down and callers fall back to local writes.
//
// The writer also broadcasts change frames ({op:"changes", ...})
// after each commit (PERF-23): they drive the session cache
// invalidation. The channel ignores anything that is not a
// response or a change frame.
import { writerSocketPath } from "./writer.ts";
import type { Row } from "./db.ts";

let channel: Bun.Socket | null = null;
let connecting = false;
let nextId = 1;
const pending = new Map<
  number,
  { resolve: (row: Row) => void; reject: (error: unknown) => void }
>();
let recvBuf = "";
// Session-cache invalidation hook (set by compat.ts): receives the
// writer's change frames. Kept as a plain callback so db.ts and the
// cache stay free of socket knowledge.
let changeListener: ((changes: Array<{ table: string; id?: number }>) => void) | null =
  null;
export function onWriterChanges(
  listener: (changes: Array<{ table: string; id?: number }>) => void,
): void {
  changeListener = listener;
}

function writerDown(error: unknown) {
  channel = null;
  const list = [...pending.values()];
  pending.clear();
  for (const { reject } of list) {
    try {
      reject(error);
    } catch {
      // Ignore late rejections.
    }
  }
}

async function connect(): Promise<void> {
  // The writer never dials itself.
  if (channel || connecting || process.env.CAMPFIRE_WRITER) return;
  connecting = true;
  try {
    channel = await Bun.connect({
      unix: writerSocketPath(),
      socket: {
        data: (_socket: Bun.Socket, data: Buffer) => {
          recvBuf += data.toString("utf8");
          let newline = recvBuf.indexOf("\n");
          while (newline >= 0) {
            const line = recvBuf.slice(0, newline);
            recvBuf = recvBuf.slice(newline + 1);
            newline = recvBuf.indexOf("\n");
            if (!line) continue;
            try {
              const res = JSON.parse(line);
              if (res && res.op === "changes") {
                // Advisory change frame: drive the session cache.
                if (changeListener && Array.isArray(res.changes))
                  changeListener(res.changes);
                continue;
              }
              const slot = pending.get(Number(res.id));
              if (!slot) continue;
              pending.delete(Number(res.id));
              if (res.ok) slot.resolve(res.row as Row);
              else
                slot.reject(
                  Object.assign(new Error(String(res.message || "writer error")), {
                    status: Number(res.status) || 500,
                  }),
                );
            } catch {
              // Malformed frame: ignore it.
            }
          }
        },
        close: () => {
          connecting = false;
          writerDown(
            Object.assign(new Error("writer unavailable"), { status: 503 }),
          );
          setTimeout(() => {
            void connect();
          }, 500).unref();
        },
        error: () => {
          connecting = false;
          writerDown(
            Object.assign(new Error("writer unavailable"), { status: 503 }),
          );
          setTimeout(() => {
            void connect();
          }, 500).unref();
        },
      },
    });
  } catch {
    channel = null;
    setTimeout(() => {
      void connect();
    }, 500).unref();
  } finally {
    connecting = false;
  }
}

export function connectWriter(): void {
  void connect();
}

export function writerAvailable(): boolean {
  return channel !== null;
}

export function remoteCreateMessage(
  roomId: string | number,
  userId: string | number,
  content: string,
  clientId: unknown,
): Promise<Row> {
  const ch = channel;
  if (!ch)
    return Promise.reject(
      Object.assign(new Error("writer unavailable"), { status: 503 }),
    );
  return new Promise<Row>((resolve, reject) => {
    const id = nextId++;
    pending.set(id, { resolve, reject });
    try {
      ch.write(
        JSON.stringify({ id, op: "message.create", roomId, userId, content, clientId }) + "\n",
      );
    } catch (error) {
      pending.delete(id);
      reject(error);
    }
  });
}
