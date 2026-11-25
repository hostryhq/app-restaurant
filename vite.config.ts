import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";
import solid from "@solidjs/vite-plugin";

const core = (p: string): string => fileURLToPath(new URL(`../client-core/src/${p}`, import.meta.url));

export default defineConfig({
  plugins: [solid()],
  build: { target: "es2022", modulePreload: { polyfill: false } },
  test: {
    environment: "jsdom",
    include: ["src/**/*.test.{ts,tsx}"],
    setupFiles: ["src/test-setup.ts"],
    testTimeout: 20_000,
    // Tests run against client-core's sources so they can use its sync simulator (src/sync/testkit), which the published
    // build leaves out. The app build itself uses the built package.
    alias: [
      { find: /^@hostry\/client-core\/testkit\/(.*)$/, replacement: core("sync/testkit/$1.ts") },
      { find: /^@hostry\/client-core$/, replacement: core("index.ts") },
    ],
  },
});
