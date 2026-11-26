import type { RefundTender } from "@hostry/client-core";
import { planCreditNote, type RebillPlan } from "./billing";
import type { TradingCtx } from "./ctx";

/**
 * What a sensitive action's approval binds (api-specs sync "Action hash"): the intent, the permission, the `target` (the first
 * row the citing op inserts or sets, as `<entity>:<id>`), the reason and `values` (the fields the intent's `proof.binds`
 * names, as the op records them). One binding is built before the PIN is asked and the same ids and amounts are then used by
 * the op, so an approval for another row or amount cannot be used.
 */
export type ApprovalBinding = { permission: string; intent: string; target: string; reason: string; values: Record<string, unknown> };

/** `bill.discount.over_limit`: the check row is set with the discount fields. */
export const discountBinding = (checkId: string, kind: "percent" | "amount", value: number, reasonCodeId: string): ApprovalBinding => ({
  permission: "bill.discount.over_limit",
  intent: "bill.discount.over_limit",
  target: `check:${checkId}`,
  reason: reasonCodeId,
  values: { discount_kind: kind, discount_value: value },
});

/** `bill.line.comp`: the line row is set with `comp` and its reason. */
export const compBinding = (lineId: string, reasonCodeId: string): ApprovalBinding => ({
  permission: "bill.line.comp",
  intent: "bill.line.comp",
  target: `order_line:${lineId}`,
  reason: reasonCodeId,
  values: { comp: true, comp_reason_code_id: reasonCodeId },
});

/** `order.line.cancel`: the op's first row is the cancel ticket (`kot`); the cancellation row carries the line, quantity and reason. */
export const lineCancelBinding = (kotId: string, lineId: string, qtyMilli: number, reasonCodeId: string): ApprovalBinding => ({
  permission: "order.line.cancel",
  intent: "order.line.cancel",
  target: `kot:${kotId}`,
  reason: reasonCodeId,
  values: { order_line_id: lineId, qty_milli: qtyMilli, reason_code_id: reasonCodeId },
});

/** `bill.cancel`: the cancellation row, with the check and the reason. */
export const billCancelBinding = (cancelId: string, checkId: string, reasonCodeId: string): ApprovalBinding => ({
  permission: "bill.cancel",
  intent: "bill.cancel",
  target: `check_cancel:${cancelId}`,
  reason: reasonCodeId,
  values: { check_id: checkId, reason_code_id: reasonCodeId },
});

/** `payment.refund`: the refund row, with the bill, the payment and the amount returned. */
export const refundBinding = (refundId: string, billId: string, paymentId: string, amountPaise: number, reasonCodeId: string): ApprovalBinding => ({
  permission: "payment.refund",
  intent: "payment.refund",
  target: `refund:${refundId}`,
  reason: reasonCodeId,
  values: { bill_id: billId, payment_id: paymentId, amount_paise: amountPaise },
});

/**
 * `bill.rebill.approved` (a re-bill after payment or past the allowance): the approval is the sensitive permission of the credit note
 * (bill.credit_note.create) and binds the original bill, the rebill group, the value withdrawn (the credit note total) and the
 * replacement value, so it cannot be cited for another bill or a different replacement. The ids and totals come from the plan the op
 * then uses. Undefined when the re-bill is within the allowance (plain bill.rebill: a session proof only).
 */
export function rebillBinding(billId: string, reasonCodeId: string, plan: RebillPlan): ApprovalBinding | undefined {
  if (plan.approvalReason === undefined) return undefined;
  return {
    permission: "bill.credit_note.create",
    intent: "bill.rebill.approved",
    target: `credit_note:${plan.noteId}`,
    reason: reasonCodeId,
    values: { bill_id: billId, rebill_group_id: plan.rebillGroupId, total_paise: plan.creditTotalPaise, replacement_total_paise: plan.replacementTotalPaise },
  };
}

/** `creditnote.issue` (a credit note, or the credit of credit-and-reopen): the credit note row, with the bill and its total. The total is calculated here exactly as the issue will. */
export function creditNoteBinding(ctx: TradingCtx, o: { billId: string; lines?: Array<{ bill_line_id: string; qty_milli: number }>; reasonCodeId: string; refundTender: RefundTender }): ApprovalBinding & { noteId: string } {
  const plan = planCreditNote(ctx, o);
  return { permission: "bill.credit_note.create", intent: "creditnote.issue", target: `credit_note:${plan.noteId}`, reason: o.reasonCodeId, values: { bill_id: o.billId, total_paise: plan.totalPaise }, noteId: plan.noteId };
}
