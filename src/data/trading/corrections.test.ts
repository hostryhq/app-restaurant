import { describe, expect, it } from "vitest";
import { OUTLET_STREAM } from "../../runtime";
import { Net, rows, world, type World } from "../../test/world";
import type { Bill, Check, OrderLine } from "./test-types";
import * as T from "./index";

const list = (w: World) => (e: string) => w.rt.data.snapshot().list(e);
const sale = async (w: World, item: string, qty: number, tender: "cash" | "card" | "upi" | "none"): Promise<{ billId: string; number: string; checkId: string; total: number }> => {
  const checkId = await T.newCounterCheck(w.rt.ctx);
  await T.addLine(w.rt.ctx, checkId, { itemId: item, qtyMilli: qty });
  const total = T.previewCheck(list(w), "outlet-1", checkId, w.clock.now())!.c.result.total_paise;
  const r = await T.settle(w.rt.ctx, checkId, { payments: tender === "none" ? [] : [{ tender, amount_paise: total }] });
  return { ...r, checkId, total };
};

describe("RS19 refund a payment (payment.refund)", () => {
  it("returns money for a recorded payment, never more than was paid, and lowers the cash the drawer should hold", async () => {
    const w = await world();
    await w.signIn("Meena");
    const shiftId = await T.startShift(w.rt.ctx, 100_000);
    const s = await sale(w, "it-dosa", 2000, "cash");
    const pay = rows<{ id: string; amount_paise: number }>(w.rt, "payment")[0]!;
    const before = T.expectedCashFor(list(w), w.rt.data.snapshot().get("shift", shiftId)!);
    expect(before).toBe(100_000 + s.total);
    await expect(T.refundPayment(w.rt.ctx, { paymentId: pay.id, amountPaise: pay.amount_paise + 1, reasonCodeId: "rc-cn-wrong" })).rejects.toMatchObject({ code: "refused" });
    await T.refundPayment(w.rt.ctx, { paymentId: pay.id, amountPaise: 5_000, reasonCodeId: "rc-cn-wrong" });
    await expect(T.refundPayment(w.rt.ctx, { paymentId: pay.id, amountPaise: pay.amount_paise - 4_999, reasonCodeId: "rc-cn-wrong" })).rejects.toMatchObject({ code: "refused" }); // earlier refunds count
    expect(rows<Bill>(w.rt, "bill")).toHaveLength(1); // a refund never changes the bill
    expect(T.expectedCashFor(list(w), w.rt.data.snapshot().get("shift", shiftId)!)).toBe(before - 5_000);
    await T.closeShift(w.rt.ctx, shiftId, before - 5_000);
    const z = await T.closeDay(w.rt.ctx);
    expect(z.billCount).toBe(1);
    expect(rows<{ refund_total_paise: number }>(w.rt, "day_close")[0]?.refund_total_paise).toBe(5_000);
  });

  it("needs the permission: a cashier is refused, a manager's approval lets the cashier go ahead", async () => {
    const w = await world();
    await w.signIn("Meena");
    await T.startShift(w.rt.ctx, 0);
    await sale(w, "it-chai", 1000, "card");
    const pay = rows<{ id: string }>(w.rt, "payment")[0]!;
    await w.signIn("Asha");
    await expect(T.refundPayment(w.rt.ctx, { paymentId: pay.id, amountPaise: 100, reasonCodeId: "rc-cn-wrong" })).rejects.toBeInstanceOf(T.PermissionError);
    const ap = await w.rt.identity.approve("m-meena", "3333", "payment.refund", "m-asha");
    if (!ap.ok) throw new Error("approval");
    await T.refundPayment(w.rt.ctx, { paymentId: pay.id, amountPaise: 100, reasonCodeId: "rc-cn-wrong", approvalId: ap.approvalId });
    expect(rows(w.rt, "refund")).toHaveLength(1);
  });
});

describe("RS19 credit and reopen", () => {
  it("credits an unpaid invoice in full and puts its items on a new open bill, which gets the next number when billed", async () => {
    const w = await world();
    await w.signIn("Meena");
    const first = await sale(w, "it-dosa", 2000, "none");
    const r = await T.creditAndReopen(w.rt.ctx, { billId: first.billId, reasonCodeId: "rc-cn-wrong" });
    expect(r.credit).toBe("C07/2627/000001");
    const lines = rows<OrderLine>(w.rt, "order_line").filter((l) => l.check_id === r.checkId);
    expect(lines.map((l) => [l.item_id, l.qty_milli])).toEqual([["it-dosa", 2000]]);
    expect(rows<Check>(w.rt, "check").find((c) => c.id === r.checkId)?.status).toBe("open");
    expect(rows<Check>(w.rt, "check").find((c) => c.id === first.checkId)?.status).toBe("billed");
    const again = await T.settle(w.rt.ctx, r.checkId, { payments: [] });
    expect(again.number).toBe("A07/2627/000002");
    expect(again.totalPaise).toBe(first.total);
  });

  it("is refused on a paid bill (refund first) and for a cashier", async () => {
    const w = await world();
    await w.signIn("Meena");
    await T.startShift(w.rt.ctx, 0);
    const paid = await sale(w, "it-chai", 1000, "card");
    await expect(T.creditAndReopen(w.rt.ctx, { billId: paid.billId, reasonCodeId: "rc-cn-wrong" })).rejects.toMatchObject({ code: "refused" });
    expect(rows(w.rt, "credit_note")).toHaveLength(0); // nothing was credited
    await w.signIn("Asha");
    await expect(T.creditAndReopen(w.rt.ctx, { billId: paid.billId, reasonCodeId: "rc-cn-wrong" })).rejects.toBeInstanceOf(T.PermissionError);
  });
});

describe("RS21 late documents and Z revisions", () => {
  it("a bill from a device that was offline during the close keeps its date, shows as late, and the cloud's revision number appears and prints", async () => {
    const net = await Net.create();
    const one = await net.add({ deviceKind: "pos", deviceCode: "A07" });
    const two = await net.add({ deviceKind: "pos", deviceCode: "B3K" });
    await net.links({ hub: true }); // both have the menu and the open day
    await two.rt.links!.set({ hub: false }); // counter 2 loses the LAN

    await one.signIn("Meena");
    await sale(one, "it-chai", 1000, "card");
    await two.signIn("Meena");
    const late = await sale(two, "it-vada", 1000, "card");
    expect(late.number).toBe("B3K/2627/000001");

    await T.closeDay(one.rt.ctx); // counter 1 closes: it has never heard of counter 2's bill
    expect(T.lateDays(list(one))).toEqual([]);

    await net.links({ hub: true }); // counter 2 is back: its bill arrives after the close, dated the same day
    const days = T.lateDays(list(one));
    expect(days).toHaveLength(1);
    expect(days[0]).toMatchObject({ date: "2026-11-24", billNumbers: ["B3K/2627/000001"], noteNumbers: [], devices: [two.rt.deviceId], revisions: [] });
    expect(rows<Bill>(one.rt, "bill").find((b) => b.number === "B3K/2627/000001")?.business_date).toBe("2026-11-24");
    expect(rows<{ status: string }>(one.rt, "business_day")[0]?.status).toBe("closed"); // never reopened

    // The cloud numbers the revision (cloud-only intent day.revision.record); it reaches the LAN through the hub.
    const day = rows<{ id: string }>(one.rt, "business_day")[0]!;
    await net.cloud.emit(OUTLET_STREAM, "day.revision.record", [
      {
        e: "business_day_revision",
        id: "rev-1",
        k: "insert",
        f: { business_day_id: day.id, revision: 1, cause: "late_documents", origin_device_id: two.rt.deviceId, display_number: "Z/2026-11-24/A07/R1", gross_paise: 20_000, discount_paise: 0, net_paise: 20_000, service_charge_paise: 0, cgst_paise: 500, sgst_paise: 500, non_gst_paise: 0, round_off_paise: 0, total_paise: 21_000, bill_count: 2, credit_note_count: 0, refund_total_paise: 0, internal_consumption_paise: 0, tenders_json: JSON.stringify({ card: 21_000 }) },
      },
    ]);
    await net.settle();
    for (const w of [one, two]) expect(T.lateDays(list(w))[0]?.revisions.map((r) => r.display_number)).toEqual(["Z/2026-11-24/A07/R1"]);
    await T.printRevision(one.rt.ctx, "rev-1");
    const paper = one.rt.fakes.bill.printed.map((b) => Buffer.from(b).toString("latin1"));
    expect(paper[paper.length - 1]).toContain("Z/2026-11-24/A07/R1");
  });
});
