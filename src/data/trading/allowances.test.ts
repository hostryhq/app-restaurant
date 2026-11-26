import { describe, expect, it } from "vitest";
import type { OriginalBill } from "@hostry/client-core";
import { DEMO_MEMBERS, ROLE_PERMS } from "../../fixtures/demo-pack";
import { world, rows, type World } from "../../test/world";
import type { Bill } from "./test-types";
import * as T from "./index";

/** Phase 1 ruling 8 / P2-H2: re-bill and grace-cancel allowances on the device. Asha is a cashier who holds bill.rebill here. */
ROLE_PERMS["cashier_rebill"] = [...ROLE_PERMS["cashier"]!, "bill.rebill"];
const members = DEMO_MEMBERS.map((m) => (m.displayName === "Asha" ? { ...m, role: "cashier_rebill" } : m));

const list = (w: World) => (e: string) => w.rt.data.snapshot().list(e);
const numbered = async (w: World, item: string, qty: number, pay: boolean): Promise<string> => {
  const c = await T.newCounterCheck(w.rt.ctx);
  await T.addLine(w.rt.ctx, c, { itemId: item, qtyMilli: qty });
  const total = T.previewCheck(list(w), w.rt.ctx.outletId, c, w.clock.now())!.c.result.total_paise;
  return (await T.settle(w.rt.ctx, c, { payments: pay ? [{ tender: "cash", amount_paise: total }] : [] })).billId;
};
const latest = (w: World): string => rows<Bill>(w.rt, "bill").at(-1)!.id;
const scaled = (f: (q: number) => number) => (o: OriginalBill) => {
  const r = T.replacementFor(o, {});
  return [{ ...r, lines: r.lines.map((l) => ({ ...l, qty_milli: f(l.qty_milli) })) }];
};

describe("re-bill allowance (RM-A11, ruling 8)", () => {
  it("F29: after a payment a manager's own session is not enough: the re-bill cites an approval and is bill.rebill.approved", async () => {
    const w = await world({ members });
    await w.signIn("Meena");
    await T.startShift(w.rt.ctx, 0);
    const bill = await numbered(w, "it-dosa", 2000, true);
    const input = { billId: bill, gstin: "33ABCDE1234F1Z5", reasonCodeId: "rc-cn-gstin" };
    await expect(T.rebillBill(w.rt.ctx, input)).rejects.toMatchObject({ code: "approval_needed" });
    expect(rows(w.rt, "credit_note")).toHaveLength(0);
    const plan = T.planRebill(w.rt.ctx, input);
    const ap = await w.rt.identity.approve("m-anand", "4444", "bill.credit_note.create", "m-meena", T.rebillBinding(bill, input.reasonCodeId, plan)!);
    if (!ap.ok) throw new Error("approval");
    await T.rebillBill(w.rt.ctx, { ...input, plan, approvalId: ap.approvalId });
    const ops = rows<{ intent: string; own: boolean; approval?: string }>(w.rt, "_op");
    expect(ops.filter((o) => o.intent === "bill.rebill.approved" && o.approval === ap.approvalId)).toHaveLength(1);
  });

  it("a cashier cannot re-bill once a payment is recorded; a manager needs a cited approval", async () => {
    const w = await world({ members });
    await w.signIn("Asha");
    await T.startShift(w.rt.ctx, 0);
    const bill = await numbered(w, "it-dosa", 2000, true);
    await expect(T.rebillBill(w.rt.ctx, { billId: bill, gstin: "33ABCDE1234F1Z5", reasonCodeId: "rc-cn-gstin" })).rejects.toMatchObject({ code: "approval_needed" });
    expect(rows(w.rt, "credit_note")).toHaveLength(0);
    await w.signIn("Meena");
    await expect(T.rebillBill(w.rt.ctx, { billId: bill, gstin: "33ABCDE1234F1Z5", reasonCodeId: "rc-cn-gstin" })).rejects.toMatchObject({ code: "approval_needed" });
  });

  it("is counted per shift: the fourth unpaid re-bill needs a manager", async () => {
    const w = await world({ members });
    await w.signIn("Asha");
    await T.startShift(w.rt.ctx, 0);
    let bill = await numbered(w, "it-chai", 1000, false);
    for (let i = 0; i < 3; i++) {
      await T.rebillBill(w.rt.ctx, { billId: bill, gstin: "33ABCDE1234F1Z5", reasonCodeId: "rc-cn-gstin" });
      bill = latest(w);
    }
    await expect(T.rebillBill(w.rt.ctx, { billId: bill, gstin: "33ABCDE1234F1Z5", reasonCodeId: "rc-cn-gstin" })).rejects.toMatchObject({ code: "approval_needed" });
  });

  it("a re-bill that lowers the value counts against the comp and discount limit", async () => {
    const w = await world({ members });
    await w.signIn("Asha");
    await T.startShift(w.rt.ctx, 0);
    const bill = await numbered(w, "it-meal", 10_000, false); // 10 meals, over the 50,000 paise comp allowance
    await expect(T.rebillBill(w.rt.ctx, { billId: bill, reasonCodeId: "rc-cn-wrong", replacements: scaled((q) => q / 2) })).rejects.toMatchObject({ code: "approval_needed" });
    await expect(T.rebillBill(w.rt.ctx, { billId: bill, reasonCodeId: "rc-cn-wrong", replacements: scaled((q) => q - 1000) })).resolves.toBeDefined(); // one meal off: inside the limit
  });
});

describe("grace cancel (order.line.cancel.grace, ruling 8)", () => {
  const sentLine = async (w: World): Promise<{ checkId: string; lineId: string }> => {
    const c = await T.newCounterCheck(w.rt.ctx);
    await T.addLine(w.rt.ctx, c, { itemId: "it-dosa", qtyMilli: 1000 });
    await T.sendKot(w.rt.ctx, c);
    return { checkId: c, lineId: rows<{ id: string }>(w.rt, "order_line")[0]!.id };
  };

  it("works inside the window on a line the kitchen has not started", async () => {
    const w = await world({ members });
    await w.signIn("Ravi");
    const { lineId } = await sentLine(w);
    await T.cancelSentLine(w.rt.ctx, { lineId, qtyMilli: 1000, reasonCodeId: "rc-cancel-mind", grace: true });
    expect(rows<{ kind: string }>(w.rt, "order_line_cancel")[0]?.kind).toBe("grace_cancel");
  });

  it("is refused on a presented check", async () => {
    const w = await world({ members });
    await w.signIn("Asha");
    const { checkId, lineId } = await sentLine(w);
    await T.present(w.rt.ctx, checkId);
    await expect(T.cancelSentLine(w.rt.ctx, { lineId, qtyMilli: 1000, reasonCodeId: "rc-cancel-mind", grace: true })).rejects.toMatchObject({ code: "approval_needed" });
  });
});
