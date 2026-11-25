import { businessDayId, type BillRow, type CreditNoteRow, type PaymentRow, type ZReportDoc } from "@hostry/client-core";
import { dayBlockers, expectedCash, lateDocuments, refundTotal, seriesRangesOf, zNumber, zTotals, type DayBlocker } from "../../domain/shift-day";
import { liveQty } from "../../domain/lines";
import type { BusinessDay, BusinessDayRevision, CashEvent, DayClose, Check, CheckPresent, OpRow, OrderLine, OrderLineCancel, Shift, ShiftClose } from "../../domain/rows";
import { settingsFrom } from "../context";
import { BILL_PRINTER } from "./bill-printer";
import { businessFrom, openShift } from "./billing";
import { ensureDayOpen } from "./orders";
import { need, TradingError, isoNow, type ListFn, type TradingCtx } from "./ctx";

/** RS02: open a shift with the counted float. Needed only at the first cash payment, and only when the outlet requires it (AC 145, 146). */
export async function startShift(ctx: TradingCtx, floatPaise: number): Promise<string> {
  need(ctx, "shift.open");
  const date = await ensureDayOpen(ctx);
  const list: ListFn = (e) => ctx.data.snapshot().list(e);
  if (openShift(list)) throw new TradingError("refused", "a shift is already open");
  const id = ctx.newId();
  await ctx.data.write({ intent: "shift.open", build: () => [{ e: "shift", id, k: "insert", f: { business_date: date, opening_float_paise: floatPaise, status: "open" } }] });
  return id;
}

/** Float to prefill the open-shift sheet: the last shift's counted amount (RS02). */
export function lastClosingFloat(list: ListFn): number {
  const closes = (list("shift_close") as ShiftClose[]).slice().sort((a, b) => a.id.localeCompare(b.id));
  return closes.length ? closes[closes.length - 1]!.counted_paise : 0;
}

/** Cash the drawer should hold for a shift. The cashier never sees this before counting (blind count, AC 147). */
export function expectedCashFor(list: ListFn, shift: Shift): number {
  // The drawer is this device's: only cash payments recorded here count.
  const ops = (list("_op") as OpRow[]).filter((o) => o.own && o.at >= shift.opened_at);
  const payIds = new Set(ops.flatMap((o) => o.muts.filter((m) => m.e === "payment").map((m) => m.id)));
  const cashPayments = (list("payment") as unknown as PaymentRow[]).filter((p) => payIds.has(p.id) && p.tender === "cash").reduce((s, p) => s + p.amount_paise, 0);
  const refundIds = new Set(ops.flatMap((o) => o.muts.filter((m) => m.e === "refund").map((m) => m.id)));
  const cashRefunds = (list("refund") as unknown as Array<{ id: string; tender: string; amount_paise: number }>).filter((r) => refundIds.has(r.id) && r.tender === "cash").reduce((s, r) => s + r.amount_paise, 0);
  const events = (list("cash_event") as CashEvent[]).filter((e) => e.shift_id === shift.id);
  const sum = (k: CashEvent["kind"]) => events.filter((e) => e.kind === k).reduce((s, e) => s + e.amount_paise, 0);
  return expectedCash({ openingFloat: shift.opening_float_paise, cashPayments, cashRefunds, cashIn: sum("cash_in"), cashOut: sum("cash_out"), ownerDrops: sum("owner_cash_drop") });
}

/** Cash in or out of the drawer, with a note (RM-S6). */
export async function cashMove(ctx: TradingCtx, kind: "cash_in" | "cash_out" | "owner_cash_drop", amountPaise: number, note: string): Promise<void> {
  need(ctx, "drawer.cash_move");
  const list: ListFn = (e) => ctx.data.snapshot().list(e);
  const shift = openShift(list);
  if (!shift) throw new TradingError("no_open_shift");
  await ctx.data.write({ intent: "drawer.cash_move", build: (b) => [{ e: "cash_event", id: b.newId(), k: "insert", f: { kind, amount_paise: amountPaise, note, shift_id: shift.id, business_date: shift.business_date } }] });
}

/** Close a shift with a blind count: the variance is recorded, never shown to the cashier before they count. */
export async function closeShift(ctx: TradingCtx, shiftId: string, countedPaise: number, o: { force?: boolean } = {}): Promise<{ variancePaise: number }> {
  need(ctx, o.force ? "shift.close.any" : "shift.close");
  const list: ListFn = (e) => ctx.data.snapshot().list(e);
  const shift = (list("shift") as Shift[]).find((s) => s.id === shiftId);
  if (!shift || shift.status !== "open") throw new TradingError("not_open", shiftId);
  const expected = expectedCashFor(list, shift);
  const variance = o.force ? 0 : countedPaise - expected;
  await ctx.data.write({
    intent: o.force ? "shift.close.any" : "shift.close",
    build: (b) => [
      { e: "shift", id: shiftId, k: "rank", f: { status: "closed" } },
      { e: "shift_close", id: b.newId(), k: "insert", f: { shift_id: shiftId, counted_paise: o.force ? 0 : countedPaise, expected_paise: expected, variance_paise: variance, ...(o.force ? { force_closed: true } : {}) } },
    ],
  });
  return { variancePaise: variance };
}

/** Open checks that still hold live lines, for the day-close list (RS21). Cancelled checks are not open. */
export function unresolvedChecks(list: ListFn): Array<{ checkId: string; lines: number; presented: boolean }> {
  const cancelled = new Set((list("check_cancel") as unknown as Array<{ check_id: string }>).map((c) => c.check_id));
  const cancels = list("order_line_cancel") as OrderLineCancel[];
  const presents = list("check_present") as CheckPresent[];
  return (list("check") as Check[])
    .filter((c) => c.status === "open" && !cancelled.has(c.id))
    .map((c) => ({ checkId: c.id, lines: (list("order_line") as OrderLine[]).filter((l) => l.check_id === c.id && liveQty(l, cancels) > 0).length, presented: presents.some((p) => p.check_id === c.id) }))
    .filter((c) => c.lines > 0);
}

export function dayBlockersNow(list: ListFn, carried: readonly string[] = [], forced: readonly string[] = []): DayBlocker[] {
  return dayBlockers({ openShiftIds: (list("shift") as Shift[]).filter((s) => s.status === "open").map((s) => s.id), openChecks: unresolvedChecks(list), carriedCheckIds: carried, forcedShiftIds: forced });
}

/** Carry an unbilled check over to the next day (RS21): a local mark; the check keeps its own business date. */
export async function carryOver(ctx: TradingCtx, checkId: string): Promise<void> {
  need(ctx, "day.close");
  await ctx.data.putLocal(`carry-${checkId}`, { kind: "carry", check_id: checkId });
}

/**
 * Close the business day (RS21): refused while a shift is open or a check with lines is unbilled (unless carried over); on
 * success the Z-report numbered `Z/<date>/<device>` is recorded and printed. There is no reopen: corrections are credit
 * notes dated when made (ADR-0014 A1.1).
 */
export async function closeDay(ctx: TradingCtx): Promise<{ zNumber: string; totalPaise: number; billCount: number }> {
  const s = need(ctx, "day.close");
  const list: ListFn = (e) => ctx.data.snapshot().list(e);
  const day = (list("business_day") as BusinessDay[]).filter((d) => d.status === "open").sort((a, b) => a.business_date.localeCompare(b.business_date)).pop();
  if (!day) throw new TradingError("no_open_day");
  const carried = (list("_local") as Array<{ kind?: string; check_id?: string }>).filter((r) => r.kind === "carry").map((r) => r.check_id as string);
  const blockers = dayBlockersNow(list, carried);
  if (blockers.length) throw new TradingError("day_blocked", blockers.map((b) => b.kind).join(","));
  const bills = list("bill") as unknown as BillRow[];
  const t = zTotals(day.business_date, bills, list("payment") as unknown as PaymentRow[], list("credit_note") as unknown as CreditNoteRow[]);
  const z = zNumber(day.business_date, ctx.deviceCode);
  const refunds = refundTotal(day.business_date, list("refund") as unknown as Array<{ business_date: string; amount_paise: number }>);
  const ranges = seriesRangesOf([...bills, ...(list("credit_note") as unknown as CreditNoteRow[])].filter((d) => d.business_date === day.business_date));
  await ctx.data.write({
    intent: "day.close",
    build: (b) => [
      { e: "business_day", id: day.id, k: "rank", f: { status: "closed" } },
      {
        e: "day_close",
        id: b.newId(),
        k: "insert",
        f: {
          business_day_id: day.id,
          z_number: z,
          cutoff: new Date(b.now).toISOString(),
          gross_paise: t.gross,
          discount_paise: t.discount,
          net_paise: t.net,
          service_charge_paise: t.serviceCharge,
          cgst_paise: t.cgst,
          sgst_paise: t.sgst,
          non_gst_paise: t.nonGst,
          round_off_paise: t.roundOff,
          total_paise: t.total,
          bill_count: t.billCount,
          credit_note_count: t.creditNoteCount,
          credit_note_total_paise: t.creditNoteTotal,
          refund_total_paise: refunds.total,
          // What this Z-report covers of each series: a document above it, or from a series not in it, is a late document.
          series_ranges_json: JSON.stringify(ranges),
          tenders_json: JSON.stringify(t.tenders),
        },
      },
    ],
  });
  const closes = (list("shift_close") as ShiftClose[]).filter((c) => (list("shift") as Shift[]).some((sh) => sh.id === c.shift_id && sh.business_date === day.business_date));
  const doc: ZReportDoc = {
    kind: "z_report",
    number: z,
    outletName: businessFrom(list).name,
    businessDate: day.business_date,
    closedAt: isoNow(ctx),
    closedBy: ctx.nameOf(s.memberId),
    rows: [
      { label: "Gross", amount: t.gross },
      { label: "Discount", amount: -t.discount },
      { label: "Net", amount: t.net },
      { label: "Service charge", amount: t.serviceCharge },
      { label: "CGST", amount: t.cgst },
      { label: "SGST", amount: t.sgst },
      { label: "Round off", amount: t.roundOff },
    ],
    total: t.total,
    bills: t.billCount,
    tenders: Object.entries(t.tenders).map(([label, amount]) => ({ label, amount })),
    channels: [],
    control: { voids: 0, cancels: 0, comps: 0, refunds: refunds.count, creditNotes: t.creditNoteCount },
    series: [],
    variances: closes.map((c, i) => ({ label: `Shift ${i + 1}`, amount: c.variance_paise })),
  };
  if (ctx.print.has(BILL_PRINTER)) {
    ctx.print.print(BILL_PRINTER, doc, { jobId: `z-${day.id}`, trigger: "manual" });
    await ctx.print.flush();
  }
  return { zNumber: z, totalPaise: t.total, billCount: t.billCount };
}

/** Open day for the day-close banner. */
export const openDayOf = (list: ListFn): BusinessDay | undefined => (list("business_day") as BusinessDay[]).filter((d) => d.status === "open").sort((a, b) => a.business_date.localeCompare(b.business_date)).pop();

export { businessDayId, settingsFrom };

export type LateDay = {
  dayCloseId: string;
  date: string;
  zNumber: string;
  billNumbers: string[];
  noteNumbers: string[];
  /** Devices the late documents came from (their op origins). */
  devices: string[];
  /** Revisions the cloud has numbered for this day (`Z/<date>/<device>/R<n>`); none until the device is online. */
  revisions: BusinessDayRevision[];
};

/**
 * RS21 late documents: for every closed day, the bills and credit notes the Z-report did not cover. They keep their own
 * business date. The revision number is assigned by the cloud (day.revision.record), so a LAN-only outlet sees the list and
 * no number; when the revision row arrives it is shown and can be printed.
 */
export function lateDays(list: ListFn): LateDay[] {
  const bills = list("bill") as unknown as BillRow[];
  const notes = list("credit_note") as unknown as CreditNoteRow[];
  const ops = list("_op") as OpRow[];
  const originOf = (number: string): string | undefined => ops.find((o) => o.doc?.number === number)?.origin;
  const revisions = list("business_day_revision") as unknown as BusinessDayRevision[];
  const out: LateDay[] = [];
  for (const dc of list("day_close") as DayClose[]) {
    const day = (list("business_day") as BusinessDay[]).find((d) => d.id === dc.business_day_id);
    if (!day) continue;
    let ranges: Record<string, number>;
    try {
      ranges = JSON.parse(dc.series_ranges_json ?? "{}") as Record<string, number>;
    } catch {
      continue;
    }
    const late = lateDocuments(day.business_date, ranges, bills, notes);
    if (late.bills.length + late.notes.length === 0) continue;
    const devices = [...new Set([...late.bills, ...late.notes].map((d) => originOf(d.number)).filter((o): o is string => o !== undefined))];
    out.push({
      dayCloseId: dc.id,
      date: day.business_date,
      zNumber: dc.z_number,
      billNumbers: late.bills.map((b) => b.number),
      noteNumbers: late.notes.map((n) => n.number),
      devices,
      revisions: revisions.filter((r) => r.business_day_id === day.id).sort((a, b) => a.revision - b.revision),
    });
  }
  return out;
}

/** Print a revision the cloud numbered (`Z/<date>/<device>/R<n>`): the figures the cloud recorded for the whole day. */
export async function printRevision(ctx: TradingCtx, revisionId: string): Promise<void> {
  need(ctx, "day.close");
  const list: ListFn = (e) => ctx.data.snapshot().list(e);
  const r = (list("business_day_revision") as unknown as BusinessDayRevision[]).find((x) => x.id === revisionId);
  if (!r) throw new TradingError("not_found", revisionId);
  const day = (list("business_day") as BusinessDay[]).find((d) => d.id === r.business_day_id);
  const tenders = r.tenders_json ? (JSON.parse(r.tenders_json) as Record<string, number>) : {};
  const doc: ZReportDoc = {
    kind: "z_report",
    number: r.display_number,
    outletName: businessFrom(list).name,
    businessDate: day?.business_date ?? "",
    closedAt: isoNow(ctx),
    closedBy: ctx.session() ? ctx.nameOf(ctx.session()!.memberId) : "",
    rows: [
      { label: "Gross", amount: r.gross_paise },
      { label: "Discount", amount: -r.discount_paise },
      { label: "Net", amount: r.net_paise },
      { label: "Service charge", amount: r.service_charge_paise },
      { label: "CGST", amount: r.cgst_paise },
      { label: "SGST", amount: r.sgst_paise },
      { label: "Round off", amount: r.round_off_paise },
    ],
    total: r.total_paise,
    bills: r.bill_count,
    tenders: Object.entries(tenders).map(([label, amount]) => ({ label, amount })),
    channels: [],
    control: { voids: 0, cancels: 0, comps: 0, refunds: 0, creditNotes: r.credit_note_count },
    series: [],
    variances: [],
  };
  if (ctx.print.has(BILL_PRINTER)) {
    ctx.print.print(BILL_PRINTER, doc, { jobId: `zr-${r.id}`, trigger: "manual" });
    await ctx.print.flush();
  }
}
