import { describe, expect, it } from "vitest";
import { world, rows, Net } from "../../test/world";
import type { Bill, Check, Kot, KotLine, OrderLine } from "./test-types";
import * as T from "./index";
import { PermissionError, TradingError } from "./ctx";

describe("order entry, KOT and settle", () => {
  it("opens the seating on the first item, folds repeats, sends one KOT per station and prints the kitchen ticket", async () => {
    const w = await world();
    await w.signIn("Ravi");
    const { checkId } = await T.openTableCheck(w.rt.ctx, "tb-1");
    await T.addLine(w.rt.ctx, checkId, { itemId: "it-dosa", qtyMilli: 1000 });
    await T.addLine(w.rt.ctx, checkId, { itemId: "it-dosa", qtyMilli: 1000 });
    await T.addLine(w.rt.ctx, checkId, { itemId: "it-coffee", qtyMilli: 1000 });
    const lines = rows<OrderLine>(w.rt, "order_line");
    expect(lines).toHaveLength(2);
    expect(lines.find((l) => l.item_id === "it-dosa")?.qty_milli).toBe(2000);
    expect(rows(w.rt, "seating")).toHaveLength(1);

    const kots = await T.sendKot(w.rt.ctx, checkId);
    expect(kots).toHaveLength(2); // KITCHEN and BAR
    expect(rows<Kot>(w.rt, "kot").map((k) => k.station_code).sort()).toEqual(["BAR", "KITCHEN"]);
    expect(rows<OrderLine>(w.rt, "order_line").every((l) => l.state === "sent")).toBe(true);
    expect(w.rt.fakes.kitchen.printed).toHaveLength(1); // BAR is KDS-only
    await expect(T.sendKot(w.rt.ctx, checkId)).rejects.toBeInstanceOf(TradingError);
  });

  it("a waiter cannot settle; a cashier takes cash exactly once the shift is open, and the bill number is gapless", async () => {
    const w = await world();
    await w.signIn("Ravi");
    const { checkId } = await T.openTableCheck(w.rt.ctx, "tb-2");
    await T.addLine(w.rt.ctx, checkId, { itemId: "it-meal", qtyMilli: 1000 });
    await expect(T.settle(w.rt.ctx, checkId, { payments: [] })).rejects.toBeInstanceOf(PermissionError);

    await w.signIn("Asha");
    const p = T.previewCheck((e) => w.rt.data.snapshot().list(e), w.rt.ctx.outletId, checkId, w.clock.now())!;
    const total = p.c.result.total_paise;
    expect(total).toBe(15800); // 15000 + 5% GST (demo rate) = 157.50, rounded to the rupee
    await expect(T.settle(w.rt.ctx, checkId, { payments: [{ tender: "cash", amount_paise: total }] })).rejects.toMatchObject({ code: "no_open_shift" });
    await T.startShift(w.rt.ctx, 200000);
    const r = await T.settle(w.rt.ctx, checkId, { payments: [{ tender: "cash", amount_paise: total, tendered_paise: 20000, change_paise: 20000 - total }] });
    expect(r.number).toBe("A07/2627/000001");
    expect(rows<Check>(w.rt, "check")[0]?.status).toBe("billed");
    expect(rows<{ status: string }>(w.rt, "seating")[0]?.status).toBe("billed");
    expect(w.rt.fakes.drawer.opened).toBe(1);
    expect(w.rt.fakes.bill.printed.length).toBe(1);

    // counter sale: next number, no gap
    const c = await T.newCounterCheck(w.rt.ctx);
    await T.addLine(w.rt.ctx, c, { itemId: "it-chai", qtyMilli: 2000 });
    const r2 = await T.settle(w.rt.ctx, c, { payments: [{ tender: "upi", amount_paise: 4200 }] });
    expect(r2.number).toBe("A07/2627/000002");
    expect(w.rt.fakes.kitchen.printed.length + rows<Kot>(w.rt, "kot").length).toBeGreaterThan(0);
  });

  it("a refused calculation takes no number", async () => {
    const w = await world();
    await w.signIn("Asha");
    const c = await T.newCounterCheck(w.rt.ctx);
    await T.addLine(w.rt.ctx, c, { itemId: "it-chai", qtyMilli: 1000 });
    await T.startShift(w.rt.ctx, 0);
    await expect(T.settle(w.rt.ctx, c, { payments: [{ tender: "cash", amount_paise: 999999 }] })).rejects.toBeDefined();
    const ok = await T.settle(w.rt.ctx, c, { payments: [{ tender: "cash", amount_paise: 2100 }] });
    expect(ok.number).toBe("A07/2627/000001");
  });
});

describe("discounts, credit notes, re-bill", () => {
  it("over-limit discount needs a manager approval; a cashier alone is asked to get one", async () => {
    const w = await world();
    await w.signIn("Asha");
    const c = await T.newCounterCheck(w.rt.ctx);
    await T.addLine(w.rt.ctx, c, { itemId: "it-meal", qtyMilli: 1000 });
    expect(T.discountDecision(w.rt.ctx, c, "percent", 500)).toBe("apply"); // 5% within the 10% limit
    expect(T.discountDecision(w.rt.ctx, c, "percent", 2000)).toBe("ask_manager");
    await expect(T.applyDiscount(w.rt.ctx, { checkId: c, kind: "percent", value: 2000, reasonCodeId: "rc-disc-regular" })).rejects.toMatchObject({ code: "approval_needed" });
    const ap = await w.rt.identity.approve("m-meena", "3333", "bill.discount.over_limit", "m-asha");
    expect(ap.ok).toBe(true);
    if (!ap.ok) return;
    await T.applyDiscount(w.rt.ctx, { checkId: c, kind: "percent", value: 2000, reasonCodeId: "rc-disc-regular", approvalId: ap.approvalId });
    await T.startShift(w.rt.ctx, 0);
    const p = T.previewCheck((e) => w.rt.data.snapshot().list(e), w.rt.ctx.outletId, c, w.clock.now())!;
    const r = await T.settle(w.rt.ctx, c, { payments: [{ tender: "cash", amount_paise: p.c.result.total_paise }] });
    expect(rows<Bill>(w.rt, "bill").find((b) => b.id === r.billId)?.discount_paise).toBe(3000);
  });

  it("without approval the finalisation itself refuses an over-limit discount (defence in depth)", async () => {
    const w = await world();
    await w.signIn("Meena");
    const c = await T.newCounterCheck(w.rt.ctx);
    await T.addLine(w.rt.ctx, c, { itemId: "it-meal", qtyMilli: 1000 });
    await w.rt.data.write({ intent: "bill.discount.apply", build: () => [{ e: "check", id: c, k: "set", f: { discount_kind: "percent", discount_value: 5000 } }] });
    await T.startShift(w.rt.ctx, 0);
    await w.signIn("Asha");
    await expect(T.settle(w.rt.ctx, c, { payments: [] })).rejects.toMatchObject({ code: "discount_over_limit" });
  });

  it("credit note reverses a bill; re-bill adds a GSTIN in one op with a credit note and a new number", async () => {
    const w = await world();
    await w.signIn("Meena");
    await T.startShift(w.rt.ctx, 0);
    const c = await T.newCounterCheck(w.rt.ctx);
    await T.addLine(w.rt.ctx, c, { itemId: "it-dosa", qtyMilli: 2000 });
    const total = T.previewCheck((e) => w.rt.data.snapshot().list(e), w.rt.ctx.outletId, c, w.clock.now())!.c.result.total_paise;
    const r = await T.settle(w.rt.ctx, c, { payments: [{ tender: "cash", amount_paise: total }] });

    // The bill is paid: the owner approves, bound to the plan (F29).
    const input = { billId: r.billId, gstin: "33ABCDE1234F1Z5", reasonCodeId: "rc-cn-gstin" };
    const plan = T.planRebill(w.rt.ctx, input);
    const ap = await w.rt.identity.approve("m-anand", "4444", "bill.credit_note.create", "m-meena", T.rebillBinding(r.billId, input.reasonCodeId, plan)!);
    if (!ap.ok) throw new Error("approval");
    const rebillOps = () => rows<{ intent: string }>(w.rt, "_op").filter((o) => !o.intent.startsWith("approval.")).length;
    const ops = rebillOps();
    const rb = await T.rebillBill(w.rt.ctx, { ...input, plan, approvalId: ap.approvalId });
    expect(rb.credit).toBe("C07/2627/000001");
    expect(rb.bills).toEqual(["A07/2627/000002"]);
    expect(rebillOps()).toBe(ops + 1); // one op: no node sees half of it
    const bills = rows<Bill>(w.rt, "bill");
    expect(bills).toHaveLength(2);
    expect(bills.find((b) => b.number === "A07/2627/000002")?.total_paise).toBe(total);
    expect(bills.find((b) => b.number === "A07/2627/000002")?.customer_gstin).toBe("33ABCDE1234F1Z5");
    await expect(T.creditNote(w.rt.ctx, { billId: r.billId, reasonCodeId: "rc-cn-wrong", refundTender: "cash" })).rejects.toBeDefined(); // already fully credited by the re-bill
  });

  it("a cashier without bill.rebill is refused", async () => {
    const w = await world();
    await w.signIn("Meena");
    await T.startShift(w.rt.ctx, 0);
    const c = await T.newCounterCheck(w.rt.ctx);
    await T.addLine(w.rt.ctx, c, { itemId: "it-chai", qtyMilli: 1000 });
    const r = await T.settle(w.rt.ctx, c, { payments: [] });
    await w.signIn("Asha");
    await expect(T.rebillBill(w.rt.ctx, { billId: r.billId, gstin: "33ABCDE1234F1Z5", reasonCodeId: "rc-cn-gstin" })).rejects.toBeInstanceOf(PermissionError);
  });
});

describe("KDS, cancel, blackout late tickets", () => {
  it("KDS steps an item, bumps a ticket, recalls it; cancel after KOT needs the permission or an approval", async () => {
    const w = await world();
    await w.signIn("Asha");
    const c = await T.newCounterCheck(w.rt.ctx);
    await T.addLine(w.rt.ctx, c, { itemId: "it-vada", qtyMilli: 1000 });
    await T.addLine(w.rt.ctx, c, { itemId: "it-bajji", qtyMilli: 1000 });
    const [kotId] = await T.sendKot(w.rt.ctx, c);
    const kl = rows<KotLine>(w.rt, "kot_line");
    await T.stepItem(w.rt.ctx, kl[0]!.id);
    expect(rows<KotLine>(w.rt, "kot_line").find((l) => l.id === kl[0]!.id)?.status).toBe("preparing");
    await T.bump(w.rt.ctx, kotId!);
    expect(rows<KotLine>(w.rt, "kot_line").every((l) => l.status === "ready")).toBe(true);
    const rc = await T.recall(w.rt.ctx, kotId!);
    expect(rows<Kot>(w.rt, "kot").find((k) => k.id === rc)?.recall_of_kot_id).toBe(kotId);

    const line = rows<OrderLine>(w.rt, "order_line")[0]!;
    await expect(T.cancelSentLine(w.rt.ctx, { lineId: line.id, qtyMilli: 1000, reasonCodeId: "rc-cancel-mind" })).rejects.toBeInstanceOf(PermissionError);
    const ap = await w.rt.identity.approve("m-meena", "3333", "order.line.cancel", "m-asha");
    if (!ap.ok) throw new Error("approval");
    await T.cancelSentLine(w.rt.ctx, { lineId: line.id, qtyMilli: 1000, reasonCodeId: "rc-cancel-mind", approvalId: ap.approvalId });
    const cancel = rows<{ wastage: boolean; kitchen_status_at_cancel: string }>(w.rt, "order_line_cancel")[0]!;
    expect(cancel.kitchen_status_at_cancel).toBe("ready");
    expect(cancel.wastage).toBe(true);
    expect(rows<Kot>(w.rt, "kot").some((k) => k.kind === "cancel")).toBe(true);
  });

  /** A counter (the printing device, with the menu) and a waiter handheld on one LAN hub; the handheld then loses the LAN. */
  async function counterAndHandheld() {
    const net = await Net.create();
    const host = await net.add({ deviceKind: "pos", deviceCode: "A07" });
    const hand = await net.add({ deviceKind: "waiter", deviceCode: "B3K", billing: false });
    await net.links({ hub: true }); // morning: the LAN is up, the handheld gets the menu and the open day
    await net.links({ hub: false }); // then the power and the wifi go
    return { net, host, hand };
  }

  it("blackout: a handed-over KOT never prints as an original; a recent one prints exactly once", async () => {
    const { net, host, hand } = await counterAndHandheld();
    await hand.signIn("Ravi");
    const { checkId } = await T.openTableCheck(hand.rt.ctx, "tb-3");
    await T.addLine(hand.rt.ctx, checkId, { itemId: "it-bajji", qtyMilli: 1000 });
    const [given] = await T.sendKot(hand.rt.ctx, checkId);
    await T.handover(hand.rt.ctx, given!, "by_hand");
    net.clock.minutes(5);
    await T.addLine(hand.rt.ctx, checkId, { itemId: "it-plain", qtyMilli: 1000 });
    const [recent] = await T.sendKot(hand.rt.ctx, checkId);

    // the LAN returns a minute after the last KOT: the counter pulls the handheld's ops
    net.clock.minutes(1);
    await net.links({ hub: true });
    await host.signIn("Asha");
    expect(T.ingestArrivedKot(host.rt.ctx, recent!)).toBe("queued");
    expect(T.ingestArrivedKot(host.rt.ctx, recent!)).toBe("already_handled"); // exactly once
    expect(T.ingestArrivedKot(host.rt.ctx, given!)).toBe("late"); // handed over: never an original
    expect(host.rt.fakes.hub.lateTickets().map((t) => t.reason)).toEqual(["handover"]);
  });

  it("a KOT older than the stale window is held for a person; printing it marks it late, dismissing it is final", async () => {
    const { net, host, hand } = await counterAndHandheld();
    await hand.signIn("Ravi");
    const { checkId } = await T.openTableCheck(hand.rt.ctx, "tb-4");
    await T.addLine(hand.rt.ctx, checkId, { itemId: "it-vada", qtyMilli: 1000 });
    const [k] = await T.sendKot(hand.rt.ctx, checkId);
    net.clock.minutes(20);
    await net.links({ hub: true });
    await host.signIn("Asha");
    expect(T.ingestArrivedKot(host.rt.ctx, k!)).toBe("late");
    expect(host.rt.fakes.hub.lateTickets()).toHaveLength(1);
    expect(host.rt.fakes.hub.lateTickets()[0]?.reason).toBe("stale");
    expect(host.rt.fakes.kitchen.printed).toHaveLength(0);
    expect(host.rt.fakes.hub.printLate(k!)).toBe(true);
    await host.rt.fakes.hub.flush();
    expect(host.rt.fakes.kitchen.printed).toHaveLength(1);
    expect(host.rt.fakes.hub.lateTickets()).toHaveLength(0);
  });

  it("a failed kitchen print never loses the order: the KOT exists, the job stays queued and visible", async () => {
    const w = await world();
    await w.signIn("Ravi");
    const { checkId } = await T.openTableCheck(w.rt.ctx, "tb-5");
    await T.addLine(w.rt.ctx, checkId, { itemId: "it-plain", qtyMilli: 1000 });
    w.rt.fakes.kitchen.failWith = "offline";
    const [k] = await T.sendKot(w.rt.ctx, checkId);
    expect(rows<Kot>(w.rt, "kot")).toHaveLength(1);
    expect(w.rt.fakes.hub.jobs().some((j) => j.id === k)).toBe(true);
    w.rt.fakes.kitchen.failWith = undefined;
    w.clock.advance(3000); // past the retry backoff
    await w.rt.fakes.hub.flush();
    expect(w.rt.fakes.hub.jobs()).toHaveLength(0);
    expect(w.rt.fakes.kitchen.printed).toHaveLength(1);
  });
});

describe("shift and day close", () => {
  it("blind count records the variance; day close is blocked by an open shift and unbilled lines, then prints the Z-report", async () => {
    const w = await world();
    await w.signIn("Meena");
    const shiftId = await T.startShift(w.rt.ctx, 100000);
    const c = await T.newCounterCheck(w.rt.ctx);
    await T.addLine(w.rt.ctx, c, { itemId: "it-meal", qtyMilli: 1000 });
    await expect(T.closeDay(w.rt.ctx)).rejects.toMatchObject({ code: "day_blocked" });
    const total = T.previewCheck((e) => w.rt.data.snapshot().list(e), w.rt.ctx.outletId, c, w.clock.now())!.c.result.total_paise;
    await T.settle(w.rt.ctx, c, { payments: [{ tender: "cash", amount_paise: total }] });
    await expect(T.closeDay(w.rt.ctx)).rejects.toMatchObject({ code: "day_blocked" }); // shift still open
    const expected = 100000 + total;
    const r = await T.closeShift(w.rt.ctx, shiftId, expected - 500);
    expect(r.variancePaise).toBe(-500);
    const z = await T.closeDay(w.rt.ctx);
    expect(z.zNumber).toBe("Z/2026-11-24/A07");
    expect(z.billCount).toBe(1);
    expect(z.totalPaise).toBe(total);
    expect(rows<{ status: string }>(w.rt, "business_day")[0]?.status).toBe("closed");
    // trading after close opens the next date, never reopens the closed one (ADR-0014 A1.1)
    const c2 = await T.newCounterCheck(w.rt.ctx);
    expect(rows<{ business_date: string; status: string }>(w.rt, "business_day").filter((d) => d.status === "open")[0]?.business_date).toBe("2026-11-25");
    void c2;
  });
});
