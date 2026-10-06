import test from "node:test";
import assert from "node:assert/strict";
process.env.DATABASE_PATH = ":memory:";
process.env.SECRET_KEY_BASE = "native-session-integer-tests";
const { serveApp } = await import("./helper.ts");
const rails = await import("../src/rails.ts");
test("HTTP middleware preserves a large integer in a real encrypted Rails session", async () => {
  const { base, close } = await serveApp();
  const server = { close: (cb: any) => { close().then(cb); } };
  try {
    const cookie = rails.encryptCookie("_campfire_session", {
      custom_id: 9007199254740993n,
    });
    const response = await fetch(
      base + "/first_run",
      {
        headers: { cookie: "_campfire_session=" + encodeURIComponent(cookie) },
      },
    );
    assert.equal(response.status, 200);
    const raw = response.headers
      .getSetCookie()
      .find((c) => c.startsWith("_campfire_session="))!
      .split(";")[0]!
      .slice("_campfire_session=".length);
    assert.equal(
      (rails.decryptCookie("_campfire_session", raw) as { custom_id: bigint })
        .custom_id,
      9007199254740993n,
    );
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
