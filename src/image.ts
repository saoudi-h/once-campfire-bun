// Image transforms. Bun.Image (native, statically linked JPEG) handles the
// hot thumbnail path and runs the resize off the JS thread. Sharp loads
// lazily and stays the fallback for everything Bun is slower at or can't
// do on Linux (measured PERF-21, 1200x800 fit unless noted):
//   - PNG output: Bun 128ms vs sharp 36ms (~3.5x); 400x300: 18.6 vs 9.2ms
//   - WebP input decode: Bun 19.7ms vs sharp 5.3ms (~3.7x, jpeg output)
//   - TIFF/AVIF/HEIC input: Bun can't decode on Linux at all
//   - GIF/TIFF/AVIF output: Bun has no encoder; WebP output stays on sharp
//     (PERF-18: Bun's WebP encoder ~3x slower than libwebp)
// Loading sharp only when needed also lets `bun build --compile` produce a
// binary that boots without libvips on the JPEG path. The variant cache key
// is unchanged, so stored thumbnails stay valid; only the bytes for a fresh
// transform differ, and both are valid re-encodes of the same source.

type VariantFormat = "png" | "jpeg" | "webp" | "gif" | "tiff" | "avif";
type Sharp = ReturnType<typeof import("sharp").default>;

let sharpModule: typeof import("sharp").default | null = null;
async function sharp(): Promise<typeof import("sharp").default> {
  sharpModule ??= (await import("sharp")).default;
  return sharpModule;
}

// Bun.Image's WebP encoder is slower than libwebp via sharp (~3x on our
// fixture), its PNG encoder ~2-3.5x slower, and its WebP decoder ~3.7x
// slower — so only JPEG output stays native. JPEG/PNG/GIF/BMP decode fast
// natively; TIFF/AVIF/HEIC have no Linux decoder at all.
const BUN_OUT = new Set(["jpeg"]);
// Inputs routed straight to sharp: slow-or-impossible decodes on Linux.
// (Everything else tries Bun first for JPEG output, with fallback below.)
const SHARP_IN = new Set(["webp", "tiff", "tif", "avif", "heic", "heif"]);
// Formats Bun.Image decodes on every platform.
const BUN_IN = new Set(["jpeg", "png", "webp", "gif", "bmp"]);

// Pixel cap matching sharp's limitInputPixels below: Bun's default
// (268M) is looser, so pin it for identical oversized-input behavior.
const MAX_PIXELS = 100_000_000;

type BunOutFormat = "jpeg" | "png";

function bunEncode(format: string): BunOutFormat | null {
  return BUN_OUT.has(format) ? (format as BunOutFormat) : null;
}

export interface TransformOptions {
  width: number;
  height: number;
  format: string;
  sharpen?: boolean;
  // Lowercase input format hint ("jpeg", "webp", "tiff", ...) when the
  // caller knows it (e.g. blob content-type). Lets slow-or-impossible
  // Bun decodes skip straight to sharp without paying a failed attempt.
  // Unknown/missing falls back to try-Bun-then-sharp.
  inputFormat?: string;
}

// Resize (fit inside, never enlarge) + re-encode. Accepts a file path or
// raw bytes as input. Prefers Bun.Image for the hot JPEG path; everything
// else goes to sharp (see engine notes above).
export async function transformImage(
  input: string | Uint8Array,
  opts: TransformOptions,
): Promise<Buffer> {
  const format = opts.format;
  const bunFormat = bunEncode(format);
  const inFmt = (opts.inputFormat || "").toLowerCase();
  if (bunFormat && !SHARP_IN.has(inFmt)) {
    try {
      // autoOrient applies JPEG EXIF orientation (sharp's .rotate() equivalent);
      // .rotate() here takes explicit degrees and would spin the image.
      const img =
        (typeof input === "string"
          ? Bun.file(input).image({ autoOrient: true, maxPixels: MAX_PIXELS })
          : new Bun.Image(input, { autoOrient: true, maxPixels: MAX_PIXELS })
        ).resize(opts.width, opts.height, {
          fit: "inside",
          withoutEnlargement: true,
        });
      const encoded =
        bunFormat === "jpeg"
          ? await img.jpeg().buffer()
          : await img.png().buffer();
      return Buffer.from(encoded);
    } catch (error) {
      // A Bun.Image decode/format gap (damaged input, TIFF/AVIF/HEIC on
      // Linux, unknown sniff) falls through to sharp. Anything else is a
      // real failure and propagates.
      const code = (error as { code?: string })?.code;
      if (
        code !== "ERR_IMAGE_DECODE_FAILED" &&
        code !== "ERR_IMAGE_FORMAT_UNSUPPORTED" &&
        code !== "ERR_IMAGE_UNKNOWN_FORMAT"
      )
        throw error;
    }
  }
  const lib = await sharp();
  let pipeline: Sharp = lib(input, { limitInputPixels: 100_000_000 })
    .rotate()
    .resize(opts.width, opts.height, {
      fit: "inside",
      withoutEnlargement: true,
    });
  if (opts.sharpen) pipeline = pipeline.sharpen();
  pipeline = pipeline.toFormat(format as VariantFormat);
  return pipeline.toBuffer();
}

export interface ImageInfo {
  width?: number;
  height?: number;
  format?: string;
}

// Header-only metadata (no decode). Prefers Bun.Image, falls back to sharp
// for formats Bun.Image can't decode on this platform.
export async function imageMetadata(
  input: string | Uint8Array,
): Promise<ImageInfo> {
  try {
    const src =
      typeof input === "string" ? Bun.file(input).image() : new Bun.Image(input);
    const md = await src.metadata();
    if (md.format && BUN_IN.has(md.format)) return md as ImageInfo;
  } catch {
    // fall through to sharp
  }
  const lib = await sharp();
  return (await lib(input).metadata()) as ImageInfo;
}
