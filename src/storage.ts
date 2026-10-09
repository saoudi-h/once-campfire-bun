import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { promisify } from "node:util";
import { execFile } from "node:child_process";
import { AsyncLocalStorage } from "node:async_hooks";
import type { CompatReq, CompatRes } from "./compat.ts";
import type { Row } from "./db.ts";
import { transformImage, imageMetadata } from "./image.ts";
import { all, get, run, transaction, now } from "./db.ts";
import * as rails from "./rails.ts";

const execute = promisify(execFile);
const staged = new AsyncLocalStorage<string[]>();
export const filesPath = () =>
  path.resolve(
    process.env.FILES_PATH ||
      path.join(
        process.env.CAMPFIRE_STORAGE_PATH ||
          process.env.STORAGE_PATH ||
          "storage",
        "files",
      ),
  );
export function pathFor(key: string) {
  if (!/^[a-zA-Z0-9]{4,128}$/.test(key)) throw new Error("invalid storage key");
  return path.join(filesPath(), key.slice(0, 2), key.slice(2, 4), key);
}
const checksum = (raw: Buffer) => crypto.createHash("md5").update(raw).digest("base64");
/** Multipart upload or direct-upload payload shape. */
export interface StoredUpload {
  buffer?: Buffer;
  data?: Buffer;
  originalname?: string;
  filename?: string;
  mimetype?: string;
  content_type?: string;
}
export function stagedFiles<T>(fn: () => T): T {
  if (staged.getStore()) return fn();
  const paths: string[] = [];
  const clean = (error: unknown) => {
    for (const file of paths) fs.rmSync(file, { force: true });
    throw error;
  };
  return staged.run(paths, () => {
    try {
      const result = fn() as T | Promise<T>;
      return (result &&
      typeof (result as Promise<T>).then === "function"
        ? (result as Promise<T>).catch(clean)
        : result) as T;
    } catch (error) {
      return clean(error);
    }
  });
}
function write(key: string, raw: Buffer) {
  const target = pathFor(key);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const tmp = `${target}.${crypto.randomBytes(8).toString("hex")}`;
  try {
    fs.writeFileSync(tmp, raw, { flag: "wx" });
    fs.renameSync(tmp, target);
  } finally {
    fs.rmSync(tmp, { force: true });
  }
  staged.getStore()?.push(target);
}
export function storeUpload(upload: StoredUpload, recordType: string, recordId: number | string, name: string): Row {
  const raw = upload.buffer || upload.data;
  if (!Buffer.isBuffer(raw) || raw.length > 50 * 1024 * 1024)
    throw new Error("invalid upload");
  const key = crypto.randomBytes(14).toString("hex");
  return stagedFiles(() =>
    transaction(() => {
      write(key, raw);
      const id = Number(
        run(
          "INSERT INTO active_storage_blobs(key,filename,content_type,byte_size,checksum,metadata,service_name,created_at) VALUES(?,?,?,?,?,?,?,?)",
          key,
          path.basename(upload.originalname || upload.filename || "file"),
          upload.mimetype || upload.content_type || "application/octet-stream",
          raw.length,
          checksum(raw),
          "{}",
          "local",
          now(),
        ).lastInsertRowid,
      );
      run(
        "INSERT INTO active_storage_attachments(name,record_type,record_id,blob_id,created_at) VALUES(?,?,?,?,?)",
        name,
        recordType,
        recordId,
        id,
        now(),
      );
      return get("SELECT * FROM active_storage_blobs WHERE id=?", id)!;
    }),
  );
}
export function attachSigned(token: string, recordType: string, recordId: number | string, name: string, userId: number | null = null): Row {
  const id = rails.verifyId("ActiveStorage::Blob", token, "blob_id");
  const blob = get("SELECT * FROM active_storage_blobs WHERE id=?", id);
  if (!blob || !fs.existsSync(pathFor(blob.key)))
    throw new Error("upload missing");
  const owner = JSON.parse(blob.metadata || "{}").campfire_upload_user_id;
  if (owner && Number(owner) !== Number(userId))
    throw new Error("upload belongs to another user");
  if (userId != null && !authorizedBlob(blob, { id: userId }))
    throw new Error("attachment access denied");
  run(
    "INSERT INTO active_storage_attachments(name,record_type,record_id,blob_id,created_at) VALUES(?,?,?,?,?)",
    name,
    recordType,
    recordId,
    id,
    now(),
  );
  return blob;
}
export function removeAttachment(recordType: string, recordId: number | string, name: string): number[] {
  const ids = all(
    "SELECT blob_id FROM active_storage_attachments WHERE record_type=? AND record_id=? AND name=?",
    recordType,
    recordId,
    name,
  ).map((r) => Number(r.blob_id));
  run(
    "DELETE FROM active_storage_attachments WHERE record_type=? AND record_id=? AND name=?",
    recordType,
    recordId,
    name,
  );
  return ids;
}
export function replaceAttachment(upload: StoredUpload, recordType: string, recordId: number | string, name: string) {
  return stagedFiles(() =>
    transaction(() => {
      const old = removeAttachment(recordType, recordId, name);
      const blob = storeUpload(upload, recordType, recordId, name);
      return { ...blob, removedBlobIds: old };
    }),
  );
}
export function purgeBlob(id: number | string) {
  if (
    get("SELECT id FROM active_storage_attachments WHERE blob_id=? LIMIT 1", id)
  )
    return;
  const blob = get("SELECT * FROM active_storage_blobs WHERE id=?", id);
  if (!blob) return;
  const children: number[] = [];
  transaction(() => {
    for (const variant of all(
      "SELECT id FROM active_storage_variant_records WHERE blob_id=?",
      id,
    )) {
      children.push(
        ...all(
          "SELECT blob_id FROM active_storage_attachments WHERE record_type='ActiveStorage::VariantRecord' AND record_id=?",
          variant.id,
        ).map((r) => Number(r.blob_id)),
      );
      run(
        "DELETE FROM active_storage_attachments WHERE record_type='ActiveStorage::VariantRecord' AND record_id=?",
        variant.id,
      );
    }
    children.push(
      ...all(
        "SELECT blob_id FROM active_storage_attachments WHERE record_type='ActiveStorage::Blob' AND record_id=?",
        id,
      ).map((r) => Number(r.blob_id)),
    );
    run(
      "DELETE FROM active_storage_attachments WHERE record_type='ActiveStorage::Blob' AND record_id=?",
      id,
    );
    run("DELETE FROM active_storage_variant_records WHERE blob_id=?", id);
    run("DELETE FROM active_storage_blobs WHERE id=?", id);
  });
  fs.rmSync(pathFor(blob.key), { force: true });
  for (const child of children) purgeBlob(child);
}
export function blobUrl(blob: Row) {
  return `/rails/active_storage/blobs/redirect/${rails.signedId("ActiveStorage::Blob", blob.id, "blob_id")}/${encodeURIComponent(blob.filename)}`;
}
export function representationUrl(blob: Row, dimensions: number[] = [1200, 800], format?: string) {
  const transforms = {
    format: format || path.extname(blob.filename).slice(1) || "png",
    resize_to_limit: dimensions,
  };
  return `/rails/active_storage/representations/redirect/${rails.signedId("ActiveStorage::Blob", blob.id, "blob_id")}/${rails.sign(transforms, "ActiveStorage", "variation")}/${encodeURIComponent(blob.filename)}`;
}
const binary = new Set([
  "text/html",
  "image/svg+xml",
  "application/postscript",
  "application/x-shockwave-flash",
  "text/xml",
  "application/xml",
  "application/xhtml+xml",
  "application/mathml+xml",
  "text/cache-manifest",
]);
const inline = new Set([
  "image/webp",
  "image/avif",
  "image/png",
  "image/gif",
  "image/jpeg",
  "image/tiff",
  "image/bmp",
  "image/vnd.adobe.photoshop",
  "image/vnd.microsoft.icon",
  "application/pdf",
]);
export function servingAttributes(type: string, disposition = "inline"): [string, string] {
  type =
    (type || "application/octet-stream").split(";")[0]?.toLowerCase() ||
    "application/octet-stream";
  return binary.has(type)
    ? ["application/octet-stream", "attachment"]
    : [
        type,
        inline.has(type) && disposition !== "attachment"
          ? "inline"
          : "attachment",
      ];
}
export function serve(req: CompatReq, res: CompatRes, file: string, type: string, filename: string, disposition = "inline") {
  if (!fs.existsSync(file)) return res.sendStatus(404);
  const size = fs.statSync(file).size;
  res.set({
    "Accept-Ranges": "bytes",
    "Content-Type": type,
    "Content-Disposition": `${disposition === "attachment" ? "attachment" : "inline"}; filename="${filename.replace(/[\r\n"\\]/g, "")}"; filename*=UTF-8''${encodeURIComponent(filename)}`,
  });
  let start = 0,
    end = size - 1;
  if (req.headers.range) {
    const m = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range);
    if (!m || (!m[1] && !m[2]))
      return res.status(416).set("Content-Range", `bytes */${size}`).end();
    start = m[1] ? Number(m[1]) : Math.max(0, size - Number(m[2]));
    end = m[1] && m[2] ? Math.min(size - 1, Number(m[2])) : size - 1;
    if (
      !Number.isSafeInteger(start) ||
      !Number.isSafeInteger(end) ||
      start > end ||
      start >= size
    )
      return res.status(416).set("Content-Range", `bytes */${size}`).end();
    res.status(206).set("Content-Range", `bytes ${start}-${end}/${size}`);
  }
  res.set("Content-Length", String(Math.max(0, end - start + 1)));
  if (req.method === "HEAD" || size === 0) return res.end();
  // Stash a lazy file slice; app.ts materializes it into a 206 Response.
  (res as any).bunFile = Bun.file(file).slice(start, end + 1);
  return res.end();
}
export function authorizedBlob(blob: Row, user: Row | null | undefined): boolean {
  if (!user) return false;
  const attachments = all(
    "SELECT * FROM active_storage_attachments WHERE blob_id=?",
    blob.id,
  );
  if (!attachments.length) {
    const owner = JSON.parse(blob.metadata || "{}").campfire_upload_user_id;
    return owner == null || Number(owner) === Number(user.id);
  }
  return attachments.some((a) => {
    if (a.record_type === "User" || a.record_type === "Account") return true;
    let messageId = a.record_id;
    if (a.record_type === "ActionText::RichText")
      messageId = get(
        "SELECT record_id FROM action_text_rich_texts WHERE id=? AND record_type='Message'",
        a.record_id,
      )?.record_id;
    if (a.record_type !== "Message" && a.record_type !== "ActionText::RichText")
      return false;
    return !!get(
      "SELECT m.id FROM messages m JOIN memberships ms ON ms.room_id=m.room_id WHERE m.id=? AND ms.user_id=?",
      messageId,
      user.id,
    );
  });
}
export async function variant(blob: Row, dimensions: number[] = [1200, 800], format?: string): Promise<Row> {
  if (
    !Array.isArray(dimensions) ||
    dimensions.length !== 2 ||
    dimensions.some((n) => !Number.isInteger(n) || n < 1 || n > 16384)
  )
    throw new Error("invalid dimensions");
  format ||= path.extname(blob.filename).slice(1).toLowerCase();
  if (format === "jpg") format = "jpeg";
  if (!["png", "jpeg", "webp", "gif", "tiff", "avif"].includes(format))
    format = "png";
  // Native variant records own generated files; digest is intentionally namespaced from Rails Marshal variants.
  const digest = crypto
    .createHash("sha1")
    .update(`express:${JSON.stringify([dimensions, format])}`)
    .digest("base64");
  const existing = get(
    "SELECT b.* FROM active_storage_variant_records v JOIN active_storage_attachments a ON a.record_type='ActiveStorage::VariantRecord' AND a.record_id=v.id AND a.name='image' JOIN active_storage_blobs b ON b.id=a.blob_id WHERE v.blob_id=? AND v.variation_digest=?",
    blob.id,
    digest,
  );
  if (existing && fs.existsSync(pathFor(existing.key))) return existing;
  const width = dimensions[0] as number;
  const height = dimensions[1] as number;
  // Rails parity is a plain resize_to_limit (no sharpen anywhere in the
  // reference): sharpening was an Express-port artifact that also cost
  // ~13ms on the sharp path (PERF-21). The input hint lets slow decodes
  // (WebP) and impossible ones (TIFF/AVIF/HEIC on Linux) skip Bun.
  const inputFormat = (blob.content_type || "").replace(/^image\//, "").toLowerCase();
  const raw = await transformImage(pathFor(blob.key), {
    width,
    height,
    format,
    inputFormat: inputFormat === "jpg" ? "jpeg" : inputFormat,
  });
  const metadata = await imageMetadata(raw);
  return stagedFiles(() =>
    transaction(() => {
      const winner = get(
        "SELECT id FROM active_storage_variant_records WHERE blob_id=? AND variation_digest=?",
        blob.id,
        digest,
      );
      if (winner) {
        const result = get(
          "SELECT b.* FROM active_storage_attachments a JOIN active_storage_blobs b ON b.id=a.blob_id WHERE a.record_type='ActiveStorage::VariantRecord' AND a.record_id=?",
          winner.id,
        );
        if (result && fs.existsSync(pathFor(result.key))) return result;
      }
      const id =
        winner?.id ||
        Number(
          run(
            "INSERT INTO active_storage_variant_records(blob_id,variation_digest) VALUES(?,?)",
            blob.id,
            digest,
          ).lastInsertRowid,
        );
      const output = storeUpload(
        {
          buffer: raw,
          originalname: `${path.parse(blob.filename).name}.${format}`,
          mimetype: `image/${format}`,
        },
        "ActiveStorage::VariantRecord",
        id,
        "image",
      );
      run(
        "UPDATE active_storage_blobs SET metadata=? WHERE id=?",
        JSON.stringify({
          identified: true,
          analyzed: true,
          width: metadata.width,
          height: metadata.height,
        }),
        output.id,
      );
      return output;
    }),
  );
}
export async function analyze(blob: Row): Promise<Record<string, unknown>> {
  let metadata: Record<string, unknown> = {
    ...JSON.parse(blob.metadata || "{}"),
    identified: true,
    analyzed: true,
  };
  if (
    /^image\/(png|jpeg|gif|tiff|webp|avif|heic|heif)$/.test(
      blob.content_type || "",
    )
  ) {
    const image = await imageMetadata(pathFor(blob.key));
    metadata = { ...metadata, width: image.width, height: image.height };
  } else if (/^(audio|video)\//.test(blob.content_type || "")) {
    const { stdout } = await execute(
      "ffprobe",
      [
        "-v",
        "quiet",
        "-show_format",
        "-show_streams",
        "-of",
        "json",
        pathFor(blob.key),
      ],
      { timeout: 30000, maxBuffer: 1024 * 1024 },
    );
    const probe = JSON.parse(stdout) as {
      format?: { duration?: string | number };
      streams?: Array<{ codec_type?: string; width?: number; height?: number }>;
    };
    metadata.duration = Number(probe.format?.duration || 0);
    const v = probe.streams?.find((s) => s.codec_type === "video");
    if (v)
      Object.assign(metadata, { width: v.width, height: v.height, angle: 0 });
  }
  run(
    "UPDATE active_storage_blobs SET metadata=? WHERE id=?",
    JSON.stringify(metadata),
    blob.id,
  );
  return metadata;
}
export async function preview(blob: Row): Promise<Row | null> {
  const existing = get(
    "SELECT b.* FROM active_storage_attachments a JOIN active_storage_blobs b ON b.id=a.blob_id WHERE a.record_type='ActiveStorage::Blob' AND a.record_id=? AND a.name='preview_image'",
    blob.id,
  );
  if (existing && fs.existsSync(pathFor(existing.key))) return existing;
  const root = path.join(
    process.env.CAMPFIRE_STORAGE_PATH || process.env.STORAGE_PATH || "storage",
    "tmp",
  );
  fs.mkdirSync(root, { recursive: true });
  const temp = fs.mkdtempSync(path.join(root, "preview-"));
  try {
    const out = path.join(temp, "preview.webp");
    if ((blob.content_type || "").startsWith("video/"))
      await execute(
        "ffmpeg",
        [
          "-nostdin",
          "-loglevel",
          "error",
          "-i",
          pathFor(blob.key),
          "-y",
          "-vframes",
          "1",
          "-vf",
          "thumbnail,scale=1200:800:force_original_aspect_ratio=decrease",
          out,
        ],
        { timeout: 60000, maxBuffer: 1024 * 1024 },
      );
    else if (blob.content_type === "application/pdf") {
      await execute(
        "pdftoppm",
        [
          "-f",
          "1",
          "-singlefile",
          "-png",
          "-scale-to",
          "1200",
          pathFor(blob.key),
          path.join(temp, "preview"),
        ],
        { timeout: 60000, maxBuffer: 1024 * 1024 },
      );
      const webp = await Bun.file(path.join(temp, "preview.png"))
        .image()
        .webp()
        .buffer();
      await Bun.write(out, webp);
    } else return null;
    return storeUpload(
      {
        buffer: fs.readFileSync(out),
        originalname: `${path.parse(blob.filename).name}.webp`,
        mimetype: "image/webp",
      },
      "ActiveStorage::Blob",
      blob.id,
      "preview_image",
    );
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
}
export async function processAttachment(blob: Row): Promise<Row | null | undefined> {
  await analyze(blob);
  if (
    /^image\/(png|jpeg|gif|tiff|webp|avif|heic|heif)$/.test(
      blob.content_type || "",
    )
  )
    return variant(blob);
  if (
    blob.content_type === "application/pdf" ||
    blob.content_type?.startsWith("video/")
  )
    return preview(blob);
}

// Elysia route registration. `add` bridges CompatReq/CompatRes handlers
// into the Elysia app (defined in app.ts).
export function registerStorage(
  add: (method: string, path: string, handler: (req: CompatReq, res: CompatRes) => any) => void,
  rawBody: (path: string) => void,
) {
  add("POST", "/rails/active_storage/direct_uploads", (req, res) => {
    if (!req.user) return res.sendStatus(401);
    try {
      const data = req.body.blob;
      if (
        !data ||
        !Number.isSafeInteger(data.byte_size) ||
        data.byte_size < 0 ||
        data.byte_size > 50 * 1024 * 1024 ||
        !/^.{1,255}$/.test(data.filename) ||
        !/^[A-Za-z0-9+/]{22}==$/.test(data.checksum)
      )
        return res.sendStatus(422);
      const key = crypto.randomBytes(14).toString("hex"),
        type = data.content_type || "application/octet-stream";
      const id = Number(
        run(
          "INSERT INTO active_storage_blobs(key,filename,content_type,byte_size,checksum,metadata,service_name,created_at) VALUES(?,?,?,?,?,?,?,?)",
          key,
          path.basename(data.filename),
          type,
          data.byte_size,
          data.checksum,
          JSON.stringify({
            ...data.metadata,
            campfire_upload_user_id: req.user.id,
          }),
          "local",
          now(),
        ).lastInsertRowid,
      );
      const token = rails.sign(
        {
          key,
          content_type: type,
          content_length: data.byte_size,
          checksum: data.checksum,
        },
        "ActiveStorage",
        "blob_token",
        new Date(Date.now() + 300000),
      );
      res.json({
        id,
        key,
        filename: path.basename(data.filename),
        content_type: type,
        byte_size: data.byte_size,
        checksum: data.checksum,
        signed_id: rails.signedId("ActiveStorage::Blob", id, "blob_id"),
        attachable_sgid: rails.sgid("ActiveStorage::Blob", id),
        direct_upload: {
          url: `${req.protocol}://${req.get("host")}/rails/active_storage/disk/${token}`,
          headers: { "Content-Type": type },
        },
      });
    } catch {
      res.sendStatus(422);
    }
  });
  rawBody("/rails/active_storage/disk/:token");
  add("PUT", "/rails/active_storage/disk/:token", (req, res) => {
    try {
      const data = rails.verify(req.params.token, "ActiveStorage", "blob_token") as {
        key: string;
        content_length: number;
        checksum: string;
      };
      const raw: Buffer = req.body as any;
      if (
        !Buffer.isBuffer(raw) ||
        raw.length !== data.content_length ||
        checksum(raw) !== data.checksum
      )
        return res.sendStatus(422);
      write(data.key, raw);
      res.status(204).end();
    } catch {
      res.sendStatus(404);
    }
  });
  add("GET", "/rails/active_storage/disk/:token/:filename", (req, res) => {
    try {
      const data = rails.verify(req.params.token, "ActiveStorage", "blob_key") as {
        key: string;
        content_type?: string;
        disposition?: string;
        filename?: string;
      };
      const [type] = servingAttributes(data.content_type || "", data.disposition);
      const disposition = servingAttributes(data.content_type || "", data.disposition)[1];
      serve(
        req, res, pathFor(data.key),
        type,
        data.filename || "file",
        disposition,
      );
    } catch {
      res.sendStatus(404);
    }
  });
  for (const kind of ["redirect", "proxy"])
    add("GET", `/rails/active_storage/blobs/${kind}/:token/:filename`, (req, res) => {
      if (!req.user) return res.sendStatus(401);
      try {
        const blob = get(
          "SELECT * FROM active_storage_blobs WHERE id=?",
          rails.verifyId("ActiveStorage::Blob", req.params.token, "blob_id"),
        );
        if (!blob) return res.sendStatus(404);
        if (!authorizedBlob(blob, req.user)) return res.sendStatus(403);
        const [type, disposition] = servingAttributes(blob.content_type, req.query.disposition as string | undefined);
        serve(req, res, pathFor(blob.key), type, blob.filename, disposition);
      } catch {
        res.sendStatus(404);
      }
    });
  for (const kind of ["redirect", "proxy"])
    add("GET", `/rails/active_storage/representations/${kind}/:token/:variation/:filename`, async (req, res) => {
      if (!req.user) return res.sendStatus(401);
      try {
        const blob = get(
          "SELECT * FROM active_storage_blobs WHERE id=?",
          rails.verifyId("ActiveStorage::Blob", req.params.token, "blob_id"),
        );
        if (!blob) return res.sendStatus(404);
        if (!authorizedBlob(blob, req.user)) return res.sendStatus(403);
        const transforms = rails.verify(req.params.variation, "ActiveStorage", "variation") as
          | { resize_to_limit?: number[]; format?: string }
          | undefined;
        if (!transforms || Object.keys(transforms).some((k) => !["format", "resize_to_limit"].includes(k)))
          return res.sendStatus(404);
        const source =
          blob.content_type === "application/pdf" || blob.content_type?.startsWith("video/")
            ? await preview(blob)
            : blob;
        const out = await variant(source as Row, transforms.resize_to_limit || [1200, 800], transforms.format);
        serve(req, res, pathFor(out.key), out.content_type, out.filename);
      } catch {
        res.sendStatus(404);
      }
    });
}
