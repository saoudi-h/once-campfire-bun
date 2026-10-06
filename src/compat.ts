// Compatibility layer: Express-like req/res facade over Elysia 2.
// Only this file and cable.ts touch Elysia/WS primitives directly.
import { randomBytes } from "node:crypto";
import * as rails from "./rails.ts";
import { get, run, now } from "./db.ts";
import { allowLogin } from "./rate_limit.ts";

export interface CompatFile {
  fieldname: string;
  originalname: string;
  filename?: string;
  mimetype: string;
  content_type?: string;
  buffer?: Buffer;
  data?: Buffer;
  size: number;
  /** Original web File kept for native pipelines; resolved by resolveFiles. */
  _webFile?: File;
}

export interface CompatReq {
  method: string;
  path: string;
  originalUrl: string;
  url: string;
  params: Record<string, string | undefined>;
  query: Record<string, BodyValue>;
  headers: Record<string, string | undefined>;
  cookies: Record<string, string>;
  body: any;
  files?: CompatFile[];
  format?: string;
  ip: string;
  protocol: string;
  secure: boolean;
  session: Record<string, any>;
  csrfToken: string;
  currentSession: any;
  user: any;
  account: any;
  authenticatedByBot: boolean;
  newSessionToken?: string;
  clearSessionToken?: boolean;
  lastRoom?: number;
  get(name: string): string | undefined;
  accepts(...types: string[]): string | false;
  is(type: string): boolean;
}

export interface CompatRes {
  statusCode: number;
  headers: Record<string, string | string[]>;
  body: unknown;
  status(code: number): CompatRes;
  set(h: Record<string, string | string[] | undefined> | string, v?: string): CompatRes;
  type(t: string): CompatRes;
  json(o: unknown): CompatRes;
  send(b: unknown): CompatRes;
  end(b?: unknown): CompatRes;
  redirect(url: string): CompatRes;
  sendStatus(code: number): CompatRes;
}

export function parseCookies(header = ""): Record<string, string> {
  const result: Record<string, string> = Object.create(null);
  for (const item of (header ?? "").split(";")) {
    const i = item.indexOf("=");
    if (i < 0) continue;
    const k = item.slice(0, i).trim();
    try { result[k] = decodeURIComponent(item.slice(i + 1).trim()); } catch {}
  }
  return result;
}

export function authenticateCookies(header: string | undefined) {
  try {
    const token = rails.verifyCookie("session_token", parseCookies(header).session_token ?? "");
    return get("SELECT s.*,u.name,u.role,u.status FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token=? AND u.status=0", token);
  } catch { return null; }
}

const mimeFor: Record<string, string | undefined> = {
  html: "text/html; charset=utf-8",
  json: "application/json; charset=utf-8",
  text: "text/plain; charset=utf-8",
  png: "image/png",
  css: "text/css; charset=utf-8",
  js: "application/javascript; charset=utf-8",
  svg: "image/svg+xml",
};

export function makeRes(): CompatRes {
  const res: CompatRes & { headers: Record<string, string | string[]> } = {
    statusCode: 200,
    headers: {},
    body: undefined,
    status(code: number) { res.statusCode = code; return res; },
    set(h: Record<string, string | string[] | undefined> | string, v?: string) {
      if (typeof h === "string") {
        if (v !== undefined) res.headers[h.toLowerCase()] = v;
      } else for (const [k, val] of Object.entries(h)) {
        if (val !== undefined) res.headers[k.toLowerCase()] = val;
      }
      return res;
    },
    type(t: string) {
      const mime = mimeFor[t] ?? (t.includes("/") ? t : mimeFor.html);
      if (mime) res.headers["content-type"] = mime;
      return res;
    },
    json(o: unknown) {
      res.headers["content-type"] ||= mimeFor.json!;
      res.body = JSON.stringify(o);
      return res;
    },
    send(b: unknown) { if (b !== undefined) res.body = b; return res; },
    end(b?: unknown) { if (b !== undefined) res.body = b; return res; },
    redirect(url: string) { res.statusCode = 302; res.headers["location"] = url; res.body = ""; return res; },
    sendStatus(code: number) { res.statusCode = code; res.body = ""; return res; },
  };
  return res;
}

export type BodyValue = string | number | boolean | null | File | BodyValue[] | { [key: string]: BodyValue };

export function normalizeBody(raw: unknown): { body: Record<string, BodyValue>; files: CompatFile[] } {
  const files: CompatFile[] = [];
  const body: Record<string, BodyValue> =
    raw && typeof raw === "object" && !(raw instanceof Buffer) && !(raw instanceof Uint8Array) ? { ...(raw as Record<string, BodyValue>) } : {};
  for (const [name, value] of Object.entries(body)) {
    if (value instanceof File) {
      files.push({
        fieldname: name, originalname: value.name || "file", filename: value.name,
        mimetype: value.type || "application/octet-stream", content_type: value.type, size: value.size, buffer: undefined,
        _webFile: value,
      });
      delete body[name];
    } else if (Array.isArray(value) && value.some((v) => v instanceof File)) {
      for (const v of value)
        if (v instanceof File) files.push({
          fieldname: name, originalname: v.name || "file", filename: v.name,
          mimetype: v.type || "application/octet-stream", content_type: v.type, size: v.size,
          _webFile: v,
        });
      delete body[name];
    }
  }
  for (const [name, value] of Object.entries({ ...body })) {
    const parts = name.match(/[^[\]]+/g) || [];
    if (parts.length < 2 || parts.some((p) => ["__proto__", "constructor", "prototype"].includes(p))) continue;
    let target: Record<string, BodyValue> = body;
    for (const p of parts.slice(0, -1)) target = (target[p] as Record<string, BodyValue>) ||= Object.create(null);
    target[parts.at(-1)!] = value;
  }
  return { body, files };
}

export async function resolveFiles(files?: CompatFile[]): Promise<CompatFile[]> {
  if (!files) return [];
  for (const f of files) {
    const web = f._webFile;
    if (web && !f.buffer) {
      const buf = Buffer.from(await web.arrayBuffer());
      f.buffer = buf; f.data = buf; f.size = buf.length;
      delete f._webFile;
    }
  }
  return files;
}

export function clientIp(headers: Record<string, string | string[] | undefined>, remote: string): string {
  const trusted = (process.env.TRUSTED_PROXIES || "").split(",").filter(Boolean);
  const fwdRaw = headers["x-forwarded-for"];
  const fwd = Array.isArray(fwdRaw) ? fwdRaw.join(",") : fwdRaw;
  if (trusted.includes(remote) && typeof fwd === "string" && fwd) {
    const first = fwd.split(",")[0]?.trim().replace(/^::ffff:/, "") ?? "";
    if (first) return first;
  }
  return (remote || "").replace(/^::ffff:/, "");
}

export function isSecure(headers: Record<string, string | undefined>, remote: string): boolean {
  const trusted = (process.env.TRUSTED_PROXIES || "").split(",").filter(Boolean);
  if (trusted.includes(remote) && headers["x-forwarded-proto"] === "https") return true;
  return false;
}

export interface BuildContext {
  request: Request;
  params?: Record<string, string | undefined>;
  query?: Record<string, BodyValue>;
}

export function buildReq(ctx: BuildContext, rawBody: unknown, remoteAddr: string): CompatReq {
  const request: Request = ctx.request;
  const url = new URL(request.url);
  const headers: Record<string, string | undefined> = {};
  request.headers.forEach((v, k) => (headers[k.toLowerCase()] = v));
  const { body, files } = normalizeBody(rawBody);
  const methodOverride = request.method === "POST" ? String(body?._method || "").toUpperCase() : "";
  const method = ["PATCH", "PUT", "DELETE"].includes(methodOverride) ? methodOverride : request.method;
  const ip = clientIp(headers, remoteAddr);
  const secure = isSecure(headers, remoteAddr);
  const cookies = parseCookies(typeof headers.cookie === "string" ? headers.cookie : "");
  const req = {
    method, path: url.pathname, originalUrl: url.pathname + url.search, url: url.pathname + url.search,
    params: { ...(ctx.params || {}) }, query: { ...(ctx.query || {}) },
    headers, cookies, body, files, ip, protocol: secure ? "https" : "http", secure,
    session: {} as Record<string, any>, csrfToken: "", currentSession: null,
    user: null, account: null, authenticatedByBot: false,
    get(name: string) { return headers[name.toLowerCase()]; },
    accepts(...types: any[]) {
      // Express accepts either varargs or a single array: flatten both.
      const list: string[] = ([] as string[]).concat(...types.map((t) => (Array.isArray(t) ? t : [t])));
      const accept = headers.accept || "";
      if (!accept || accept.includes("*/*")) return list[0] ?? false;
      for (const t of list) {
        const full = t === "html" ? "text/html" : t === "json" ? "application/json" : t;
        if (accept.includes(full)) return t;
      }
      return false;
    },
    is(type: string) { return (headers["content-type"] || "").includes(type); },
  } as CompatReq;
  try {
    const session = rails.decryptCookie("_campfire_session", req.cookies._campfire_session || "");
    if (session && typeof session === "object" && !Array.isArray(session)) req.session = session;
  } catch {}
  // Snapshot BEFORE csrf/session_id initialization (mirrors app.js `before`).
  (req as { sessionBefore?: string }).sessionBefore = rails.stringify(req.session);
  try {
    if (rails.decode64(req.session._csrf_token).length !== 32) delete req.session._csrf_token;
  } catch { delete req.session._csrf_token; }
  req.session.session_id ||= randomBytes(16).toString("hex");
  req.session._csrf_token ||= rails.b64(randomBytes(32));
  req.csrfToken = (req.session._csrf_token as string | undefined) ? rails.maskCsrf(rails.decode64(req.session._csrf_token as string)) : "";
  req.currentSession = authenticateCookies(headers.cookie);
  req.user = req.currentSession ? get("SELECT * FROM users WHERE id=?", req.currentSession.user_id) : null;
  req.account = get("SELECT * FROM accounts ORDER BY id LIMIT 1");
  req.authenticatedByBot = false;
  const botMatch = req.path.match(/^\/rooms\/\d+\/([^/]+)\/messages(?:\/|$)/);
  const botKey = (req.query.bot_key as string | undefined) || botMatch?.[1];
  if (!req.user && botKey) {
    const m = String(botKey).trim().match(/^(\d+)-(.+)$/);
    if (m && m[1] && m[2]) {
      req.user = get("SELECT * FROM users WHERE id=? AND bot_token=? AND status=0 AND role=2", Number(m[1]), m[2]);
      req.authenticatedByBot = Boolean(req.user);
    }
  }
  if (req.currentSession && req.currentSession.last_active_at) {
    const lastActive = new Date(String(req.currentSession.last_active_at).replace(" ", "T") + "Z").getTime();
    if (Number.isFinite(lastActive) && lastActive < Date.now() - 3600000)
      run("UPDATE sessions SET last_active_at=?,updated_at=?,user_agent=?,ip_address=? WHERE id=?", now(), now(), headers["user-agent"] || "", ip, req.currentSession.id);
  }
  return req;
}

export function sessionCookieHeaders(req: CompatReq, before: string): string[] {
  const out: string[] = [];
  const attrs = `Path=/; HttpOnly; SameSite=Lax${req.secure ? "; Secure" : ""}`;
  const expiry = new Date(Date.now() + 20 * 365 * 86400 * 1000).toUTCString();
  if (rails.stringify(req.session) !== before)
    out.push(`_campfire_session=${encodeURIComponent(rails.encryptCookie("_campfire_session", req.session, new Date(Date.now() + 20 * 365 * 86400 * 1000)))}; ${attrs}; Expires=${expiry}`);
  if (req.clearSessionToken) out.push(`session_token=; ${attrs}; Expires=Thu, 01 Jan 1970 00:00:00 GMT`);
  else if ((req as any).newSessionToken)
    out.push(`session_token=${encodeURIComponent(rails.signCookie("session_token", (req as any).newSessionToken, new Date(Date.now() + 20 * 365 * 86400 * 1000)))}; ${attrs}; Expires=${expiry}`);
  if (req.lastRoom !== undefined)
    out.push(`last_room=${req.lastRoom}; Path=/; SameSite=Lax${req.secure ? "; Secure" : ""}; Expires=${expiry}`);
  return out;
}

export function guardRequest(req: CompatReq): number {
  if (get("SELECT id FROM bans WHERE ip_address=?", req.ip)) return 403;
  if (req.authenticatedByBot && !/^\/rooms\/\d+\/[^/]+\/messages(?:\/|$)/.test(req.path)) return 403;
  if (["GET", "HEAD", "OPTIONS"].includes(req.method)) return 0;
  if (req.authenticatedByBot && /^\/rooms\/\d+\/[^/]+\/messages(?:\/|$)/.test(req.path)) return 0;
  if (req.method === "PUT" && req.path.startsWith("/rails/active_storage/disk/")) {
    try {
      const p = rails.verify(req.path.split("/").at(-1)!, "ActiveStorage", "blob_token");
      if (p && typeof p === "object" && (p as { key?: unknown }).key) return 0;
    } catch {}
  }
  const origin = req.headers.origin ?? "";
  if (origin && origin !== req.protocol + "://" + req.get("host")) return 422;
  if (!rails.validCsrf(rails.decode64(req.session._csrf_token), req.headers["x-csrf-token"] || req.body?.authenticity_token, req.path, req.method)) return 422;
  return 0;
}

export function loginAllowed(req: CompatReq): boolean {
  return allowLogin(req.ip);
}
