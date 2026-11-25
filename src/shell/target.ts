import type { DevicePack } from "../data/auth/pack";

/**
 * What this bundle is (ADR-0002 A3.3). The browser build is a dev/test target: its store is unencrypted IndexedDB, it has no keystore,
 * no PIN prover and cannot reach a hub over TLS 1.3. It therefore declares itself and refuses every pack whose signed `issuer_env`
 * is not `dev`. The native shell's bundle is built with HOSTRY_TARGET=native; a native release build (HOSTRY_RELEASE=1) refuses every
 * pack whose `issuer_env` is not `live`. `scripts/release-lint.mjs` checks the built output against this declaration, so a release
 * build that would accept a dev pack fails CI.
 */
export type BuildTarget = "browser" | "native";

export const BUILD_TARGET: BuildTarget = __HOSTRY_TARGET__;

/** Present in the bundle of every browser build; the release lint looks for it. */
export const BROWSER_REFUSAL_MARKER = "hostry:browser-build-accepts-only-dev-issuer";

export class LivePackRefused extends Error {
  readonly code = "live_pack_refused";
  constructor(detail: string) {
    super(`${BROWSER_REFUSAL_MARKER}: ${detail}`);
    this.name = "LivePackRefused";
  }
}

/**
 * The runtime check, on the signed `issuer_env` claim (it is signed with the pack, so a pack from a dev identity cannot pass for a live
 * one): a browser build accepts only `dev`; a native release build accepts only `live`; a native development build accepts any issuer.
 */
export function assertPackAllowed(pack: Pick<DevicePack, "issuerEnv">, target: BuildTarget = BUILD_TARGET, release: boolean = __HOSTRY_RELEASE__): void {
  if (target === "browser" && pack.issuerEnv !== "dev") throw new LivePackRefused(`a browser build holds only packs issued by a dev identity (issuer_env dev), not ${pack.issuerEnv}; a live pack needs the native shell`);
  if (target === "native" && release && pack.issuerEnv !== "live") throw new LivePackRefused(`a release build holds only live packs, not ${pack.issuerEnv}`);
}
