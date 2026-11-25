import { describe, expect, it } from "vitest";
// @ts-expect-error plain ES module script, no types
import { BROWSER_ONLY_MARKERS, REFUSAL_MARKER, lintRelease } from "../../scripts/release-lint.mjs";
import { BROWSER_REFUSAL_MARKER, LivePackRefused, assertPackAllowed } from "./target";
import { createRuntime } from "../runtime";
import { demoPack } from "../fixtures/demo-pack";

describe("browser build refuses live packs (ADR-0002 A3.3)", () => {
  it("a browser build holds only an unprotected pack; the native bundle takes a protected one", () => {
    expect(() => assertPackAllowed({ store: "unprotected" }, "browser")).not.toThrow();
    expect(() => assertPackAllowed({ store: "protected" }, "browser")).toThrow(LivePackRefused);
    expect(() => assertPackAllowed({ store: "protected" }, "native")).not.toThrow();
  });

  it("the runtime refuses a protected pack in a browser build and runs it in a native one", async () => {
    const { pack, prover } = demoPack({ storeClaim: "protected" });
    await expect(createRuntime({ pack, prover, target: "browser" })).rejects.toBeInstanceOf(LivePackRefused);
    const rt = await createRuntime({ pack, prover, target: "native" });
    expect(rt.engine.storeClaim).toBe("protected");
  });

  it("the lint's marker is the one the runtime throws with", () => {
    expect(REFUSAL_MARKER).toBe(BROWSER_REFUSAL_MARKER);
  });
});

describe("release lint", () => {
  const ok = `/* bundle */ "${REFUSAL_MARKER}"`;
  it("passes a browser dev build that carries its refusal, and fails one that would accept live packs", () => {
    expect(lintRelease({ manifest: { target: "browser", release: false }, js: ok })).toEqual([]);
    expect(lintRelease({ manifest: { target: "browser", release: false }, js: "no refusal here" })).toHaveLength(1);
  });
  it("a browser build is never a release artifact", () => {
    expect(lintRelease({ manifest: { target: "browser", release: true }, js: ok })).toHaveLength(1);
  });
  it("a native build must not bundle the browser shell or IndexedDB store", () => {
    expect(lintRelease({ manifest: { target: "native", release: true }, js: "clean" })).toEqual([]);
    for (const m of BROWSER_ONLY_MARKERS) expect(lintRelease({ manifest: { target: "native", release: true }, js: `x "${m}" y` })).toHaveLength(1);
  });
  it("a build that does not declare itself fails", () => {
    expect(lintRelease({ manifest: undefined, js: ok })).toHaveLength(1);
    expect(lintRelease({ manifest: { target: "web" }, js: ok })).toHaveLength(1);
  });
});
