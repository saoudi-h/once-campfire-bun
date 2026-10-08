import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import QRCode from "qrcode";
import { get } from "./db.ts";
import * as rails from "./rails.ts";
import { makeRes, type CompatReq, type CompatRes } from "./compat.ts";
import {
  variant,
  pathFor,
  serve,
  removeAttachment,
  purgeBlob,
} from "./storage.ts";

const colors = [
  "#AF2E1B",
  "#CC6324",
  "#3B4B59",
  "#BFA07A",
  "#ED8008",
  "#ED3F1C",
  "#BF1B1B",
  "#736B1E",
  "#D07B53",
  "#736356",
  "#AD1D1D",
  "#BF7C2A",
  "#C09C6F",
  "#698F9C",
  "#7C956B",
  "#5D618F",
  "#3B3633",
  "#67695E",
];
function crc32(value: string) {
  let c = -1;
  for (const byte of Buffer.from(value)) {
    c ^= byte;
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (c & 1 ? 0xedb88320 : 0);
  }
  return (c ^ -1) >>> 0;
}
const escape = (value: unknown) =>
  String(value).replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" } as Record<
        string,
        string
      >)[c]!,
  );
function attachment(type: string, id: number | string, name: string) {
  return get(
    "SELECT b.* FROM active_storage_attachments a JOIN active_storage_blobs b ON b.id=a.blob_id WHERE a.record_type=? AND a.record_id=? AND a.name=?",
    type,
    id,
    name,
  );
}
// Static avatar artwork (reference tree is immutable): read once,
// not per request.
let botAvatarSvg = "";
let initialsTemplate = "";
function staticAvatars() {
  botAvatarSvg ||= fs.readFileSync(
    "reference/app/assets/images/default-bot-avatar.svg",
    "utf8",
  );
  initialsTemplate ||= fs.readFileSync(
    "reference/app/views/users/avatars/show.svg.erb",
    "utf8",
  );
  return { botAvatarSvg, initialsTemplate };
}
export interface AvatarResult {
  status: number;
  headers: Record<string, string>;
  file?: unknown;
  body?: unknown;
}
// Avatar response cache: the signed id is stable per user, so the
// entry is keyed by user id and dropped when the avatar changes
// (replaceImage, avatar DELETE). Blob responses are immutable bytes
// served from memory; SVG initials depend on the mutable name and
// stay dynamic.
const avatarCache = new Map<number, { status: number; headers: Record<string, string>; data: Buffer }>();
const AVATAR_CACHE_MAX = 512;
export function dropAvatarCache(userId: number) {
  avatarCache.delete(Number(userId));
}
function toAvatarResult(res: CompatRes): AvatarResult {
  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(res.headers))
    headers[k] = Array.isArray(v) ? v.join(", ") : String(v);
  return {
    status: res.statusCode,
    headers,
    file: (res as any).bunFile,
    body: res.body === undefined ? undefined : res.body,
  };
}
// Native avatar resolver (no session/DB auth: the signed id is the
// credential). Shared by the native Elysia route in app.ts; byte
// behavior matches the old compat route.
export async function avatarPayload(
  signedId: string | undefined,
  header: (name: string) => string | undefined,
  method: string,
): Promise<AvatarResult> {
  try {
    return await avatarPayloadInner(signedId, header, method);
  } catch {
    // Missing files, corrupt variants: 404 like the old route.
    return { status: 404, headers: {} };
  }
}
async function avatarPayloadInner(
  signedId: string | undefined,
  header: (name: string) => string | undefined,
  method: string,
): Promise<AvatarResult> {
  let userId: number;
  try {
    userId = Number(rails.verifyId("User", signedId, "avatar"));
  } catch {
    return { status: 404, headers: {} };
  }
  // Hot path: immutable bytes, no database at all. The entry is
  // dropped when the avatar changes; ranges bypass the cache.
  if (header("range") === undefined) {
    const cached = avatarCache.get(userId);
    if (cached) {
      if (header("if-none-match") === cached.headers.etag)
        return {
          status: 304,
          headers: {
            etag: cached.headers.etag!,
            "cache-control": cached.headers["cache-control"]!,
          },
        };
      return {
        status: cached.status,
        headers: { ...cached.headers },
        body: cached.data,
      };
    }
  }
  const user = get("SELECT * FROM users WHERE id=?", userId);
  if (!user) return { status: 404, headers: {} };
  const blob = attachment("User", user.id, "avatar");
  const etag = `"${crypto
    .createHash("sha256")
    .update(JSON.stringify([user.id, user.name, user.updated_at, blob?.id]))
    .digest("hex")}"`;
  const baseHeaders: Record<string, string> = {
    etag,
    "cache-control": "public, max-age=1800, stale-while-revalidate=604800",
  };
  if (header("if-none-match") === etag)
    return { status: 304, headers: baseHeaders };
  if (blob) {
    const out = await variant(blob, [512, 512], "webp");
    const file = pathFor(out.key);
    const res = makeRes();
    res.set(baseHeaders);
    serve(
      { headers: { range: header("range") }, method } as unknown as CompatReq,
      res,
      file,
      "image/webp",
      out.filename,
    );
    const result = toAvatarResult(res);
    // Cache full-file 200s (ranges stay dynamic): bounded, dropped
    // on avatar change.
    if (
      result.status === 200 &&
      typeof result.file === "object" &&
      result.file !== null &&
      header("range") === undefined
    ) {
      try {
        const data = Buffer.from(
          await (result.file as { arrayBuffer(): Promise<ArrayBuffer> }).arrayBuffer(),
        );
        if (avatarCache.size >= AVATAR_CACHE_MAX) {
          const oldest = avatarCache.keys().next();
          if (!oldest.done) avatarCache.delete(oldest.value);
        }
        avatarCache.set(Number(user.id), {
          status: result.status,
          headers: { ...result.headers },
          data,
        });
        return { ...result, body: data, file: undefined };
      } catch {
        // Fall through with the file slice.
      }
    }
    return result;
  }
  if (user.role === 2)
    return {
      status: 200,
      headers: { ...baseHeaders, "content-type": "image/svg+xml" },
      body: staticAvatars().botAvatarSvg,
    };
  const initials = Array.from(
    user.name.matchAll(/(?:^|\s)(\S)/gu) as Iterable<RegExpMatchArray>,
  )
    .map((m) => m[1])
    .join("");
  const svg = staticAvatars()
    .initialsTemplate.replace(
      "<%= avatar_background_color(@user) %>",
      colors[crc32(String(user.id)) % colors.length]!,
    )
    .replace("<%= @user.initials %>", escape(initials))
    .replace(
      /<%=raw .*? %>/g,
      initials.length >= 3
        ? 'textLength="85%" lengthAdjust="spacingAndGlyphs"'
        : "",
    );
  return {
    status: 200,
    headers: { ...baseHeaders, "content-type": "image/svg+xml" },
    body: svg,
  };
}
export function registerPublic(
  add: (method: string, path: string, handler: (req: CompatReq, res: CompatRes) => any) => void,
) {
  // NOTE: /up is served natively in app.ts (no session/DB/compat
  // overhead for the health check); see UP_HTML there.
  // NOTE: user avatars are served natively in app.ts via
  // avatarPayload (no session/DB auth: the signed id is the
  // credential).
  add("DELETE", "/users/me/avatar", (req, res) => {
    if (!req.user) return res.sendStatus(401);
    for (const id of removeAttachment("User", req.user.id, "avatar"))
      purgeBlob(id);
    dropAvatarCache(req.user.id);
    res.redirect("/users/me/profile");
  });
  add("GET", "/account/logo", async (req, res) => {
    try {
      const account = get("SELECT * FROM accounts LIMIT 1");
      const blob = account && attachment("Account", account.id, "logo");
      if (blob) {
        const out = await variant(
          blob,
          req.query.size === "small" ? [192, 192] : [512, 512],
          "png",
        );
        return serve(req, res, pathFor(out.key), "image/png", out.filename);
      }
      const filename =
        req.query.size === "small" ? "app-icon-192.png" : "app-icon.png";
      res
        .type("png")
        .send(
          fs.readFileSync(
            path.join("reference/app/assets/images/logos", filename),
          ),
        );
    } catch {
      res.sendStatus(404);
    }
  });
  add("DELETE", "/account/logo", (req, res) => {
    if (!req.user || req.user.role !== 1) return res.sendStatus(403);
    const account = get("SELECT * FROM accounts LIMIT 1");
    if (account)
      for (const id of removeAttachment("Account", account.id, "logo"))
        purgeBlob(id);
    res.redirect("/account/edit");
  });
  for (const __p of ["/webmanifest", "/webmanifest.json"]) add("GET", __p, (req, res) => {
    const account = get("SELECT name FROM accounts LIMIT 1");
    res.type("application/manifest+json").json({
      name: account?.name || "Campfire",
      icons: [
        {
          src: "/account/logo?size=small",
          type: "image/png",
          sizes: "192x192",
        },
        { src: "/account/logo", type: "image/png", sizes: "512x512" },
        {
          src: "/account/logo",
          type: "image/png",
          sizes: "512x512",
          purpose: "maskable",
        },
      ],
      start_url: "/",
      display: "standalone",
      scope: "/",
      description: "A chat app from the makers of Basecamp and HEY.",
      categories: ["social", "business", "productivity"],
      theme_color: "#ffffff",
      background_color: "#ffffff",
      shortcuts: [
        { name: "New chat room", url: "/rooms/opens/new" },
        { name: "My profile", url: "/users/me/profile" },
      ],
    });
  });
  for (const __p of ["/service-worker", "/service-worker.js"]) add("GET", __p, (req, res) =>
    res
      .type("application/javascript")
      .send(fs.readFileSync("reference/app/views/pwa/service_worker.js")),
  );
  add("GET", "/qr_code/:id", async (req, res) => {
    try {
      const raw = rails.decode64(req.params.id);
      const value = new TextDecoder("utf-8", { fatal: true }).decode(raw);
      if (value.length > 4096) return res.sendStatus(422);
      res.type("png").send(await QRCode.toBuffer(value));
    } catch {
      res.sendStatus(404);
    }
  });
}
