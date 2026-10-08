import { randomUUID } from "node:crypto";
import { all, get, run, transaction, now, onCommit, type Row } from "./db.ts";
import {
  sanitize,
  plainText,
  mentionIds,
  reconcileEmbeds,
} from "./richtext.ts";
import { publish, dropRoom } from "./cable.ts";
import { stream } from "./rails.ts";
import { messageFragment, messageData } from "./rendering.ts";
import { enqueue, enqueueMany } from "./jobs.ts";
export const userById = (id: string | number) =>
  get("SELECT * FROM users WHERE id=?", Number(id));
export const roomsForUser = (id: string | number) =>
  all(
    "SELECT r.*,m.involvement,m.unread_at FROM rooms r JOIN memberships m ON m.room_id=r.id WHERE m.user_id=? ORDER BY lower(r.name)",
    Number(id),
  );
export const roomForUser = (
  user: Row | string | number | null | undefined,
  id: string | number | null | undefined,
) =>
  get(
    "SELECT r.* FROM rooms r JOIN memberships m ON m.room_id=r.id WHERE m.user_id=? AND r.id=?",
    Number((user as Row | null | undefined)?.id ?? user),
    Number(id),
  );
const presentation =
  "SELECT m.*,u.name AS creator_name,u.bio AS creator_bio,u.updated_at AS creator_updated_at,r.name AS room_name,r.type AS room_type FROM messages m JOIN users u ON u.id=m.creator_id JOIN rooms r ON r.id=m.room_id";
export const messageById = (id: string | number) =>
  get(presentation + " WHERE m.id=?", Number(id));
// Batch version of messageById: one query for N ids, rows returned in
// the requested order (missing ids skipped). The search page resolved
// up to 100 ids with one query each.
export function messagesByIds(ids: Array<string | number>): Row[] {
  const nums = [
    ...new Set(ids.map(Number).filter((n) => Number.isSafeInteger(n))),
  ];
  if (!nums.length) return [];
  const byId = new Map(
    all(
      presentation + ` WHERE m.id IN (${nums.map(() => "?").join(",")})`,
      ...nums,
    ).map((r) => [r.id, r] as const),
  );
  return ids.map(Number).flatMap((id) => {
    const hit = byId.get(id);
    return hit === undefined ? [] : [hit];
  });
}
export function messagesForRoom(
  id: string | number,
  {
    before,
    after,
    around,
  }: { before?: any; after?: any; around?: any } = {},
) {
  if (around) {
    const pivot = get(
      "SELECT * FROM messages WHERE id=? AND room_id=?",
      Number(around),
      Number(id),
    );
    if (!pivot) return messagesForRoom(id);
    return [
      ...all(
        presentation +
          " WHERE m.room_id=? AND m.created_at<? ORDER BY m.created_at DESC LIMIT 40",
        Number(id),
        pivot.created_at,
      ).reverse(),
      messageById(pivot.id)!,
      ...all(
        presentation +
          " WHERE m.room_id=? AND m.created_at>? ORDER BY m.created_at ASC LIMIT 40",
        Number(id),
        pivot.created_at,
      ),
    ];
  }
  let clauses = " WHERE m.room_id=?",
    args = [Number(id)];
  for (const [anchor, operator] of [
    [before, "<"],
    [after, ">"],
  ])
    if (anchor) {
      const pivot = get(
        "SELECT created_at FROM messages WHERE id=? AND room_id=?",
        Number(anchor),
        Number(id),
      );
      if (!pivot)
        throw Object.assign(new Error("Message not found"), { status: 404 });
      clauses += ` AND m.created_at${operator}?`;
      args.push(pivot.created_at);
    }
  const rows = all(
    presentation +
      clauses +
      ` ORDER BY m.created_at ${after ? "ASC" : "DESC"}, m.id ${after ? "ASC" : "DESC"} LIMIT 40`,
    ...args,
  );
  return after ? rows : rows.reverse();
}
export function grantMemberships(room: Row, userIds: Array<string | number>) {
  const timestamp = now();
  for (const id of userIds)
    run(
      "INSERT OR IGNORE INTO memberships(room_id,user_id,involvement,created_at,updated_at) VALUES(?,?,?,?,?)",
      room.id,
      Number(id),
      room.type === "Rooms::Direct" ? "everything" : "mentions",
      timestamp,
      timestamp,
    );
}
// Bun.password runs bcrypt in a worker thread, so hashing never
// blocks the event loop (bcryptjs hashSync did). Digests are
// standard bcrypt ($2a$/$2b$), interchangeable with the Rails
// reference app's.
export async function hashPassword(password: string): Promise<string> {
  return Bun.password.hash(password, { algorithm: "bcrypt", cost: 12 });
}
export function createUser({
  name,
  email_address = null,
  password_digest = null,
  role = 0,
  bot_token = null,
}: {
  name?: string;
  email_address?: string | null;
  password_digest?: string | null;
  role?: number;
  bot_token?: string | null;
}): Row | undefined {
  if (!name?.trim() || (role !== 2 && (!email_address || !password_digest)))
    throw Object.assign(new Error("Name, email and password required"), {
      status: 422,
    });
  return transaction(() => {
    const time = now();
    const result = run(
      "INSERT INTO users(name,email_address,password_digest,role,bot_token,status,created_at,updated_at) VALUES(?,?,?,?,?,0,?,?)",
      name,
      email_address,
      password_digest,
      role,
      bot_token,
      time,
      time,
    );
    const user = userById(Number(result.lastInsertRowid));
    for (const room of all("SELECT * FROM rooms WHERE type='Rooms::Open'"))
      grantMemberships(room, [user!.id]);
    return user;
  });
}
export function indexMessage(id: string | number, body: string, filename = "") {
  run("DELETE FROM message_search_index WHERE rowid=?", Number(id));
  run(
    "INSERT INTO message_search_index(rowid,body) VALUES(?,?)",
    Number(id),
    plainText(body) || filename,
  );
}
// Index a brand-new message: the DELETE is a guaranteed no-op for a
// fresh rowid, so skip it (one fewer write statement on the hot path).
export function indexNewMessage(id: string | number, body: string) {
  run(
    "INSERT INTO message_search_index(rowid,body) VALUES(?,?)",
    Number(id),
    plainText(body),
  );
}
export function createMessage(
  roomId: string | number,
  userId: string | number,
  body: any = "",
  clientId: any = null,
) {
  // Pure CPU outside the write lock: sanitize parses HTML.
  return insertMessage(roomId, userId, sanitize(body), clientId);
}
// Message insert on pre-sanitized content (shared by createMessage
// and the dedicated writer process, ADR-001).
export function insertMessage(
  roomId: string | number,
  userId: string | number,
  content: string,
  clientId: any = null,
) {
  const hasEmbeds = content.includes("action-text-attachment");
  return transaction(() => {
    const time = now();
    // Membership check folded into the INSERT (one statement, one
    // roundtrip on the writer lock): no row without membership.
    const result = run(
      "INSERT INTO messages(room_id,creator_id,client_message_id,created_at,updated_at) SELECT ?,?,?,?,? WHERE EXISTS(SELECT 1 FROM memberships WHERE room_id=? AND user_id=?)",
      Number(roomId),
      Number(userId),
      clientId || randomUUID(),
      time,
      time,
      Number(roomId),
      Number(userId),
    );
    if (Number(result.changes || 0) < 1)
      throw Object.assign(new Error("Room membership required"), {
        status: 403,
      });
    const id = Number(result.lastInsertRowid);
    const rich = run(
      "INSERT INTO action_text_rich_texts(name,record_type,record_id,body,created_at,updated_at) VALUES('body','Message',?,?,?,?)",
      id,
      content,
      time,
      time,
    );
    // Plain-text posts carry no embeds and a new message owns no
    // embed rows yet: skip the parse and the queries entirely.
    if (hasEmbeds)
      reconcileEmbeds(Number(rich.lastInsertRowid), content, Number(userId));
    const created = messageById(id);
    // Post-commit effects run as short autocommit statements instead
    // of inside the write transaction: one long RESERVED hold blocks
    // every other worker's loop in busy-sleep, while short holds
    // interleave. A crash in between leaves FTS/unread milliseconds
    // stale (self-heals on the next write); the message row itself
    // is atomic.
    indexNewMessage(id, content);
    run("UPDATE rooms SET updated_at=? WHERE id=?", time, Number(roomId));
    const cutoff = new Date(Date.now() - 60000)
      .toISOString()
      .replace("T", " ")
      .replace("Z", "");
    run(
      "UPDATE memberships SET unread_at=?,updated_at=? WHERE room_id=? AND user_id<>? AND involvement<>'invisible' AND (connected_at IS NULL OR connected_at<?)",
      time,
      time,
      Number(roomId),
      Number(userId),
      cutoff,
    );
    return created;
  });
}
export function updateMessage(
  message: Row,
  body: any = null,
  userId: any = message.creator_id,
) {
  // Pure CPU outside the write lock: sanitize parses HTML.
  const content = body === null ? null : sanitize(body);
  transaction(() => {
    const time = now();
    if (content !== null) {
      run(
        "INSERT INTO action_text_rich_texts(name,record_type,record_id,body,created_at,updated_at) VALUES('body','Message',?,?,?,?) ON CONFLICT(record_type,record_id,name) DO UPDATE SET body=excluded.body,updated_at=excluded.updated_at",
        message.id,
        content,
        time,
        time,
      );
      const obsolete = reconcileEmbeds(
        get(
          "SELECT id FROM action_text_rich_texts WHERE record_type='Message' AND record_id=?",
          message.id,
        )!.id,
        content,
        userId,
      );
      onCommit(() => {
        for (const blobId of obsolete) enqueue("purge", { blob_id: blobId });
      });
      const attachment = get(
        "SELECT b.filename FROM active_storage_attachments a JOIN active_storage_blobs b ON b.id=a.blob_id WHERE a.record_type='Message' AND a.record_id=? AND a.name='attachment'",
        message.id,
      );
      indexMessage(message.id, content, attachment?.filename || "");
    }
    run("UPDATE messages SET updated_at=? WHERE id=?", time, message.id);
    run("UPDATE rooms SET updated_at=? WHERE id=?", time, message.room_id);
  });
  return messageById(message.id);
}
export function deleteMessage(message: Row | number, { broadcast = true }: { broadcast?: boolean } = {}) {
  const row = typeof message === "number" ? messageById(message) : message;
  if (!row) return;
  const richIds = all(
    "SELECT id FROM action_text_rich_texts WHERE record_type='Message' AND record_id=?",
    row.id,
  ).map((r) => r.id);
  const blobIds = all(
    "SELECT blob_id FROM active_storage_attachments WHERE record_type='Message' AND record_id=?",
    row.id,
  ).map((a) => a.blob_id);
  for (const id of richIds)
    blobIds.push(
      ...all(
        "SELECT blob_id FROM active_storage_attachments WHERE record_type='ActionText::RichText' AND record_id=?",
        id,
      ).map((a) => a.blob_id),
    );
  transaction(() => {
    run("DELETE FROM boosts WHERE message_id=?", row.id);
    for (const id of richIds)
      run(
        "DELETE FROM active_storage_attachments WHERE record_type='ActionText::RichText' AND record_id=?",
        id,
      );
    run(
      "DELETE FROM active_storage_attachments WHERE record_type='Message' AND record_id=?",
      row.id,
    );
    run(
      "DELETE FROM action_text_rich_texts WHERE record_type='Message' AND record_id=?",
      row.id,
    );
    run("DELETE FROM message_search_index WHERE rowid=?", row.id);
    run("DELETE FROM messages WHERE id=?", row.id);
    run("UPDATE rooms SET updated_at=? WHERE id=?", now(), row.room_id);
  });
  onCommit(() => {
    for (const id of blobIds) enqueue("purge", { blob_id: id });
    if (broadcast) publishMessage(row, "remove");
  });
}
export function publishMessage(message: Row, action = "append", html?: string) {
  const room = get("SELECT * FROM rooms WHERE id=?", message.room_id);
  if (!room) return;
  const target =
    action === "append"
      ? `messages_rooms_${room.type.split("::").pop().toLowerCase()}_${room.id}`
      : `message_${message.client_message_id}`;
  const body =
    action === "remove"
      ? ""
      : (html ?? messageFragment(messageData([messageById(message.id)!])[0]!));
  publish(
    stream(room),
    `<turbo-stream action="${action}" target="${target}" maintain_scroll="true"><template>${body}</template></turbo-stream>`,
  );
  if (action === "append")
    for (const m of all(
      "SELECT user_id FROM memberships WHERE room_id=?",
      room.id,
    ))
      publish(`user_${m.user_id}_unreads`, { roomId: room.id });
}
export function notifyMessage(message: Row, { webhooks = true }: { webhooks?: boolean } = {}) {
  const body =
      get(
        "SELECT body FROM action_text_rich_texts WHERE record_type='Message' AND record_id=?",
        message.id,
      )?.body || "",
    mentions = mentionIds(body),
    room = get("SELECT * FROM rooms WHERE id=?", message.room_id)!;
  const pending: Array<{ kind: string; data: unknown }> = [];
  for (const m of all(
    "SELECT m.*,u.role,u.status FROM memberships m JOIN users u ON u.id=m.user_id WHERE m.room_id=? AND m.user_id<>?",
    message.room_id,
    message.creator_id,
  )) {
    if (m.status !== 0) continue;
    if (
      webhooks &&
      m.role === 2 &&
      (room.type === "Rooms::Direct" || mentions.has(m.user_id))
    )
      for (const w of all("SELECT id FROM webhooks WHERE user_id=?", m.user_id))
        pending.push({
          kind: "webhook",
          data: { webhook_id: w.id, message_id: message.id },
        });
    if (
      (!m.connected_at ||
        Date.now() - Date.parse(m.connected_at + "Z") > 60000) &&
      (m.involvement === "everything" ||
        (m.involvement === "mentions" && mentions.has(m.user_id)))
    )
      pending.push({
        kind: "push",
        data: { user_id: m.user_id, message_id: message.id },
      });
  }
  enqueueMany(pending);
}
export function deleteRoom(room: Row) {
  for (const message of all("SELECT * FROM messages WHERE room_id=?", room.id))
    deleteMessage(message);
  transaction(() => {
    run("DELETE FROM memberships WHERE room_id=?", room.id);
    run("DELETE FROM rooms WHERE id=?", room.id);
  });
  dropRoom(room.id);
  publish(
    "rooms",
    `<turbo-stream action="remove" target="list_rooms_${room.type.split("::").pop().toLowerCase()}_${room.id}"></turbo-stream>`,
  );
}
