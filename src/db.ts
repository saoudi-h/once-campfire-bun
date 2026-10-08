import { Database, type SQLQueryBindings } from "bun:sqlite";
import { mkdirSync, readFileSync } from "node:fs";
import { dirname, resolve, join } from "node:path";

// Row shape at the DB boundary: columns are `any` by design.
export type Row = Record<string, any>;
export type RunResult = { changes: number | bigint | undefined; lastInsertRowid: number | bigint | undefined };

// The app issues ~150 distinct SQL strings; keep every prepared
// statement in bun:sqlite's LRU cache so hot queries never re-prepare.
Database.MAX_QUERY_CACHE_SIZE = 256;

let connection: Database | undefined;
let depth = 0;
const callbacks: Array<Array<() => void>> = [];
export function onCommit(fn: () => void) {
  if (depth) callbacks.at(-1)!.push(fn);
  else fn();
}
export function initialize(
  path: string = process.env.DATABASE_PATH ||
    join(
      process.env.CAMPFIRE_STORAGE_PATH ||
        process.env.STORAGE_PATH ||
        "storage",
      "db/production.sqlite3",
    ),
): Database {
  if (connection) return connection;
  if (path !== ":memory:")
    mkdirSync(dirname(resolve(path)), { recursive: true });
  connection = new Database(path);
  // Durability matches Rails (WAL + NORMAL, like the Rust port):
  // commits don't fsync. Auto-checkpoint is off here: it would run
  // inside the committing transaction on the event loop thread
  // (~12ms of fsyncs every ~64 posts). server.ts runs PASSIVE
  // checkpoints on a worker thread instead (see checkpoint.ts).
  connection.exec(
    "PRAGMA busy_timeout=10000; PRAGMA foreign_keys=ON; PRAGMA synchronous=NORMAL; PRAGMA wal_autocheckpoint=0;",
  );
  if (
    !connection
      .query("SELECT name FROM sqlite_master WHERE name='users'")
      .get()
  ) {
    connection.exec(
      readFileSync(new URL("./schema.sql", import.meta.url), "utf8"),
    );
  }
  validateSchema(connection);
  // Rolling upgrade for databases created before the composite
  // room/time index existed (same as the Rust port adds at boot;
  // keeps long rooms fast without a Rails migration).
  connection.exec(
    'CREATE INDEX IF NOT EXISTS "index_messages_on_room_id_and_created_at" ON "messages" ("room_id", "created_at")',
  );
  connection.exec("PRAGMA journal_mode=WAL;");
  return connection;
}
export function db(): Database {
  return connection || initialize();
}
// bun:sqlite binds scalars (string/number/bigint/boolean/null/typed array).
type Param = SQLQueryBindings;
export function all(sql: string, ...params: Param[]): Row[] {
  return db()
    .query(sql)
    .all(...params) as Row[];
}
export function get(sql: string, ...params: Param[]): Row | undefined {
  // bun:sqlite returns `null` for missing rows; node:sqlite
  // returned `undefined`. Normalize so callers see one contract.
  const row = db()
    .query(sql)
    .get(...params) as Row | null | undefined;
  return row ?? undefined;
}
export function run(sql: string, ...params: Param[]): RunResult {
  return db()
    .query(sql)
    .run(...params) as unknown as RunResult;
}
export function now() {
  return new Date(process.env.CAMPFIRE_FROZEN_TIME || Date.now())
    .toISOString()
    .replace("T", " ")
    .replace("Z", "")
    .replace(/(\.\d{3})$/, "$1000");
}
export function transaction<T>(fn: () => T): T {
  const name = `nested_${depth}`,
    nested = depth > 0;
  db().exec(nested ? `SAVEPOINT ${name}` : "BEGIN IMMEDIATE");
  depth++;
  callbacks.push([]);
  let result: T;
  let hooks: Array<() => void> | undefined;
  try {
    result = fn() as T;
    if (result != null && typeof (result as unknown as { then?: unknown }).then === "function")
      throw new TypeError("SQLite transactions must be synchronous");
    db().exec(nested ? `RELEASE ${name}` : "COMMIT");
    hooks = callbacks.pop();
  } catch (error) {
    callbacks.pop();
    db().exec(nested ? `ROLLBACK TO ${name}; RELEASE ${name}` : "ROLLBACK");
    throw error;
  } finally {
    depth--;
  }
  if (nested) callbacks.at(-1)!.push(...(hooks ?? []));
  else for (const callback of hooks ?? []) callback();
  return result!;
}

function validateSchema(conn: Database) {
  const required = {
    accounts: [
      "id",
      "name",
      "join_code",
      "settings",
      "custom_styles",
      "singleton_guard",
      "created_at",
      "updated_at",
    ],
    users: [
      "id",
      "name",
      "email_address",
      "password_digest",
      "role",
      "status",
      "bot_token",
      "bio",
      "created_at",
      "updated_at",
    ],
    rooms: ["id", "name", "type", "creator_id", "created_at", "updated_at"],
    memberships: [
      "id",
      "room_id",
      "user_id",
      "involvement",
      "connections",
      "connected_at",
      "unread_at",
      "created_at",
      "updated_at",
    ],
    messages: [
      "id",
      "room_id",
      "creator_id",
      "client_message_id",
      "created_at",
      "updated_at",
    ],
    action_text_rich_texts: [
      "id",
      "record_id",
      "record_type",
      "name",
      "body",
      "created_at",
      "updated_at",
    ],
    active_storage_blobs: [
      "id",
      "key",
      "filename",
      "content_type",
      "byte_size",
      "checksum",
      "metadata",
      "service_name",
      "created_at",
    ],
    active_storage_attachments: [
      "id",
      "name",
      "record_type",
      "record_id",
      "blob_id",
      "created_at",
    ],
    active_storage_variant_records: ["id", "blob_id", "variation_digest"],
    boosts: [
      "id",
      "message_id",
      "booster_id",
      "content",
      "created_at",
      "updated_at",
    ],
    sessions: [
      "id",
      "user_id",
      "token",
      "user_agent",
      "ip_address",
      "last_active_at",
      "created_at",
      "updated_at",
    ],
    searches: ["id", "user_id", "query", "created_at", "updated_at"],
    bans: ["id", "user_id", "ip_address", "created_at", "updated_at"],
    push_subscriptions: [
      "id",
      "user_id",
      "endpoint",
      "p256dh_key",
      "auth_key",
      "user_agent",
      "created_at",
      "updated_at",
    ],
    webhooks: ["id", "user_id", "url", "created_at", "updated_at"],
    message_search_index: ["body"],
  };
  for (const [table, columns] of Object.entries(required)) {
    const installed = new Set(
      conn
        .query(`PRAGMA table_info("${table}")`)
        .all()
        .map((c) => (c as Row).name),
    );
    const missing = columns.filter((c) => !installed.has(c));
    if (missing.length)
      throw new Error(
        `Unsupported Campfire database schema: ${table} missing ${missing.join(", ")}. Upgrade the Rails installation to the pinned reference schema before importing it.`,
      );
  }
  const fts = (conn
    .query("SELECT sql FROM sqlite_master WHERE name='message_search_index'")
    .get() as Row | undefined)?.sql as string | undefined;
  if (!/USING\s+fts5\b/i.test(fts || ""))
    throw new Error(
      "Unsupported Campfire database schema: message_search_index must be FTS5",
    );
}
