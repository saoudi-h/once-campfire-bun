import nunjucks from "nunjucks";
import { readFileSync, existsSync } from "node:fs";
import { all, get, type Row } from "./db.ts";
import * as rails from "./rails.ts";
import { escape, plainText, renderBody } from "./richtext.ts";
import { blobUrl, representationUrl } from "./storage.ts";
import type { CompatReq } from "./compat.ts";
const env = new nunjucks.Environment(
  new nunjucks.FileSystemLoader(
    new URL("../templates/", import.meta.url).pathname,
  ),
  { autoescape: true },
);
const safe = (value: string) => new nunjucks.runtime.SafeString(value || "");
// Cache size knob (PERF-15): per-cache CAMPFIRE_<NAME>_CACHE_MB,
// fallback CAMPFIRE_CACHE_MB, default 32. Read once at import;
// defaults preserve current behavior exactly.
export function cacheLimitMb(envName: string, defMb: number): number {
  const pick = (v: string | undefined) => {
    const n = Number(v);
    return v !== undefined && Number.isFinite(n) && n > 0 ? n : undefined;
  };
  const mb =
    pick(process.env[envName]) ?? pick(process.env.CAMPFIRE_CACHE_MB) ?? defMb;
  return Math.floor(mb * 1024 * 1024);
}
const generatedCache = new Map<string, string>();
function generated(name: string, fallback = "") {
  const cached = generatedCache.get(name);
  if (cached !== undefined) return cached;
  const path = new URL(`../assets/generated/${name}`, import.meta.url);
  const value = existsSync(path) ? readFileSync(path, "utf8") : fallback;
  generatedCache.set(name, value);
  return value;
}
export function generatedCacheClear() {
  generatedCache.clear();
}
let manifest: Record<string, { digested_path?: string }> | undefined;
export function asset(name: string) {
  manifest ||= JSON.parse(
    generated("manifest.json", "{}"),
  ) as Record<string, { digested_path?: string }>;
  return "/assets/" + (manifest[name]?.digested_path || name);
}
export function epoch(value: unknown) {
  return value
    ? new Date(
        String(value).replace(" ", "T") +
          (String(value).endsWith("Z") ? "" : "Z"),
      ).getTime() || 0
    : 0;
}
export function iso(value: unknown) {
  return new Date(epoch(value)).toISOString();
}
export function avatar(id: unknown, updated: unknown) {
  return (
    `/users/${rails.signedId("User", Number(id), "avatar")}/avatar` +
    (updated ? "?v=" + versionTime(updated) : "")
  );
}
export function versionTime(value: unknown) {
  return new Date(epoch(value))
    .toISOString()
    .replace(/[-:T]/g, "")
    .slice(0, 14);
}
// Fragment cache (Rails `cache record do` / Rust `FragmentCache` port): the
// room page re-renders every message on each request although the HTML
// of a message version never changes. Cache the rendered `_message`
// partial keyed by message id + updated_at (Rails `cache_key_with_version`),
// bounded LRU like ActiveSupport::MemoryStore (see cacheLimitMb).
const FRAGMENT_MAX_BYTES = cacheLimitMb("CAMPFIRE_FRAGMENT_CACHE_MB", 32);
const FRAGMENT_PRUNE_TO = Math.floor(FRAGMENT_MAX_BYTES * 0.75);
const FRAGMENT_ENTRY_OVERHEAD = 240;
const fragmentStore = new Map<string, { html: string; bytes: number }>();
let fragmentBytes = 0;
// Rendered body-HTML cache: renderBody()/plainText() re-parse each message
// body with parse5 on every request, although the body only changes when
// the message's updated_at changes. Memoize per message version.
const bodyHtmlCache = new Map<string, { body: string; text: string; bytes: number }>();
const BODY_HTML_MAX_BYTES = cacheLimitMb("CAMPFIRE_BODY_CACHE_MB", 32);
let bodyHtmlBytes = 0;
export function bodyCacheStats() {
  return { entries: bodyHtmlCache.size, bytes: bodyHtmlBytes };
}
export function bodyCacheClear() {
  bodyHtmlCache.clear();
  bodyHtmlBytes = 0;
}
function bodyHtmlFor(id: unknown, updatedAt: unknown, raw: string): { body: string; text: string } {
  const key = `body/${id}-${updatedAt}`;
  const hit = bodyHtmlCache.get(key);
  if (hit) {
    // LRU touch like the fragment store.
    bodyHtmlCache.delete(key);
    bodyHtmlCache.set(key, hit);
    return hit;
  }
  const entry = { body: renderBody(raw), text: plainText(raw), bytes: 0 };
  entry.bytes = key.length + entry.body.length + entry.text.length + FRAGMENT_ENTRY_OVERHEAD;
  if (entry.bytes < FRAGMENT_MAX_BYTES / 4) {
    bodyHtmlCache.set(key, entry);
    bodyHtmlBytes += entry.bytes;
    while (bodyHtmlBytes > BODY_HTML_MAX_BYTES && bodyHtmlCache.size > 0) {
      const oldest = bodyHtmlCache.keys().next();
      if (oldest.done) break;
      const victim = bodyHtmlCache.get(oldest.value);
      bodyHtmlCache.delete(oldest.value);
      if (victim) bodyHtmlBytes -= victim.bytes;
    }
  }
  return entry;
}
export function fragmentCacheStats() {
  return { entries: fragmentStore.size, bytes: fragmentBytes };
}
export function fragmentCacheClear() {
  fragmentStore.clear();
  fragmentBytes = 0;
}
function fragmentKey(id: unknown, updatedAt: unknown): string {
  return `views/messages/_message/messages/${id}-${updatedAt}/presentation-v3`;
}
export function readMessageFragment(id: unknown, updatedAt: unknown): string | undefined {
  const entry = fragmentStore.get(fragmentKey(id, updatedAt));
  if (!entry) return undefined;
  // LRU touch: re-insert so eviction drops least-recently-used first.
  fragmentStore.delete(fragmentKey(id, updatedAt));
  fragmentStore.set(fragmentKey(id, updatedAt), entry);
  return entry.html;
}
export function writeMessageFragment(id: unknown, updatedAt: unknown, html: string): void {
  const key = fragmentKey(id, updatedAt);
  const bytes = key.length + html.length + FRAGMENT_ENTRY_OVERHEAD;
  if (bytes > FRAGMENT_MAX_BYTES / 4) return;
  const old = fragmentStore.get(key);
  if (old) fragmentBytes -= old.bytes;
  else fragmentStore.delete(key);
  fragmentStore.set(key, { html, bytes });
  fragmentBytes += bytes;
  while (fragmentBytes > FRAGMENT_MAX_BYTES && fragmentStore.size > 0) {
    const oldest = fragmentStore.keys().next();
    if (oldest.done) break;
    const victim = fragmentStore.get(oldest.value);
    fragmentStore.delete(oldest.value);
    if (victim) fragmentBytes -= victim.bytes;
  }
}
// Whole-page cache (Rust "cache every part of a page" port): the room
// show and messages-list HTML only change when the underlying rows
// change, but render() re-runs nunjucks over ~500KB on every request.
// Callers build a key from every input that can change the output
// (room/user/account versions, host, paging anchor, per-session CSRF
// token) and skip the render on a hit. Bounded LRU (see cacheLimitMb).
const PAGE_MAX_BYTES = cacheLimitMb("CAMPFIRE_PAGE_CACHE_MB", 32);
const pageStore = new Map<string, { html: string; bytes: number }>();
let pageBytes = 0;
export function pageCacheStats() {
  return { entries: pageStore.size, bytes: pageBytes };
}
export function pageCacheClear() {
  pageStore.clear();
  pageBytes = 0;
}
export function readPage(key: string): string | undefined {
  const hit = pageStore.get(key);
  if (hit === undefined) return undefined;
  // LRU touch: re-insert so eviction drops least-recently-used first.
  pageStore.delete(key);
  pageStore.set(key, hit);
  return hit.html;
}
export function writePage(key: string, html: string): void {
  const bytes = key.length + html.length + FRAGMENT_ENTRY_OVERHEAD;
  if (bytes > PAGE_MAX_BYTES / 4) return;
  const old = pageStore.get(key);
  if (old !== undefined) {
    pageBytes -= old.bytes;
    pageStore.delete(key);
  }
  pageStore.set(key, { html, bytes });
  pageBytes += bytes;
  while (pageBytes > PAGE_MAX_BYTES && pageStore.size > 0) {
    const oldest = pageStore.keys().next();
    if (oldest.done) break;
    const victim = pageStore.get(oldest.value);
    pageStore.delete(oldest.value);
    if (victim) pageBytes -= victim.bytes;
  }
}
export function userData(user: Row | null | undefined) {
  if (!user) return { ID: 0, Role: 0, Name: "" };
  return {
    ID: user.id,
    Role: user.role,
    Name: user.name,
    Email: user.email_address || "",
    Bio: user.bio || "",
    UpdatedAt: user.updated_at,
    Title: [user.name, user.bio].filter(Boolean).join(" – "),
    Status: user.status,
    BotKey: `${user.id}-${user.bot_token}`,
    Administer: user.role === 1,
  };
}
export function roomData(room: Row, user: Row | null | undefined) {
  const kind = (room.type || "Rooms::Open").split("::").pop().toLowerCase();
  const members =
    kind === "direct"
      ? all(
          "SELECT u.* FROM users u JOIN memberships m ON m.user_id=u.id WHERE m.room_id=? ORDER BY u.name",
          room.id,
        ).filter((u) => u.id !== user?.id)
      : [];
  return {
    ID: room.id || 0,
    Name:
      kind === "direct"
        ? members.map((u) => u.name).join(", ")
        : room.name || "",
    Type: room.type,
    UpdatedAt: room.updated_at,
    CreatorID: room.creator_id,
    DOM: (prefix: string) => `${prefix}_rooms_${kind}_${room.id}`,
    Noun: kind === "direct" ? "ping" : "room",
    EditPath: `/rooms/${kind}s/${room.id}/edit`,
    Members: members.map(userData),
    Label: members.map((u) => u.name.split(" ")[0]).join(", "),
  };
}
export function messageData(messages: Row[], origin = "") {
  if (!messages.length) return [];
  const ids = messages.map((m) => m.id),
    placeholders = ids.map(() => "?").join(",");
  const bodies = new Map(
    all(
      `SELECT record_id,body FROM action_text_rich_texts WHERE record_type='Message' AND name='body' AND record_id IN (${placeholders})`,
      ...ids,
    ).map((r) => [r.record_id, r.body || ""]),
  );
  const blobs = new Map(
    all(
      `SELECT a.record_id,b.* FROM active_storage_attachments a JOIN active_storage_blobs b ON b.id=a.blob_id WHERE a.record_type='Message' AND a.name='attachment' AND a.record_id IN (${placeholders})`,
      ...ids,
    ).map((r) => [r.record_id, r]),
  );
  const boosts = all(
    `SELECT b.*,u.name,u.bio,u.updated_at AS booster_updated_at FROM boosts b JOIN users u ON u.id=b.booster_id WHERE b.message_id IN (${placeholders}) ORDER BY b.created_at`,
    ...ids,
  );
  return messages.map((m) => {
    const blob = blobs.get(m.id);
    const rawBody = bodies.get(m.id) || "";
    const cached = bodyHtmlFor(m.id, m.updated_at, rawBody);
    let body = cached.body;
    const text = cached.text;
    let url = "";
    if (blob) {
      url = blobUrl(blob);
      const name = escape(blob.filename);
      if (
        (blob.content_type || "").startsWith("image/") ||
        blob.content_type === "application/pdf"
      )
        body = `<a href="${url}" data-lightbox-target="image" data-action="lightbox#open" data-lightbox-url-value="${url}?disposition=attachment"><img class="message__attachment" src="${representationUrl(blob, [1200, 800], undefined!)}" alt="${name}" loading="lazy"></a>`;
      else if ((blob.content_type || "").startsWith("video/"))
        body = `<video src="${url}" poster="${representationUrl(blob, [1200, 800], undefined!)}" controls class="message__attachment"></video>`;
      else body = `<a href="${url}?disposition=attachment">${name}</a>`;
    }
    return {
      ID: m.id,
      ClientID: m.client_message_id,
      CreatorID: m.creator_id,
      Creator:
        m.creator_name ||
        get("SELECT name FROM users WHERE id=?", m.creator_id)?.name,
      CreatorTitle: m.creator_name,
      CreatorUpdatedAt: m.creator_updated_at,
      RoomID: m.room_id,
      RoomName: m.room_name || "",
      CreatedAt: m.created_at,
      UpdatedAt: m.updated_at,
      HTML: safe('<div class="lexxy-content">' + body + "</div>"),
      AllEmoji: !!text && !/[\p{L}\p{N}]/u.test(text),
      Boosts: boosts
        .filter((b) => b.message_id === m.id)
        .map((b) => ({
          ID: b.id,
          MessageID: b.message_id,
          BoosterID: b.booster_id,
          Booster: b.name,
          BoosterTitle: b.name,
          BoosterUpdatedAt: b.booster_updated_at,
          Content: b.content,
        })),
      Attachment: blob ? { Filename: blob.filename } : null,
      DownloadURL: url ? url + "?disposition=attachment" : "",
      BlobURL: url,
      Permalink: `${origin}/rooms/${m.room_id}/@${m.id}`,
    };
  });
}
const translations: Record<string, Array<[string, string]>> = JSON.parse(
  readFileSync(new URL("./translations.json", import.meta.url), "utf8"),
);
const reactions: Array<[string, string]> = [
  ["👍", "Thumbs up"],
  ["👏", "Clapping"],
  ["👋", "Waving hand"],
  ["💪", "Muscle"],
  ["❤️", "Red heart"],
  ["😂", "Face with tears of joy"],
  ["🎉", "Party popper"],
  ["🔥", "Fire"],
];
for (const [name, fn] of Object.entries({
  asset,
  avatar,
  epoch,
  iso,
  versionTime,
  len: (x: { length?: number } | null | undefined) => x?.length || 0,
  get: (
    x: Record<string, unknown> | null | undefined,
    k: string | number,
  ) => x?.[k] || false,
  firstName: (s: string) => (s || "").split(" ")[0],
  lower: (s: string) => (s || "").toLowerCase(),
  stylesheets: () => safe(generated("stylesheets.html")),
  importmap: () => safe(generated("importmap.html")),
  // nunjucks templates pass printf arguments as arbitrary values
  printf: (fmt: string, ...args: any[]) =>
    fmt.replace(/%[sd]/g, () => args.shift()),
  allEmoji: (s: string) => !!s && !/[\p{L}\p{N}]/u.test(s),
  qrpath: (s: string) => "/qr_code/" + Buffer.from(s).toString("base64url"),
  humanInvolvement: (s: string) =>
    ({
      everything: "Notifying about all messages",
      mentions: "Notifying about @ mentions",
      nothing: "Notifications are off",
      invisible: "Notifications are off and room invisible in sidebar",
    } as Record<string, string>)[s] || "",
  nextInvolvement: (kind: string, v: string) => {
    const choices =
      kind === "Rooms::Direct"
        ? ["everything", "nothing"]
        : ["mentions", "everything", "nothing", "invisible"];
    return choices[(choices.indexOf(v) + 1) % choices.length];
  },
  reactions: () =>
    reactions.map(([Character, Title]) => ({ Character, Title })),
  agent: (s: string) => ({ Name: s, Platform: "", Browser: s }),
  helpMailto: (u: { Email: string }) =>
    safe(`href="mailto:${escape(u.Email)}"`),
  botCommand: (origin: string, room: string | number, key: string) =>
    `curl -d 'Hello!' ${origin}/rooms/${room}/${key}/messages`,
  translate: (key: string) =>
    safe(
      '<details class="position-relative" data-controller="popup"><summary class="btn"><img width="20" height="20" src="' +
        asset("globe.svg") +
        '"><span class="for-screen-reader">Translate</span></summary><dl>' +
        (translations[key] || [])
          .map(
            ([flag, text]) =>
              `<dt>${escape(flag)}</dt><dd>${escape(text)}</dd>`,
          )
          .join("") +
        "</dl></details>",
    ),
}))
  env.addGlobal(name, fn);
// Precompiled screen wrappers: fragment() used to call
// env.renderString(), which runs `new Template(src)` on every
// request (nunjucks/src/environment.js). The wrapper source is
// fixed per screen name (a bounded set), so compile once and
// render the cached template instead.
const wrapperCache = new Map<string, { render: (ctx: unknown) => string }>();
function wrapperFor(name: string): { render: (ctx: unknown) => string } {
  const key = name.replaceAll("-", "_");
  const cached = wrapperCache.get(key);
  if (cached) return cached;
  const tpl = nunjucks.compile(`{% import "pages.html" as p %}{{ p.${key}(dot) }}`, env);
  wrapperCache.set(key, tpl);
  return tpl;
}
// Render one message's `_message` partial through the fragment cache.
// On hit the cached HTML is byte-identical to a fresh render; on miss
// the partial is rendered once and stored for later requests. Like Rust's
// `cached_message`, the presenter only needs id + updated_at to look up.
export function messageFragment(item: Record<string, unknown>): string {
  const html = readMessageFragment(item.ID, item.UpdatedAt);
  if (html !== undefined) return html;
  const rendered = fragment("message", item);
  writeMessageFragment(item.ID, item.UpdatedAt, rendered);
  return rendered;
}
// Render a whole message list through the fragment cache and concatenate.
// Passed as `MessagesHTML`, this lets the `messages` macro skip its
// per-message Nunjucks loop entirely on full hits.
export function messagesHtml(items: Record<string, unknown>[]): string {
  return items.map(messageFragment).join("");
}
export function fragment(
  name: string,
  data: Record<string, unknown> = {},
): string {
  return wrapperFor(name).render({ dot: data });
}
export function render(
  req: CompatReq,
  screen: string,
  extra: Record<string, unknown> = {},
) {
  const account = get("SELECT * FROM accounts LIMIT 1");
  let settings: Record<string, unknown> = {};
  try {
    settings = JSON.parse(account?.settings || "{}");
  } catch {}
  const Account = account
    ? {
        ID: account.id,
        Name: account.name,
        JoinCode: account.join_code,
        UpdatedAt: account.updated_at,
        HasLogo: !!get(
          "SELECT id FROM active_storage_attachments WHERE record_type='Account' AND record_id=? AND name='logo'",
          account.id,
        ),
        RestrictRooms: !!settings.restrict_room_creation_to_administrators,
        RestrictRoomCreation:
          !!settings.restrict_room_creation_to_administrators,
      }
    : {};
  const data = {
    User: userData(req.user),
    Account,
    Screen: screen,
    BodyClass:
      screen === "search"
        ? "sidebar searches"
        : ["room", "welcome"].includes(screen)
          ? "sidebar"
          : screen,
    Title: "Campfire",
    Frame: !!req.get?.("Turbo-Frame"),
    Origin: `${req.protocol || "http"}://${req.get?.("host") || "localhost"}`,
    CSRF: req.csrfToken || "",
    Version: "once-campfire-express",
    VAPIDPublicKey: process.env.VAPID_PUBLIC_KEY || "",
    CustomStyles: safe(
      account?.custom_styles ? `<style>${account.custom_styles}</style>` : "",
    ),
    Messages: [],
    RecentSearches: [],
    RoomsStream: rails.signStream("rooms"),
    UserRoomsStream: req.user
      ? rails.signStream(
          Buffer.from(`gid://campfire/User/${req.user.id}`)
            .toString("base64")
            .replace(/=+$/, "") + ":rooms",
        )
      : "",
    CanCreateRooms: req.user?.role === 1 || !Account.RestrictRooms,
    Notice: "",
    Error: "",
    Reload: false,
    Chat: screen === "room",
    ReturnRoom: req.session?.last_room_id || "",
    Query: "",
    ...extra,
  };
  let html = fragment(screen, data);
  const csrf = escape(req.csrfToken || "");
  html = html.replace(
    "</head>",
    `<meta name="csrf-param" content="authenticity_token"><meta name="csrf-token" content="${csrf}"></head>`,
  );
  return html.replace(
    /(<form\b[^>]*\bmethod="post"[^>]*>)/gi,
    `$1<input type="hidden" name="authenticity_token" value="${csrf}">`,
  );
}
