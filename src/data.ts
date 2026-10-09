import fs from "node:fs";
import path from "node:path";

// Runtime data files the bundler cannot embed by default: nunjucks
// templates, the compiled asset manifest, translations, the Rails
// reference tree. Resolution order:
//   1. CAMPFIRE_DATA_DIR or cwd (deploy directory beside a compiled binary)
//   2. files embedded with `bun build --compile --asset` (live under
//      import.meta.dir as $bunfs paths, readable via node:fs)
//   3. the source tree (dev/tests)
// Interpreted mode resolves them next to the source; a `bun build
// --compile` binary either ships them beside it (cwd pointing at that
// directory) or embeds them. CAMPFIRE_DATA_DIR overrides everything.
function dataRoot(): string {
  return process.env.CAMPFIRE_DATA_DIR || process.cwd();
}

// `bun build --compile --asset <dir>` strips the asset root: each given
// directory becomes its own embedded root (verified PERF-21: 547 files,
// e.g. `./assets/generated/x` embeds as `generated/x`, and
// `./src/translations.json` as `translations.json`). Repo-relative paths
// are unachievable, so map them here. Keep in sync with the --asset list
// in the Dockerfile/build command. Prefixes must stay collision-free
// across roots (checked: `assets/` vs `generated/public/assets/` differ).
const EMBED_MAP: Array<{ prefix: string[]; replace: string[] }> = [
  { prefix: ["assets", "generated"], replace: ["generated"] },
  { prefix: ["src", "translations.json"], replace: ["translations.json"] },
  { prefix: ["src", "schema.sql"], replace: ["schema.sql"] },
  { prefix: ["reference", "app", "assets"], replace: ["assets"] },
  { prefix: ["reference", "app", "views", "users"], replace: ["users"] },
  { prefix: ["reference", "app", "views", "pwa"], replace: ["pwa"] },
  // ("templates", ...) embeds identically, no entry needed.
];

function embeddedPath(segments: string[]): string | null {
  try {
    let mapped = segments;
    for (const m of EMBED_MAP) {
      if (
        m.prefix.length <= segments.length &&
        m.prefix.every((s, i) => segments[i] === s)
      ) {
        mapped = [...m.replace, ...segments.slice(m.prefix.length)];
        break;
      }
    }
    const p = path.join(import.meta.dir, ...mapped);
    return fs.existsSync(p) ? p : null;
  } catch {
    return null;
  }
}

// Resolve a data file: the deploy directory first, then embedded assets
// (compiled binary), then the source tree, so tests and dev servers
// launched from any cwd keep working.
export function dataPath(...segments: string[]): string {
  // Normalize: callers may pass joined ("a/b/c") or split ("a", "b", "c")
  // segments; the embed map below matches per part.
  const parts = segments.flatMap((s) => s.split("/")).filter((s) => s.length > 0);
  const local = path.join(dataRoot(), ...parts);
  if (fs.existsSync(local)) return local;
  // $bunfs probing is cheap (existsSync) and a no-op miss in
  // interpreted mode (src/ holds no data dirs).
  const embedded = embeddedPath(parts);
  if (embedded) return embedded;
  const src = new URL(`../${parts.join("/")}`, import.meta.url).pathname;
  return fs.existsSync(src) ? src : local;
}
