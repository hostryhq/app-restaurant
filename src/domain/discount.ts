/**
 * Discount rules (RM-D1 to D5, AC 101 to 112). A bill-level discount is compared with the outlet limit as an effective
 * percentage of the lines' net value; the limit itself is a strong-only online setting and is never edited here.
 */

export type DiscountDecision = "apply" | "own_pin" | "ask_manager" | "refuse" | "comp";

/** Effective discount in basis points of `baseNetPaise` (amount discounts are converted; percent is already bp). */
export function effectiveBp(kind: "percent" | "amount", value: number, baseNetPaise: number): number {
  if (kind === "percent") return value;
  if (baseNetPaise <= 0) return value > 0 ? 10_000 : 0;
  return Math.ceil((value * 10_000) / baseNetPaise);
}

export function decideDiscount(o: { bp: number; limitBp: number; canApply: boolean; canOverLimit: boolean }): DiscountDecision {
  if (!o.canApply) return "refuse"; // control is not shown without bill.discount.apply
  if (o.bp >= 10_000) return "comp";
  if (o.bp <= o.limitBp) return "apply";
  return o.canOverLimit ? "own_pin" : "ask_manager";
}

/** Percent typed by a person ("12.5") to basis points. Returns undefined for anything not a non-negative number. */
export function percentToBp(text: string): number | undefined {
  if (!/^\d{1,3}(\.\d{1,2})?$/.test(text.trim())) return undefined;
  const bp = Math.round(Number(text) * 100);
  return bp >= 0 && bp <= 10_000 ? bp : undefined;
}

/** A manager approval is valid for two minutes (RS08) and the approver must be someone other than the requester. */
export const APPROVAL_VALID_MS = 120_000;
export const isApprovalValid = (approvedAtMs: number, nowMs: number): boolean => nowMs - approvedAtMs <= APPROVAL_VALID_MS && nowMs >= approvedAtMs;
