import { randomBytes } from "node:crypto";
import { all, get, run, transaction, now, type Row } from "./db.ts";
import {
  roomForUser,
  roomsForUser,
  userById,
  messageById,
  messagesByIds,
  messagesForRoom,
  placeholderUsers,
  grantMemberships,
  createUser,
  hashPassword,
  createMessage,
  updateMessage,
  deleteMessage,
  deleteRoom,
  indexMessage,
  publishMessage,
  notifyMessage,
} from "./domain.ts";
import {
  render,
  fragment,
  messageData,
  messageFragment,
  messagesHtml,
  readPage,
  writePage,
  roomData,
  userData,
  avatar,
  iso,
  epoch,
} from "./rendering.ts";
import { escape, plainText, messagePlainText, sanitize } from "./richtext.ts";
import * as rails from "./rails.ts";
import { publish, dropUserConnections, dropRoomUser } from "./cable.ts";
import { remoteCreateMessage, writerAvailable } from "./write-client.ts";
import { dropAvatarCache } from "./public.ts";
import {
  storeUpload,
  attachSigned,
  removeAttachment,
  replaceAttachment,
  stagedFiles,
  processAttachment,
  purgeBlob,
  type StoredUpload,
} from "./storage.ts";
import { enqueue } from "./jobs.ts";
import type { CompatReq, CompatRes, CompatFile } from "./compat.ts";

/** Express-style handler: reads CompatReq, writes CompatRes.
 *
 * The trailing rest parameter keeps this assignable FROM middleware-style
 * `(req, res, next)` functions while still contextually typing inline
 * `(req, res) => ...` arrows passed to RouteCollector (union signatures do
 * not contextually type arrows in TypeScript). */
export interface Handler {
  (req: CompatReq, res: CompatRes, ...rest: any[]): unknown;
}

/** Express-style middleware: must call next() to continue the chain. */
export interface Middleware {
  (req: CompatReq, res: CompatRes, next: () => Promise<void> | void): unknown;
}

/** Subset of Express app registration consumed by registerRoutes. */
export interface RouteCollector {
  get(path: string | string[], ...handlers: Handler[]): void;
  post(path: string | string[], ...handlers: Handler[]): void;
  put(path: string | string[], ...handlers: Handler[]): void;
  patch(path: string | string[], ...handlers: Handler[]): void;
  delete(path: string | string[], ...handlers: Handler[]): void;
  all(path: string | string[], ...handlers: Handler[]): void;
}

export type { CompatReq, CompatRes };
const token = () => randomBytes(18).toString("base64url");
const origin = (req: CompatReq) => `${req.protocol}://${req.get("host")}`;
export function value(req: CompatReq, group: string, key: string, fallback: unknown = "") {
  const result =
    req.body?.[group]?.[key] ?? req.body?.[`${group}[${key}]`] ?? fallback;
  return Array.isArray(result) ? result.at(-1) : result;
}
const send = (req: CompatReq, res: CompatRes, screen: string, data: Record<string, unknown> = {}) =>
  res.type("html").send(render(req, screen, data));
const can = (user: Row, row: Row) => user.role === 1 || row.creator_id === user.id;
function login(req: CompatReq, res: CompatRes, next: () => void) {
  if (!req.user) {
    req.session.return_to_after_authenticating = req.originalUrl;
    return res.redirect("/session/new");
  }
  if (req.authenticatedByBot) return res.sendStatus(403);
  next();
}
function admin(req: CompatReq, res: CompatRes, next: () => void) {
  return req.user.role === 1 ? next() : res.sendStatus(403);
}
function required<T>(row: T | undefined | null): T {
  if (row === undefined || row === null) throw Object.assign(new Error("Not found"), { status: 404 });
  return row;
}
function startSession(req: CompatReq, user: Row) {
  const time = now(),
    t = token();
  run(
    "INSERT INTO sessions(user_id,token,user_agent,ip_address,last_active_at,created_at,updated_at) VALUES(?,?,?,?,?,?,?)",
    user.id,
    t,
    req.get("user-agent") || "",
    req.ip || "",
    time,
    time,
    time,
  );
  req.user = user;
  req.newSessionToken = t;
}
const file = (req: CompatReq, name: string) => req.files?.find((f) => f.fieldname === name);
function attachment(req: CompatReq) {
  return (
    file(req, "message[attachment]") ||
    file(req, "attachment") ||
    value(req, "message", "attachment", req.body?.attachment ?? null)
  );
}
async function prepareMessageAttachment(req: CompatReq, item: unknown) {
  if (!item) return null;
  let blob;
  try {
    blob =
      typeof item === "object"
        ? storeUpload(item as StoredUpload, "Campfire::PendingUpload", 0, "attachment")
        : attachSigned(
            item as string,
            "Campfire::PendingUpload",
            0,
            "attachment",
            req.user?.id,
          );
    await processAttachment(blob);
    return blob;
  } catch (error) {
    if (blob) {
      run(
        "DELETE FROM active_storage_attachments WHERE record_type='Campfire::PendingUpload' AND record_id=0 AND blob_id=?",
        blob.id,
      );
      purgeBlob(blob.id);
    }
    throw Object.assign(error as Error, { status: 422 });
  }
}
function attachMessage(message: Row, item: unknown, blob: Row | null | undefined) {
  if (item === null) return [];
  const old = removeAttachment("Message", message.id, "attachment");
  if (blob) {
    run(
      "INSERT INTO active_storage_attachments(record_type,record_id,name,blob_id,created_at) VALUES('Message',?,'attachment',?,?)",
      message.id,
      blob.id,
      now(),
    );
    run(
      "DELETE FROM active_storage_attachments WHERE record_type='Campfire::PendingUpload' AND record_id=0 AND blob_id=?",
      blob.id,
    );
  }
  const body =
    get(
      "SELECT body FROM action_text_rich_texts WHERE record_type='Message' AND record_id=?",
      message.id,
    )?.body || "";
  indexMessage(message.id, body, blob?.filename || "");
  return old;
}
function cleanupPrepared(blob: Row | null | undefined) {
  if (blob) {
    run(
      "DELETE FROM active_storage_attachments WHERE record_type='Campfire::PendingUpload' AND record_id=0 AND blob_id=?",
      blob.id,
    );
    purgeBlob(blob.id);
  }
}
async function replaceImage(upload: CompatFile | undefined, type: string, id: number, name: string) {
  await validateUpload(upload);
  const blob = replaceAttachment(upload as StoredUpload, type, id, name);
  if (type === "User" && name === "avatar") dropAvatarCache(id);
  for (const removed of blob.removedBlobIds || [])
    enqueue("purge", { blob_id: removed });
  return blob;
}
export function serializeMessage(m: Row, req: CompatReq) {
  const body =
      get(
        "SELECT body FROM action_text_rich_texts WHERE record_type='Message' AND record_id=? AND name='body'",
        m.id,
      )?.body || "",
    user = required(userById(m.creator_id));
  return {
    id: m.id,
    created_at: iso(m.created_at),
    body: {
      plain_text: messagePlainText(m.id, body),
      html: '<div class="lexxy-content">' + body + "</div>",
    },
    creator: {
      id: user.id,
      name: user.name,
      role: ["member", "administrator", "bot"][user.role],
      avatar_url: origin(req) + avatar(user.id, user.updated_at),
    },
    room: { id: m.room_id },
    url: `${origin(req)}/rooms/${m.room_id}/messages/${m.id}`,
  };
}
const turbo = (res: CompatRes, action: string, target: string, body = "") =>
  res
    .type("text/vnd.turbo-stream.html")
    .send(
      `<turbo-stream action="${action}" target="${target}"><template>${body}</template></turbo-stream>`,
    );
function botUser(req: CompatReq) {
  const [id, ...bits] = (req.params.botKey || "").split("-");
  return get(
    "SELECT * FROM users WHERE id=? AND bot_token=? AND role=2 AND status=0",
    Number(id) || 0,
    bits.join("-"),
  );
}
export function registerRoutes(app: RouteCollector) {
  app.get("/", (req, res) => {
    if (!get("SELECT id FROM accounts LIMIT 1"))
      return res.redirect("/first_run");
    if (!req.user) return res.redirect("/session/new");
    const room =
      roomForUser(
        req.user,
        req.cookies?.last_room || req.session.last_room_id || 0,
      ) || roomsForUser(req.user.id)[0];
    return room ? res.redirect("/rooms/" + room.id) : send(req, res, "welcome");
  });
  app.get("/session/new", (req, res) =>
    get("SELECT id FROM users LIMIT 1")
      ? send(req, res, "login", { Email: req.query.email_address || "" })
      : res.redirect("/first_run"),
  );
  app.post("/session", async (req, res) => {
    const user = get(
      "SELECT * FROM users WHERE email_address=? AND status=0",
      req.body.email_address || "",
    );
    if (
      !user?.password_digest ||
      !(await Bun.password.verify(
        req.body.password || "",
        user.password_digest,
        "bcrypt",
      ))
    )
      return res
        .status(401)
        .type("html")
        .send(
          render(req, "login", {
            Error: "Too many requests or unauthorized.",
            Email: req.body.email_address || "",
          }),
        );
    startSession(req, user);
    const destination = req.session.return_to_after_authenticating || "/";
    delete req.session.return_to_after_authenticating;
    res.redirect(
      destination.startsWith("/") && !destination.startsWith("//")
        ? destination
        : "/",
    );
  });
  app.delete("/session", (req, res) => {
    if (req.currentSession)
      run("DELETE FROM sessions WHERE id=?", req.currentSession.id);
    if (req.user)
      run(
        "DELETE FROM push_subscriptions WHERE user_id=? AND endpoint=?",
        req.user.id,
        req.body?.push_subscription_endpoint || "",
      );
    req.session = {};
    req.clearSessionToken = true;
    res.redirect("/");
  });
  app.all("/first_run", async (req, res) => {
    if (get("SELECT id FROM accounts LIMIT 1")) return res.redirect("/");
    if (req.method === "GET") return send(req, res, "first-run");
    if (req.method !== "POST") return res.sendStatus(405);
    if (file(req, "user[avatar]"))
      await validateUpload(file(req, "user[avatar]"));
    // Hash outside the transaction: Bun.password is async and
    // domain transactions must stay synchronous.
    const digest = await hashPassword(value(req, "user", "password") as string);
    const user = transaction(() => {
      const time = now();
      run(
        "INSERT INTO accounts(name,join_code,created_at,updated_at) VALUES(?,?,?,?)",
        "Campfire",
        token(),
        time,
        time,
      );
      const created = required(
        createUser({
          name: value(req, "user", "name") as string,
          email_address: value(req, "user", "email_address") as string,
          password_digest: digest,
          role: 1,
        }),
      );
      const result = run(
        "INSERT INTO rooms(name,type,creator_id,created_at,updated_at) VALUES(?,?,?,?,?)",
        "All Talk",
        "Rooms::Open",
        created.id,
        time,
        time,
      );
      grantMemberships(
        { id: Number(result.lastInsertRowid), type: "Rooms::Open" },
        [created.id],
      );
      return created;
    });
    if (file(req, "user[avatar]"))
      await replaceImage(file(req, "user[avatar]"), "User", user.id, "avatar");
    startSession(req, user);
    res.redirect("/");
  });
  app.all("/join/:code", async (req, res) => {
    const account = required(
      get("SELECT * FROM accounts WHERE join_code=?", req.params.code || ""),
    );
    if (req.user) return res.redirect("/");
    if (req.method === "GET")
      return send(req, res, "join", { JoinCode: account.join_code });
    if (req.method !== "POST") return res.sendStatus(405);
    if (file(req, "user[avatar]"))
      await validateUpload(file(req, "user[avatar]"));
    const user = required(
      createUser({
        name: value(req, "user", "name") as string,
        email_address: value(req, "user", "email_address") as string,
        password_digest: await hashPassword(
          value(req, "user", "password") as string,
        ),
      }),
    );
    if (file(req, "user[avatar]"))
      await replaceImage(file(req, "user[avatar]"), "User", user.id, "avatar");
    startSession(req, user);
    res.redirect("/");
  });
  app.all("/session/transfers/:id", (req, res) => {
    if (req.method === "GET")
      return res
        .type("html")
        .send(
          `<form method="post"><input name="_method" value="put" type="hidden"><input name="authenticity_token" value="${escape(req.csrfToken)}" type="hidden"><button>Sign in to Campfire</button></form>`,
        );
    if (!["PUT", "PATCH"].includes(req.method)) return res.sendStatus(405);
    let id;
    try {
      id = rails.verifyId("User", req.params.id, "transfer");
    } catch {
      return res.sendStatus(400);
    }
    const user = get("SELECT * FROM users WHERE id=? AND status=0", Number(id));
    if (!user) return res.sendStatus(400);
    startSession(req, user);
    res.redirect("/");
  });
  registerRoomForms(app);
  app.get("/rooms", login, (req, res) => {
    const room = roomsForUser(req.user.id).at(-1);
    res.redirect(room ? "/rooms/" + room.id : "/");
  });
  app.get(
    ["/rooms/:roomId", "/rooms/:roomId/@:messageId"],
    login,
    (req, res) => {
      if (!/^\d+$/.test(req.params.roomId || "")) return res.sendStatus(404);
      const room = roomForUser(req.user, req.params.roomId);
      if (!room) return res.redirect("/");
      req.lastRoom = room.id;
      req.session.last_room_id = room.id;
      const membership = get(
        "SELECT involvement,updated_at FROM memberships WHERE room_id=? AND user_id=?",
        room.id,
        req.user.id,
      );
      // Whole-page fast path: every input that can change the room
      // page is versioned here (room/user/account rows, account logo
      // presence, host, paging anchor, Turbo-Frame, per-session CSRF
      // secret). The sidebar loads lazily via its own request, so it
      // is not part of this page. On a hit every query below and the
      // nunjucks render are skipped.
      // NOTE: key on the stable session secret, not req.csrfToken:
      // maskCsrf re-pads randomly per request (all masks stay valid).
      const account = get("SELECT id,updated_at FROM accounts LIMIT 1");
      const key = [
        origin(req),
        room.id,
        room.updated_at,
        req.params.messageId || "",
        req.user.id,
        req.user.updated_at,
        membership?.updated_at,
        membership?.involvement,
        account?.updated_at,
        get(
          "SELECT id FROM active_storage_attachments WHERE record_type='Account' AND record_id=? AND name='logo'",
          account?.id,
        ) ? 1 : 0,
        String(req.session._csrf_token || ""),
        req.get("Turbo-Frame") || "",
      ].join("|");
      const cached = readPage(key);
      if (cached !== undefined) return res.type("html").send(cached);
      const roomMessages = messageData(
        messagesForRoom(room.id, { around: req.params.messageId }),
        origin(req),
      );
      const html = render(req, "room", {
        Room: roomData(room, req.user),
        Messages: roomMessages,
        MessagesHTML: messagesHtml(roomMessages),
        LoadedAt: epoch(room.updated_at),
        Stream: rails.signStream(rails.stream(room)),
        Involvement: membership!.involvement,
        Invitation: false,
      });
      writePage(key, html);
      res.type("html").send(html);
    },
  );
  app.delete("/rooms/:roomId", login, (req, res) => {
    const room = required(roomForUser(req.user, req.params.roomId));
    if (!can(req.user, room)) return res.sendStatus(403);
    deleteRoom(room);
    res.redirect("/");
  });
  app.get(["/users/me/sidebar", "/users/:id/sidebar"], login, (req, res) => {
    // Sidebar fast path: every input that can change the fragment is
    // versioned (room id set, room/membership/member versions, account
    // version, placeholder users). The fragment carries no per-session
    // content, so it is shared across sessions; a plain GET (no
    // Turbo-Frame) renders the full Rails-equivalent page instead.
    const framed = (req.get("Turbo-Frame") || "") !== "";
    const memberRooms = all(
      "SELECT room_id FROM memberships WHERE user_id=?",
      req.user.id,
    ).map((r) => r.room_id);
    const versions = get(
      "SELECT MAX(r.updated_at) AS rooms, MAX(m.updated_at) AS memberships FROM memberships m JOIN rooms r ON r.id=m.room_id WHERE m.user_id=?",
      req.user.id,
    );
    const memberVersions = get(
      "SELECT MAX(u.updated_at) AS users FROM users u WHERE u.id IN (SELECT m2.user_id FROM memberships m2 WHERE m2.room_id IN (SELECT m.room_id FROM memberships m JOIN rooms r ON r.id=m.room_id WHERE m.user_id=? AND r.type='Rooms::Direct'))",
      req.user.id,
    );
    const sidebarAccount = get("SELECT updated_at FROM accounts LIMIT 1");
    const placeholders = placeholderUsers(req.user.id);
    const sidebarKey = [
      framed ? "frame" : "page",
      req.user.id,
      req.user.updated_at,
      [...memberRooms].sort((a, b) => a - b).join(","),
      versions?.rooms,
      versions?.memberships,
      memberVersions?.users,
      sidebarAccount?.updated_at,
      placeholders.map((u) => `${u.id}-${u.updated_at}`).join(","),
    ].join("|");
    const cachedSidebar = readPage(sidebarKey);
    if (cachedSidebar !== undefined)
      return res.type("html").send(cachedSidebar);
    const rooms = roomsForUser(req.user.id).filter(
      (r) => r.involvement !== "invisible",
    );
    rooms.sort((a, b) =>
      a.type === "Rooms::Direct" && b.type === "Rooms::Direct"
        ? b.updated_at.localeCompare(a.updated_at)
        : a.type === "Rooms::Direct"
          ? -1
          : b.type === "Rooms::Direct"
            ? 1
            : (a.name || "").localeCompare(b.name || ""),
    );
    const sidebarHtml = render(req, framed ? "sidebar" : "sidebar_page", {
      SidebarRooms: rooms.map((r) => ({
        ...roomData(r, req.user),
        Unread: !!r.unread_at,
      })),
      Placeholders: placeholders.map(userData),
    });
    writePage(sidebarKey, sidebarHtml);
    res.type("html").send(sidebarHtml);
  });
  app.all(
    [
      "/rooms/:roomId/messages/:id/edit",
      "/messages/:id/edit",
      "/rooms/:roomId/messages/:id",
      "/rooms/:roomId/messages",
      "/messages/:id",
      "/rooms/:roomId/:botKey/messages/:id",
      "/rooms/:roomId/:botKey/messages",
    ],
    async (req, res) => {
      const isBot = !!req.params.botKey,
        user = isBot ? botUser(req) : req.user;
      if (!user)
        return isBot ? res.sendStatus(401) : res.redirect("/session/new");
      if (!isBot && req.authenticatedByBot) return res.sendStatus(403);
      let message = req.params.id ? messageById(req.params.id) : null;
      const room = roomForUser(user, req.params.roomId || message?.room_id);
      if (!room) return isBot ? res.sendStatus(404) : res.redirect("/");
      if (req.params.id && (!message || message.room_id !== room.id))
        return res.sendStatus(404);
      const json =
        isBot ||
        req.format === "json" ||
        req.accepts(["html", "json"]) === "json" ||
        req.path.endsWith(".json");
      if (req.method === "GET") {
        if (req.path.endsWith("/edit")) {
          if (!can(user, message!)) return res.sendStatus(403);
          return send(req, res, "edit-message", {
            Messages: messageData([message!]),
            Room: roomData(room, user),
            Body:
              get(
                "SELECT body FROM action_text_rich_texts WHERE record_type='Message' AND record_id=?",
                message!.id,
              )?.body || "",
          });
        }
        const rows: Row[] = message ? [message] : messagesForRoom(room.id, req.query);
        if (!rows.length) return res.sendStatus(204);
        if (json) {
          if (isBot) {
            res.set(
              "X-Total-Count",
              String(
                get(
                  "SELECT count(*) AS n FROM messages WHERE room_id=?",
                  room.id,
                )!.n,
              ),
            );
            const direction = req.query.after ? "after" : "before",
              anchor = (direction === "after" ? rows.at(-1) : rows[0])!;
            if (
              get(
                `SELECT id FROM messages WHERE room_id=? AND created_at${direction === "after" ? ">" : "<"}? LIMIT 1`,
                room.id,
                anchor.created_at,
              )
            )
              res.set(
                "Link",
                `<${origin(req)}/rooms/${room.id}/${req.params.botKey}/messages?${direction}=${anchor.id}>; rel="next"`,
              );
          }
          return res.json(
            message
              ? serializeMessage(message, req)
              : rows.map((m) => serializeMessage(m, req)),
          );
        }
        if (message) return send(req, res, "show-message", { Messages: messageData(rows) });
        // The message-list fragment is viewer-independent (permalinks
        // only carry the host): share it across users keyed on the
        // room version and the paging anchor.
        const fragKey = [
          origin(req),
          room.id,
          room.updated_at,
          String(req.query.before ?? ""),
          String(req.query.after ?? ""),
        ].join("|");
        const cachedFragment = readPage(fragKey);
        if (cachedFragment !== undefined)
          return res.type("html").send(cachedFragment);
        const listMessages = messageData(rows, origin(req));
        const listHtml = fragment("messages", {
          Messages: listMessages,
          MessagesHTML: messagesHtml(listMessages),
        });
        writePage(fragKey, listHtml);
        return res.type("html").send(listHtml);
      }
      if (message && !can(user, message)) return res.sendStatus(403);
      const item = attachment(req),
        body = isBot
          ? typeof req.body === "string"
            ? req.body
            : Buffer.isBuffer(req.body)
              ? req.body.toString()
              : value(req, "message", "body", req.body?.body || "")
          : value(req, "message", "body", req.method === "POST" ? "" : null);
      if (req.method === "POST") {
        if (isBot && !body && !item) return res.sendStatus(422);
        const blob = await prepareMessageAttachment({ ...req, user }, item);
        try {
          if (item == null) {
            // Fast path (the benched shape): nothing to link, so no
            // outer transaction — createMessage's short txn holds
            // the writer lock alone. Under a master, the dedicated
            // writer executes it instead (ADR-001): awaiting yields
            // the loop instead of busy-sleeping on the lock.
            if (writerAvailable()) {
              message = await remoteCreateMessage(
                room.id,
                user.id,
                sanitize(body),
                value(req, "message", "client_message_id") || null,
              );
            } else {
              message = createMessage(
                room.id,
                user.id,
                body,
                value(req, "message", "client_message_id") || null,
              );
            }
          } else {
            message = stagedFiles(() =>
              transaction(() => {
                const created = createMessage(
                  room.id,
                  user.id,
                  body,
                  value(req, "message", "client_message_id") || null,
                );
                attachMessage(created!, item, blob);
                return created;
              }),
            );
          }
        } catch (error) {
          cleanupPrepared(blob);
          throw error;
        }
        // Render once: the broadcast and the turbo response share it.
        const frag = messageFragment(messageData([message!])[0]!);
        publishMessage(message!, "append", frag);
        notifyMessage(message!);
        if (isBot)
          return res
            .status(201)
            .set(
              "Location",
              `${origin(req)}/rooms/${room.id}/messages/${message!.id}`,
            )
            .end();
        if (json)
          return res
            .status(201)
            .json(serializeMessage(messageById(message!.id)!, req));
        return turbo(
          res,
          "append",
          `messages_rooms_${room.type.split("::").pop().toLowerCase()}_${room.id}`,
          frag,
        );
      }
      if (["PATCH", "PUT"].includes(req.method)) {
        const blob = await prepareMessageAttachment({ ...req, user }, item);
        let obsolete;
        try {
          stagedFiles(() =>
            transaction(() => {
              obsolete = attachMessage(message!, item, blob);
              message = updateMessage(message!, body, user.id);
            }),
          );
        } catch (error) {
          cleanupPrepared(blob);
          throw error;
        }
        for (const id of obsolete || []) enqueue("purge", { blob_id: id });
        publishMessage(message!, "replace");
        return json
          ? res.json(serializeMessage(message!, req))
          : res.redirect(`/rooms/${room.id}/messages/${message!.id}`);
      }
      if (req.method === "DELETE") {
        deleteMessage(message!);
        return json
          ? res.sendStatus(204)
          : turbo(res, "remove", "message_" + message!.client_message_id);
      }
      res.sendStatus(405);
    },
  );
  app.get("/rooms/:roomId/refresh", login, (req, res) => {
    const room = required(roomForUser(req.user, req.params.roomId));
    const since = Number(req.query.since) || 0;
    const messages = all(
      "SELECT * FROM messages WHERE room_id=? ORDER BY created_at",
      room.id,
    )
      .filter((m) => epoch(m.updated_at) > since)
      .slice(-80);
    res.type("text/vnd.turbo-stream.html").send(
      messages
        .map((m) => {
          const action = epoch(m.created_at) > since ? "append" : "replace",
            target =
              action === "append"
                ? `messages_rooms_${room.type.split("::").pop().toLowerCase()}_${room.id}`
                : "message_" + m.client_message_id;
          return `<turbo-stream action="${action}" target="${target}"><template>${messageFragment(messageData([messageById(m.id)!])[0]!)}</template></turbo-stream>`;
        })
        .join(""),
    );
  });
  app.all(
    ["/rooms/:roomId/involvement", "/rooms/:roomId/settings"],
    login,
    (req, res) => {
      const room = required(roomForUser(req.user, req.params.roomId));
      if (["PATCH", "PUT"].includes(req.method)) {
        const choice = req.body.involvement || req.query.involvement,
          allowed =
            room.type === "Rooms::Direct"
              ? ["everything", "nothing"]
              : ["mentions", "everything", "nothing", "invisible"];
        if (!allowed.includes(choice)) return res.sendStatus(422);
        run(
          "UPDATE memberships SET involvement=?,updated_at=? WHERE room_id=? AND user_id=?",
          choice,
          now(),
          room.id,
          req.user.id,
        );
      }
      send(req, res, "involvement", {
        Room: roomData(room, req.user),
        Involvement: get(
          "SELECT involvement FROM memberships WHERE room_id=? AND user_id=?",
          room.id,
          req.user.id,
        )!.involvement,
      });
    },
  );
  registerBoosts(app);
  registerUsers(app);
  registerAccount(app);
  registerSearch(app);
}
function registerRoomForms(app: RouteCollector) {
  app.all(
    [
      "/rooms/:kind/new",
      "/rooms/:kind/:id/edit",
      "/rooms/:kind/:id",
      "/rooms/:kind",
    ],
    login,
    (req, res, next) => {
      const { kind = "", id } = req.params;
      if (!["opens", "closeds", "directs"].includes(kind)) return next();
      let room = id ? roomForUser(req.user, id) : null;
      if (id && !room) return res.sendStatus(404);
      // Direct conversations have their own scope; shared rooms may switch open/closed.
      if (room && (room.type === "Rooms::Direct") !== (kind === "directs"))
        return res.sendStatus(404);
      if (
        room &&
        kind === "directs" &&
        !["GET", "HEAD", "DELETE"].includes(req.method)
      )
        return res.sendStatus(405);
      const type =
        "Rooms::" + kind.slice(0, -1)[0]!.toUpperCase() + kind.slice(1, -1);
      if (room && req.method === "DELETE") {
        if (kind !== "directs" && !can(req.user, room))
          return res.sendStatus(403);
        deleteRoom(room);
        return res.redirect("/");
      }
      if (room && req.method === "GET" && !req.path.endsWith("/edit"))
        return res.redirect("/rooms/" + room.id);
      let settings: Record<string, any> = {};
      try {
        settings = JSON.parse(req.account?.settings || "{}");
      } catch {}
      if (
        !room &&
        kind !== "directs" &&
        settings.restrict_room_creation_to_administrators &&
        req.user.role !== 1
      )
        return res.sendStatus(403);
      if (req.method === "GET") {
        const selected = new Set(
          room
            ? all(
                "SELECT user_id FROM memberships WHERE room_id=?",
                room.id,
              ).map((m) => m.user_id)
            : [req.user.id],
        );
        const users = all(
          "SELECT * FROM users WHERE status=0 ORDER BY lower(name)",
        ).sort(
          (a, b) => Number(selected.has(b.id)) - Number(selected.has(a.id)),
        );
        return send(req, res, "room-form", {
          Room: room
            ? { ...roomData(room, req.user), Type: type }
            : {
                ID: 0,
                Name: "New room",
                Type: type,
                DOM: () => "",
                EditPath: "",
              },
          Users: users.map(userData),
          Selected: Object.fromEntries([...selected].map((id) => [id, true])),
          UserDivider: selected.size,
          CanAdminister: !room || can(req.user, room) || kind === "directs",
          BackPath: room ? "/rooms/" + room.id : "/",
        });
      }
      if (!["POST", "PUT", "PATCH"].includes(req.method))
        return res.sendStatus(405);
      if (room && !can(req.user, room) && kind !== "directs")
        return res.sendStatus(403);
      const raw = req.body.user_ids || req.body["user_ids[]"] || [];
      let ids = [
        ...new Set(
          (Array.isArray(raw) ? raw : [raw])
            .map(Number)
            .filter((n) => Number.isSafeInteger(n) && n > 0),
        ),
      ];
      transaction(() => {
        if (kind === "directs") {
          ids = [...new Set([...ids, req.user.id])].filter(
            (id) => !!get("SELECT id FROM users WHERE id=? AND status=0", id),
          );
          for (const candidate of roomsForUser(req.user.id).filter(
            (r) => r.type === "Rooms::Direct",
          )) {
            const members = all(
              "SELECT user_id FROM memberships WHERE room_id=?",
              candidate.id,
            ).map((r) => r.user_id);
            if (
              members.length === ids.length &&
              members.every((id) => ids.includes(id))
            ) {
              room = candidate;
              return;
            }
          }
        } else if (kind === "opens")
          ids = all("SELECT id FROM users WHERE status=0").map((u) => u.id);
        else ids = [...new Set([...ids, req.user.id])];
        const time = now();
        if (room)
          run(
            "UPDATE rooms SET name=?,type=?,updated_at=? WHERE id=?",
            value(req, "room", "name"),
            type,
            time,
            room.id,
          );
        else {
          const result = run(
            "INSERT INTO rooms(name,type,creator_id,created_at,updated_at) VALUES(?,?,?,?,?)",
            kind === "directs" ? null : value(req, "room", "name"),
            type,
            req.user.id,
            time,
            time,
          );
          room = get(
            "SELECT * FROM rooms WHERE id=?",
            Number(result.lastInsertRowid),
          );
        }
        const current = all(
          "SELECT user_id FROM memberships WHERE room_id=?",
          room!.id,
        );
        for (const m of current)
          if (!ids.includes(m.user_id)) {
            run(
              "DELETE FROM memberships WHERE room_id=? AND user_id=?",
              room!.id,
              m.user_id,
            );
            dropRoomUser(room!.id, m.user_id);
          }
        grantMemberships(room!, ids);
      });
      room = get("SELECT * FROM rooms WHERE id=?", room!.id);
      for (const m of all(
        "SELECT user_id FROM memberships WHERE room_id=?",
        room!.id,
      )) {
        const stream =
          kind === "opens"
            ? "rooms"
            : Buffer.from(`gid://campfire/User/${m.user_id}`)
                .toString("base64")
                .replace(/=+$/, "") + ":rooms";
        const dto = { ...roomData(room!, userById(m.user_id)!), Unread: false };
        publish(
          stream,
          `<turbo-stream action="prepend" target="${kind === "directs" ? "direct_rooms" : "shared_rooms"}"><template>${fragment(kind === "directs" ? "sidebar-direct" : "sidebar-shared", dto)}</template></turbo-stream>`,
        );
      }
      res.redirect("/rooms/" + room!.id);
    },
  );
}
function registerBoosts(app: RouteCollector) {
  app.all(
    [
      "/messages/:messageId/boosts/new",
      "/messages/:messageId/boosts/:id",
      "/messages/:messageId/boosts",
      "/rooms/:roomId/:botKey/messages/:messageId/boosts/:id",
      "/rooms/:roomId/:botKey/messages/:messageId/boosts",
    ],
    (req, res) => {
      const bot = !!req.params.botKey,
        user = bot ? botUser(req) : req.user;
      if (!user)
        return bot ? res.sendStatus(401) : res.redirect("/session/new");
      if (!bot && req.authenticatedByBot) return res.sendStatus(403);
      const message = required(messageById(req.params.messageId || "")),
        room = required(roomForUser(user, message.room_id));
      if (req.params.roomId && Number(req.params.roomId) !== room.id)
        return res.sendStatus(404);
      if (req.method === "POST") {
        const content =
          bot && typeof req.body === "string"
            ? req.body
            : value(req, "boost", "content");
        if (!content.trim() || [...content].length > 16)
          return res.sendStatus(422);
        const time = now(),
          result = run(
            "INSERT INTO boosts(message_id,booster_id,content,created_at,updated_at) VALUES(?,?,?,?,?)",
            message.id,
            user.id,
            content,
            time,
            time,
          ),
          id = Number(result.lastInsertRowid);
        run("UPDATE messages SET updated_at=? WHERE id=?", time, message.id);
        const dto = messageData([message])[0]!,
          boost = dto.Boosts.find((b: Row) => b.ID === id);
        publish(
          rails.stream(room),
          `<turbo-stream action="append" target="boosts_message_${message.client_message_id}" maintain_scroll="true"><template>${fragment("boost", boost)}</template></turbo-stream>`,
        );
        if (bot)
          return res.status(201).json({
            id,
            content,
            created_at: iso(time),
            booster: {
              id: user.id,
              name: user.name,
              role: "bot",
              avatar_url: origin(req) + avatar(user.id, user.updated_at),
            },
            message: {
              id: message.id,
              url: `${origin(req)}/rooms/${room.id}/messages/${message.id}`,
            },
          });
        return res.redirect("/messages/" + message.id + "/boosts");
      }
      if (req.method === "DELETE") {
        required(
          get(
            "SELECT id FROM boosts WHERE id=? AND message_id=? AND booster_id=?",
            Number(req.params.id),
            message.id,
            user.id,
          ),
        );
        run("DELETE FROM boosts WHERE id=?", Number(req.params.id));
        run("UPDATE messages SET updated_at=? WHERE id=?", now(), message.id);
        publish(
          rails.stream(room),
          `<turbo-stream action="remove" target="boost_${req.params.id}"></turbo-stream>`,
        );
        return bot
          ? res.sendStatus(204)
          : turbo(res, "remove", "boost_" + req.params.id);
      }
      if (req.method !== "GET") return res.sendStatus(405);
      send(req, res, req.path.endsWith("/new") ? "new-boost" : "boosts-index", {
        Messages: messageData([message]),
      });
    },
  );
}
function deactivate(user: Row) {
  transaction(() => {
    run(
      "DELETE FROM memberships WHERE user_id=? AND room_id IN(SELECT id FROM rooms WHERE type<>'Rooms::Direct')",
      user.id,
    );
    for (const table of ["sessions", "searches", "push_subscriptions"])
      run(`DELETE FROM ${table} WHERE user_id=?`, user.id);
    run(
      "UPDATE users SET status=1,email_address=?,updated_at=? WHERE id=?",
      user.email_address?.replace("@", "-deactivated-" + token() + "@") || null,
      now(),
      user.id,
    );
  });
  // Sessions are gone: close the user's connections now instead of
  // letting broadcasts filter them out one by one.
  dropUserConnections(user.id);
}
function registerUsers(app: RouteCollector) {
  app.get("/autocompletable/users", login, (req, res) => {
    let users;
    if (req.query.room_id) {
      const room = required(roomForUser(req.user, req.query.room_id as string));
      users = all(
        "SELECT u.* FROM users u JOIN memberships m ON m.user_id=u.id WHERE m.room_id=? AND u.status=0 ORDER BY lower(u.name)",
        room.id,
      );
    } else
      users = all("SELECT * FROM users WHERE status=0 ORDER BY lower(name)");
    const query = String(
      req.query.filter || req.query.query || "",
    ).toLowerCase();
    users = users
      .filter((u) => u.name.toLowerCase().includes(query))
      .slice(0, 20);
    if (req.accepts(["html", "json"]) === "json")
      return res.json(
        users.map((u) => ({
          id: u.id,
          name: escape(u.name),
          label: u.name,
          avatar: avatar(u.id, u.updated_at),
          avatar_url: avatar(u.id, u.updated_at),
          sgid: rails.sgid("User", u.id),
          value: u.id,
        })),
      );
    res.type("html").send(
      users
        .map((u) =>
          fragment("prompt-item", {
            Mention: {
              Name: u.name,
              Title: [u.name, u.bio].filter(Boolean).join(" – "),
              SGID: rails.sgid("User", u.id),
              Path: "/users/" + u.id,
              Avatar: avatar(u.id, u.updated_at),
            },
            HTML: newSafe(
              `<span class="mention" data-user-id="${u.id}">${escape(u.name)}</span>`,
            ),
          }),
        )
        .join(""),
    );
  });
  app.all(
    ["/users/me/profile", "/users/:id/profile"],
    login,
    async (req, res) => {
      let user = req.user;
      if (["PATCH", "PUT"].includes(req.method)) {
        if (file(req, "user[avatar]"))
          await validateUpload(file(req, "user[avatar]"));
        const values: Record<string, any> = {
          name: user.name,
          bio: user.bio,
          email_address: user.email_address,
          password_digest: user.password_digest,
        };
        for (const name of ["name", "bio", "email_address"])
          values[name] = value(req, "user", name, values[name]);
        const password = value(req, "user", "password");
        if (password) values.password_digest = await hashPassword(password);
        run(
          "UPDATE users SET name=?,bio=?,email_address=?,password_digest=?,updated_at=? WHERE id=?",
          values.name,
          values.bio,
          values.email_address,
          values.password_digest,
          now(),
          user.id,
        );
        if (file(req, "user[avatar]"))
          await replaceImage(
            file(req, "user[avatar]"),
            "User",
            user.id,
            "avatar",
          );
        return res.redirect("/users/me/profile");
      }
      const memberships = roomsForUser(user.id).map((r) => ({
          ID: get(
            "SELECT id FROM memberships WHERE room_id=? AND user_id=?",
            r.id,
            user.id,
          )!.id,
          Room: { ...roomData(r, user), Involvement: r.involvement },
          Involvement: r.involvement,
        })),
        direct = memberships.filter((m) => m.Room.Type === "Rooms::Direct"),
        shared = memberships.filter((m) => m.Room.Type !== "Rooms::Direct");
      send(req, res, "profile", {
        DirectMemberships: direct,
        SharedMemberships: shared,
        Memberships: [...direct, ...shared],
        AvatarAttached: !!get(
          "SELECT id FROM active_storage_attachments WHERE record_type='User' AND record_id=? AND name='avatar'",
          user.id,
        ),
        Transfer:
          origin(req) +
          "/session/transfers/" +
          rails.signedId(
            "User",
            user.id,
            "transfer",
            new Date(Date.now() + 4 * 3600000).toISOString(),
          ),
        Platform: { Chrome: true, Firefox: false, IOS: false, Android: false },
        CanAdminister: user.role === 1,
      });
    },
  );
  app.get("/users/:id", login, (req, res) => {
    const user = required(userById(req.params.id || ""));
    send(req, res, "user", {
      Subject: userData(user),
      CanAdminister: req.user.role === 1,
      AvatarURL: avatar(user.id, user.updated_at),
    });
  });
  app.all("/users/:userId/ban", login, admin, (req, res) => {
    const user = required(userById(req.params.userId || ""));
    if (req.method === "DELETE") {
      run("DELETE FROM bans WHERE user_id=?", user.id);
      run("UPDATE users SET status=0,updated_at=? WHERE id=?", now(), user.id);
    } else if (req.method === "POST") {
      transaction(() => {
        const time = now();
        for (const row of all(
          "SELECT DISTINCT ip_address FROM sessions WHERE user_id=? AND ip_address<>''",
          user.id,
        ))
          run(
            "INSERT INTO bans(user_id,ip_address,created_at,updated_at) VALUES(?,?,?,?)",
            user.id,
            row.ip_address,
            time,
            time,
          );
        run("DELETE FROM sessions WHERE user_id=?", user.id);
        run("UPDATE users SET status=2,updated_at=? WHERE id=?", time, user.id);
      });
      dropUserConnections(user.id);
      enqueue("ban-content", { user_id: user.id });
    } else return res.sendStatus(405);
    res.redirect("/users/" + user.id);
  });
}
import nunjucks from "nunjucks";
import sharp from "sharp";
async function validateUpload(upload?: CompatFile | Row | null) {
  if (
    upload &&
    upload.mimetype?.startsWith("image/") &&
    upload.mimetype !== "image/svg+xml"
  )
    try {
      await sharp(upload.buffer!).metadata();
    } catch (error) {
      throw Object.assign(error as Error, { status: 422 });
    }
}
const newSafe = (value: string) => new nunjucks.runtime.SafeString(value);
function registerAccount(app: RouteCollector) {
  app.all(
    ["/account", "/account/edit", "/account/users"],
    login,
    async (req, res) => {
      const account = required(get("SELECT * FROM accounts LIMIT 1"));
      if (["PATCH", "PUT"].includes(req.method)) {
        if (req.user.role !== 1) return res.sendStatus(403);
        if (file(req, "account[logo]"))
          await validateUpload(file(req, "account[logo]"));
        let settings;
        try {
          settings = JSON.parse(account.settings || "{}");
        } catch {
          settings = {};
        }
        const submitted = value(req, "account", "settings", null);
        if (submitted && typeof submitted === "object")
          settings = {
            ...settings,
            restrict_room_creation_to_administrators: [
              "1",
              "true",
              "on",
              true,
            ].includes(
              Array.isArray(submitted.restrict_room_creation_to_administrators)
                ? submitted.restrict_room_creation_to_administrators.at(-1)
                : submitted.restrict_room_creation_to_administrators,
            ),
          };
        run(
          "UPDATE accounts SET name=?,settings=?,updated_at=? WHERE id=?",
          value(req, "account", "name", account.name),
          JSON.stringify(settings),
          now(),
          account.id,
        );
        if (file(req, "account[logo]"))
          await replaceImage(
            file(req, "account[logo]"),
            "Account",
            account.id,
            "logo",
          );
        return res.redirect("/account/edit");
      }
      const users = all(
        `SELECT * FROM users WHERE role<>2 AND status IN (${req.user.role === 1 ? "0,2" : "0"}) ORDER BY lower(name) LIMIT 500`,
      );
      send(req, res, "account", {
        Users: users.filter((u) => u.role !== 1).map(userData),
        Administrators: users.filter((u) => u.role === 1).map(userData),
        Members: users.filter((u) => u.role !== 1).map(userData),
        UserDivider: 0,
        CanAdminister: req.user.role === 1,
        JoinURL: origin(req) + "/join/" + account.join_code,
      });
    },
  );
  app.all("/account/users/:id", login, admin, (req, res) => {
    const user = required(
      get("SELECT * FROM users WHERE id=? AND status=0", Number(req.params.id)),
    );
    if (req.method === "DELETE") deactivate(user);
    else if (["PUT", "PATCH"].includes(req.method))
      run(
        "UPDATE users SET role=?,updated_at=? WHERE id=?",
        value(req, "user", "role") === "administrator" ? 1 : 0,
        now(),
        user.id,
      );
    else return res.sendStatus(405);
    res.redirect("/account/edit");
  });
  app.all(
    [
      "/account/bots/new",
      "/account/bots/:id/edit",
      "/account/bots/:id/key",
      "/account/bots/:id",
      "/account/bots",
    ],
    login,
    admin,
    async (req, res) => {
      let bot = req.params.id
        ? required(
            get(
              "SELECT * FROM users WHERE id=? AND role=2 AND status=0",
              Number(req.params.id),
            ),
          )
        : null;
      if (req.method === "DELETE") {
        deactivate(bot!);
        return res.redirect("/account/bots");
      }
      if (req.path.endsWith("/key") && req.method === "PUT") {
        run(
          "UPDATE users SET bot_token=?,updated_at=? WHERE id=?",
          randomBytes(6).toString("hex"),
          now(),
          bot!.id,
        );
        return res.redirect("/account/bots/" + bot!.id + "/edit");
      }
      if (["POST", "PATCH", "PUT"].includes(req.method)) {
        if (file(req, "user[avatar]"))
          await validateUpload(file(req, "user[avatar]"));
        transaction(() => {
          if (bot)
            run(
              "UPDATE users SET name=?,updated_at=? WHERE id=?",
              value(req, "user", "name"),
              now(),
              bot.id,
            );
          else
            bot = createUser({
              name: value(req, "user", "name") as string,
              role: 2,
              bot_token: randomBytes(6).toString("hex"),
            })!;
          const url = value(req, "user", "webhook_url");
          run("DELETE FROM webhooks WHERE user_id=?", bot!.id);
          if (url)
            run(
              "INSERT INTO webhooks(user_id,url,created_at,updated_at) VALUES(?,?,?,?)",
              bot!.id,
              url,
              now(),
              now(),
            );
        });
        if (file(req, "user[avatar]"))
          await replaceImage(
            file(req, "user[avatar]"),
            "User",
            bot!.id,
            "avatar",
          );
        return res.redirect("/account/bots");
      }
      if (req.path.endsWith("/new") || req.path.endsWith("/edit"))
        return send(req, res, "bot-form", {
          Subject: userData(bot),
          Webhook: bot
            ? get("SELECT url FROM webhooks WHERE user_id=?", bot.id)?.url || ""
            : "",
          AvatarURL: bot ? avatar(bot.id, bot.updated_at) : "",
        });
      send(req, res, "bots", {
        Bots: all(
          "SELECT * FROM users WHERE role=2 AND status=0 ORDER BY lower(name)",
        ).map((u) => ({
          User: userData(u),
          Rooms: roomsForUser(u.id).map((r) => roomData(r, u)),
        })),
      });
    },
  );
  app.all(
    ["/account/custom_styles", "/account/custom_styles/edit"],
    login,
    admin,
    (req, res) => {
      const account = required(get("SELECT * FROM accounts LIMIT 1"));
      if (["PATCH", "PUT"].includes(req.method)) {
        run(
          "UPDATE accounts SET custom_styles=?,updated_at=? WHERE id=?",
          value(req, "account", "custom_styles"),
          now(),
          account.id,
        );
        return res.redirect("/account/custom_styles/edit");
      }
      send(req, res, "custom-styles", {
        Styles: account.custom_styles || "",
        CustomStylesBody: account.custom_styles || "",
      });
    },
  );
  app.post("/account/join_code", login, admin, (req, res) => {
    run("UPDATE accounts SET join_code=?,updated_at=?", token(), now());
    res.redirect("/account/edit");
  });
}
function registerSearch(app: RouteCollector) {
  app.all(["/searches", "/searches/clear"], login, (req, res) => {
    const query = String(req.query.q ?? req.body?.q ?? "")
      .replace(/[^\p{L}\p{N}_]/gu, " ")
      .trim();
    if (req.method === "DELETE") {
      run("DELETE FROM searches WHERE user_id=?", req.user.id);
      return res.redirect("/searches");
    }
    if (req.method === "POST") {
      if (query) {
        transaction(() => {
          const old = get(
            "SELECT id FROM searches WHERE user_id=? AND query=?",
            req.user.id,
            query,
          );
          if (old)
            run("UPDATE searches SET updated_at=? WHERE id=?", now(), old.id);
          else
            run(
              "INSERT INTO searches(user_id,query,created_at,updated_at) VALUES(?,?,?,?)",
              req.user.id,
              query,
              now(),
              now(),
            );
          run(
            "DELETE FROM searches WHERE user_id=? AND id NOT IN(SELECT id FROM searches WHERE user_id=? ORDER BY updated_at DESC LIMIT 10)",
            req.user.id,
            req.user.id,
          );
        });
      }
      return res.redirect("/searches?" + new URLSearchParams({ q: query }));
    }
    // Search fast path: the FTS id query is cheap, everything after
    // it (message fetches, render, gzip) is cached keyed on the
    // query, the matched message versions, the recent-search state
    // and the usual page versions. The search page links back to the
    // last room, so the session's last_room_id is part of the key.
    const matchIds: number[] = query
      ? all(
          "SELECT m.id FROM messages m JOIN message_search_index idx ON idx.rowid=m.id JOIN memberships ms ON ms.room_id=m.room_id WHERE ms.user_id=? AND idx.body MATCH ? ORDER BY m.created_at DESC LIMIT 100",
          req.user.id,
          query
            .split(/\s+/)
            .map((word) => '"' + word.replaceAll('"', '""') + '"')
            .join(" "),
        ).map((r) => r.id)
      : [];
    const rows: Row[] = messagesByIds(matchIds).sort((a, b) =>
      a.created_at.localeCompare(b.created_at),
    );
    const searchAccount = get("SELECT id,updated_at FROM accounts LIMIT 1");
    const searchKey = [
      req.path,
      origin(req),
      req.user.id,
      req.user.updated_at,
      query,
      get("SELECT MAX(updated_at) AS max FROM searches WHERE user_id=?", req.user.id)?.max || "",
      rows.map((m) => `${m.id}-${m.updated_at}`).join(","),
      searchAccount?.updated_at,
      get(
        "SELECT id FROM active_storage_attachments WHERE record_type='Account' AND record_id=? AND name='logo'",
        searchAccount?.id,
      ) ? 1 : 0,
      req.session.last_room_id || "",
      String(req.session._csrf_token || ""),
      req.get("Turbo-Frame") || "",
    ].join("|");
    const cachedSearch = readPage(searchKey);
    if (cachedSearch !== undefined)
      return res.type("html").send(cachedSearch);
    const searchMessages = messageData(rows);
    const searchHtml = render(req, "search", {
      Messages: searchMessages,
      MessagesHTML: messagesHtml(searchMessages),
      Query: query,
      RecentSearches: all(
        "SELECT query FROM searches WHERE user_id=? ORDER BY updated_at DESC LIMIT 10",
        req.user.id,
      ).map((s) => s.query),
    });
    writePage(searchKey, searchHtml);
    res.type("html").send(searchHtml);
  });
}
