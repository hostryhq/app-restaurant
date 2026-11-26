// Release lint (ADR-0002 A3.3): fails a browser build that would accept a pack whose `issuer_env` is not `dev`, a browser build marked as a
// release, or a native build that bundles browser-only pieces. (A native release build enforces `issuer_env: live` at runtime, src/shell/target.ts.)
// Usage: node scripts/release-lint.mjs   (after `vite build`; `pnpm build` runs it)
//
// The build declares itself in dist/hostry-build.json ({ target, release }), written by vite.config.ts.
//  - browser build: must carry the refusal marker (its runtime check, src/shell/target.ts) and must not be a release artifact.
//  - native build: must not bundle the browser shell's pack storage or the IndexedDB store.
//  - anything else (no manifest, unknown target): fails, because nothing says what the build accepts.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export const REFUSAL_MARKER = "hostry:browser-build-accepts-only-dev-issuer";
/** String literals of code that exists only in the browser build (shell pack storage key, IndexedDB database name). */
export const BROWSER_ONLY_MARKERS = ["hostry.pack", "hostry-restaurant-"];

/** @returns {string[]} the problems found; empty means the build passes. */
export function lintRelease({ manifest, js }) {
  const problems = [];
  if (!manifest || (manifest.target !== "browser" && manifest.target !== "native")) {
    return ["the build does not declare its target (dist/hostry-build.json): it cannot be shown to check the pack's issuer_env"];
  }
  if (manifest.target === "browser") {
    if (manifest.release) problems.push("a browser build is not a release artifact: it holds an unencrypted store and accepts only dev-issued packs (ADR-0002 A3.3)");
    if (!js.includes(REFUSAL_MARKER)) problems.push("the browser build does not carry its issuer_env check: it would accept packs from a test, ci or live identity");
  } else {
    for (const m of BROWSER_ONLY_MARKERS) {
      if (js.includes(m)) problems.push(`a native build bundles browser-only code (${m}): the browser shell or the IndexedDB store`);
    }
  }
  return problems;
}

function readBuild(dir) {
  const manifestPath = join(dir, "hostry-build.json");
  const manifest = existsSync(manifestPath) ? JSON.parse(readFileSync(manifestPath, "utf8")) : undefined;
  const assets = join(dir, "assets");
  const js = existsSync(assets)
    ? readdirSync(assets)
        .filter((f) => f.endsWith(".js"))
        .map((f) => readFileSync(join(assets, f), "utf8"))
        .join("\n")
    : "";
  return { manifest, js };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const problems = lintRelease(readBuild(process.argv[2] ?? "dist"));
  if (problems.length) {
    for (const p of problems) console.error(`release lint: ${p}`);
    process.exit(1);
  }
  console.log("release lint: ok");
}
