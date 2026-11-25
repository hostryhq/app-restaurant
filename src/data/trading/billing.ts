import {
  billMutations,
  computeCheck,
  creditNoteMutations,
  finalizeBill,
  fullCredit,
  istDateOf,
  issueCreditNote,
  manualBookEntry,
  presentCheck,
  rebill,
  rebillMutations,
  toBillDoc,
  toCreditNoteDoc,
  triggerForPresent,
  type BillableLine,
  type BillDoc,
  type BillLineRow,
  type BillRow,
  type Business,
  type CheckHeader,
  type Computation,
  type CreditNoteLineRow,
  type CreditNoteRow,
  type ManualEntryInput,
  type Mutation,
  type OriginalBill,
  type PaymentInput,
  type PaymentRow,
  type RefundTender,
  type Replacement,
  type TaxLineRow,
} from "@hostry/client-core";
import { decideDiscount, effectiveBp, type DiscountDecision } from "../../domain/discount";
import { liveQty, toBillable, toHeader } from "../../domain/lines";
import type { Check, CheckPresent, OrderLine, OrderLineCancel, OpRow, Shift } from "../../domain/rows";
import { billingContextFrom, settingsFrom } from "../context";
import { BILL_PRINTER } from "./bill-printer";
import { checkOf, depsFor, holds, liveLines, need, requireDay, TradingError, isoNow, type ListFn, type TradingCtx } from "./ctx";
import { newCounterCheck, orderIdOf } from "./orders";
import { sendKot, ackPrinted } from "./kitchen";
import { tableLabelOf } from "./kitchen";

const GSTIN_RE = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/;

export function businessFrom(list: ListFn): Business {
  const p = (list("receipt_profile")[0] ?? {}) as { trade_name?: string; address?: string; gstin?: string };
  const t = (list("outlet_tax_profile")[0] ?? {}) as { fssai_number?: string };
  const b: Business = { name: p.trade_name ?? "Restaurant" };
  if (p.address) b.addressLines = [p.address];
  if (p.gstin) b.gstin = p.gstin;
  if (t.fssai_number) b.fssai = t.fssai_number;
  return b;
}

/** The figures on screen for a check, from the same calculation the bill will use (so Present and Pay never disagree). */
export function previewCheck(list: ListFn, outletId: string, checkId: string, nowMs: number): { c: Computation; lines: OrderLine[]; check: Check } | undefined {
  const check = (list("check") as Check[]).find((x) => x.id === checkId);
  if (!check) return undefined;
  const lines = liveLines(list, checkId);
  if (lines.length === 0) return undefined;
  const ctx = billingContextFrom(list, outletId);
  return { c: computeCheck(ctx, toHeader(check), lines.map(toBillable), istDateOf(nowMs)), lines, check };
}

export function loadOriginal(list: ListFn, billId: string): OriginalBill {
  const bill = (list("bill") as unknown as BillRow[]).find((b) => b.id === billId);
  if (!bill) throw new TradingError("not_found", `bill ${billId}`);
  const lines = (list("bill_line") as unknown as BillLineRow[]).filter((l) => l.bill_id === billId).sort((a, b) => a.line_no - b.line_no);
  const taxLines = (list("bill_tax_line") as unknown as Array<TaxLineRow & { bill_id: string }>)
    .filter((t) => t.bill_id === billId)
    .map(({ bill_id, ...t }) => ({ ...t, owner_id: bill_id }));
  return { bill, lines, taxLines };
}

export function paymentsOf(list: ListFn, billId: string): PaymentRow[] {
  return (list("payment") as unknown as PaymentRow[]).filter((p) => p.bill_id === billId);
}

export const paidOf = (list: ListFn, billId: string): number => paymentsOf(list, billId).reduce((s, p) => s + p.amount_paise, 0);

/** Next credit quantities already used per bill line, from earlier credit notes. */
export function previouslyCredited(list: ListFn, billId: string): Record<string, number> {
  const notes = new Set((list("credit_note") as unknown as CreditNoteRow[]).filter((n) => n.bill_id === billId).map((n) => n.id));
  const out: Record<string, number> = {};
  for (const l of list("credit_note_line") as unknown as CreditNoteLineRow[]) if (notes.has(l.credit_note_id)) out[l.bill_line_id] = (out[l.bill_line_id] ?? 0) + l.qty_milli;
  return out;
}

export function openShift(list: ListFn): Shift | undefined {
  return (list("shift") as Shift[]).find((s) => s.status === "open");
}

function discountApproved(list: ListFn, checkId: string): boolean {
  return (list("_op") as OpRow[]).some((o) => o.intent === "bill.discount.over_limit" && o.muts.some((m) => m.e === "check" && m.id === checkId));
}

// ---- Present, bill please ----------------------------------------------------------------------------------------

export async function billPlease(ctx: TradingCtx, checkId: string): Promise<void> {
  need(ctx, "bill.request");
  const check = checkOf((e) => ctx.data.snapshot().list(e), checkId);
  await ctx.data.write({ intent: "bill.request", build: (b) => [{ e: "bill_request", id: b.newId(), k: "insert", f: { check_id: checkId, ...(check.seating_id ? { seating_id: check.seating_id } : {}) } }] });
}

/**
 * Present (ADR-0014 A1.5): record the unnumbered pre-bill and print it. In an outlet set to `print` the first Present IS
 * the finalisation, so it issues the numbered invoice instead (`triggerForPresent`).
 */
export async function present(ctx: TradingCtx, checkId: string, mode: "printed" | "displayed" = "printed"): Promise<{ kind: "pre_bill"; count: number } | { kind: "invoice"; billId: string; number: string }> {
  need(ctx, "bill.present");
  const snap = ctx.data.snapshot();
  const list: ListFn = (e) => snap.list(e);
  const settings = settingsFrom(list);
  if (triggerForPresent(settings.number_at) === "finalize") {
    const r = await settle(ctx, checkId, { payments: [] });
    return { kind: "invoice", billId: r.billId, number: r.number };
  }
  const check = checkOf(list, checkId);
  const lines = liveLines(list, checkId);
  const count = snap.list<CheckPresent>("check_present").filter((p) => p.check_id === checkId).length + 1;
  const bctx = billingContextFrom(list, ctx.outletId);
  const waiter = check.waiter_id ? ctx.nameOf(check.waiter_id) : undefined;
  const r = presentCheck(bctx, toHeader(check) as CheckHeader & { id: string }, lines.map(toBillable), {
    presentCount: count,
    mode,
    nowMs: ctx.now(),
    newId: ctx.newId,
    businessName: businessFrom(list).name,
    tableLabel: tableLabelOf(list, check),
    ...(waiter ? { waiter } : {}),
  });
  await ctx.data.write({ intent: "bill.present", build: () => [{ e: "check_present", id: r.row.id, k: "insert", f: { check_id: checkId, present_count: count, content_hash: r.row.content_hash, total_paise: r.row.total_paise, mode } }] });
  if (mode === "printed" && ctx.print.has(BILL_PRINTER)) {
    ctx.print.print(BILL_PRINTER, r.doc, { jobId: r.row.id, trigger: "manual" });
    await ctx.print.flush();
  }
  return { kind: "pre_bill", count };
}

// ---- Customer, discounts, charges ----------------------------------------------------------------------------------

export const validGstin = (g: string): boolean => GSTIN_RE.test(g.trim().toUpperCase());

export async function setCustomer(ctx: TradingCtx, checkId: string, c: { name?: string; gstin?: string }): Promise<void> {
  need(ctx, "bill.customer_details.edit");
  if (c.gstin && !validGstin(c.gstin)) throw new TradingError("bad_gstin");
  await ctx.data.write({
    intent: "bill.customer_details.edit",
    // customer_name and customer_gstin are pii fields of `check`: the engine moves them out of the op body by schema.
    build: () => [{ e: "check", id: checkId, k: "set", f: { ...(c.name !== undefined ? { customer_name: c.name } : {}), ...(c.gstin ? { customer_gstin: c.gstin.trim().toUpperCase() } : {}) } }],
  });
}

export async function removeServiceCharge(ctx: TradingCtx, checkId: string): Promise<void> {
  need(ctx, "bill.service_charge.remove");
  await ctx.data.write({ intent: "bill.service_charge.remove", build: () => [{ e: "check", id: checkId, k: "set", f: { service_charge_removed: true } }] });
}

/** What a discount of this size needs from this member (RS16): apply, own PIN, or a manager. */
export function discountDecision(ctx: TradingCtx, checkId: string, kind: "percent" | "amount", value: number): DiscountDecision {
  const list: ListFn = (e) => ctx.data.snapshot().list(e);
  const lines = liveLines(list, checkId);
  const base = lines.reduce((s, l) => s + Math.round(((l.unit_price_paise + l.modifier_delta_paise) * l.qty_milli) / 1000), 0);
  const bp = effectiveBp(kind, value, base);
  return decideDiscount({ bp, limitBp: settingsFrom(list).discount_limit_bp, canApply: holds(ctx, "bill.discount.apply"), canOverLimit: holds(ctx, "bill.discount.over_limit") });
}

/**
 * Bill-level discount (RM-D1). Within the limit it needs `bill.discount.apply`; above it, `bill.discount.over_limit` (own PIN
 * proof) or a manager's approval id. A billed check is not editable: use a credit note or Re-bill (AC 109).
 */
export async function applyDiscount(ctx: TradingCtx, o: { checkId: string; kind: "percent" | "amount"; value: number; reasonCodeId: string; approvalId?: string }): Promise<DiscountDecision> {
  const decision = discountDecision(ctx, o.checkId, o.kind, o.value);
  const check = checkOf((e) => ctx.data.snapshot().list(e), o.checkId);
  if (check.status !== "open") throw new TradingError("not_open", "bill already issued: use Credit note or Re-bill");
  if (decision === "refuse") throw new TradingError("refused", "no discount permission");
  const over = decision === "own_pin" || decision === "ask_manager" || decision === "comp";
  if (decision === "ask_manager" && !o.approvalId) throw new TradingError("approval_needed", "bill.discount.over_limit");
  need(ctx, over ? "bill.discount.over_limit" : "bill.discount.apply", o.approvalId);
  await ctx.data.write({
    intent: over ? "bill.discount.over_limit" : "bill.discount.apply",
    ...(o.approvalId ? { approval: o.approvalId } : {}),
    build: () => [{ e: "check", id: o.checkId, k: "set", f: { discount_kind: o.kind, discount_value: o.value, discount_reason_code_id: o.reasonCodeId } }],
  });
  return decision;
}

/** Comp a line (RM-D3): needs `bill.line.comp` or a manager's approval. */
export async function compLine(ctx: TradingCtx, o: { lineId: string; reasonCodeId: string; approvalId?: string }): Promise<void> {
  need(ctx, "bill.line.comp", o.approvalId);
  await ctx.data.write({ intent: "bill.line.comp", ...(o.approvalId ? { approval: o.approvalId } : {}), build: () => [{ e: "order_line", id: o.lineId, k: "set", f: { comp: true, comp_reason_code_id: o.reasonCodeId } }] });
}

// ---- Settle ---------------------------------------------------------------------------------------------------------

export type SettleResult = { billId: string; number: string; totalPaise: number; changePaise: number };

/**
 * Settle (RS15): number the bill, record its payments and move the check to billed in one local op (bill.finalize). The
 * invoice number is taken here, in the same transaction (ADR-0002 S7). With no payments this is "Issue invoice". A counter
 * order sends its unsent lines to the kitchen first. Printing and the drawer never hold the screen: a failed print stays in
 * the queue (RS17) and the bill is settled anyway.
 */
export async function settle(ctx: TradingCtx, checkId: string, o: { payments: PaymentInput[]; customerGstin?: string; customerName?: string }): Promise<SettleResult> {
  need(ctx, "bill.finalize");
  const snap0 = ctx.data.snapshot();
  const list0: ListFn = (e) => snap0.list(e);
  const settings = settingsFrom(list0);
  const check0 = checkOf(list0, checkId);
  if (check0.status !== "open") throw new TradingError("not_open", checkId);
  const usesCash = o.payments.some((p) => p.tender === "cash");
  if (usesCash && settings.shift_required && !openShift(list0)) throw new TradingError("no_open_shift");
  requireDay(list0);
  if (o.customerGstin && !validGstin(o.customerGstin)) throw new TradingError("bad_gstin");

  if (check0.order_type !== "dine_in") {
    const drafts = snap0.list<OrderLine>("order_line").filter((l) => l.check_id === checkId && l.state === "draft" && liveQty(l, snap0.list<OrderLineCancel>("order_line_cancel")) > 0);
    if (drafts.length) await sendKot(ctx, checkId);
  }
  if (o.customerGstin || o.customerName) await setCustomer(ctx, checkId, { ...(o.customerName ? { name: o.customerName } : {}), ...(o.customerGstin ? { gstin: o.customerGstin } : {}) });

  let billId = "";
  let result!: { number: string; total: number };
  // Read before the write, from the snapshot: inside the engine's transaction the op log is not a table, and the waiter of a
  // check is provenance the snapshot adds from the op log.
  const approved = discountApproved(list0, checkId);
  await ctx.data.write({
    intent: "bill.finalize",
    build: (b) => {
      const list = b.list;
      const check = { ...checkOf(list, checkId), ...(check0.waiter_id ? { waiter_id: check0.waiter_id } : {}) };
      const lines = liveLines(list, checkId);
      const bctx = billingContextFrom(list, ctx.outletId);
      const f = finalizeBill(depsFor(b), bctx, toHeader(check), lines.map(toBillable), { payments: o.payments, discountApproved: approved });
      billId = f.bill.id;
      result = { number: f.bill.number, total: f.bill.total_paise };
      const muts: Mutation[] = billMutations(f);
      const siblings = (b.list("check") as Check[]).filter((c) => c.seating_id !== undefined && c.seating_id === check.seating_id && c.id !== check.id && c.status === "open");
      if (check.seating_id && siblings.length === 0) muts.push({ e: "seating", id: check.seating_id, k: "rank", f: { status: "billed" } });
      return muts;
    },
  });
  const change = o.payments.reduce((s, p) => s + (p.change_paise ?? 0), 0);
  await printBill(ctx, billId);
  if (usesCash) await ctx.print.openDrawer().catch(() => undefined);
  return { billId, number: result.number, totalPaise: result.total, changePaise: change };
}

/** Prints (or reprints, as a numbered DUPLICATE with a copy count) a bill. Never throws on a printer fault. */
export async function printBill(ctx: TradingCtx, billId: string, duplicate?: { copy: number }): Promise<void> {
  const list: ListFn = (e) => ctx.data.snapshot().list(e);
  const o = loadOriginal(list, billId);
  const check = o.bill.check_id ? (list("check") as Check[]).find((c) => c.id === o.bill.check_id) : undefined;
  const waiter = o.bill.waiter_id ? ctx.nameOf(o.bill.waiter_id) : undefined;
  const cashier = ctx.session() ? ctx.nameOf(ctx.session()!.memberId) : undefined;
  const doc: BillDoc = toBillDoc(o.bill, o.lines, o.taxLines, paymentsOf(list, billId), {
    business: businessFrom(list),
    issuedAt: isoNow(ctx),
    ...(check ? { tableLabel: tableLabelOf(list, check) } : {}),
    ...(waiter ? { waiter } : {}),
    ...(cashier ? { cashier } : {}),
    ...(duplicate ? { duplicate: { copy: duplicate.copy, reprintedAt: isoNow(ctx) } } : {}),
  });
  if (!ctx.print.has(BILL_PRINTER)) return;
  ctx.print.print(BILL_PRINTER, doc, { jobId: duplicate ? `${billId}-dup-${duplicate.copy}` : billId, trigger: duplicate ? "manual" : "auto" });
  await ctx.print.flush();
}

/**
 * Reprint a bill: same number, marked DUPLICATE with the copy count (AC 119). Each reprint is an audit row (`bill.reprint`,
 * entity `bill_reprint`): the first reprint is row 1 and prints as Copy 2, because the original print is copy 1.
 */
export async function reprintBill(ctx: TradingCtx, billId: string): Promise<number> {
  need(ctx, "bill.reprint");
  const n = ctx.data.snapshot().list<{ bill_id: string }>("bill_reprint").filter((r) => r.bill_id === billId).length + 1;
  await ctx.data.write({ intent: "bill.reprint", build: (b) => [{ e: "bill_reprint", id: b.newId(), k: "insert", f: { bill_id: billId, copy_no: n, mode: "printed" } }] });
  await printBill(ctx, billId, { copy: n + 1 });
  return n + 1;
}

/** Take payment on an issued, not fully paid bill (payment.record). */
export async function recordPayment(ctx: TradingCtx, billId: string, payments: PaymentInput[]): Promise<void> {
  need(ctx, "payment.record");
  const list: ListFn = (e) => ctx.data.snapshot().list(e);
  const o = loadOriginal(list, billId);
  const total = payments.reduce((s, p) => s + p.amount_paise, 0);
  if (paidOf(list, billId) + total > o.bill.total_paise) throw new TradingError("payment_short", "more than the bill");
  if (payments.some((p) => p.tender === "cash") && settingsFrom(list).shift_required && !openShift(list)) throw new TradingError("no_open_shift");
  await ctx.data.write({
    intent: "payment.record",
    build: (b) =>
      payments.map((p): Mutation => ({
        e: "payment",
        id: b.newId(),
        k: "insert",
        f: { bill_id: billId, target_kind: "bill", tender: p.tender, amount_paise: p.amount_paise, ...(p.tendered_paise !== undefined ? { tendered_paise: p.tendered_paise } : {}), ...(p.change_paise !== undefined ? { change_paise: p.change_paise } : {}), ...(p.reference ? { reference: p.reference } : {}), business_date: requireDay(b.list) },
      })),
  });
  if (payments.some((p) => p.tender === "cash")) await ctx.print.openDrawer().catch(() => undefined);
}

// ---- Credit note, re-bill -------------------------------------------------------------------------------------------

/** Credit note for a numbered bill (RM-Y6): chosen lines and quantities, or the whole bill. Manager permission or approval. */
export async function creditNote(ctx: TradingCtx, o: { billId: string; lines?: Array<{ bill_line_id: string; qty_milli: number }>; reasonCodeId: string; refundTender: RefundTender; approvalId?: string }): Promise<{ number: string; totalPaise: number }> {
  need(ctx, "bill.credit_note.create", o.approvalId);
  let out!: { number: string; total: number };
  await ctx.data.write({
    intent: "creditnote.issue",
    ...(o.approvalId ? { approval: o.approvalId } : {}),
    build: (b) => {
      const original = loadOriginal(b.list, o.billId);
      const prev = previouslyCredited(b.list, o.billId);
      const cn = issueCreditNote(depsFor(b), billingContextFrom(b.list, ctx.outletId), original, {
        lines: o.lines ?? fullCredit(original, prev),
        reasonCodeId: o.reasonCodeId,
        refundTender: o.refundTender,
        previousCredited: prev,
      });
      out = { number: cn.note.number, total: cn.note.total_paise };
      return creditNoteMutations(cn);
    },
  });
  await printCreditNote(ctx, o.billId).catch(() => undefined);
  return { number: out.number, totalPaise: out.total };
}

async function printCreditNote(ctx: TradingCtx, billId: string): Promise<void> {
  const list: ListFn = (e) => ctx.data.snapshot().list(e);
  const notes = (list("credit_note") as unknown as CreditNoteRow[]).filter((n) => n.bill_id === billId);
  const n = notes[notes.length - 1];
  if (!n || !ctx.print.has(BILL_PRINTER)) return;
  const lines = (list("credit_note_line") as unknown as CreditNoteLineRow[]).filter((l) => l.credit_note_id === n.id);
  const taxLines = (list("credit_note_tax_line") as unknown as Array<TaxLineRow & { credit_note_id: string }>).filter((t) => t.credit_note_id === n.id).map(({ credit_note_id, ...t }) => ({ ...t, owner_id: credit_note_id }));
  ctx.print.print(BILL_PRINTER, toCreditNoteDoc(n, lines, taxLines, { business: businessFrom(list), issuedAt: isoNow(ctx), refundMode: n.refund_tender ?? "adjusted", reason: n.reason_code_id ?? "" }), { jobId: n.id, trigger: "auto" });
  await ctx.print.flush();
}

/** The replacement of a billed bill: same lines and discount as the original, with the new customer details. */
export function replacementFor(o: OriginalBill, header: Partial<CheckHeader>): Replacement {
  const lines: BillableLine[] = o.lines.map((l) => {
    const b: BillableLine = { id: l.id, item_id: l.item_id, name: l.item_name, category_name: l.category_name, qty_milli: l.qty_milli, unit_price_paise: l.unit_price_paise, modifier_delta_paise: l.modifier_delta_paise, tax_class: l.tax_class };
    if (l.category_id) b.category_id = l.category_id;
    if (l.hsn_sac) b.hsn_sac = l.hsn_sac;
    if (l.comp) b.comp = true;
    else if (l.line_discount_paise > 0) {
      b.discount_kind = "amount";
      b.discount_value = l.line_discount_paise;
    }
    return b;
  });
  const h: CheckHeader = { order_type: o.bill.order_type, ...(o.bill.token_no !== undefined ? { token_no: o.bill.token_no } : {}), ...header };
  if (o.bill.bill_discount_kind && o.bill.bill_discount_value !== undefined) {
    h.discount_kind = o.bill.bill_discount_kind;
    h.discount_value = o.bill.bill_discount_value;
  }
  return { header: h, lines };
}

/**
 * Re-bill (RS19): a full credit note and the replacement bill(s) in one op, so no device sees half of it. The common case
 * is adding a GSTIN after the invoice was issued. Needs `bill.rebill` or a manager's approval.
 */
export async function rebillBill(ctx: TradingCtx, o: { billId: string; gstin?: string; customerName?: string; reasonCodeId: string; approvalId?: string; replacements?: (orig: OriginalBill) => Replacement[] }): Promise<{ credit: string; bills: string[] }> {
  need(ctx, "bill.rebill", o.approvalId);
  if (o.gstin && !validGstin(o.gstin)) throw new TradingError("bad_gstin");
  let out!: { credit: string; bills: string[] };
  await ctx.data.write({
    intent: "bill.rebill",
    ...(o.approvalId ? { approval: o.approvalId } : {}),
    build: (b) => {
      const original = loadOriginal(b.list, o.billId);
      const reps = o.replacements ? o.replacements(original) : [replacementFor(original, { ...(o.gstin ? { customer_gstin: o.gstin.trim().toUpperCase() } : {}), ...(o.customerName ? { customer_name: o.customerName } : {}), ...(original.bill.customer_gstin && !o.gstin ? { customer_gstin: original.bill.customer_gstin } : {}) })];
      const r = rebill(depsFor(b), billingContextFrom(b.list, ctx.outletId), original, reps, { reasonCodeId: o.reasonCodeId, previousCredited: previouslyCredited(b.list, o.billId) });
      out = { credit: r.credit.note.number, bills: r.bills.map((x) => x.bill.number) };
      return rebillMutations(r);
    },
  });
  const list: ListFn = (e) => ctx.data.snapshot().list(e);
  const replacement = (list("bill") as unknown as BillRow[]).filter((b) => b.replaces_bill_id === o.billId);
  await printCreditNote(ctx, o.billId).catch(() => undefined);
  for (const b of replacement) await printBill(ctx, b.id);
  return out;
}

/** Paper bill-book page typed in after a power cut (RS31): manager only, never renumbered; a total mismatch is flagged. */
export async function bookEntry(ctx: TradingCtx, input: ManualEntryInput): Promise<{ matchesBook: boolean; billId: string }> {
  need(ctx, "bill.manual_entry");
  const maxBack = settingsFrom((e) => ctx.data.snapshot().list(e)).manual_entry_max_days_back;
  const daysBack = Math.round((Date.parse(`${istDateOf(ctx.now())}T00:00:00Z`) - Date.parse(`${input.invoiceDate}T00:00:00Z`)) / 86_400_000);
  if (daysBack < 0 || daysBack > maxBack) throw new TradingError("refused", `book entry is limited to ${maxBack} days back`);
  let out!: { matchesBook: boolean; billId: string };
  await ctx.data.write({
    intent: "bill.manual_entry",
    build: (b) => {
      const f = manualBookEntry(depsFor(b), billingContextFrom(b.list, ctx.outletId), input);
      out = { matchesBook: f.matchesBook, billId: f.bill.id };
      return billMutations(f);
    },
  });
  return out;
}

export { newCounterCheck, ackPrinted };

// ---- Refund, credit and reopen -----------------------------------------------------------------------------------

/**
 * Refund a payment (RS19, payment.refund): money returned for a recorded payment; it never changes the bill (use a credit note
 * for that). At most what was paid, less earlier refunds. Needs `payment.refund` or a manager's approval. A cash refund opens
 * the drawer and lowers the shift's expected cash.
 */
export async function refundPayment(ctx: TradingCtx, o: { paymentId: string; amountPaise: number; reasonCodeId: string; approvalId?: string }): Promise<{ refundId: string }> {
  need(ctx, "payment.refund", o.approvalId);
  const list: ListFn = (e) => ctx.data.snapshot().list(e);
  const pay = (list("payment") as unknown as PaymentRow[]).find((p) => p.id === o.paymentId);
  if (!pay) throw new TradingError("not_found", o.paymentId);
  const refunded = (list("refund") as unknown as Array<{ payment_id?: string; amount_paise: number }>).filter((r) => r.payment_id === pay.id).reduce((s, r) => s + r.amount_paise, 0);
  if (!Number.isInteger(o.amountPaise) || o.amountPaise < 1 || o.amountPaise + refunded > pay.amount_paise) throw new TradingError("refused", "a refund cannot be more than what was paid");
  const date = requireDay(list);
  const refundId = ctx.newId();
  await ctx.data.write({
    intent: "payment.refund",
    ...(o.approvalId ? { approval: o.approvalId } : {}),
    build: () => [{ e: "refund", id: refundId, k: "insert", f: { bill_id: pay.bill_id, payment_id: pay.id, amount_paise: o.amountPaise, tender: pay.tender, reason_code_id: o.reasonCodeId, business_date: date } }],
  });
  if (pay.tender === "cash") await ctx.print.openDrawer().catch(() => undefined);
  return { refundId };
}

const LINE_FIELDS = ["item_id", "variant_id", "variant_name", "name", "kitchen_name", "category_id", "category_name", "unit_price_paise", "modifier_delta_paise", "modifiers_text", "note", "seat_no", "tax_class", "hsn_sac", "station_code", "discount_kind", "discount_value", "discount_reason_code_id", "comp", "comp_reason_code_id"] as const;

/**
 * Credit and reopen (RS19): the correction for an invoice issued by mistake and not yet paid. A full credit note, then a new
 * open check with the same items, so the table or counter order can be billed again. Two ops, in this order: if the app stops
 * between them the credit note stands and the manager sees an uncredited-but-empty table, never a bill without its credit.
 * Refused on a bill with payments (refund those first).
 */
export async function creditAndReopen(ctx: TradingCtx, o: { billId: string; reasonCodeId: string; approvalId?: string }): Promise<{ credit: string; checkId: string }> {
  need(ctx, "bill.credit_note.create", o.approvalId);
  const list0: ListFn = (e) => ctx.data.snapshot().list(e);
  const original = loadOriginal(list0, o.billId);
  if (paidOf(list0, o.billId) > 0) throw new TradingError("refused", "a paid bill cannot be reopened: refund the payments first");
  if (!original.bill.check_id) throw new TradingError("refused", "no check to reopen");
  const check = checkOf(list0, original.bill.check_id);
  const kept = liveLines(list0, check.id);
  const modifiers = (list0("order_line_modifier") as unknown as Array<{ order_line_id: string; modifier_id: string; name: string; price_delta_paise: number }>).filter((m) => kept.some((l) => l.id === m.order_line_id));
  const cn = await creditNote(ctx, { billId: o.billId, reasonCodeId: o.reasonCodeId, refundTender: "adjusted", ...(o.approvalId ? { approvalId: o.approvalId } : {}) });
  let checkId: string;
  let orderId: string | undefined;
  if (check.order_type === "dine_in" && check.seating_id) {
    checkId = ctx.newId();
    const date = requireDay(list0);
    await ctx.data.write({ intent: "check.create", build: () => [{ e: "check", id: checkId, k: "insert", f: { seating_id: check.seating_id, order_type: "dine_in", label: "Reopened", business_date: date, status: "open" } }] });
    orderId = orderIdOf((e) => ctx.data.snapshot().list(e), check);
  } else {
    checkId = await newCounterCheck(ctx, check.order_type === "takeaway" ? "takeaway" : "counter");
    const fresh = checkOf((e) => ctx.data.snapshot().list(e), checkId);
    orderId = orderIdOf((e) => ctx.data.snapshot().list(e), fresh);
  }
  if (!orderId) throw new TradingError("not_found", "order");
  const order = orderId;
  await ctx.data.write({
    intent: "order.line.add",
    build: (b) => {
      const muts: Mutation[] = [];
      for (const l of kept) {
        const id = b.newId();
        const f: Record<string, unknown> = { order_id: order, check_id: checkId, qty_milli: l.qty_milli, state: "sent" };
        for (const k of LINE_FIELDS) if ((l as Record<string, unknown>)[k] !== undefined) f[k] = (l as Record<string, unknown>)[k];
        muts.push({ e: "order_line", id, k: "insert", f });
        for (const m of modifiers.filter((x) => x.order_line_id === l.id)) muts.push({ e: "order_line_modifier", id: b.newId(), k: "insert", f: { order_line_id: id, modifier_id: m.modifier_id, name: m.name, price_delta_paise: m.price_delta_paise } });
      }
      return muts;
    },
  });
  return { credit: cn.number, checkId };
}
