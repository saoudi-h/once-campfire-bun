import { Elysia } from "elysia";
import { websocket } from "elysia/websocket";
import path from "node:path";
import fs from "node:fs";
import { initialize } from "./db.ts";
import * as rails from "./rails.ts";
import {
  registerRoutes,
  type CompatReq,
  type CompatRes,
  type RouteCollector,
  type Handler,
  type Middleware,
} from "./routes.ts";
import { registerStorage } from "./storage.ts";
import { registerPublic } from "./public.ts";
import { registerOpengraph } from "./opengraph.ts";
import { allowLogin } from "./rate_limit.ts";
import { cableWs, startCablePing } from "./cable.ts";
import {
  buildReq, makeRes, sessionCookieHeaders, guardRequest, resolveFiles,
  type CompatReq as FacadeReq, type CompatRes as FacadeRes,
  type CompatFile, type BodyValue,
} from "./compat.ts";

interface Entry { methods: Set<string>; handlers: Array<Handler | Middleware>; }

interface ElysiaContext {
  request: Request;
  params: Record<string, string | undefined>;
  query: Record<string, BodyValue>;
  body: unknown;
  store: Record<string, unknown>;
}

const SEC_HEADERS = {
  "x-content-type-options": "nosniff",
  "x-frame-options": "SAMEORIGIN",
  "referrer-policy": "strict-origin-when-cross-origin",
};

// Elysia path syntax: Express `:param` works; Express `*` splat and
// `:param(...)` patterns need translation; `{*name}` -> `*`.
function toElysiaPath(p: string): string {
  let out = p.replace(/\{\*[^}]*\}/g, "*");
  // /a/:p1-:p2 composite segments are unsupported; only our botKey route uses them.
  out = out.replace(/\/:(\w+)-:(\w+)/g, "/*");
  return out;
}

export function createApp() {
  initialize();
  const routes = new Map<string, Entry>();
  const rawBodyPaths = new Set<string>();
  const collector: RouteCollector = {
    get: (p, ...h) => reg("GET", p, h),
    post: (p, ...h) => reg("POST", p, h),
    put: (p, ...h) => reg("PUT", p, h),
    patch: (p, ...h) => reg("PATCH", p, h),
    delete: (p, ...h) => reg("DELETE", p, h),
    all: (p, ...h) => reg("ALL", p, h),
  };
  function reg(method: string, p: string | string[], h: Array<Handler | Middleware>) {
    for (const path of Array.isArray(p) ? p : [p]) {
      let e = routes.get(path);
      if (!e) { e = { methods: new Set(), handlers: [] }; routes.set(path, e); }
      e.methods.add(method);
      (e as any)[method] = h;
    }
  }
  const add = (method: string, path: string, handler: Handler) => reg(method, path, [handler]);
  registerStorage(add, (p) => rawBodyPaths.add(p));
  registerPublic(add);
  registerOpengraph(add);
  registerRoutes(collector);

  // Elysia 2 compiles route handlers just-in-time by default; `precompile`
  // warms them ahead of listen() for production-like latency.
  const elysia = new Elysia({ precompile: true });
  elysia.use(websocket());

  // --- /cable WebSocket (Action Cable) ---
  elysia.ws("/cable", cableWs);
  startCablePing();

  const ALL = ["GET", "POST", "PUT", "PATCH", "DELETE"];
  const seen = new Set<string>();
  for (const [origPath, entry] of routes) {
    const epath = toElysiaPath(origPath);
    const methods: string[] = (entry.methods.has("ALL") ? ALL : [...entry.methods]);
    for (const m of methods) {
      const handlers = (entry as any)[m] || (entry.methods.has("ALL") ? (entry as any)["ALL"] : []);
      if (!handlers?.length) continue;
      const key = m + " " + epath;
      if (seen.has(key)) continue;
      seen.add(key);
      const fn = m.toLowerCase() as "get" | "post" | "put" | "patch" | "delete";
      // Raw-upload routes must keep the untouched bytes: disable Elysia body parsing.
      if (rawBodyPaths.has(origPath))
        (elysia as any)[fn](epath, { parse: "none" } as any, async (ctx: any) => runHandlers(ctx, handlers, origPath));
      else
        (elysia as any)[fn](epath, async (ctx: any) => runHandlers(ctx, handlers, origPath));
    }
  }

  async function runHandlers(ctx: ElysiaContext, handlers: Array<Handler | Middleware>, origPath: string) {
    const request: Request = ctx.request;
    // Body: Elysia already parsed it into ctx.body (json/form/multipart).
    // Only raw-upload routes need the untouched bytes.
    let rawBody: Buffer | undefined = undefined;
    const isRaw = [...rawBodyPaths].some((p) => matchRaw(p, new URL(request.url).pathname));
    let parsed: unknown = {};
    if (!isRaw) {
      parsed = ctx.body ?? {};
      if (parsed instanceof FormData) {
        const obj: Record<string, string | File | Array<string | File>> = {};
        for (const [k, v] of parsed.entries()) {
          if (obj[k] === undefined) obj[k] = v as string | File;
          else if (Array.isArray(obj[k])) (obj[k] as Array<string | File>).push(v as string | File);
          else obj[k] = [obj[k] as string | File, v as string | File];
        }
        parsed = obj;
      }
    } else {
      rawBody = Buffer.from(await request.arrayBuffer());
    }
    // Remote address for trust-proxy/IP logic.
    let remote = "";
    try { remote = String((elysia.server?.requestIP?.(request) as { address?: unknown } | undefined)?.address || ""); } catch {}
    const req = buildReq({ request, params: ctx.params, query: ctx.query }, parsed, remote);
    // botKey composite segment fallback: /rooms/:roomId/* -> split botKey/messages...
    if (req.params["*"] !== undefined && origPath.includes("/:botKey/")) {
      const rest = String(req.params["*"] ?? "").split("/");
      if (rest.length >= 2 && rest[1] === "messages") {
        req.params.botKey = rest[0];
        req.params.id = rest[2] || "";
      } else { return finalize(req, makeRes().sendStatus(404), request); }
      delete (req.params as any)["*"];
    }
    if (isRaw) req.body = rawBody;
    if (typeof parsed === "string") req.body = { ...(req.body || {}), _text: parsed };
    await resolveFiles(req.files);
    // .json/.turbo_stream suffix strip (mirror of app.js rewrite middleware)
    if (!req.path.startsWith("/rails/active_storage/") && !req.path.startsWith("/webmanifest")) {
      const m = req.path.match(/\.(json|turbo_stream)(\?|$)/);
      // operate on path only; query already parsed by Elysia
      const pm = /\.(json|turbo_stream)$/.exec(req.path);
      if (pm) { req.format = pm[1]; req.path = req.path.slice(0, -pm[0].length) || "/"; }
    }
    // login rate limit for POST /session (mirror)
    if (req.path === "/session" && req.method === "POST" && !allowLogin(req.ip))
      return finalize(req, makeRes().status(429).send("Too many requests or unauthorized."), request);
    const guard = guardRequest(req);
    if (guard) return finalize(req, makeRes().sendStatus(guard), request);
    const before = (req as any).sessionBefore;
    const res = makeRes();
    try {
      await dispatchChain(handlers, req, res);
    } catch (error: any) {
      const st = Number(error?.status) || 500;
      if (st >= 500) console.error(error?.stack || error);
      res.status(st).send(st >= 500 ? "Internal Server Error" : error.message);
    }
    return finalize(req, res, request, before);
  }

  function matchRaw(pattern: string, pathname: string): boolean {
    const rx = new RegExp("^" + pattern.replace(/:[^/]+/g, "[^/]+") + "$");
    return rx.test(pathname);
  }

  async function dispatchChain(handlers: (Handler | Middleware)[], req: CompatReq, res: CompatRes) {
    let i = -1;
    async function next(): Promise<void> {
      i++;
      if (i >= handlers.length) return;
      const h = handlers[i] as Handler | Middleware | undefined;
      if (!h) return;
      if (h.length >= 3) await (h as Middleware)(req, res, next);
      else await (h as Handler)(req, res, next);
    }
    // Express semantics: run chain until a handler ends the response.
    // Our facade has no "ended" flag; replicate Express by running the
    // chain and treating first res.body assignment as terminal for
    // middleware-style flows: run all, but guards short-circuit via return.
    await next();
  }

  function finalize(req: CompatReq, res: CompatRes, request: Request, before = rails.stringify(req.session)): Response {
    const headers: Record<string, string> = { ...SEC_HEADERS };
    for (const [k, v] of Object.entries(res.headers)) headers[k] = Array.isArray(v) ? v.join(", ") : String(v);
    const cookies = sessionCookieHeaders(req, before);
    // gzip: Bun.serve handles it natively when the client accepts it and
    // the response opts in; do it manually for text payloads.
    let body: any = (res as any).bunFile ?? res.body ?? "";
    const accept = request.headers.get("accept-encoding") || "";
    const ctype = headers["content-type"] || "";
    const textual = /text|json|javascript|svg|manifest/.test(ctype);
    if (typeof body === "string" && textual && accept.includes("gzip") && body.length > 1024) {
      try {
        const gz = Bun.gzipSync(Buffer.from(body));
        if (gz.length < body.length) { body = gz; headers["content-encoding"] = "gzip"; }
      } catch {}
    }
    if (body !== "" && headers["content-length"] === undefined && typeof body === "string")
      headers["content-length"] = String(Buffer.byteLength(body));
    if ((res as any).bunFile && headers["content-length"] === undefined) {
      try { headers["content-length"] = String((body as any).size); } catch {}
    }
    const outHeaders = new Headers(headers as any);
    for (const c of cookies) outHeaders.append("set-cookie", c);
    return new Response(body === "" && res.statusCode === 200 && !headers["content-type"] ? "" : body, {
      status: res.statusCode,
      headers: outHeaders,
    });
  }

  // --- static assets (mirror of app.js static mounts) ---
  const genDir = path.resolve("assets/generated/public");
  const assetsDir = path.resolve("assets/generated/public/assets");
  async function staticFile(file: string, immutable: boolean): Promise<Response | null> {
    try {
      const st = fs.statSync(file);
      if (!st.isFile()) return null;
      const f = Bun.file(file);
      const h: Record<string, string> = { ...SEC_HEADERS };
      if (immutable) { h["cache-control"] = "public, max-age=31536000, immutable"; }
      return new Response(f as any, { status: 200, headers: h as any });
    } catch { return null; }
  }
  elysia.get("/assets/*", async (ctx: any) => {
    const rel = String((ctx.params as any)["*"] || "").replace(/\.\./g, "");
    return (await staticFile(path.join(assetsDir, rel), true)) ?? new Response("nf", { status: 404 });
  });
  elysia.get("/*", async (ctx: any) => {
    const pathname: string = new URL(ctx.request.url).pathname;
    if (pathname.startsWith("/assets/")) return new Response("nf", { status: 404 });
    const rel = pathname.replace(/^\//, "").replace(/\.\./g, "");
    const hit = await staticFile(path.join(genDir, rel), false);
    if (hit) return hit;
    return new Response("Not Found", { status: 404, headers: SEC_HEADERS as any });
  });

  elysia.error(({ error }: any) => {
    const st = Number((error as any)?.status) || 500;
    if (st >= 500) console.error((error as any)?.stack || error);
    return new Response(st >= 500 ? "Internal Server Error" : String((error as any)?.message || "Error"), { status: st, headers: SEC_HEADERS as any });
  });

  return elysia;
}
