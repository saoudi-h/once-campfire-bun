import { test, before } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Row } from "../src/db.ts";
import type { CompatReq } from "../src/compat.ts";
process.env.SECRET_KEY_BASE = "core-test-secret-".repeat(8);
const temp = mkdtempSync(join(tmpdir(), "campfire-express-core-"));
process.env.CAMPFIRE_STORAGE_PATH = temp;
const { all, get, run, transaction, initialize, now, queryCount } =
  await import("../src/db.ts");
const domain = await import("../src/domain.ts");
const { plainText, sanitize, mentionIds } = await import("../src/richtext.ts");
const rails = await import("../src/rails.ts");
const { serveApp } = await import("./helper.ts");
const { fragment, render, messageFragment, pageCacheStats, pageCacheClear } =
  await import("../src/rendering.ts");
let admin: Row, member: Row, outsider: Row, open: Row, privateRoom: Row;
before(async () => {
  initialize();
  const t = now();
  const digest = await domain.hashPassword("password");
  run(
    "INSERT INTO accounts(name,join_code,created_at,updated_at) VALUES(?,?,?,?)",
    "Testing",
    "join-me",
    t,
    t,
  );
  admin = domain.createUser({
    name: "Admin",
    email_address: "admin@example.test",
    password_digest: digest,
    role: 1,
  })!;
  member = domain.createUser({
    name: "Member",
    email_address: "member@example.test",
    password_digest: digest,
  })!;
  outsider = domain.createUser({
    name: "Outside",
    email_address: "outside@example.test",
    password_digest: digest,
  })!;
  const make = (name: string, type: string) => {
    const r = run(
      "INSERT INTO rooms(name,type,creator_id,created_at,updated_at) VALUES(?,?,?,?,?)",
      name,
      type,
      admin.id,
      t,
      t,
    );
    return get("SELECT * FROM rooms WHERE id=?", Number(r.lastInsertRowid))!;
  };
  open = make("Open", "Rooms::Open");
  privateRoom = make("Secret", "Rooms::Closed");
  domain.grantMemberships(open, [admin.id, member.id, outsider.id]);
  domain.grantMemberships(privateRoom, [admin.id, member.id]);
});
test("synchronous nested transactions rollback together", async () => {
  const n = get("SELECT count(*) n FROM users")!.n;
  const digest = await domain.hashPassword("password");
  assert.throws(() =>
    transaction(() => {
      domain.createUser({
        name: "Temp",
        email_address: "temp@example.test",
        password_digest: digest,
      });
      throw new Error("rollback");
    }),
  );
  assert.equal(get("SELECT count(*) n FROM users")!.n, n);
});
test("messages preserve schema, search index, raw timestamp cursors and membership authorization", () => {
  const m = domain.createMessage(
    open.id,
    admin.id,
    "<p>Hello <strong>world</strong></p>",
    "client-1",
  )!;
  assert.equal(
    get(
      "SELECT body FROM action_text_rich_texts WHERE record_id=? AND record_type='Message'",
      m.id,
    )!.body,
    "<p>Hello <strong>world</strong></p>",
  );
  assert.equal(
    get("SELECT rowid FROM message_search_index WHERE body MATCH 'world'")!
      .rowid,
    m.id,
  );
  assert.throws(() =>
    domain.createMessage(privateRoom.id, outsider.id, "secret"),
  );
  assert.equal(domain.roomForUser(outsider, privateRoom.id), undefined);
  run(
    "UPDATE messages SET created_at=? WHERE id=?",
    "2026-01-01 00:00:00",
    m.id,
  );
  const newer = domain.createMessage(open.id, admin.id, "later")!;
  run(
    "UPDATE messages SET created_at=? WHERE id=?",
    "2026-01-01 00:00:01.000000",
    newer.id,
  );
  assert.deepEqual(
    domain.messagesForRoom(open.id, { after: m.id }).map((x) => x.id),
    [newer.id],
  );
  assert.deepEqual(
    domain.messagesForRoom(open.id, { before: newer.id }).map((x) => x.id),
    [m.id],
  );
});
test("updates replace FTS and deletes remove message and rich text", () => {
  let m = domain.createMessage(open.id, member.id, "obsolete")!;
  m = domain.updateMessage(m, "replacement")!;
  assert.equal(
    get("SELECT rowid FROM message_search_index WHERE body MATCH 'obsolete'"),
    undefined,
  );
  assert.equal(
    get("SELECT rowid FROM message_search_index WHERE body MATCH 'replacement'")!
      .rowid,
    m.id,
  );
  domain.deleteMessage(m, { broadcast: false });
  assert.equal(domain.messageById(m.id), undefined);
  assert.equal(
    get("SELECT rowid FROM message_search_index WHERE rowid=?", m.id),
    undefined,
  );
  assert.equal(
    get(
      "SELECT id FROM action_text_rich_texts WHERE record_type='Message' AND record_id=?",
      m.id,
    ),
    undefined,
  );
});
test("creation avoids re-reading the rich-text id and stays within a query budget", () => {
  const before = queryCount();
  const m = domain.createMessage(
    open.id,
    admin.id,
    "<p>Fish &amp; <strong>chips</strong> café</p>",
  )!;
  assert.ok(
    queryCount() - before <= 8,
    `creation executed ${queryCount() - before} queries`,
  );
  assert.equal(
    get("SELECT body FROM message_search_index WHERE rowid=?", m.id)!.body,
    "Fish & chips café",
  );
  assert.ok(
    get(
      "SELECT body FROM action_text_rich_texts WHERE record_type='Message' AND record_id=?",
      m.id,
    )!.body.includes("<strong>chips</strong>"),
  );
});
test("creation failure rolls back message, rich text, index and unread state", () => {
  const counts = () => [
    get("SELECT count(*) AS n FROM messages")!.n,
    get("SELECT count(*) AS n FROM action_text_rich_texts")!.n,
    get("SELECT count(*) AS n FROM message_search_index")!.n,
  ];
  const before = counts();
  const unread = get(
    "SELECT unread_at FROM memberships WHERE room_id=? AND user_id=?",
    open.id,
    member.id,
  )!.unread_at;
  run(
    "CREATE TEMP TRIGGER fail_unread BEFORE UPDATE OF unread_at ON memberships BEGIN SELECT RAISE(ABORT,'forced unread failure'); END",
  );
  try {
    assert.throws(
      () => domain.createMessage(open.id, admin.id, "rollback creation"),
      /forced unread failure/,
    );
  } finally {
    run("DROP TRIGGER fail_unread");
  }
  assert.deepEqual(counts(), before);
  assert.equal(
    get(
      "SELECT unread_at FROM memberships WHERE room_id=? AND user_id=?",
      open.id,
      member.id,
    )!.unread_at,
    unread,
  );
});
test("turbo poster reuses the broadcast fragment instead of rendering twice", async () => {
  const { base, close } = await serveApp();
  const server = { close: (cb: any) => { close().then(cb); } };
  let cookie = "";
  try {
    let response = await fetch(base + "/session/new");
    const html = await response.text();
    const csrf = html.match(/name="csrf-token" content="([^"]+)"/)![1]!;
    cookie = response.headers
      .getSetCookie()
      .map((c) => c.split(";")[0])
      .join("; ");
    response = await fetch(base + "/session", {
      method: "POST",
      redirect: "manual",
      headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        email_address: admin.email_address,
        password: "password",
        authenticity_token: csrf,
      }),
    });
    assert.equal(response.status, 302);
    cookie +=
      "; " +
      response.headers
        .getSetCookie()
        .map((c) => c.split(";")[0])
        .join("; ");
    response = await fetch(base + "/rooms/" + open.id + "/messages", {
      method: "POST",
      headers: {
        cookie,
        "content-type": "application/x-www-form-urlencoded",
        accept: "text/vnd.turbo-stream.html, text/html",
      },
      body: new URLSearchParams({
        "message[body]": "<p>Posted &amp; <strong>rich</strong></p>",
        authenticity_token: csrf,
      }),
    });
    const body = await response.text();
    assert.equal(response.status, 200, body);
    assert.ok(body.includes("Posted &amp; <strong>rich</strong>"));
    const posted = get("SELECT * FROM messages ORDER BY id DESC LIMIT 1")!;
    const expected = String(
      messageFragment(messageData([domain.messageById(posted.id)!])[0]!),
    );
    assert.ok(body.includes(`<template>${expected}</template>`));
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
async function login(base: string): Promise<{ cookie: string; csrf: string }> {
  let response = await fetch(base + "/session/new");
  const html = await response.text();
  const csrf = html.match(/name="csrf-token" content="([^"]+)"/)![1]!;
  let cookie = response.headers
    .getSetCookie()
    .map((c) => c.split(";")[0])
    .join("; ");
  response = await fetch(base + "/session", {
    method: "POST",
    redirect: "manual",
    headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      email_address: admin.email_address,
      password: "password",
      authenticity_token: csrf,
    }),
  });
  assert.equal(response.status, 302);
  cookie +=
    "; " +
    response.headers
      .getSetCookie()
      .map((c) => c.split(";")[0])
      .join("; ");
  return { cookie, csrf };
}
test("page cache serves fresh content after a same-process write (PERF-22)", async () => {
  const { base, close } = await serveApp();
  const server = { close: (cb: any) => { close().then(cb); } };
  try {
    const { cookie, csrf } = await login(base);
    let response = await fetch(base + "/rooms/" + open.id, {
      headers: { cookie },
    });
    let html = await response.text();
    assert.equal(response.status, 200, html);
    assert.ok(!html.includes("invalidation-probe"));
    // Tests run single-process (local writes, no writer child):
    // the read-only observer connection must still see the commit
    // and move the generation, or every page serves stale content.
    response = await fetch(base + "/rooms/" + open.id + "/messages", {
      method: "POST",
      headers: {
        cookie,
        "content-type": "application/x-www-form-urlencoded",
        accept: "text/vnd.turbo-stream.html, text/html",
      },
      body: new URLSearchParams({
        "message[body]": "invalidation-probe",
        authenticity_token: csrf,
      }),
    });
    assert.equal(response.status, 200);
    response = await fetch(base + "/rooms/" + open.id, {
      headers: { cookie },
    });
    html = await response.text();
    assert.ok(
      html.includes("invalidation-probe"),
      "stale page served after a local write",
    );
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
test("page cache hits skip the render and re-render under a new generation (PERF-22)", async () => {
  const { base, close } = await serveApp();
  const server = { close: (cb: any) => { close().then(cb); } };
  try {
    const { cookie, csrf } = await login(base);
    pageCacheClear();
    const url = base + "/rooms/" + open.id;
    await (await fetch(url, { headers: { cookie } })).text();
    assert.equal(pageCacheStats().entries, 1);
    // Second GET is a cache hit: no new entry, no re-render.
    await (await fetch(url, { headers: { cookie } })).text();
    assert.equal(pageCacheStats().entries, 1);
    // A write moves the generation: the next GET re-renders and
    // files under the new generation key.
    await fetch(base + "/rooms/" + open.id + "/messages", {
      method: "POST",
      headers: {
        cookie,
        "content-type": "application/x-www-form-urlencoded",
        accept: "text/vnd.turbo-stream.html, text/html",
      },
      body: new URLSearchParams({
        "message[body]": "generation-probe",
        authenticity_token: csrf,
      }),
    });
    const html = await (await fetch(url, { headers: { cookie } })).text();
    assert.ok(html.includes("generation-probe"));
    assert.equal(pageCacheStats().entries, 2);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
test("search page cache invalidates on new matching messages (PERF-22)", async () => {
  const { base, close } = await serveApp();
  const server = { close: (cb: any) => { close().then(cb); } };
  try {
    const { cookie } = await login(base);
    domain.createMessage(open.id, admin.id, "unique-token alpha");
    const url = base + "/searches?q=unique-token";
    let html = await (await fetch(url, { headers: { cookie } })).text();
    assert.ok(html.includes("alpha"));
    assert.ok(!html.includes("beta"));
    // A new matching message (same-process write) must invalidate.
    domain.createMessage(open.id, admin.id, "unique-token beta");
    html = await (await fetch(url, { headers: { cookie } })).text();
    assert.ok(
      html.includes("beta"),
      "stale search page served after a local write",
    );
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
test("sanitize discards executable markup and unsafe URL schemes", () => {
  const html = sanitize(
    '<script>evil()</script><a href="javascript:evil()" onclick="evil()">hello</a><p>good</p>',
  );
  assert.equal(html, "<a>hello</a><p>good</p>");
  assert.equal(plainText("<p>a<br>b</p><p>c</p>"), "a\nb\n\nc");
});
test("Rails signed mentions are indexed with @ and notified securely", () => {
  const token = rails.sgid("User", member.id);
  const html = `<p>Hello <action-text-attachment sgid="${token}"></action-text-attachment></p>`;
  assert.equal(plainText(html), "Hello @Member");
  assert.deepEqual([...mentionIds(html)], [member.id]);
  assert.deepEqual(
    [...mentionIds(html.replace(token, token + "x"))],
    [member.id],
  );
});
test("retained frontend compiles room/login/sidebar/profile/admin screens", () => {
  const req = {
    user: admin,
    session: {},
    csrfToken: "test-csrf",
    get: (name: string) => (name === "host" ? "example.test" : null),
    protocol: "http",
  } as CompatReq;
  for (const screen of [
    "login",
    "welcome",
    "account",
    "bots",
    "bot-form",
    "custom-styles",
  ])
    assert.ok(render(req, screen, { Subject: { ID: 0 } }).includes("Campfire"));
  assert.ok(
    render(req, "room", {
      Room: {
        ID: open.id,
        Name: "Open",
        Type: "Rooms::Open",
        DOM: (p: string) => p + "_rooms_open_" + open.id,
      },
      Messages: [],
    }).includes('name="message[body]"'),
  );
  assert.ok(fragment("messages", { Messages: [] }) === "");
});
test("HTTP actual cookie login, CSRF, rooms, search, posting and private denial", async () => {
  const { base, close } = await serveApp();
  const server = { close: (cb: any) => { close().then(cb); } };
  let cookie = "";
  try {
    let response = await fetch(base + "/session/new");
    const html = await response.text();
    const csrf = html.match(/name="csrf-token" content="([^"]+)"/)![1]!;
    cookie = response.headers
      .getSetCookie()
      .map((c) => c.split(";")[0])
      .join("; ");
    response = await fetch(base + "/session", {
      method: "POST",
      redirect: "manual",
      headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        email_address: member.email_address,
        password: "password",
        authenticity_token: csrf,
      }),
    });
    assert.equal(response.status, 302);
    cookie +=
      "; " +
      response.headers
        .getSetCookie()
        .map((c) => c.split(";")[0])
        .join("; ");
    response = await fetch(base + "/rooms/" + open.id, { headers: { cookie } });
    assert.equal(response.status, 200);
    assert.ok((await response.text()).includes("Lexxy") === false);
    response = await fetch(base + "/rooms/" + open.id + "/messages", {
      method: "POST",
      headers: {
        cookie,
        "content-type": "application/x-www-form-urlencoded",
        accept: "application/json",
      },
      body: new URLSearchParams({
        "message[body]": "<p>Persisted HTTP marker</p>",
        authenticity_token: csrf,
      }),
    });
    assert.equal(response.status, 201);
    const message = (await response.json()) as { body: { plain_text: string } };
    assert.equal(message.body.plain_text, "Persisted HTTP marker");
    assert.ok(
      get(
        "SELECT rowid FROM message_search_index WHERE body MATCH 'Persisted'",
      ),
    );
    response = await fetch(base + "/rooms/" + open.id + "/messages", {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ message: { body: "without token" } }),
    });
    assert.equal(response.status, 422);
    response = await fetch(base + "/searches?q=Persisted", {
      headers: { cookie },
    });
    assert.equal(response.status, 200);
    assert.ok((await response.text()).includes("Persisted HTTP marker"));
    const outsideToken = "outside-session";
    run(
      "INSERT INTO sessions(user_id,token,created_at,updated_at,last_active_at) VALUES(?,?,?,?,?)",
      outsider.id,
      outsideToken,
      now(),
      now(),
      now(),
    );
    response = await fetch(base + "/rooms/" + privateRoom.id + "/messages", {
      redirect: "manual",
      headers: {
        cookie:
          "session_token=" +
          encodeURIComponent(rails.signCookie("session_token", outsideToken)),
      },
    });
    assert.equal(response.status, 302);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
process.on("exit", () => rmSync(temp, { recursive: true, force: true }));
import { readFileSync } from "node:fs";
test("64 independent Rails canonical editor plaintext examples", () => {
  const vectors = JSON.parse(
    readFileSync(new URL("../compat/richtext.json", import.meta.url), "utf8"),
  );
  for (const example of vectors.cases)
    assert.equal(plainText(example.body), example.plain_text, example.name);
});
import { storeUpload, blobUrl, purgeBlob } from "../src/storage.ts";
import { messageData } from "../src/rendering.ts";
test("inline native attachments preserve rich text ownership, private authorization and cleanup", () => {
  const privateMessage = domain.createMessage(
    privateRoom.id,
    admin.id,
    "private attachment",
  )!;
  const blob = storeUpload(
    {
      buffer: Buffer.from("private content"),
      originalname: "private.txt",
      mimetype: "text/plain",
    },
    "Message",
    privateMessage.id,
    "attachment",
  );
  const html = `<p>Attachment <action-text-attachment sgid="${rails.sgid("ActiveStorage::Blob", blob.id)}"></action-text-attachment></p>`;
  const n = get("SELECT count(*) n FROM messages")!.n;
  assert.throws(
    () => domain.createMessage(open.id, outsider.id, html),
    /membership/,
  );
  assert.equal(get("SELECT count(*) n FROM messages")!.n, n);
  const message = domain.createMessage(privateRoom.id, member.id, html)!;
  const rich = get(
    "SELECT id FROM action_text_rich_texts WHERE record_type='Message' AND record_id=?",
    message.id,
  )!;
  assert.equal(
    get(
      "SELECT blob_id FROM active_storage_attachments WHERE record_type='ActionText::RichText' AND record_id=?",
      rich.id,
    )!.blob_id,
    blob.id,
  );
  assert.equal(plainText(html), "Attachment [private.txt]");
  assert.ok(String(messageData([message])[0]!.HTML).includes(blobUrl(blob)));
  domain.deleteMessage(message, { broadcast: false });
  assert.equal(
    get(
      "SELECT id FROM active_storage_attachments WHERE record_type='ActionText::RichText' AND record_id=?",
      rich.id,
    ),
    undefined,
  );
  purgeBlob(blob.id);
  assert.ok(get("SELECT id FROM active_storage_blobs WHERE id=?", blob.id));
});
test("failed image create and edit leave existing message body, attachments and FTS intact", async () => {
  const sessionToken = "atomic-media-session";
  run(
    "INSERT INTO sessions(user_id,token,created_at,updated_at,last_active_at) VALUES(?,?,?,?,?)",
    admin.id,
    sessionToken,
    now(),
    now(),
    now(),
  );
  const { base, close } = await serveApp();
  const server = { close: (cb: any) => { close().then(cb); } };
  const auth =
      "session_token=" +
      encodeURIComponent(rails.signCookie("session_token", sessionToken));
  try {
    const response = await fetch(base + "/rooms/" + open.id, {
        headers: { cookie: auth },
      }),
      html = await response.text(),
      csrf = html.match(/name="csrf-token" content="([^"]+)"/)![1]!,
      cookie =
        auth +
        "; " +
        response.headers
          .getSetCookie()
          .map((c) => c.split(";")[0])
          .join("; ");
    let m = domain.createMessage(open.id, admin.id, "Original atomic body")!;
    const original = storeUpload(
      {
        buffer: Buffer.from("original file"),
        originalname: "original.txt",
        mimetype: "text/plain",
      },
      "Message",
      m.id,
      "attachment",
    );
    const snapshot = () =>
      Object.fromEntries(
        [
          "messages",
          "action_text_rich_texts",
          "active_storage_blobs",
          "active_storage_attachments",
          "active_storage_variant_records",
        ].map((t) => [t, get(`SELECT count(*) n FROM ${t}`)!.n]),
      );
    const before = snapshot();
    const form = (method: string | null) => {
      const body = new FormData();
      body.append("authenticity_token", csrf);
      if (method) body.append("_method", method);
      body.append("message[body]", "Must not persist");
      body.append(
        "message[attachment]",
        new Blob(["this is not a jpeg"], { type: "image/jpeg" }),
        "invalid.jpg",
      );
      return body;
    };
    for (const [path, method] of [
      [`/rooms/${open.id}/messages`, null],
      [`/rooms/${open.id}/messages/${m.id}`, "patch"],
    ] as Array<[string, string | null]>) {
      const reply = await fetch(base + path, {
        method: "POST",
        headers: { cookie },
        body: form(method),
      });
      assert.equal(reply.status, 422);
      assert.deepEqual(snapshot(), before);
    }
    assert.equal(
      get(
        "SELECT body FROM action_text_rich_texts WHERE record_type='Message' AND record_id=?",
        m.id,
      )!.body,
      "Original atomic body",
    );
    assert.equal(
      get(
        "SELECT blob_id FROM active_storage_attachments WHERE record_type='Message' AND record_id=?",
        m.id,
      )!.blob_id,
      original.id,
    );
    assert.equal(
      get("SELECT rowid FROM message_search_index WHERE body MATCH 'Original'")!
        .rowid,
      m.id,
    );
    assert.equal(
      all(
        "SELECT rowid FROM message_search_index WHERE body MATCH 'persist'",
      ).some((row) => row.rowid === m.id),
      false,
    );
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
test("room namespaces cannot promote direct history or bypass shared room administration", async () => {
  const time = now();
  const directId = Number(
    run(
      "INSERT INTO rooms(type,creator_id,created_at,updated_at) VALUES('Rooms::Direct',?,?,?)",
      admin.id,
      time,
      time,
    ).lastInsertRowid,
  );
  const direct = get("SELECT * FROM rooms WHERE id=?", directId)!;
  domain.grantMemberships(direct, [admin.id, member.id]);
  const sessionToken = "namespace-member-session";
  run(
    "INSERT INTO sessions(user_id,token,created_at,updated_at,last_active_at) VALUES(?,?,?,?,?)",
    member.id,
    sessionToken,
    time,
    time,
    time,
  );
  const { base, close } = await serveApp();
  const server = { close: (cb: any) => { close().then(cb); } };
  const auth =
    "session_token=" +
    encodeURIComponent(rails.signCookie("session_token", sessionToken));
  try {
    const loginPage = await fetch(base + "/rooms/" + open.id, {
      headers: { cookie: auth },
    });
    const csrf = (await loginPage.text()).match(
      /name="csrf-token" content="([^"]+)"/,
    )![1]!;
    const cookie =
      auth +
      "; " +
      loginPage.headers
        .getSetCookie()
        .map((c) => c.split(";")[0])
        .join("; ");
    const snapshot = () =>
      JSON.stringify({
        rooms: all("SELECT * FROM rooms ORDER BY id"),
        memberships: all("SELECT * FROM memberships ORDER BY id"),
      });
    const initial = snapshot();
    const cases: Array<[string, string, number]> = [
      ["GET", "/rooms/unknown", 404],
      ["GET", `/rooms/opens/${direct.id}/edit`, 404],
      ["PATCH", `/rooms/opens/${direct.id}`, 404],
      ["DELETE", `/rooms/opens/${direct.id}`, 404],
      ["GET", `/rooms/closeds/${direct.id}/edit`, 404],
      ["PATCH", `/rooms/closeds/${direct.id}`, 404],
      ["GET", `/rooms/directs/${open.id}/edit`, 404],
      ["DELETE", `/rooms/directs/${open.id}`, 404],
      ["PATCH", `/rooms/directs/${open.id}`, 404],
      ["PATCH", `/rooms/directs/${direct.id}`, 405],
      ["PUT", `/rooms/directs/${direct.id}`, 405],
      ["DELETE", `/rooms/opens/${open.id}`, 403],
    ];
    for (const [method, path, expected] of cases) {
      const response = await fetch(base + path, {
        method,
        redirect: "manual",
        headers: {
          cookie,
          "x-csrf-token": csrf,
          "content-type": "application/x-www-form-urlencoded",
        },
        ...(method === "GET"
          ? {}
          : {
              body: new URLSearchParams({
                "room[name]": "Leaked",
                "user_ids[]": outsider.id,
              }),
            }),
      });
      assert.equal(response.status, expected, method + " " + path);
      assert.equal(
        snapshot(),
        initial,
        method + " " + path + " changed persisted access",
      );
    }
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("Attachment-only bot JSON and notification text use the original filename", async () => {
  const { messagePlainText } = await import("../src/richtext.ts");
  const { serializeMessage } = await import("../src/routes.ts");
  const message = domain.createMessage(open.id, admin.id, "")!;
  storeUpload(
    {
      buffer: Buffer.from("attachment-only"),
      originalname: "contract-file.txt",
      mimetype: "text/plain",
    },
    "Message",
    message.id,
    "attachment",
  );
  assert.equal(messagePlainText(message.id, ""), "contract-file.txt");
  assert.equal(messagePlainText(message.id, "<p>Caption</p>"), "Caption");
  const req = {
    protocol: "http",
    get: (name: string): string | undefined => "example.test",
  } as CompatReq;
  assert.equal(
    serializeMessage(message, req).body.plain_text,
    "contract-file.txt",
  );
});
test("sidebar placeholders suggest active users outside direct rooms", async () => {
  const { placeholderUsers } = domain;
  const { fragment, userData } = await import("../src/rendering.ts");
  const stamp = (ms: number) =>
    new Date(ms)
      .toISOString()
      .replace("T", " ")
      .replace("Z", "")
      .replace(/(\.\d{3})$/, "$1000");
  // A direct room between admin and member excludes both (plus admin).
  const direct = run(
    "INSERT INTO rooms(name,type,creator_id,created_at,updated_at) VALUES(?,?,?,?,?)",
    null,
    "Rooms::Direct",
    admin.id,
    now(),
    now(),
  );
  const directId = Number(direct.lastInsertRowid);
  domain.grantMemberships({ id: directId, type: "Rooms::Direct" }, [
    admin.id,
    member.id,
  ]);
  const ids = () => placeholderUsers(admin.id).map((u) => u.id);
  assert.ok(!ids().includes(admin.id), "self excluded");
  assert.ok(!ids().includes(member.id), "direct partner excluded");
  assert.ok(ids().includes(outsider.id), "stranger suggested");
  // Deactivated users are never suggested.
  run("UPDATE users SET status=1 WHERE id=?", outsider.id);
  assert.ok(!ids().includes(outsider.id), "deactivated excluded");
  run("UPDATE users SET status=0 WHERE id=?", outsider.id);
  assert.ok(ids().includes(outsider.id), "reactivated suggested again");
  // Oldest first (distinct timestamps), capped at 20 minus the
  // excluded count: outsider plus the 17 oldest of 25 extras.
  const base = Date.now();
  const extra: number[] = [];
  for (let i = 0; i < 25; i++) {
    const t = stamp(base + i * 1000);
    const u = run(
      "INSERT INTO users(name,email_address,password_digest,role,status,created_at,updated_at) VALUES(?,?,?,?,0,?,?)",
      "Extra" + i,
      `extra${i}@example.test`,
      "digest",
      0,
      t,
      t,
    );
    extra.push(Number(u.lastInsertRowid));
  }
  const listed = placeholderUsers(admin.id);
  assert.equal(listed.length, 18);
  assert.deepEqual(
    listed.map((u) => u.id),
    [outsider.id, ...extra.slice(0, 17)],
  );
  // The sidebar fragment renders one start-ping form per suggestion.
  const html = fragment("sidebar", {
    User: userData(admin),
    SidebarRooms: [],
    Placeholders: listed.slice(0, 2).map(userData),
    CanCreateRooms: true,
  });
  assert.equal((html.match(/\/rooms\/directs\?user_ids/g) || []).length, 2);
  // Cleanup: leave no trace for the other tests.
  run("DELETE FROM memberships WHERE room_id=?", directId);
  run("DELETE FROM rooms WHERE id=?", directId);
  for (const id of extra) run("DELETE FROM users WHERE id=?", id);
});
async function loginForSession(base: string) {
  let response = await fetch(base + "/session/new");
  const html = await response.text();
  const csrf = html.match(/name="csrf-token" content="([^"]+)"/)![1]!;
  let cookie = response.headers
    .getSetCookie()
    .map((c) => c.split(";")[0])
    .join("; ");
  response = await fetch(base + "/session", {
    method: "POST",
    redirect: "manual",
    headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      email_address: admin.email_address,
      password: "password",
      authenticity_token: csrf,
    }),
  });
  assert.equal(response.status, 302);
  cookie +=
    "; " +
    response.headers
      .getSetCookie()
      .map((c) => c.split(";")[0])
      .join("; ");
  return { cookie, csrf };
}

test("session cache serves repeated requests without re-reading auth (PERF-23)", async () => {
  const { base, close } = await serveApp();
  const server = { close: (cb: any) => { close().then(cb); } };
  try {
    const { cookie, csrf } = await loginForSession(base);
    // First request populates the entry.
    let response = await fetch(base + "/up", { headers: { cookie } });
    assert.equal(response.status, 200);
    // A second request on the same cookie hits the cache: no auth
    // SELECT, no cookie verify. The page still renders.
    response = await fetch(base + "/rooms/" + open.id, { headers: { cookie } });
    assert.equal(response.status, 200);
    const html = await response.text();
    assert.ok(html.length > 0);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("logout invalidates the session cache entry immediately (PERF-23)", async () => {
  const { base, close } = await serveApp();
  const server = { close: (cb: any) => { close().then(cb); } };
  try {
    const { cookie, csrf } = await loginForSession(base);
    const url = base + "/rooms/" + open.id;
    // Warm the cache.
    let response = await fetch(url, { headers: { cookie } });
    assert.equal(response.status, 200);
    // Logout deletes the session row. The cached entry must die with
    // it, or a revoked cookie would keep working. redirect:"manual"
    // so the 302 does not turn into a followed 200.
    response = await fetch(base + "/session", {
      method: "DELETE",
      redirect: "manual",
      headers: { cookie, "x-csrf-token": csrf },
    });
    assert.equal(response.status, 302);
    // The revoked cookie must no longer authenticate. Use /up (never
    // page-cached) and a profile page, not the room page: the room
    // page has its own whole-page cache keyed on generation, which is
    // a separate mechanism from the session cache.
    response = await fetch(base + "/up", { headers: { cookie } });
    assert.equal(response.status, 200);
    // redirect:"manual": a followed redirect would land on the login
    // page (200) and hide the revocation.
    response = await fetch(`${base}/users/${admin.id}`, {
      headers: { cookie },
      redirect: "manual",
    });
    assert.equal(
      response.status,
      302,
      "revoked session still authenticated (expected a login redirect)",
    );
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("user status change invalidates cached sessions (PERF-23)", async () => {
  const { base, close } = await serveApp();
  const server = { close: (cb: any) => { close().then(cb); } };
  try {
    const { cookie, csrf } = await loginForSession(base);
    const url = base + "/rooms/" + open.id;
    let response = await fetch(url, { headers: { cookie } });
    assert.equal(response.status, 200);
    // Ban the user (status 1) directly: a local write on users.
    run("UPDATE users SET status=1 WHERE id=?", admin.id);
    response = await fetch(`${base}/users/${admin.id}`, {
      headers: { cookie },
      redirect: "manual",
    });
    assert.equal(
      response.status,
      302,
      "banned user still authenticated (expected a login redirect)",
    );
    run("UPDATE users SET status=0 WHERE id=?", admin.id);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
