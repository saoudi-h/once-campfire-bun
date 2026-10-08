import fs from "node:fs";
import path from "node:path";

// Runtime data files the bundler cannot embed: nunjucks templates, the
// compiled asset manifest, translations, the Rails reference tree.
// Interpreted mode resolves them next to the source; a
// `bun build --compile` binary ships them beside it and starts with cwd
// pointing at that directory. CAMPFIRE_DATA_DIR overrides both.
function dataRoot(): string {
  return process.env.CAMPFIRE_DATA_DIR || process.cwd();
}

// Resolve a data file: the deploy directory first, then the source tree,
// so tests and dev servers launched from any cwd keep working.
export function dataPath(...segments: string[]): string {
  const local = path.join(dataRoot(), ...segments);
  if (fs.existsSync(local)) return local;
  const src = new URL(`../${segments.join("/")}`, import.meta.url).pathname;
  return fs.existsSync(src) ? src : local;
}
