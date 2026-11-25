import { describe, expect, it } from "vitest";
import { newCounterCheck } from "./trading";
import { world } from "../test/world";

describe("sync simulator", () => {
  it("counts ops waiting, at the hub and in the cloud as links come back, and never drops one", async () => {
    const w = await world();
    await w.signIn("Asha");
    await newCounterCheck(w.rt.ctx);
    const total = w.rt.data.snapshot().list("_op").length;
    expect(w.rt.sync.status()).toMatchObject({ state: "offline", pendingOps: total, atHubOps: 0, upstream: "none", online: false });
    await w.rt.sync.setLinks({ hub: true });
    expect(w.rt.sync.status()).toMatchObject({ state: "pending", pendingOps: 0, atHubOps: total, upstream: "hub" });
    await w.rt.sync.setLinks({ cloud: true });
    expect(w.rt.sync.status()).toMatchObject({ state: "synced", pendingOps: 0, atHubOps: 0, upstream: "cloud" });
    // a new op while online reaches the cloud on the next round
    await newCounterCheck(w.rt.ctx);
    await w.rt.sync.syncNow();
    expect(w.rt.sync.status()).toMatchObject({ state: "synced", pendingOps: 0 });
    // the cloud goes away again: new work waits, nothing is lost, the count is honest
    await w.rt.sync.setLinks({ hub: false, cloud: false });
    await newCounterCheck(w.rt.ctx);
    expect(w.rt.sync.status().state).toBe("offline");
    expect(w.rt.sync.status().pendingOps).toBe(2);
  });
});
