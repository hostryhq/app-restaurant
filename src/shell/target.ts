import type { DevicePack } from "../data/auth/pack";

/**
 * What this bundle is (ADR-0002 A3.3). The browser build is a dev/test target: its store is unencrypted IndexedDB, it has no keystore,
 * no PIN prover and cannot reach a hub over TLS 1.3. It therefore declares itself, always claims `store: unprotected`, and refuses
 * a live pack. The native shell's bundle is built with HOSTRY_TARGET=native. `scripts/release-lint.mjs` checks the built output
 * against this declaration, so a release build that would accept live packs fails CI.
 */
export type BuildTarget = "browser" | "native";

export const BUILD_TARGET: BuildTarget = __HOSTRY_TARGET__;

/** Present in the bundle of every browser build; the release lint looks for it (and for its absence in a native build). */
export const BROWSER_REFUSAL_MARKER = "hostry:browser-build-refuses-live-packs";

export class LivePackRefused extends Error {
  readonly code = "live_pack_refused";
  constructor(detail: string) {
    super(`${BROWSER_REFUSAL_MARKER}: ${detail}`);
    this.name = "LivePackRefused";
  }
}

/**
 * The runtime check: a browser build accepts a pack only when it says `store: unprotected`, which identity issues only in
 * HOSTRY_ENV dev, test and ci (A3.5 item 1). A `protected` pack is a live pack meant for the native shell's encrypted store.
 */
export function assertPackAllowed(pack: Pick<DevicePack, "store">, target: BuildTarget = BUILD_TARGET): void {
  if (target === "browser" && pack.store !== "unprotected") throw new LivePackRefused("a browser build holds only dev, test or ci packs (store unprotected); a live pack needs the native shell");
}
