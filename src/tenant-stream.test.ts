import { describe, expect, it } from "vitest";
import { Net, OUTLET_STREAM, TENANT_STREAM, rows } from "./test/world";

describe("F4b: tenant-level ops travel on the tenant stream", () => {
  it("the device opens the tenant stream and receives a tenant-stream op the cloud emits (never the outlet stream)", async () => {
    const net = await Net.create();
    const w = await net.add({ deviceKind: "pos", deviceCode: "A07" });
    expect(w.rt.engine.streams).toEqual(expect.arrayContaining([OUTLET_STREAM, TENANT_STREAM]));
    expect(TENANT_STREAM).toMatch(/^tenant:/);
    await net.cloud.emit(TENANT_STREAM, "tax.rule_set.publish", [
      { e: "tax_rule_set", id: "rs-t1", k: "insert", f: { version: 2, name: "Published", effective_date: "2026-11-01", calc_v: 1, review_status: "approved" } },
    ]);
    await net.links({ hub: true });
    await net.settle();
    expect(rows<{ id: string }>(w.rt, "tax_rule_set").some((r) => r.id === "rs-t1")).toBe(true);
    expect(Object.keys(await w.rt.engine.vector(TENANT_STREAM)).length).toBeGreaterThan(0);
    expect(Object.keys(await w.rt.engine.vector(OUTLET_STREAM))).not.toContain("cloud");
  });
});
