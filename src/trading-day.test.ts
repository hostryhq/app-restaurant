import { describe, expect, it } from "vitest";
import type { BillRow, CreditNoteRow } from "@hostry/client-core";
import type { OpRow } from "./domain/rows";
import * as T from "./data/trading";
import { deviceSession } from "./runtime";
import { rows, world } from "./test/world";

/**
 * The scripted trading day (docs/design flows 1.1 to 1.9) run on the app logic against client-core's in-memory store and the
 * sync simulator: the device is offline all day (no hub, no cloud), trades, loses a printer, closes the shift and the day, and
 * only then reconnects. Nothing may be lost, numbers stay gapless, and the Z-report equals the bills.
 */
describe("trading day: offline all day, then reconnect", () => {
  it("runs the whole day with no network, then converges when the links come back", async () => {
    const w = await world();
    const { rt, clock } = w;
    expect(rt.sync.status()).toMatchObject({ online: false, upstream: "none" });

    // 09:00 morning: the manager is in, the cashier opens the shift with the float.
    clock.minutes(-65); // 12:00 IST is 06:30 UTC; the world starts at 13:05, step back to a morning start
    await w.signIn("Asha");
    const shiftId = await T.startShift(rt.ctx, 200_000);

    // Lunch: a waiter takes two tables, sends to kitchen and bar, the kitchen bumps.
    await w.signIn("Ravi");
    const t1 = await T.openTableCheck(rt.ctx, "tb-1");
    const t2 = await T.openTableCheck(rt.ctx, "tb-2");
    await T.addLine(rt.ctx, t1.checkId, { itemId: "it-dosa", qtyMilli: 2000 });
    await T.addLine(rt.ctx, t1.checkId, { itemId: "it-coffee", qtyMilli: 2000 });
    await T.addLine(rt.ctx, t2.checkId, { itemId: "it-meal", qtyMilli: 1000 });
    await T.addLine(rt.ctx, t2.checkId, { itemId: "it-chicken", qtyMilli: 1000, modifierIds: ["md-hot"] });
    const k1 = await T.sendKot(rt.ctx, t1.checkId);
    const k2 = await T.sendKot(rt.ctx, t2.checkId);
    expect(k1.length + k2.length).toBeGreaterThanOrEqual(3);
    clock.minutes(12);
    await w.signIn("Asha");
    for (const id of [...k1, ...k2]) await T.bump(rt.ctx, id);
    expect(rows<{ status: string }>(rt, "kot_line").every((l) => l.status === "ready")).toBe(true);

    // The kitchen printer jams for a few minutes: a KOT is queued and visible, then prints on retry. The order is never lost.
    await w.signIn("Ravi");
    await T.addLine(rt.ctx, t1.checkId, { itemId: "it-vada", qtyMilli: 1000 });
    rt.fakes.kitchen.failWith = "paper_out";
    const [jam] = await T.sendKot(rt.ctx, t1.checkId);
    expect(rt.fakes.hub.jobs().map((j) => j.id)).toContain(jam);
    rt.fakes.kitchen.failWith = undefined;
    clock.minutes(1);
    await rt.fakes.hub.flush();
    expect(rt.fakes.hub.jobs()).toHaveLength(0);

    // Bills: T1 presented and paid with cash + UPI; T2 pays by card after a discount a manager approved.
    await T.billPlease(rt.ctx, t1.checkId);
    await w.signIn("Asha");
    const pre = await T.present(rt.ctx, t1.checkId);
    expect(pre).toEqual({ kind: "pre_bill", count: 1 });
    expect(rows<BillRow>(rt, "bill")).toHaveLength(0); // a pre-bill takes no number (ADR-0014 A1.5)
    const due1 = T.previewCheck((e) => rt.data.snapshot().list(e), "outlet-1", t1.checkId, clock.now())!.c.result.total_paise;
    const half = Math.floor(due1 / 2);
    const b1 = await T.settle(rt.ctx, t1.checkId, { payments: [{ tender: "cash", amount_paise: half }, { tender: "upi", amount_paise: due1 - half }] });
    expect(b1.number).toBe("A07/2627/000001");

    await T.addLine(rt.ctx, t2.checkId, { itemId: "it-lime", qtyMilli: 1000 });
    const ap = await rt.identity.approve("m-meena", "3333", "bill.discount.over_limit", "m-asha");
    if (!ap.ok) throw new Error("approval");
    await T.applyDiscount(rt.ctx, { checkId: t2.checkId, kind: "percent", value: 1500, reasonCodeId: "rc-disc-complaint", approvalId: ap.approvalId });
    const due2 = T.previewCheck((e) => rt.data.snapshot().list(e), "outlet-1", t2.checkId, clock.now())!.c.result.total_paise;
    const b2 = await T.settle(rt.ctx, t2.checkId, { payments: [{ tender: "card", amount_paise: due2 }] });
    expect(b2.number).toBe("A07/2627/000002");
    await T.reprintBill(rt.ctx, b2.billId);
    expect(rt.fakes.bill.printed.length).toBeGreaterThanOrEqual(4); // pre-bill, two bills, one duplicate

    // Afternoon counter sales, one held while another is paid; a wrong item is credited by the manager.
    clock.minutes(120);
    const held = await T.newCounterCheck(rt.ctx);
    await T.addLine(rt.ctx, held, { itemId: "it-roast", qtyMilli: 1000 });
    const c1 = await T.newCounterCheck(rt.ctx);
    await T.addLine(rt.ctx, c1, { itemId: "it-chai", qtyMilli: 3000 });
    const s3 = await T.settle(rt.ctx, c1, { payments: [{ tender: "cash", amount_paise: 6300, tendered_paise: 10000, change_paise: 3700 }] });
    expect(s3.number).toBe("A07/2627/000003");
    await w.signIn("Meena");
    const cn = await T.creditNote(rt.ctx, { billId: s3.billId, reasonCodeId: "rc-cn-wrong", refundTender: "cash" });
    expect(cn.number).toBe("C07/2627/000001");
    await w.signIn("Asha");
    const heldDue = T.previewCheck((e) => rt.data.snapshot().list(e), "outlet-1", held, clock.now())!.c.result.total_paise;
    expect(heldDue).toBe(10_000); // 95.00 + 5% = 99.75, rounded to the rupee
    const sh = await T.settle(rt.ctx, held, { payments: [{ tender: "upi", amount_paise: heldDue }] });
    expect(sh.number).toBe("A07/2627/000004");

    // Evening: blind count, day close. A shift left open and an unbilled check both block it first.
    await w.signIn("Meena");
    const late = await T.newCounterCheck(rt.ctx);
    await T.addLine(rt.ctx, late, { itemId: "it-vada", qtyMilli: 1000 });
    await expect(T.closeDay(rt.ctx)).rejects.toMatchObject({ code: "day_blocked" });
    const lateDue = T.previewCheck((e) => rt.data.snapshot().list(e), "outlet-1", late, clock.now())!.c.result.total_paise;
    await T.settle(rt.ctx, late, { payments: [{ tender: "cash", amount_paise: lateDue }] });
    const counted = T.expectedCashFor((e) => rt.data.snapshot().list(e), rt.data.snapshot().get("shift", shiftId)!) - 100;
    const close = await T.closeShift(rt.ctx, shiftId, counted);
    expect(close.variancePaise).toBe(-100);
    const z = await T.closeDay(rt.ctx);

    // The Z-report equals the bills; the numbers are gapless; the credit note is its own series.
    const bills = rows<BillRow>(rt, "bill");
    expect(z.billCount).toBe(bills.length);
    expect(z.totalPaise).toBe(bills.reduce((s, b) => s + b.total_paise, 0));
    expect(bills.map((b) => b.number).sort()).toEqual(["A07/2627/000001", "A07/2627/000002", "A07/2627/000003", "A07/2627/000004", "A07/2627/000005"]);
    expect(rows<CreditNoteRow>(rt, "credit_note").map((n) => n.number)).toEqual(["C07/2627/000001"]);
    expect(bills.every((b) => b.business_date === "2026-11-24")).toBe(true);

    // Offline all day: every op is still only on this device, in gapless order, none dropped.
    const ops = rows<OpRow>(rt, "_op").sort((a, b) => a.seq - b.seq);
    expect(ops.every((o) => o.delivery === "local")).toBe(true);
    expect(ops.map((o) => o.seq)).toEqual(ops.map((_, i) => i + 1));
    expect(rt.sync.status()).toMatchObject({ state: "offline", pendingOps: ops.length });

    // Reconnect: the LAN hub first (partway: the link drops after a few ops), then the cloud. Resume loses nothing.
    await rt.writer.deliver("at_hub", 5); // an interrupted push
    await rt.sync.setLinks({ hub: true });
    expect(rt.sync.status()).toMatchObject({ state: "pending", pendingOps: 0, atHubOps: ops.length, upstream: "hub" });
    await rt.sync.setLinks({ cloud: true });
    expect(rt.sync.status()).toMatchObject({ state: "synced", pendingOps: 0, atHubOps: 0, upstream: "cloud" });
    expect(rows<OpRow>(rt, "_op").every((o) => o.delivery === "in_cloud")).toBe(true);
    expect(rows<OpRow>(rt, "_op")).toHaveLength(ops.length); // idempotent: delivering again changes nothing
    await rt.sync.syncNow();
    expect(rows<OpRow>(rt, "_op")).toHaveLength(ops.length);

    // The next morning trades on the next date; the closed day is never reopened.
    clock.minutes(24 * 60);
    await w.signIn("Meena");
    await T.newCounterCheck(rt.ctx);
    const days = rows<{ business_date: string; status: string }>(rt, "business_day");
    expect(days.find((d) => d.business_date === "2026-11-24")?.status).toBe("closed");
    expect(days.filter((d) => d.status === "open").map((d) => d.business_date)).toEqual(["2026-11-25"]);
  });
});

describe("permissions by role (the check is on the permission, never the role name)", () => {
  const table: Array<[string, Array<[string, boolean]>]> = [
    ["Ravi", [["order.create", true], ["bill.finalize", false], ["bill.discount.over_limit", false], ["order.line.cancel", false], ["day.close", false]]],
    ["Asha", [["bill.finalize", true], ["shift.close", true], ["bill.rebill", false], ["bill.credit_note.create", false], ["day.close", false]]],
    ["Meena", [["bill.rebill", true], ["bill.credit_note.create", true], ["day.close", true], ["order.line.cancel", true]]],
    ["Anand", [["bill.rebill", true], ["anything.at.all", true]]],
  ];
  it.each(table)("%s", async (name, checks) => {
    const w = await world();
    await w.signIn(name as "Ravi");
    for (const [perm, expected] of checks) expect(T.holds(w.rt.ctx, perm), perm).toBe(expected);
  });

  it("a KDS device session can bump but cannot settle, discount or cancel; no session can do anything", async () => {
    const w = await world();
    await w.signIn("Ravi");
    const { checkId } = await T.openTableCheck(w.rt.ctx, "tb-1");
    await T.addLine(w.rt.ctx, checkId, { itemId: "it-vada", qtyMilli: 1000 });
    const [kot] = await T.sendKot(w.rt.ctx, checkId);
    w.rt.setSession(deviceSession(w.rt));
    await T.bump(w.rt.ctx, kot!);
    await expect(T.settle(w.rt.ctx, checkId, { payments: [] })).rejects.toBeInstanceOf(T.PermissionError);
    await expect(T.applyDiscount(w.rt.ctx, { checkId, kind: "percent", value: 100, reasonCodeId: "rc-disc-regular" })).rejects.toBeDefined();
    w.rt.setSession(undefined);
    await expect(T.bump(w.rt.ctx, kot!)).rejects.toBeInstanceOf(T.PermissionError);
  });

  it("an expired session grants nothing (offline sessions expire; the device revalidates on reconnect)", async () => {
    const w = await world();
    await w.signIn("Asha");
    expect(T.holds(w.rt.ctx, "bill.finalize")).toBe(true);
    w.clock.advance(13 * 3_600_000);
    expect(T.holds(w.rt.ctx, "bill.finalize")).toBe(false);
  });
});
