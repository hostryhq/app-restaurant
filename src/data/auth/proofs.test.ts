import { describe, expect, it } from "vitest";
import type { OpEnvelope } from "@hostry/client-core";
import { demoPack } from "../../fixtures/demo-pack";
import { deviceSession } from "../../runtime";
import { OUTLET_STREAM, TestClock, world, type World } from "../../test/world";
import * as T from "../trading";
import { packFromJson, PackError } from "./pack";

/** Every op this device recorded, in order. */
async function ownOps(w: World): Promise<OpEnvelope[]> {
  const high = (await w.rt.engine.vector(OUTLET_STREAM))[w.rt.deviceId] ?? 0;
  const out: OpEnvelope[] = [];
  for (let seq = 1; seq <= high; seq++) out.push((await w.rt.engine.opAt({ origin: w.rt.deviceId, stream: OUTLET_STREAM, seq }))!);
  return out;
}

describe("ops carry PIN-derived proofs (ADR-0005 A2.1, A3.1)", () => {
  it("session.open carries a session proof the identity service would accept, with the sealed integer pack_v and the pack's pin_v", async () => {
    const w = await world();
    await w.signIn("Asha");
    const open = (await ownOps(w)).filter((o) => o.intent === "session.open" && o.actor === "m-asha");
    expect(open).toHaveLength(1);
    const op = open[0]!;
    const { pack, prover } = demoPack({ now: new TestClock().now });
    expect(op.actor).toBe("m-asha");
    expect(op.sid).toBe(w.rt.session()?.sessionId);
    expect(typeof op.proof).toBe("string");
    expect(typeof (op.pack_v as unknown)).toBe("number");
    expect(op.pack_v as unknown).toBe(pack.packV);
    const pinV = pack.members.find((m) => m.memberId === "m-asha")!.pinV;
    expect(await prover.verifySession({ proof: op.proof!, sid: op.sid, deviceId: op.origin, memberId: op.actor, packV: pack.packV, pinV, openedAt: op.at })).toBe(true);
    // The proof binds the member: another member's key does not verify it.
    expect(await prover.verifySession({ proof: op.proof!, sid: op.sid, deviceId: op.origin, memberId: "m-ravi", packV: pack.packV, pinV, openedAt: op.at })).toBe(false);
  });

  it("a wrong PIN records nothing; ops after sign-in name the session and carry no proof of their own", async () => {
    const w = await world();
    const before = (await ownOps(w)).length; // the day opened by the manager's session
    expect((await w.rt.identity.signIn("m-asha", "0000")).ok).toBe(false);
    expect((await ownOps(w)).length).toBe(before);
    await w.signIn("Asha");
    await T.startShift(w.rt.ctx, 100_000);
    const ops = await ownOps(w);
    const shift = ops.find((o) => o.intent === "shift.open")!;
    expect(shift.proof).toBeUndefined();
    expect(shift.sid).toBe(w.rt.session()?.sessionId);
    // Proofs sit only on the two proof-bearing control intents.
    for (const o of ops) if (o.proof !== undefined) expect(["session.open", "approval.grant"]).toContain(o.intent);
  });

  it("approval.grant carries the approver's action proof, under the approver's name", async () => {
    const w = await world();
    await w.signIn("Asha");
    const r = await w.rt.identity.approve("m-meena", "3333", "bill.discount.over_limit", "m-asha");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const grant = (await ownOps(w)).find((o) => o.intent === "approval.grant")!;
    const { pack, prover } = demoPack({ now: new TestClock().now });
    expect(grant.actor).toBe("m-meena");
    expect(grant.approval).toBe(r.approvalId);
    expect(typeof grant.proof).toBe("string");
    const pinV = pack.members.find((m) => m.memberId === "m-meena")!.pinV;
    expect(await prover.verifyApproval({ proof: grant.proof!, approvalId: r.approvalId, approverId: "m-meena", permission: "bill.discount.over_limit", requesterId: "m-asha", deviceId: grant.origin, packV: pack.packV, pinV, at: grant.at })).toBe(true);
    // A wrong approver PIN records no grant.
    const bad = await w.rt.identity.approve("m-meena", "0000", "bill.discount.over_limit", "m-asha");
    expect(bad.ok).toBe(false);
    expect((await ownOps(w)).filter((o) => o.intent === "approval.grant")).toHaveLength(1);
  });
});

describe("configuration comes from the device's pack, not from constants", () => {
  it("a device in another tenant and outlet writes to its own stream, numbers from its own series, with its own manual books", async () => {
    const clock = new TestClock();
    const { pack, prover } = demoPack({ now: clock.now, tenantId: "t-other", outletId: "o-other", deviceCode: "D11", manualBooks: ["XB9"] });
    const { createRuntime } = await import("../../runtime");
    const rt = await createRuntime({ now: clock.now, pack, prover });
    expect(rt.ctx.outletId).toBe("o-other");
    expect(rt.ctx.manualBookCodes).toEqual(["XB9"]);
    expect(rt.engine.outletStream).toBe("outlet:o-other");
    expect(rt.store.tenantId).toBe("t-other");
    expect(rt.pack.series.map((s) => s.code)).toEqual(["D11", "D11", "D11", "C11"]);
    // No demo configuration unless a dev seed is asked for: an activated device waits for its configuration from sync.
    expect(rt.data.snapshot().list("item")).toHaveLength(0);
  });

  it("a KDS device session acts as device:<origin> and belongs to its own outlet", async () => {
    const w = await world({ deviceKind: "kds", deviceCode: "K9K", billing: false });
    const s = deviceSession(w.rt);
    expect(s.memberId).toBe(`device:${w.rt.deviceId}`);
    expect(s.grants[0]!.outlets).toEqual([w.rt.pack.outletId]);
    expect(w.rt.pack.series).toEqual([]);
  });

  it("a malformed pack is refused", () => {
    expect(() => packFromJson({ tenantId: "t" })).toThrow(PackError);
    const { pack } = demoPack();
    expect(() => packFromJson({ ...pack, packV: "7" })).toThrow(PackError);
    expect(packFromJson(JSON.parse(JSON.stringify({ ...pack, manualBooks: undefined }))).manualBooks).toEqual([]);
  });
});
