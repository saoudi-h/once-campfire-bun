// Image transforms. Bun.Image (native, statically linked JPEG/PNG) handles
// the hot thumbnail path and runs the resize off the JS thread. Sharp loads
// lazily and stays the fallback for formats Bun.Image can't encode/decode on
// Linux (WebP output here, TIFF, AVIF, HEIC/HEIF decode, GIF output). Loading
// sharp only when needed also lets `bun build --compile` produce a binary that
// boots without libvips on the JPEG/PNG path. The variant cache key is
// unchanged, so stored thumbnails stay valid; only the bytes for a fresh
// transform differ, and both are valid re-encodes of the same source.

type VariantFormat = "png" | "jpeg" | "webp" | "gif" | "tiff" | "avif";
type Sharp = ReturnType<typeof import("sharp").default>;

let sharpModule: typeof import("sharp").default | null = null;
async function sharp(): Promise<typeof import("sharp").default> {
  sharpModule ??= (await import("sharp")).default;
  return sharpModule;
}

// Bun.Image's WebP encoder is slower than libwebp via sharp (~3x on our
// fixture), so WebP stays on sharp. JPEG/PNG encode faster natively.
const BUN_OUT = new Set(["jpeg", "png"]);
// Formats Bun.Image decodes on every platform.
const BUN_IN = new Set(["jpeg", "png", "webp", "gif", "bmp"]);

type BunOutFormat = "jpeg" | "png";

function bunEncode(format: string): BunOutFormat | null {
  return BUN_OUT.has(format) ? (format as BunOutFormat) : null;
}

export interface TransformOptions {
  width: number;
  height: number;
  format: string;
  sharpen?: boolean;
}

// Resize (fit inside, never enlarge) + re-encode. Accepts a file path or
// raw bytes as input. Prefers Bun.Image; falls back to sharp per format.
export async function transformImage(
  input: string | Uint8Array,
  opts: TransformOptions,
): Promise<Buffer> {
  const format = opts.format;
  const bunFormat = bunEncode(format);
  if (bunFormat) {
    try {
      // autoOrient applies JPEG EXIF orientation (sharp's .rotate() equivalent);
      // .rotate() here takes explicit degrees and would spin the image.
      const img =
        (typeof input === "string"
          ? Bun.file(input).image()
          : new Bun.Image(input, { autoOrient: true })
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
      // A Bun.Image decode gap (e.g. damaged input) falls through to sharp.
      if ((error as { code?: string })?.code !== "ERR_IMAGE_DECODE_FAILED")
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
