// Build the self-contained production binary (PERF-21).
// Uses the Bun.build API because CLI `--asset` silently drops directory
// assets after the first (canary bug, verified 2026-10-09), and embeds
// every runtime data dir so the binary needs no source tree beside it.
// Data layout is resolved by src/data.ts (EMBED_MAP — keep in sync).
// Usage: bun bin/build-binary.js [outfile]
// BYTECODE=1 adds --bytecode (server.ts boot is wrapped in
// main() so the entry has no top-level await). Measured zero
// on this canary (boot 108->107ms, rps/RSS identical,
// +5.4MB binary): opt-in only.
// Not adopted for production (PERF-21): sharp's native binding fails to
// load inside the binary and `--external sharp` can't resolve outside
// $bunfs, so every sharp path (PNG/WebP/GIF/TIFF/AVIF variants) 500s.
// The binary is fully working for the JPEG path and perf-neutral;
// re-run the webp-variant probe before any adoption.
const outfile = process.argv[2] || "/tmp/opencode/campfire-A";
// BYTECODE=1 adds --bytecode (needs no top-level await in the entry;
// blocked on canaries where the bytecode transform rejects it).
const bytecode = process.env.BYTECODE === "1";

const result = await Bun.build({
  entrypoints: ["./src/server.ts"],
  compile: {
    target: "bun-linux-x64",
    outfile,
    assets: [
      "./templates",
      "./assets/generated",
      "./src/translations.json",
      "./src/schema.sql",
      "./reference/app/assets",
      "./reference/app/views/users",
      "./reference/app/views/pwa",
    ],
  },
  minify: true,
  bytecode,
  define: {
    "process.env.NODE_ENV": JSON.stringify("production"),
  },
});

if (!result.success) {
  for (const log of result.logs) console.error(String(log));
  process.exit(1);
}
console.log("built", outfile);
