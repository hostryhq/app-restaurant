import type { BillRow } from "@hostry/client-core";
import type { OpRow, OrderLine, Shift } from "../../domain/rows";
import { settingsFrom } from "../context";
import { holds, TradingError, type ListFn, type TradingCtx } from "./ctx";

/**
 * Per-shift allowance accounting (Phase 1 ruling 8, P2-H2). Every figure is derived from the op log and the stored rows,
 * never typed. The device checks here; the owning service repeats the checks as detectors (offline devices may each use
 * the allowance, accepted by the ruling provided the detector alerts the owner).
 */

export const GRACE_DEFAULT_SECONDS = 120;
export const GRACE_PER_MEMBER_PER_SHIFT = 5;

type MoneyRow = { id: string; total_paise: number };

/** Ops since the open shift began. Without an open shift nothing counts as used. */
export function shiftOps(list: ListFn, shift: Shift | undefined): OpRow[] {
  return shift ? (list("_op") as OpRow[]).filter((o) => o.at >= shift.opened_at) : [];
}

/** A manager's say-so: an approval id, or a session that itself holds the over-limit permission. */
export const managerCleared = (ctx: TradingCtx, approvalId?: string): boolean => !!approvalId || holds(ctx, "bill.discount.over_limit");

/** Re-bills recorded in this shift (every device whose ops reached this one). */
export const rebillCount = (ops: OpRow[]): number => ops.filter((o) => o.intent === "bill.rebill").length;

/** Value a re-bill op took off the bills: the credit note total less the replacement totals (never below 0). */
export function rebillReduction(list: ListFn, op: OpRow): number {
  const notes = list("credit_note") as unknown as MoneyRow[];
  const bills = list("bill") as unknown as MoneyRow[];
  const credited = op.muts.filter((m) => m.e === "credit_note").reduce((s, m) => s + (notes.find((n) => n.id === m.id)?.total_paise ?? 0), 0);
  const billed = op.muts.filter((m) => m.e === "bill").reduce((s, m) => s + (bills.find((b) => b.id === m.id)?.total_paise ?? 0), 0);
  return Math.max(0, credited - billed);
}

/** Value of lines comped in this shift, from the line snapshots. */
export function compedValue(list: ListFn, ops: OpRow[]): number {
  const ids = new Set(ops.filter((o) => o.intent === "bill.line.comp").flatMap((o) => o.muts.filter((m) => m.e === "order_line").map((m) => m.id)));
  return (list("order_line") as OrderLine[]).filter((l) => ids.has(l.id)).reduce((s, l) => s + Math.round(((l.unit_price_paise + l.modifier_delta_paise) * l.qty_milli) / 1000), 0);
}

/** What the shift has already taken off sales by comp or value-reducing re-bill: usage of the one shared limit. */
export function reductionUsed(list: ListFn, ops: OpRow[]): number {
  return compedValue(list, ops) + ops.filter((o) => o.intent === "bill.rebill").reduce((s, o) => s + rebillReduction(list, o), 0);
}

/**
 * The device-side refusals for a re-bill, unless a manager clears it: any payment recorded on the bill; the shift's
 * re-bill count reached; or a reduction that, with what comps and earlier re-bills already took, passes the larger of
 * the comp allowance and the discount limit on this bill.
 */
export function checkRebill(ctx: TradingCtx, list: ListFn, shift: Shift | undefined, bill: Pick<BillRow, "total_paise">, paidPaise: number, replacementTotal: number, approvalId?: string): void {
  if (managerCleared(ctx, approvalId)) return;
  const s = settingsFrom(list);
  if (paidPaise > 0) throw new TradingError("approval_needed", "bill.rebill after payment");
  const ops = shiftOps(list, shift);
  if (rebillCount(ops) >= s.rebill_allowance_per_shift) throw new TradingError("approval_needed", "bill.rebill shift count");
  const reduction = Math.max(0, bill.total_paise - replacementTotal);
  if (reduction > 0) {
    const limit = Math.max(s.comp_allowance_paise, Math.floor((bill.total_paise * s.discount_limit_bp) / 10_000));
    if (reductionUsed(list, ops) + reduction > limit) throw new TradingError("approval_needed", "bill.rebill reduces the bill beyond the discount and comp limits");
  }
}

/** Grace cancel: the line is `new` as the device received it, inside the window, the check not presented, under the member's shift limit. */
export function checkGrace(ctx: TradingCtx, list: ListFn, shift: Shift | undefined, line: { check_id: string }, kotLine: { id: string; status: string } | undefined): void {
  if (!kotLine || kotLine.status !== "new") throw new TradingError("approval_needed", "grace cancel needs a line the kitchen has not started");
  if ((list("check_present") as unknown as Array<{ check_id: string }>).some((p) => p.check_id === line.check_id)) throw new TradingError("approval_needed", "no grace cancel on a presented check");
  const sentOp = (list("_op") as OpRow[]).find((o) => o.muts.some((m) => m.e === "kot_line" && m.id === kotLine.id));
  const windowMs = (Number(list("outlet_settings")[0]?.cancel_grace_seconds ?? GRACE_DEFAULT_SECONDS) || 0) * 1000;
  if (!sentOp || ctx.now() - Date.parse(sentOp.at) > windowMs) throw new TradingError("approval_needed", "grace window passed");
  const me = ctx.session()?.memberId;
  const mine = shiftOps(list, shift).filter((o) => o.intent === "order.line.cancel.grace" && o.actor === me).length;
  if (mine >= GRACE_PER_MEMBER_PER_SHIFT) throw new TradingError("approval_needed", "grace cancel limit for this shift");
}
