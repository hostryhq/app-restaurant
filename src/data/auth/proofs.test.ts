import { describe, expect, it } from "vitest";
import { approvalActionHash, type OpEnvelope } from "@hostry/client-core";
import { demoPack } from "../../fixtures/demo-pack";
import { deviceSession, openDeviceSession } from "../../runtime";
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
    // F15: the gateway types the session from the session record of the op.
    expect(op.muts).toEqual([{ e: "session", id: op.sid, k: "insert", f: { type: "pin" } }]);
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
    for (const o of ops) if (o.proof !== undefined) expect(["session.open", "approval.grant", "approval.self_confirm"]).toContain(o.intent);
  });

  it("approval.grant carries the approver's action proof, under the approver's name", async () => {
    const w = await world();
    await w.signIn("Asha");
    const about = { intent: "bill.discount.over_limit", target: "check:c-7", reason: "rc-1", values: { discount_kind: "percent", discount_value: 1500 } };
    const r = await w.rt.identity.approve("m-meena", "3333", "bill.discount.over_limit", "m-asha", about);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const grant = (await ownOps(w)).find((o) => o.intent === "approval.grant")!;
    // F15, A3.3: the record names the intent and the row; the action hash binds them and the values the citing op will record.
    const hashOf = (values: Record<string, unknown>) => approvalActionHash({ intent: "bill.discount.over_limit", permission: "bill.discount.over_limit", requester: "m-asha", target: "check:c-7", approvalId: r.approvalId, reason: "rc-1", values });
    const actionHash = await hashOf(about.values);
    expect(grant.muts).toEqual([
      { e: "approval", id: r.approvalId, k: "insert", f: { permission: "bill.discount.over_limit", intent: "bill.discount.over_limit", requester: "m-asha", action_hash: actionHash, target: "check:c-7", reason: "rc-1" } },
    ]);
    // OV2: the same approval for another amount recomputes to another hash.
    expect(await hashOf({ discount_kind: "percent", discount_value: 2500 })).not.toBe(actionHash);
    const { pack, prover } = demoPack({ now: new TestClock().now });
    expect(grant.actor).toBe("m-meena");
    expect(grant.approval).toBe(r.approvalId);
    expect(typeof grant.proof).toBe("string");
    const pinV = pack.members.find((m) => m.memberId === "m-meena")!.pinV;
    // The proof message is the contract's bytes, with `at` = the op's own `at` (the time the proof binds).
    expect(await prover.verifyApproval({ proof: grant.proof!, approvalId: r.approvalId, approverId: "m-meena", permission: "bill.discount.over_limit", requesterId: "m-asha", actionHash, target: "check:c-7", reason: "rc-1", deviceId: grant.origin, packV: pack.packV, pinV, at: grant.at })).toBe(true);
    // The approval binds the row: a proof for another target does not verify.
    expect(await prover.verifyApproval({ proof: grant.proof!, approvalId: r.approvalId, approverId: "m-meena", permission: "bill.discount.over_limit", requesterId: "m-asha", actionHash, target: "check:c-8", reason: "rc-1", deviceId: grant.origin, packV: pack.packV, pinV, at: grant.at })).toBe(false);
    // A wrong approver PIN records no grant.
    const bad = await w.rt.identity.approve("m-meena", "0000", "bill.discount.over_limit", "m-asha");
    expect(bad.ok).toBe(false);
    expect((await ownOps(w)).filter((o) => o.intent === "approval.grant")).toHaveLength(1);
  });

  it("own-PIN reconfirmation is an approval.self_confirm with requester = approver, and is refused to a member who lacks the permission", async () => {
    const w = await world();
    await w.signIn("Meena");
    const about = { intent: "bill.cancel", target: "check_cancel:cc-1", reason: "rc-1", values: { check_id: "c-1", reason_code_id: "rc-1" } };
    const own = await w.rt.identity.confirmOwnPin("m-meena", "3333", "bill.cancel", about);
    expect(own.ok).toBe(true);
    if (!own.ok) return;
    const op = (await ownOps(w)).find((o) => o.intent === "approval.self_confirm")!;
    expect(op.actor).toBe("m-meena");
    expect(op.approval).toBe(own.approvalId);
    expect(op.muts[0]).toMatchObject({ e: "approval", id: own.approvalId, f: { requester: "m-meena", intent: "bill.cancel", target: "check_cancel:cc-1" } });
    expect(typeof op.proof).toBe("string");
    expect((await w.rt.identity.confirmOwnPin("m-meena", "0000", "bill.cancel", about)).ok).toBe(false);
    // The cashier does not hold bill.cancel: her own PIN is no approval for it.
    expect(await w.rt.identity.confirmOwnPin("m-asha", "1111", "bill.cancel", about)).toEqual({ ok: false, reason: "not_allowed" });
    expect((await ownOps(w)).filter((o) => o.intent === "approval.self_confirm")).toHaveLength(1);
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

  it("a KDS opens its device session with a session.open of type device under device:<origin> and no proof (F15)", async () => {
    const w = await world({ deviceKind: "kds", deviceCode: "K9K", billing: false });
    const s = await openDeviceSession(w.rt);
    expect(w.rt.session()).toEqual(s);
    const open = (await ownOps(w)).filter((o) => o.intent === "session.open" && o.actor.startsWith("device:"));
    expect(open).toHaveLength(1);
    const op = open[0]!;
    expect(op.actor).toBe(`device:${w.rt.deviceId}`);
    expect(op.sid).toBe(s.sessionId);
    expect(op.muts).toEqual([{ e: "session", id: s.sessionId, k: "insert", f: { type: "device" } }]);
    expect(op.proof).toBeUndefined();
    // Later ops of the KDS name that session.
    expect(w.rt.engine.session).toEqual({ actor: `device:${w.rt.deviceId}`, sid: s.sessionId });
  });

  it("a KDS opens a new device session at the first op after a new business day or 26 hours, and not before", async () => {
    const w = await world({ deviceKind: "kds", deviceCode: "K9K", billing: false });
    const first = await openDeviceSession(w.rt);
    const opens = async () => (await ownOps(w)).filter((o) => o.intent === "session.open" && o.actor.startsWith("device:"));
    w.clock.minutes(60);
    await T.setAvailability(w.rt.ctx, "it-dosa", false);
    expect(await opens()).toHaveLength(1); // same day, an hour old: the session stands
    expect(w.rt.session()?.sessionId).toBe(first.sessionId);
    w.clock.minutes(26 * 60);
    await T.setAvailability(w.rt.ctx, "it-dosa", true);
    const all = await opens();
    expect(all).toHaveLength(2); // 27 hours old: the screen opened a new one itself, with no person
    expect(w.rt.session()?.sessionId).toBe(all[1]!.sid);
    expect(w.rt.session()?.sessionId).not.toBe(first.sessionId);
    const last = (await ownOps(w)).at(-1)!;
    expect(last.intent).toBe("menu.availability.set");
    expect(last.sid).toBe(all[1]!.sid);
  });

  it("a malformed pack is refused", () => {
    expect(() => packFromJson({ tenantId: "t" })).toThrow(PackError);
    const { pack } = demoPack();
    expect(() => packFromJson({ ...pack, packV: "7" })).toThrow(PackError);
    expect(() => packFromJson({ ...pack, kid: undefined })).toThrow(PackError); // the key id comes from the pack
    expect(packFromJson({ ...pack, deviceKind: "personal" }).deviceKind).toBe("personal");
    expect(() => packFromJson({ ...pack, deviceKind: "hub" })).toThrow(PackError);
    expect(packFromJson(JSON.parse(JSON.stringify({ ...pack, manualBooks: undefined }))).manualBooks).toEqual([]);
  });
});
