import type { BillRow, CreditNoteRow, PaymentRow } from "@hostry/client-core";

/** Cash the drawer should hold, from the shift's own facts (RM-S5). All integer paise. */
export function expectedCash(o: { openingFloat: number; cashPayments: number; cashRefunds: number; cashIn: number; cashOut: number; ownerDrops?: number }): number {
  return o.openingFloat + o.cashPayments - o.cashRefunds + o.cashIn - o.cashOut - (o.ownerDrops ?? 0);
}

export type Denomination = { id: string; label: string; valuePaise: number };
export const INR_DENOMINATIONS: Denomination[] = [2000, 500, 200, 100, 50, 20, 10, 5, 2, 1].map((rupees) => ({ id: `d${rupees}`, label: `${rupees}`, valuePaise: rupees * 100 }));

export function countedTotal(counts: Readonly<Record<string, number>>, denoms: readonly Denomination[] = INR_DENOMINATIONS): number {
  return denoms.reduce((s, d) => s + (counts[d.id] ?? 0) * d.valuePaise, 0);
}

/** Blind count: the cashier never sees `expected`; the variance is recorded and printed (AC 147, 148). */
export function variance(counted: number, expected: number): number {
  return counted - expected;
}

export type DayBlocker =
  | { kind: "open_shift"; shiftId: string }
  | { kind: "unresolved_lines"; checkId: string; lines: number }
  | { kind: "presented_unbilled"; checkId: string };

export type DayCloseInput = {
  openShiftIds: readonly string[];
  /** Open checks that hold at least one live line, with the number of such lines. */
  openChecks: ReadonlyArray<{ checkId: string; lines: number; presented: boolean }>;
  /** Shifts the manager chose to force close are no longer blocking. */
  forcedShiftIds?: readonly string[];
  /** Checks the manager chose to carry over to the next day. */
  carriedCheckIds?: readonly string[];
};

/** What stops a day from closing (RS21). Unpaid numbered bills never block: they are listed on the Z-report. */
export function dayBlockers(i: DayCloseInput): DayBlocker[] {
  const out: DayBlocker[] = [];
  for (const id of i.openShiftIds) if (!i.forcedShiftIds?.includes(id)) out.push({ kind: "open_shift", shiftId: id });
  for (const c of i.openChecks) {
    if (i.carriedCheckIds?.includes(c.checkId)) continue;
    out.push(c.presented ? { kind: "presented_unbilled", checkId: c.checkId } : { kind: "unresolved_lines", checkId: c.checkId, lines: c.lines });
  }
  return out;
}

export type ZTotals = {
  gross: number;
  discount: number;
  net: number;
  serviceCharge: number;
  cgst: number;
  sgst: number;
  nonGst: number;
  roundOff: number;
  total: number;
  billCount: number;
  creditNoteCount: number;
  creditNoteTotal: number;
  tenders: Record<string, number>;
};

/** Z-report figures of one business date from the document rows (never from timestamps). */
export function zTotals(date: string, bills: readonly BillRow[], payments: readonly PaymentRow[], notes: readonly CreditNoteRow[]): ZTotals {
  const bs = bills.filter((b) => b.business_date === date);
  const ids = new Set(bs.map((b) => b.id));
  const sum = (f: (b: BillRow) => number) => bs.reduce((s, b) => s + f(b), 0);
  const tenders: Record<string, number> = {};
  for (const p of payments) {
    if (p.business_date === date && ids.has(p.bill_id)) tenders[p.tender] = (tenders[p.tender] ?? 0) + p.amount_paise;
  }
  const cn = notes.filter((n) => n.business_date === date);
  return {
    gross: sum((b) => b.gross_paise),
    discount: sum((b) => b.discount_paise),
    net: sum((b) => b.gross_paise - b.discount_paise),
    serviceCharge: sum((b) => b.service_charge_paise),
    cgst: sum((b) => b.cgst_paise),
    sgst: sum((b) => b.sgst_paise),
    nonGst: sum((b) => b.non_gst_subtotal_paise),
    roundOff: sum((b) => b.round_off_paise),
    total: sum((b) => b.total_paise),
    billCount: bs.length,
    creditNoteCount: cn.length,
    creditNoteTotal: cn.reduce((s, n) => s + n.total_paise, 0),
    tenders,
  };
}

/** Display number of a Z-report: `Z/<date>/<device code>`, revision `R<n>` for a late document (ADR-0014 A1.1). */
export function zNumber(date: string, deviceCode: string, revision?: number): string {
  return `Z/${date}/${deviceCode}${revision ? `/R${revision}` : ""}`;
}

/** A day still open past the cut-off the next morning: a banner on every device, trading continues (RS00). */
export function dayCloseOverdue(openDate: string | undefined, nowMs: number, cutoffMinutes: number): boolean {
  if (!openDate) return false;
  const cutoff = Date.parse(`${openDate}T00:00:00+05:30`) + 86_400_000 + cutoffMinutes * 60_000;
  return nowMs > cutoff;
}

/** Highest running number per series code among the given documents (what a Z-report covers of each series). */
export function seriesRangesOf(docs: ReadonlyArray<{ number: string }>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const d of docs) {
    const [code, , running] = d.number.split("/");
    if (!code || running === undefined) continue;
    out[code] = Math.max(out[code] ?? 0, Number(running));
  }
  return out;
}

/**
 * Documents of a closed business date that the Z-report did not cover (RS21, ADR-0014 A1.1): bills and credit notes an
 * offline device made on that date and sent after the day was closed. A document is late when its series is missing from the
 * ranges the Z-report recorded, or its running number is above the recorded top of its series. The date is never reopened.
 */
export function lateDocuments<B extends { number: string; business_date: string }, N extends { number: string; business_date: string }>(
  date: string,
  ranges: Readonly<Record<string, number>>,
  bills: readonly B[],
  notes: readonly N[],
): { bills: B[]; notes: N[] } {
  const late = (d: { number: string; business_date: string }): boolean => {
    if (d.business_date !== date) return false;
    const [code, , running] = d.number.split("/");
    const top = code ? ranges[code] : undefined;
    return top === undefined || Number(running) > top;
  };
  return { bills: bills.filter(late), notes: notes.filter(late) };
}

/** Sum of refunds of one business date (RS19 payment.refund); refunds are not part of bill or credit-note totals. */
export function refundTotal(date: string, refunds: ReadonlyArray<{ business_date: string; amount_paise: number }>): { count: number; total: number } {
  const rs = refunds.filter((r) => r.business_date === date);
  return { count: rs.length, total: rs.reduce((s, r) => s + r.amount_paise, 0) };
}
