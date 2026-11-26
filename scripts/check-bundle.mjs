// Bundle budget check (client-app-standard): initial JS per app <= 250 KB gzipped unless an ADR raises it.
// Usage: node scripts/check-bundle.mjs   (after `pnpm build`)
import { readdirSync, readFileSync } from "node:fs";
import { gzipSync } from "node:zlib";
import { join } from "node:path";

const BUDGET_KB = 250;
const dir = "dist/assets";
const files = readdirSync(dir).filter((f) => f.endsWith(".js"));
let total = 0;
for (const f of files) {
  const kb = gzipSync(readFileSync(join(dir, f))).length / 1024;
  total += kb;
  console.log(`${f}: ${kb.toFixed(1)} KB gzip`);
}
console.log(`initial JS total: ${total.toFixed(1)} KB gzip (budget ${BUDGET_KB} KB)`);
if (total > BUDGET_KB) {
  console.error("bundle over budget");
  process.exit(1);
}
