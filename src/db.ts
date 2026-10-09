import { Database, type SQLQueryBindings } from "bun:sqlite";
import { mkdirSync, readFileSync } from "node:fs";
import { dirname, resolve, join } from "node:path";
import { dataPath } from "./data.ts";

// Row shape at the DB boundary: columns are `any` by design.
export type Row = Record<string, any>;
export type RunResult = { changes: number | bigint | undefined; lastInsertRowid: number | bigint | undefined };

// The app issues ~150 distinct SQL strings; keep every prepared
// statement in bun:sqlite's LRU cache so hot queries never re-prepare.
Database.MAX_QUERY_CACHE_SIZE = 256;

let connection: Database | undefined;
// Page-cache generation observer (PERF-22, mirrors Rust's
// response_cache Observer): PRAGMA data_version only advances
// when the database file changes as seen by ANOTHER connection
// — the write connection never observes its own commits. This
// separate read-only connection sees every commit: local writes
// (same process, other connection), the writer child and
// sibling workers (cross-process). Read-only, so it never
// contends with the single write connection.
let observer: Database | undefined;
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
      readFileSync(dataPath("src", "schema.sql"), "utf8"),
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
  // Opened after WAL is set: a read-only connection joins the
  // existing WAL (the -shm wal-index must exist). An observer
  // failure disables the page cache (bypass, never stale) —
  // same policy as Rust's observer error path.
  if (path !== ":memory:") {
    try {
      observer = new Database(path, { readonly: true });
    } catch {
      observer = undefined;
    }
  }
  return connection;
}
export function db(): Database {
  return connection || initialize();
}
// bun:sqlite binds scalars (string/number/bigint/boolean/null/typed array).
type Param = SQLQueryBindings;
// Monotonic statement counter for perf tests (mirrors Express db.js):
// creation-path tests assert a bounded number of queries.
let queries = 0;
export function queryCount(): number {
  return queries;
}
export function all(sql: string, ...params: Param[]): Row[] {
  queries++;
  return db()
    .query(sql)
    .all(...params) as Row[];
}
export function get(sql: string, ...params: Param[]): Row | undefined {
  // bun:sqlite returns `null` for missing rows; node:sqlite
  // returned `undefined`. Normalize so callers see one contract.
  queries++;
  const row = db()
    .query(sql)
    .get(...params) as Row | null | undefined;
  return row ?? undefined;
}
export function run(sql: string, ...params: Param[]): RunResult {
  queries++;
  const result = db()
    .query(sql)
    .run(...params) as unknown as RunResult;
  recordChange(sql, result);
  return result;
}
// Change journal for the session cache (PERF-23, mirrors the C++
// port's tx.changed()): every write records the tables it touched so
// a per-worker session cache can drop exactly the entries whose
// session or user row changed, instead of a TTL or a wholesale flush.
// A local commit also bumps writeGeneration(), which is the coarse
// fallback when the change set is unknown (another worker's writes,
// seen through the observer).
export type TableName =
  | "sessions"
  | "users"
  | "memberships"
  | "rooms"
  | "messages"
  | "accounts"
  | "other";
export interface Change {
  table: TableName;
  id?: number;
}
const changeLog = new Set<string>();
let writeGen = 0;
let writeGenSeen = 0;
const WRITE_TABLE = /^\s*(?:INSERT\s+INTO|INSERT\s+OR\s+\w+\s+INTO|UPDATE(?:\s+OR\s+\w+)?|DELETE\s+FROM)\s+"?(\w+)"?/i;
function recordChange(sql: string, result: RunResult): void {
  const match = WRITE_TABLE.exec(sql);
  if (!match) return;
  const name = match[1]!;
  const table: TableName =
    name === "sessions" ||
    name === "users" ||
    name === "memberships" ||
    name === "rooms" ||
    name === "messages" ||
    name === "accounts"
      ? name
      : "other";
  // UPDATE/DELETE without a rowid in hand key on the table alone:
  // a session-cache entry matches on session id or user id, so a
  // table-level entry drops every entry of that table (correct,
  // coarser). INSERTs carry lastInsertRowid.
  const id =
    table !== "other" && result && Number.isFinite(Number(result.lastInsertRowid))
      ? Number(result.lastInsertRowid)
      : undefined;
  changeLog.add(id === undefined ? table : `${table}:${id}`);
  // Any local commit advances the write generation so a consumer
  // that only tracks the counter (not the events) still flushes.
  writeGen++;
}
// Called by a transaction commit so nested runs flush their journal
// exactly once per commit.
export function noteCommit(): void {
  writeGen++;
}
export function drainChanges(): Change[] {
  const out: Change[] = [];
  for (const entry of changeLog) {
    const [table, id] = entry.split(":");
    out.push({
      table: table as TableName,
      id: id === undefined ? undefined : Number(id),
    });
  }
  changeLog.clear();
  return out;
}
// True when any write committed since the last call (local or remote).
// Consumers that cannot apply precise events use this to flush.
export function writeGenerationMoved(): boolean {
  if (writeGen !== writeGenSeen) {
    writeGenSeen = writeGen;
    return true;
  }
  return false;
}
// Write generation for page-cache tickets (PERF-22, mirrors
// Rust's Observer): one cheap PRAGMA on the read-only observer
// replaces the multi-SELECT version discovery on cache hits.
// Equality-compare is wrap-safe (samples are microseconds apart;
// 2^32 commits cannot land between two). Per-process sequence:
// page keys live in per-process Maps, so generations only need
// process-local consistency. Uncounted like the init pragmas
// (infrastructure, not table queries).
let lastDataVersion: number | null = null;
let generation = 0;
export function dataVersion(): number | null {
  if (!observer) return null;
  try {
    const row = observer
      .query("PRAGMA data_version")
      .get() as { data_version?: unknown } | null;
    return typeof row?.data_version === "number" ? row.data_version : null;
  } catch {
    return null;
  }
}
export function pageGeneration(): number | null {
  const v = dataVersion();
  if (v === null) return null;
  if (lastDataVersion === null) lastDataVersion = v;
  else if (v !== lastDataVersion) {
    generation++;
    lastDataVersion = v;
  }
  return generation;
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
