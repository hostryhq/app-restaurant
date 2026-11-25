import { describe, expect, it } from "vitest";
import { seriesGaps, type BillRow, type CreditNoteRow, type OpEnvelope } from "@hostry/client-core";
import type { OpRow } from "./domain/rows";
import * as T from "./data/trading";
import { KITCHEN_PRINTER } from "./data/trading/bill-printer";
import { deviceSession, OUTLET_STREAM } from "./runtime";
import { Net, rows, world, type World } from "./test/world";

const list = (w: World) => (e: string) => w.rt.data.snapshot().list(e);
const dueOf = (w: World, checkId: string): number => T.previewCheck(list(w), "outlet-1", checkId, w.clock.now())!.c.result.total_paise;

/**
 * The scripted trading day (docs/design flows 1.1 to 1.9) on three devices and client-core's sync simulator: the counter
 * (series A07), a captain's tablet and a KDS screen, on one LAN hub. The internet is out all day: the hub never reaches the
 * cloud until the evening. In the afternoon the LAN itself fails (a blackout): the captain hands a KOT over by hand, the
 * paper bill book is used, and when the LAN returns nothing stale prints by itself. The day closes with a blind count, and
 * only then does the hub reach the cloud: every device must converge to the same state.
 */
describe("trading day: three devices, offline all day, a blackout, then reconnect", () => {
  it("runs the whole day, then converges: same state hash, unique gapless numbers per series, Z equals the bills", async () => {
    const net = await Net.create();
    const counter = await net.add({ deviceKind: "pos", deviceCode: "A07" });
    const captain = await net.add({ deviceKind: "waiter", deviceCode: "B3K", billing: false });
    const kds = await net.add({ deviceKind: "kds", deviceCode: "K9K", billing: false });
    const clock = net.clock;
    expect(counter.rt.sync.status()).toMatchObject({ online: false, upstream: "none" });

    // Opening: the cashier opens the shift; the LAN is up, so the tablet and the KDS get the menu, the open day and the shift.
    await counter.signIn("Asha");
    const shiftId = await T.startShift(counter.rt.ctx, 200_000);
    await net.links({ hub: true });
    expect(rows(captain.rt, "item").length).toBeGreaterThan(5);
    expect(rows(kds.rt, "business_day")).toHaveLength(1);
    kds.rt.setSession(deviceSession(kds.rt));
    expect(kds.rt.sync.status()).toMatchObject({ online: true, upstream: "hub" }); // the internet is out; the LAN hub answers

    // Lunch: the captain takes two tables and sends to the kitchen and the bar; the KDS bumps; everything is offline from the cloud.
    await captain.signIn("Ravi");
    const t1 = await T.openTableCheck(captain.rt.ctx, "tb-1");
    const t2 = await T.openTableCheck(captain.rt.ctx, "tb-2");
    await T.addLine(captain.rt.ctx, t1.checkId, { itemId: "it-dosa", qtyMilli: 2000 });
    await T.addLine(captain.rt.ctx, t1.checkId, { itemId: "it-coffee", qtyMilli: 2000 });
    await T.addLine(captain.rt.ctx, t2.checkId, { itemId: "it-meal", qtyMilli: 1000 });
    await T.addLine(captain.rt.ctx, t2.checkId, { itemId: "it-chicken", qtyMilli: 1000, modifierIds: ["md-hot"] });
    const k1 = await T.sendKot(captain.rt.ctx, t1.checkId);
    const k2 = await T.sendKot(captain.rt.ctx, t2.checkId);
    expect(k1.length + k2.length).toBeGreaterThanOrEqual(3);
    clock.minutes(3);
    await net.sync();
    expect(rows(kds.rt, "kot")).toHaveLength(k1.length + k2.length); // the KDS reads the tickets from its own store
    for (const id of [...k1, ...k2]) await T.bump(kds.rt.ctx, id);
    await net.sync();
    expect(rows<{ status: string }>(captain.rt, "kot_line").every((l) => l.status === "ready")).toBe(true);

    // The kitchen printer jams for a minute: the order is never lost, the job waits visibly and prints on retry.
    await T.addLine(captain.rt.ctx, t1.checkId, { itemId: "it-vada", qtyMilli: 1000 });
    captain.rt.fakes.kitchen.failWith = "paper_out";
    const [jam] = await T.sendKot(captain.rt.ctx, t1.checkId);
    expect(captain.rt.fakes.hub.jobs().map((j) => j.id)).toContain(jam);
    captain.rt.fakes.kitchen.failWith = undefined;
    clock.minutes(1);
    await captain.rt.fakes.hub.flush();
    expect(captain.rt.fakes.hub.jobs()).toHaveLength(0);
    await T.billPlease(captain.rt.ctx, t1.checkId);
    await net.sync();

    // Bills at the counter: T1 is presented (no number) and paid cash + UPI; T2 gets a 15% discount a manager approves, then card.
    const c = counter;
    await c.signIn("Asha");
    expect(await T.present(c.rt.ctx, t1.checkId)).toEqual({ kind: "pre_bill", count: 1 });
    expect(rows<BillRow>(c.rt, "bill")).toHaveLength(0); // a pre-bill takes no number (ADR-0014 A1.5)
    const due1 = dueOf(c, t1.checkId);
    const b1 = await T.settle(c.rt.ctx, t1.checkId, { payments: [{ tender: "cash", amount_paise: Math.floor(due1 / 2) }, { tender: "upi", amount_paise: due1 - Math.floor(due1 / 2) }] });
    expect(b1.number).toBe("A07/2627/000001");
    const ap = await c.rt.identity.approve("m-meena", "3333", "bill.discount.over_limit", "m-asha");
    if (!ap.ok) throw new Error("approval");
    await T.applyDiscount(c.rt.ctx, { checkId: t2.checkId, kind: "percent", value: 1500, reasonCodeId: "rc-disc-complaint", approvalId: ap.approvalId });
    const b2 = await T.settle(c.rt.ctx, t2.checkId, { payments: [{ tender: "card", amount_paise: dueOf(c, t2.checkId) }] });
    expect(b2.number).toBe("A07/2627/000002");
    await T.reprintBill(c.rt.ctx, b2.billId);
    expect(c.rt.fakes.bill.printed.length).toBeGreaterThanOrEqual(4); // pre-bill, two bills, one duplicate

    // Afternoon counter sales; the manager credits a wrong item and re-bills T1's invoice with the customer's GSTIN (one op, two numbers).
    clock.minutes(120);
    const held = await T.newCounterCheck(c.rt.ctx);
    await T.addLine(c.rt.ctx, held, { itemId: "it-roast", qtyMilli: 1000 });
    const chai = await T.newCounterCheck(c.rt.ctx);
    await T.addLine(c.rt.ctx, chai, { itemId: "it-chai", qtyMilli: 3000 });
    const s3 = await T.settle(c.rt.ctx, chai, { payments: [{ tender: "cash", amount_paise: 6300, tendered_paise: 10000, change_paise: 3700 }] });
    expect(s3.number).toBe("A07/2627/000003");
    await c.signIn("Meena");
    const cn = await T.creditNote(c.rt.ctx, { billId: s3.billId, reasonCodeId: "rc-cn-wrong", refundTender: "cash" });
    expect(cn.number).toBe("C07/2627/000001");
    const rb = await T.rebillBill(c.rt.ctx, { billId: b1.billId, gstin: "33ABCDE1234F1Z5", reasonCodeId: "rc-cn-gstin" });
    expect(rb).toEqual({ credit: "C07/2627/000002", bills: ["A07/2627/000004"] });
    const rebillOp = (await c.rt.engine.opAt({ origin: c.rt.deviceId, stream: OUTLET_STREAM, seq: rows<OpRow>(c.rt, "_op").filter((o) => o.own && o.intent === "bill.rebill")[0]!.seq })) as OpEnvelope;
    expect(rebillOp.docs?.map((d) => d.number)).toEqual(["C07/2627/000002", "A07/2627/000004"]);
    await c.signIn("Asha");
    const heldDue = dueOf(c, held);
    expect(heldDue).toBe(10_000); // 95.00 + 5% = 99.75, rounded to the rupee
    expect((await T.settle(c.rt.ctx, held, { payments: [{ tender: "upi", amount_paise: heldDue }] })).number).toBe("A07/2627/000005");

    // BLACKOUT: the LAN is gone (wifi and power). The captain's tablet works alone; the KDS cannot hear it.
    await net.links({ hub: false });
    expect(captain.rt.sync.status().online).toBe(false);
    await captain.signIn("Ravi");
    const t3 = await T.openTableCheck(captain.rt.ctx, "tb-3");
    await T.addLine(captain.rt.ctx, t3.checkId, { itemId: "it-bajji", qtyMilli: 1000 });
    captain.rt.fakes.kitchen.failWith = "offline"; // the kitchen printer is on the dead LAN
    const [given] = await T.sendKot(captain.rt.ctx, t3.checkId);
    expect(captain.rt.fakes.hub.jobs().map((j) => j.id)).toContain(given); // queued, visible
    await T.handover(captain.rt.ctx, given!, "by_hand"); // ADR-0014 A1.6: the waiter walked the ticket to the kitchen
    captain.rt.fakes.hub.remove(KITCHEN_PRINTER, given!); // the queued original must never print
    expect(captain.rt.fakes.hub.jobs().filter((j) => j.id === given)).toHaveLength(0);
    clock.minutes(10);
    await T.addLine(captain.rt.ctx, t3.checkId, { itemId: "it-plain", qtyMilli: 1000 });
    const [stale] = await T.sendKot(captain.rt.ctx, t3.checkId); // sent, never handed over, and old by the time the LAN is back
    captain.rt.fakes.hub.remove(KITCHEN_PRINTER, stale!);
    clock.minutes(20);
    await T.addLine(captain.rt.ctx, t3.checkId, { itemId: "it-vada", qtyMilli: 1000 });
    const [recent] = await T.sendKot(captain.rt.ctx, t3.checkId);
    captain.rt.fakes.hub.remove(KITCHEN_PRINTER, recent!);
    captain.rt.fakes.kitchen.failWith = undefined;
    // Meanwhile the counter has a paper bill book: a page is typed in later by the manager, never renumbered.
    await c.signIn("Meena");
    const book = await T.bookEntry(c.rt.ctx, {
      number: "MB1/2627/000007",
      invoiceDate: "2026-11-24",
      bookTotalPaise: 8400,
      header: { order_type: "counter" },
      lines: [{ id: "paper-1", item_id: "it-dosa", name: "Masala Dosa", category_name: "Dosa", qty_milli: 1000, unit_price_paise: 8000, modifier_delta_paise: 0, tax_class: "fnb_standard" }],
    });
    expect(book.matchesBook).toBe(true);
    expect(rows(kds.rt, "kot").some((k) => (k as { id: string }).id === given)).toBe(false); // the KDS never heard of them

    // The LAN returns a minute after the last KOT. The printing device (the KDS station) sees what arrived.
    clock.minutes(1);
    await net.links({ hub: true });
    expect(T.ingestArrivedKot(kds.rt.ctx, recent!)).toBe("queued");
    expect(T.ingestArrivedKot(kds.rt.ctx, recent!)).toBe("already_handled"); // exactly once
    expect(T.ingestArrivedKot(kds.rt.ctx, given!)).toBe("late"); // handed over: never an original
    expect(T.ingestArrivedKot(kds.rt.ctx, stale!)).toBe("late"); // older than 15 minutes: held for a person
    expect(kds.rt.fakes.hub.lateTickets().map((t) => t.reason).sort()).toEqual(["handover", "stale"]);
    await kds.rt.fakes.hub.flush();
    expect(kds.rt.fakes.kitchen.printed).toHaveLength(1); // only the recent one
    expect(captain.rt.fakes.kitchen.printed.some((p) => JSON.stringify(p).includes("T3"))).toBe(false); // the tablet never printed a blackout original

    // Evening: the table that went through the blackout is billed at the counter; an open shift and an unbilled check block the day first.
    await c.signIn("Meena");
    expect(rows(c.rt, "check").some((r) => (r as { id: string }).id === t3.checkId)).toBe(true);
    await expect(T.closeDay(c.rt.ctx)).rejects.toMatchObject({ code: "day_blocked" });
    await T.settle(c.rt.ctx, t3.checkId, { payments: [{ tender: "cash", amount_paise: dueOf(c, t3.checkId) }] });
    const counted = T.expectedCashFor(list(c), c.rt.data.snapshot().get("shift", shiftId)!) - 100;
    const close = await T.closeShift(c.rt.ctx, shiftId, counted);
    expect(close.variancePaise).toBe(-100); // blind count: the cashier typed what they counted, the variance was computed after
    const z = await T.closeDay(c.rt.ctx);

    // Still no internet: the cloud has seen nothing, the hub holds everything, and the pending counts are honest.
    expect(net.cloud.vector()[OUTLET_STREAM] ?? {}).toEqual({});
    expect(counter.rt.sync.status()).toMatchObject({ upstream: "hub", state: "pending" });

    // Evening: the hub's uplink returns. The interrupted round resumes; everything reaches the cloud and every device.
    net.cloud.inject({ call: "pull", when: "before" }); // a cut mid-round costs nothing: the next round resumes by version vector
    await net.settle();
    const ws = [counter, captain, kds];
    const hashes = await Promise.all(ws.map((w) => w.rt.engine.stateHash()));
    expect(new Set(hashes).size).toBe(1);
    for (const w of ws) expect(await w.rt.engine.vector()).toEqual(await counter.rt.engine.vector());
    expect(net.cloud.vector()[OUTLET_STREAM]).toEqual(await counter.rt.engine.vector());
    expect(counter.rt.sync.status()).toMatchObject({ state: "synced", pendingOps: 0, atHubOps: 0 });
    for (const w of ws) expect((await w.rt.engine.rows("business_day"))[0]).toMatchObject({ status: "closed" });

    for (const w of ws) {
      // Numbers: unique across the whole outlet, gapless in each device series, and the paper book is kept as written.
      expect(await seriesGaps(w.rt.store)).toEqual([]);
      const bills = rows<BillRow>(w.rt, "bill");
      const notes = rows<CreditNoteRow>(w.rt, "credit_note");
      const nums = [...bills.map((b) => `bill:${b.number}`), ...notes.map((n) => `cn:${n.number}`)];
      expect(new Set(nums).size).toBe(nums.length);
      const own = bills.map((b) => b.number).filter((n) => n.startsWith("A07/")).sort();
      expect(own).toEqual([1, 2, 3, 4, 5, 6].map((n) => `A07/2627/00000${n}`)); // T1, T2, a counter sale, the re-bill, a held sale, the blackout table
      expect(notes.map((n) => n.number).sort()).toEqual(["C07/2627/000001", "C07/2627/000002"]);
      expect(bills.find((b) => b.number === "MB1/2627/000007")).toMatchObject({ source_kind: "manual_book", total_paise: 8400 });
      // The Z-report equals the bills of the day, on every device.
      expect(z.billCount).toBe(bills.length);
      expect(z.totalPaise).toBe(bills.reduce((s, b) => s + b.total_paise, 0));
      expect(bills.every((b) => b.business_date === "2026-11-24")).toBe(true);
      const dc = rows<{ z_number: string; total_paise: number; bill_count: number }>(w.rt, "day_close");
      expect(dc).toHaveLength(1);
      expect(dc[0]).toMatchObject({ z_number: z.zNumber, total_paise: z.totalPaise, bill_count: z.billCount });
    }
    // The re-bill is whole everywhere: its credit note cites the original, its new bill replaces it.
    const rbBill = rows<BillRow>(kds.rt, "bill").find((b) => b.number === "A07/2627/000004")!;
    expect(rbBill).toMatchObject({ replaces_bill_id: b1.billId, customer_gstin: "33ABCDE1234F1Z5" });
    // The blackout KOTs reached the KDS, flagged as given by hand; the stale one never printed on its own.
    expect(rows(kds.rt, "kot_handover")).toHaveLength(1);

    // The next morning trades on the next date; the closed day is never reopened.
    clock.minutes(24 * 60);
    await counter.signIn("Meena");
    await T.newCounterCheck(counter.rt.ctx);
    const days = rows<{ business_date: string; status: string }>(counter.rt, "business_day");
    expect(days.find((d) => d.business_date === "2026-11-24")?.status).toBe("closed");
    expect(days.filter((d) => d.status === "open").map((d) => d.business_date)).toEqual(["2026-11-25"]);
  });

  it("a cut during a round, repeated deliveries and an interrupted push lose nothing (resume by version vector)", async () => {
    const net = await Net.create();
    const a = await net.add({ deviceKind: "pos", deviceCode: "A07" });
    await a.signIn("Asha");
    for (let i = 0; i < 6; i++) await T.newCounterCheck(a.rt.ctx);
    const total = (await a.rt.engine.vector())[a.rt.deviceId]!;
    net.hub.inject({ call: "push", when: "after" }); // the hub applies the push but the answer is lost
    await net.links({ hub: true });
    await net.links({ hub: true });
    expect(a.rt.sync.status()).toMatchObject({ pendingOps: 0, atHubOps: total, upstream: "hub" });
    expect(net.hub.vector()[OUTLET_STREAM]?.[a.rt.deviceId]).toBe(total); // applied once, not twice
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
