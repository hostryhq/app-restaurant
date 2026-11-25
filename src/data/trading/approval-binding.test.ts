import { describe, expect, it } from "vitest";
import { approvalActionHash, boundValues, type OpEnvelope } from "@hostry/client-core";
import { OUTLET_STREAM, rows, world, type World } from "../../test/world";
import * as T from "./index";

/** Every op this device recorded, in order. */
async function ownOps(w: World): Promise<OpEnvelope[]> {
  const high = (await w.rt.engine.vector(OUTLET_STREAM))[w.rt.deviceId] ?? 0;
  const out: OpEnvelope[] = [];
  for (let seq = 1; seq <= high; seq++) out.push((await w.rt.engine.opAt({ origin: w.rt.deviceId, stream: OUTLET_STREAM, seq }))!);
  return out;
}

/** The rule of api-specs "Action hash": target = first inserted or set row of the citing op, values = the op's recorded `proof.binds` fields. */
const actionTargetOf = (op: OpEnvelope): string => {
  const m = op.muts.find((x) => x.k === "insert" || x.k === "set");
  return m ? `${m.e}:${m.id}` : "";
};

/**
 * Cashier asks, manager approves with the binding the screen built; the op is then recorded citing the approval. The approval
 * record must carry exactly the hash the gateway recomputes from the citing op (its target and recorded values).
 */
async function approvedHashMatchesOp(w: World, b: T.ApprovalBinding, act: (approvalId: string) => Promise<unknown>): Promise<void> {
  const ap = await w.rt.identity.approve("m-meena", "3333", b.permission, "m-asha", b);
  if (!ap.ok) throw new Error("approval");
  await act(ap.approvalId);
  const ops = await ownOps(w);
  const citing = ops.filter((o) => o.approval === ap.approvalId && o.intent === b.intent);
  expect(citing).toHaveLength(1);
  const op = citing[0]!;
  const grant = ops.find((o) => o.intent === "approval.grant" && o.approval === ap.approvalId)!;
  const rec = grant.muts[0]!;
  expect(rec.e).toBe("approval");
  const { values, missing } = boundValues(b.intent, op.muts);
  expect(missing).toEqual([]); // the op records every field the intent binds
  const target = actionTargetOf(op);
  expect(target).toBe(b.target);
  expect(values).toEqual(b.values);
  const expected = await approvalActionHash({ intent: b.intent, permission: b.permission, requester: "m-asha", target, approvalId: ap.approvalId, reason: b.reason, values });
  expect(rec.f?.action_hash).toBe(expected);
}

const list = (w: World) => (e: string) => w.rt.data.snapshot().list(e);

describe("every approval's action hash is the one the gateway recomputes from the citing op", () => {
  it("discount over limit, line comp, line cancel, bill cancel", async () => {
    const w = await world();
    await w.signIn("Asha");
    const checkId = await T.newCounterCheck(w.rt.ctx);
    const lineId = await T.addLine(w.rt.ctx, checkId, { itemId: "it-dosa", qtyMilli: 2000 });
    await approvedHashMatchesOp(w, T.discountBinding(checkId, "percent", 2000, "rc-disc-regular"), (approvalId) => T.applyDiscount(w.rt.ctx, { checkId, kind: "percent", value: 2000, reasonCodeId: "rc-disc-regular", approvalId }));
    await approvedHashMatchesOp(w, T.compBinding(lineId, "rc-comp-owner"), (approvalId) => T.compLine(w.rt.ctx, { lineId, reasonCodeId: "rc-comp-owner", approvalId }));

    const second = await T.newCounterCheck(w.rt.ctx);
    const sent = await T.addLine(w.rt.ctx, second, { itemId: "it-chai", qtyMilli: 3000 });
    await T.sendKot(w.rt.ctx, second);
    const kotId = w.rt.ctx.newId();
    await approvedHashMatchesOp(w, T.lineCancelBinding(kotId, sent, 2000, "rc-cancel-mind"), (approvalId) => T.cancelSentLine(w.rt.ctx, { lineId: sent, qtyMilli: 2000, reasonCodeId: "rc-cancel-mind", approvalId, kotId }));

    const cancelId = w.rt.ctx.newId();
    await approvedHashMatchesOp(w, T.billCancelBinding(cancelId, second, "rc-cancel-mind"), (approvalId) => T.cancelCheck(w.rt.ctx, second, "rc-cancel-mind", approvalId, cancelId));
  });

  it("credit note (with its planned total), credit-and-reopen and refund", async () => {
    const w = await world();
    await w.signIn("Meena");
    await T.startShift(w.rt.ctx, 0);
    const sale = async (item: string, qty: number, paid: boolean) => {
      const checkId = await T.newCounterCheck(w.rt.ctx);
      await T.addLine(w.rt.ctx, checkId, { itemId: item, qtyMilli: qty });
      const total = T.previewCheck(list(w), w.rt.ctx.outletId, checkId, w.rt.now())!.c.result.total_paise;
      return { ...(await T.settle(w.rt.ctx, checkId, { payments: paid ? [{ tender: "cash", amount_paise: total }] : [] })), total };
    };
    const paid = await sale("it-dosa", 2000, true);
    const unpaid = await sale("it-chai", 1000, false);
    await w.signIn("Asha");

    const part = { billId: paid.billId, reasonCodeId: "rc-cn-wrong", refundTender: "cash" as const };
    const cb = T.creditNoteBinding(w.rt.ctx, part);
    expect(cb.values.total_paise).toBe(paid.total); // no lines named: the whole bill
    await approvedHashMatchesOp(w, cb, (approvalId) => T.creditNote(w.rt.ctx, { ...part, approvalId, noteId: cb.noteId }));
    expect(rows<{ id: string }>(w.rt, "credit_note").some((n) => n.id === cb.noteId)).toBe(true);

    const re = T.creditNoteBinding(w.rt.ctx, { billId: unpaid.billId, reasonCodeId: "rc-cn-wrong", refundTender: "adjusted" });
    await approvedHashMatchesOp(w, re, (approvalId) => T.creditAndReopen(w.rt.ctx, { billId: unpaid.billId, reasonCodeId: "rc-cn-wrong", approvalId, noteId: re.noteId }));

    const pay = rows<{ id: string; bill_id: string }>(w.rt, "payment")[0]!;
    const refundId = w.rt.ctx.newId();
    await approvedHashMatchesOp(w, T.refundBinding(refundId, pay.bill_id, pay.id, 500, "rc-cn-wrong"), (approvalId) => T.refundPayment(w.rt.ctx, { paymentId: pay.id, amountPaise: 500, reasonCodeId: "rc-cn-wrong", approvalId, refundId }));
  });
});
