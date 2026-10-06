// Test helper: boot the Elysia app on an ephemeral port.
import { createApp } from "../src/app.ts";

export async function serveApp() {
  const app = createApp();
  app.listen({ port: 0, hostname: "127.0.0.1" });
  await new Promise((r) => setTimeout(r, 150));
  const port = (app.server as any)?.port;
  const base = `http://127.0.0.1:${port}`;
  return {
    app, base,
    async close() { try { app.stop(); } catch {} },
  };
}

// Minimal storage-only app mirroring the original tests' bare Express app:
// JSON body parsing, x-user injection middleware, registerStorage routes.
export async function serveStorageApp(injectUser: "x-user" | "always-1" = "x-user") {
  const { Elysia } = await import("elysia");
  const storage = await import("../src/storage.ts");
  const compat = await import("../src/compat.ts");
  const entries: { m: string; p: string; h: any; raw: boolean }[] = [];
  const rawPaths = new Set<string>();
  storage.registerStorage(
    (m: string, p: string, h: any) => entries.push({ m, p, h, raw: false }),
    (p: string) => rawPaths.add(p),
  );
  for (const e of entries) e.raw = [...rawPaths].some((p) => p === e.p);

  const app = new Elysia();
  for (const e of entries) {
    const routeHook = e.raw ? { parse: "none" } as any : undefined;
    const routeHandler = async (ctx: any) => {
      const request: Request = ctx.request;
      let parsed: any = e.raw ? undefined : (ctx.body ?? {});
      let raw: any = undefined;
      if (e.raw) raw = Buffer.from(await request.arrayBuffer());
      const req = compat.buildReq(
        { request, params: ctx.params, query: ctx.query }, parsed, "",
      );
      if (e.raw) (req as any).body = raw;
      req.user =
        injectUser === "always-1"
          ? { id: 1 }
          : req.headers["x-user"]
            ? { id: Number(req.headers["x-user"]) }
            : null;
      const res = compat.makeRes();
      try {
        await e.h(req, res);
      } catch (err: any) {
        const st = Number(err?.status) || 500;
        res.status(st).send(st >= 500 ? "Internal Server Error" : err.message);
      }
      const headers: Record<string, string> = {};
      for (const [k, v] of Object.entries(res.headers))
        headers[k] = Array.isArray(v) ? v.join(", ") : String(v);
      const body: any = (res as any).bunFile ?? res.body ?? "";
      if (typeof body === "string" && res.statusCode === 200 && !headers["content-type"] && body === "")
        return new Response(null, { status: res.statusCode, headers });
      if (typeof body === "string" && headers["content-length"] === undefined)
        headers["content-length"] = String(Buffer.byteLength(body));
      if ((res as any).bunFile && headers["content-length"] === undefined) {
        try { headers["content-length"] = String((body as any).size); } catch {}
      }
      return new Response(body === "" ? null : body, { status: res.statusCode, headers });
    };
    if (routeHook) (app as any)[e.m.toLowerCase()](e.p, routeHook, routeHandler);
    else (app as any)[e.m.toLowerCase()](e.p, routeHandler);
  }
  app.listen({ port: 0, hostname: "127.0.0.1" });
  await new Promise((r) => setTimeout(r, 120));
  const port = (app.server as any)?.port;
  return {
    app,
    base: `http://127.0.0.1:${port}`,
    async close() { try { app.stop(); } catch {} },
  };
}
