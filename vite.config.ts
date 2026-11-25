import { defineConfig } from "vitest/config";
import solid from "@solidjs/vite-plugin";

// The build declares what it is (ADR-0002 A3.3): the browser build is a dev/test target that accepts only packs from a dev issuer (`issuer_env`);
// HOSTRY_TARGET=native is for the native shell's bundle. HOSTRY_RELEASE=1 marks a build meant to ship.
const target = process.env.HOSTRY_TARGET === "native" ? "native" : "browser";
const release = process.env.HOSTRY_RELEASE === "1";

export default defineConfig({
  plugins: [
    solid(),
    {
      name: "hostry-build-manifest",
      generateBundle() {
        this.emitFile({ type: "asset", fileName: "hostry-build.json", source: JSON.stringify({ target, release }) + "\n" });
      },
    },
  ],
  define: { __HOSTRY_TARGET__: JSON.stringify(target), __HOSTRY_RELEASE__: JSON.stringify(release) },
  build: { target: "es2022", modulePreload: { polyfill: false } },
  test: {
    environment: "jsdom",
    include: ["src/**/*.test.{ts,tsx}"],
    setupFiles: ["src/test-setup.ts"],
    testTimeout: 20_000,
  },
});
