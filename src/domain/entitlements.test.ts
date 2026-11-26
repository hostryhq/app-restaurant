import { describe, expect, it } from "vitest";
import { packFromJson } from "../data/auth/pack";
import { demoPack, DEMO_ENTITLEMENTS } from "../fixtures/demo-pack";
import { adoptEntitlements, dayInProgress, featureOn, FEATURE, parseEntitlements, tradingStanding, type EntitlementSnapshot } from "./entitlements";
import { rows, world } from "../test/world";
import * as T from "../data/trading";

const snap = (o: Partial<EntitlementSnapshot> = {}): EntitlementSnapshot => ({ ...DEMO_ENTITLEMENTS, ...o });
// 2026-11-25 10:00 IST
const NOW = Date.parse("2026-11-25T04:30:00Z");

describe("optional features follow the snapshot, offline", () => {
  it("offers only the granted keys; no snapshot offers none; a malformed claim is no snapshot", () => {
    const s = snap({ features: ["restaurant.core"] });
    expect(featureOn(s, FEATURE.kds)).toBe(false);
    expect(featureOn(snap(), FEATURE.kds)).toBe(true);
    expect(featureOn(undefined, FEATURE.kds)).toBe(false);
    expect(parseEntitlements({ entitlements_v: 0, features: [], limits: {}, organisation_status: "active", as_of: "x" })).toBeUndefined();
    expect(parseEntitlements({ ...DEMO_ENTITLEMENTS, organisation_status: "overdue" })).toBeUndefined();
  });

  it("an expired snapshot (valid_until passed) removes no feature", () => {
    expect(featureOn(snap({ valid_until: "2020-01-01T00:00:00Z" }), FEATURE.kds)).toBe(true);
  });

  it("the pack carries the claim; a pack with a bad claim still loads", () => {
    const { pack } = demoPack();
    expect(packFromJson(JSON.parse(JSON.stringify(pack))).entitlements?.entitlements_v).toBe(1);
    const bad = packFromJson({ ...JSON.parse(JSON.stringify(pack)), entitlements: { entitlements_v: "x" } });
    expect(bad.entitlements).toBeUndefined();
  });
});

describe("a newer snapshot is adopted only when its version rises", () => {
  it("keeps the highest version seen", () => {
    const v3 = snap({ entitlements_v: 3, features: ["restaurant.core"] });
    expect(adoptEntitlements(snap(), v3)).toBe(v3);
    expect(adoptEntitlements(v3, snap({ entitlements_v: 2 }))).toBe(v3);
    expect(adoptEntitlements(v3, snap({ entitlements_v: 3 }))).toBe(v3);
    expect(adoptEntitlements(v3, undefined)).toBe(v3);
    expect(adoptEntitlements(undefined, v3)).toBe(v3);
  });

  it("the runtime adopts a refreshed pack, notifies, and ignores an older or absent one", async () => {
    const w = await world();
    let n = 0;
    w.rt.onEntitlements(() => n++);
    expect(w.rt.adoptPack({ entitlements: snap({ entitlements_v: 2, features: ["restaurant.core"] }) })).toBe(true);
    expect(featureOn(w.rt.entitlements(), FEATURE.kds)).toBe(false);
    expect(w.rt.adoptPack({ entitlements: snap({ entitlements_v: 1 }) })).toBe(false);
    expect(w.rt.adoptPack({})).toBe(false);
    expect(n).toBe(1);
  });
});

describe("suspension and closure apply only after the trading day ends (ADR-0014 A1.2)", () => {
  it("day in progress: open with a business date of today or yesterday in IST", () => {
    expect(dayInProgress(["2026-11-25"], NOW)).toBe(true);
    expect(dayInProgress(["2026-11-24"], NOW)).toBe(true);
    expect(dayInProgress(["2026-11-23"], NOW)).toBe(false);
    expect(dayInProgress([], NOW)).toBe(false);
    // 00:30 IST on the 26th is 19:00 UTC on the 25th; the 25th is still in progress
    expect(dayInProgress(["2026-11-25"], Date.parse("2026-11-25T19:00:00Z"))).toBe(true);
  });

  it("suspended or closed with a day open: trading goes on and says it is the last day", () => {
    for (const status of ["suspended", "closed"] as const) {
      expect(tradingStanding(snap({ organisation_status: status }), ["2026-11-25"], NOW)).toMatchObject({ startNew: true, ending: true, status });
    }
  });

  it("suspended or closed once the day has ended: no new trading", () => {
    for (const status of ["suspended", "closed"] as const) {
      expect(tradingStanding(snap({ organisation_status: status }), [], NOW)).toMatchObject({ startNew: false, status });
      expect(tradingStanding(snap({ organisation_status: status }), ["2026-11-20"], NOW).startNew).toBe(false); // a stale open day protects nothing
    }
  });

  it("trial, active and an absent snapshot never limit trading, whatever else the snapshot says", () => {
    expect(tradingStanding(undefined, [], NOW).startNew).toBe(true);
    expect(tradingStanding(snap({ organisation_status: "trial", valid_until: "2020-01-01T00:00:00Z", features: [] }), [], NOW).startNew).toBe(true);
    expect(tradingStanding(snap(), [], NOW)).toMatchObject({ startNew: true, ending: false });
  });
});

describe("a device with no snapshot keeps trading (ADR-0014 T10)", () => {
  it("opens a shift with no entitlements at all", async () => {
    const w = await world({ entitlements: null });
    expect(w.rt.entitlements()).toBeUndefined();
    await w.signIn("Asha");
    await T.startShift(w.rt.ctx, 200_000);
    expect(rows(w.rt, "shift").length).toBeGreaterThan(0);
  });
});
