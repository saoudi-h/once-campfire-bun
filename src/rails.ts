import {
  createHmac,
  pbkdf2Sync,
  timingSafeEqual,
  randomBytes,
  createCipheriv,
  createDecipheriv,
} from "node:crypto";
import type { Row } from "./db.ts";

// Rails wire contracts are checked against independently generated golden vectors.
const keys = new Map<string, Buffer>();
let clock = () => new Date();
export function setClock(fn?: () => Date) {
  clock = fn || (() => new Date());
}
export const parseJSON = (text: string) =>
  JSON.parse(
    text,
    // Bun passes the reviver a third context argument (with
    // the raw source text) that the standard lib types omit.
    (
      (k: string, v: any, context: { source?: string }) =>
        typeof v === "number" &&
        Number.isInteger(v) &&
        !Number.isSafeInteger(v) &&
        /^-?\d+$/.test(context.source || "")
          ? BigInt(context.source!)
          : v
    ) as (key: string, value: any) => any,
  );
export const stringify = (value: unknown): string =>
  JSON.stringify(value, (k, v) =>
    typeof v === "bigint" ? (JSON as unknown as { rawJSON(s: string): unknown }).rawJSON(v.toString()) : v,
  );
export const encode = (value: unknown) =>
  Buffer.from(
    stringify(value).replace(
      /[<>&]/g,
      (c) =>
        ({ "<": "\\u003c", ">": "\\u003e", "&": "\\u0026" } as Record<
          string,
          string
        >)[c]!,
    ),
  );
export const b64 = (value: Buffer | string) => Buffer.from(value).toString("base64");
export function decode64(value: unknown): Buffer {
  if (
    typeof value !== "string" ||
    !/^[A-Za-z0-9+/_-]*={0,2}$/.test(value) ||
    value.replace(/=+$/, "").length % 4 === 1
  )
    throw new Error("invalid base64");
  return Buffer.from(value, "base64");
}
export function key(salt: string, length = 64): Buffer {
  const secret = process.env.SECRET_KEY_BASE;
  if (!secret) throw new Error("SECRET_KEY_BASE is required");
  const id = JSON.stringify([secret, salt, length]);
  if (!keys.has(id)) {
    if (keys.size >= 64) keys.clear();
    keys.set(id, pbkdf2Sync(secret, salt, 1000, length, "sha256"));
  }
  return keys.get(id)!;
}
const mac = (data: string, salt: string, algorithm = "sha1") =>
  createHmac(algorithm, key(salt)).update(data).digest("hex");
export function equal(
  a: string | Uint8Array | number[],
  b: string | Uint8Array | number[],
): boolean {
  const x = Buffer.from(a),
    y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}
// Read only Marshal data primitives; never instantiate Ruby classes or execute code.
// Marshal payloads decode to arbitrary application data.
function marshal(raw: Buffer): any {
  let offset = 2,
    nodes = 0;
  const symbols: string[] = [],
    objects: any[] = [];
  const byte = () => {
    if (offset >= raw.length) throw new Error("truncated Marshal");
    return raw[offset++]!;
  };
  function integer() {
    let n = byte();
    if (n > 127) n -= 256;
    if (n === 0) return 0;
    if (n > 4) return n - 5;
    if (n < -4) return n + 5;
    const width = Math.abs(n);
    let value = n < 0 ? -1n : 0n;
    for (let i = 0; i < width; i++) {
      const mask = 255n << BigInt(i * 8);
      value = (value & ~mask) | (BigInt(byte()) << BigInt(i * 8));
    }
    return Number(value);
  }
  function bytes() {
    const length = integer();
    if (length < 0 || length > 1048576 || offset + length > raw.length)
      throw new Error("invalid Marshal length");
    const text = raw.subarray(offset, offset + length).toString("utf8");
    offset += length;
    return text;
  }
  function read(depth = 0): any {
    if (depth > 32 || ++nodes > 10000)
      throw new Error("Marshal limits exceeded");
    const type = byte();
    if (type === 48) return null;
    if (type === 84) return true;
    if (type === 70) return false;
    if (type === 105) return integer();
    if (type === 34) {
      const value = bytes();
      objects.push(value);
      return value;
    }
    if (type === 58) {
      const value = bytes();
      symbols.push(value);
      return value;
    }
    if (type === 59) {
      const i = integer();
      if (i < 0 || i >= symbols.length) throw new Error("invalid symbol link");
      return symbols[i];
    }
    if (type === 64) {
      const i = integer();
      if (i < 0 || i >= objects.length) throw new Error("invalid object link");
      return objects[i];
    }
    if (type === 73) {
      const value = read(depth + 1),
        count = integer();
      if (count < 0 || count > 1000)
        throw new Error("invalid instance metadata");
      for (let i = 0; i < count; i++) {
        const k = read(depth + 1);
        if (!["E", "encoding"].includes(k))
          throw new Error("unsupported Marshal metadata");
        read(depth + 1);
      }
      return value;
    }
    if (type === 91) {
      const count = integer();
      if (count < 0 || count > 10000) throw new Error("invalid Marshal array");
      const value: unknown[] = [];
      objects.push(value);
      for (let i = 0; i < count; i++) value.push(read(depth + 1));
      return value;
    }
    if (type === 123) {
      const count = integer();
      if (count < 0 || count > 10000) throw new Error("invalid Marshal hash");
      const value = Object.create(null);
      objects.push(value);
      for (let i = 0; i < count; i++) {
        const k = read(depth + 1);
        if (
          typeof k !== "string" ||
          ["__proto__", "constructor", "prototype"].includes(k)
        )
          throw new Error("invalid Marshal key");
        value[k] = read(depth + 1);
      }
      return value;
    }
    if (type === 102) {
      const text = bytes();
      const value = Number(text);
      if (!Number.isFinite(value)) throw new Error("nonfinite Marshal float");
      objects.push(value);
      return value;
    }
    throw new Error("unsupported Marshal type");
  }
  return read();
}
function load(raw: Buffer): any {
  return raw[0] === 4 && raw[1] === 8
    ? marshal(raw)
    : parseJSON(raw.toString("utf8"));
}

export function unpack(raw: Buffer, purpose: string | null = null): unknown {
  const v = load(raw);
  if (v && typeof v === "object" && !Array.isArray(v) && "_rails" in v) {
    const m = v._rails;
    if (!m || typeof m !== "object" || (m.pur || "") !== (purpose || ""))
      throw new Error("invalid purpose");
    if (
      m.exp !== undefined &&
      m.exp !== null &&
      !(new Date(m.exp).getTime() > clock().getTime())
    )
      throw new Error("expired message");
    return "message" in m ? load(decode64(m.message)) : m.data;
  }
  if (purpose) throw new Error("missing purpose");
  return v;
}
export interface SignOptions {
  plainJson?: boolean;
}

export function sign(
  value: unknown,
  salt: string,
  purpose: string | null = null,
  expiry: Date | string | number | null = null,
  algorithm = "sha1",
  urlsafe = false,
  padded = true,
  options: SignOptions = {},
): string {
  const m: { data: unknown; exp?: string; pur?: string } = { data: value };
  if (expiry) m.exp = new Date(expiry).toISOString();
  if (purpose) m.pur = purpose;
  const envelope = purpose || expiry ? { _rails: m } : value;
  let payload = (
    options.plainJson ? Buffer.from(stringify(envelope)) : encode(envelope)
  ).toString(urlsafe ? "base64url" : "base64");
  if (urlsafe && padded) payload += "=".repeat((4 - (payload.length % 4)) % 4);
  if (!padded) payload = payload.replace(/=+$/, "");
  return payload + "--" + mac(payload, salt, algorithm);
}
export function verify(raw: unknown, salt: string, purpose: string | null = null, algorithm = "sha1"): unknown {
  if (typeof raw !== "string") throw new Error("invalid message");
  const i = raw.lastIndexOf("--");
  if (i < 0) throw new Error("invalid message");
  const payload = raw.slice(0, i),
    signature = raw.slice(i + 2);
  if (!equal(signature, mac(payload, salt, algorithm)))
    throw new Error("invalid signature");
  return unpack(decode64(payload), purpose);
}
function cookieEnvelope(name: string, value: unknown, expiry: Date | null = null): Buffer {
  return encode({
    _rails: {
      message: b64(encode(value)),
      exp: expiry ? new Date(expiry).toISOString() : null,
      pur: "cookie." + name,
    },
  });
}
export function signCookie(name: string, value: unknown, expiry: Date | null = null): string {
  const p = b64(cookieEnvelope(name, value, expiry));
  return p + "--" + mac(p, "signed cookie");
}
function cookieValue(raw: Buffer, name: string): unknown {
  if (raw.toString().startsWith('{"_rails":{"message":"')) {
    const m = parseJSON(raw.toString())._rails;
    if (m.pur && m.pur !== "cookie." + name)
      throw new Error("invalid cookie purpose");
    if (m.exp && !(new Date(m.exp).getTime() > clock().getTime()))
      throw new Error("expired cookie");
    raw = decode64(m.message);
  }
  return parseJSON(raw.toString());
}
export function verifyCookie(name: string, raw: string): unknown {
  raw = decodeURIComponent(raw);
  const i = raw.lastIndexOf("--");
  if (i < 0) throw new Error("invalid cookie");
  const p = raw.slice(0, i);
  if (!equal(raw.slice(i + 2), mac(p, "signed cookie")))
    throw new Error("invalid cookie signature");
  return cookieValue(decode64(p), name);
}
export function encryptCookie(name: string, value: unknown, expiry: Date | null = null, options: { nonce?: Buffer } = {}): string {
  const nonce = options.nonce || randomBytes(12),
    cipher = createCipheriv(
      "aes-256-gcm",
      key("authenticated encrypted cookie", 32),
      nonce,
    );
  const data = Buffer.concat([
    cipher.update(cookieEnvelope(name, value, expiry)),
    cipher.final(),
  ]);
  return [data, nonce, cipher.getAuthTag()].map(b64).join("--");
}
export function decryptCookie(name: string, raw: string): unknown {
  const parts = decodeURIComponent(raw).split("--");
  if (parts.length !== 3) throw new Error("invalid cookie");
  const [data, nonce, tag] = parts.map(decode64) as [Buffer, Buffer, Buffer];
  if (nonce.length !== 12 || tag.length !== 16)
    throw new Error("invalid cookie");
  const cipher = createDecipheriv(
    "aes-256-gcm",
    key("authenticated encrypted cookie", 32),
    nonce,
  );
  cipher.setAuthTag(tag);
  return cookieValue(
    Buffer.concat([cipher.update(data), cipher.final()]),
    name,
  );
}
function modelPurpose(model: string, purpose: string): string {
  if (model.startsWith("Rooms::")) model = "Room";
  const underscored = model
    .replaceAll("::", "/")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1_$2")
    .replace(/([a-z\d])([A-Z])/g, "$1_$2")
    .toLowerCase();
  return underscored + (purpose ? "/" + purpose : "");
}
export function signedId(model: string, id: unknown, purpose = "", expiry: Date | string | number | null = null) {
  return model === "ActiveStorage::Blob"
    ? sign(id, "ActiveStorage", purpose || "blob_id", expiry)
    : sign(
        id,
        "active_record/signed_id",
        modelPurpose(model, purpose),
        expiry,
        "sha256",
        true,
        false,
        { plainJson: true },
      );
}
export function verifyId(model: string, raw: unknown, purpose = ""): number | bigint {
  let value;
  if (model === "ActiveStorage::Blob")
    value = verify(raw, "ActiveStorage", purpose || "blob_id");
  else {
    const p = modelPurpose(model, purpose);
    try {
      value = verify(raw, "active_record/signed_id", p, "sha256");
    } catch {
      value = verify(raw, "active_record/signed_id", p, "sha1");
    }
  }
  if (
    !["string", "number", "bigint"].includes(typeof value) ||
    !/^[-+]?\d+$/.test(String(value))
  )
    throw new Error("invalid model id");
  const id = BigInt(value as string | number | bigint);
  return id > BigInt(Number.MAX_SAFE_INTEGER) ||
    id < BigInt(Number.MIN_SAFE_INTEGER)
    ? id
    : Number(id);
}
export const stream = (room: Row): string =>
  Buffer.from(`gid://campfire/${room.type}/${room.id}`).toString("base64url") +
  ":messages";
export const signStream = (name: string): string =>
  sign(
    name,
    "turbo/signed_stream_verifier_key",
    null,
    null,
    "sha256",
    false,
    true,
    { plainJson: true },
  );
export function verifyStream(raw: unknown): string | number {
  const v = verify(raw, "turbo/signed_stream_verifier_key", null, "sha256");
  if (typeof v !== "string" && typeof v !== "number")
    throw new Error("invalid stream");
  return v;
}
export const sgid = (model: string, id: unknown): string =>
  sign(
    `gid://campfire/${model}/${id}?expires_in`,
    "signed_global_ids",
    "attachable",
    null,
    "sha1",
    true,
  );
export function verifySgid(raw: unknown, purpose = "attachable"): string {
  let v: unknown;
  try {
    v = verify(raw, "signed_global_ids", purpose);
  } catch {
    v = verify(raw, "signed_global_ids");
    if (
      !v ||
      typeof v !== "object" ||
      (v as Record<string, unknown>).purpose !== purpose
    )
      throw new Error("invalid GlobalID purpose");
    const envelope = v as { expires_at?: unknown; gid?: unknown };
    if (
      envelope.expires_at &&
      !(new Date(envelope.expires_at as string | number | Date) >= clock())
    )
      throw new Error("expired GlobalID");
    v = envelope.gid;
  }
  if (typeof v !== "string") throw new Error("invalid GlobalID");
  return v;
}
export function unverifiedUserGid(raw: string): number | null {
  try {
    const envelope = JSON.parse(
      decode64(raw.slice(0, raw.lastIndexOf("--"))).toString(),
    );
    const m = envelope._rails;
    if (!m || typeof m !== "object") return null;
    let v = m.data;
    if (v == null && m.message)
      v = decode64(m.message)
        .toString()
        .match(/gid:\/\/campfire\/[^/]+\/\d+/)?.[0];
    if (typeof v !== "string") return null;
    if (!v.startsWith("gid://")) v = decode64(v).toString();
    const url = new URL(v);
    return url.protocol === "gid:" &&
      url.hostname &&
      /^\/User\/\d+$/.test(url.pathname)
      ? Number(url.pathname.split("/").at(-1))
      : null;
  } catch {
    return null;
  }
}
export function maskCsrf(raw: Uint8Array | number[]): string {
  if (raw.length !== 32) throw new Error("invalid CSRF secret");
  const pad = randomBytes(32);
  return Buffer.concat([
    pad,
    Buffer.from((Array.from(raw) as number[]).map((x, i) => x ^ (pad[i] as number))),
  ]).toString("base64url");
}
export function validCsrf(raw: Uint8Array | number[], token: string, path: string | null = null, method: string | null = null) {
  try {
    if (raw.length !== 32) return false;
    let v = decode64(token);
    if (v.length === 32) return equal(v, raw);
    if (v.length === 64)
      v = Buffer.from(v.subarray(0, 32).map((x, i) => x ^ v[i + 32]!));
    if (v.length !== 32) return false;
    const candidates = [
      raw,
      createHmac("sha256", raw as Buffer).update("!real_csrf_token").digest(),
    ];
    if (path != null && method != null)
      candidates.push(
        createHmac("sha256", raw as Buffer)
          .update(path.replace(/\/$/, "") + "#" + method.toLowerCase())
          .digest(),
      );
    return candidates.some((c) => equal(v, c));
  } catch {
    return false;
  }
}
