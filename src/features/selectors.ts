import type { Computation } from "@hostry/client-core";
import { linesOfCheck, lineTotalPaise } from "../domain/lines";
import { floorView, effectiveTableId, type TableView } from "../domain/table-state";
import type { BillRequest, Check, CheckPresent, DiningTable, Kot, KotLine, OrderLine, OrderLineCancel, Seating, SeatingMerge, SeatingMove } from "../domain/rows";
import { previewCheck } from "../data/trading/billing";
import type { App } from "./app-state";

/** Checks that are still real: not cancelled and not merged away. */
export function liveChecks(app: App): Check[] {
  const snap = app.snap();
  const gone = new Set(snap.list("check_cancel").map((c) => c.check_id as string));
  return snap.list<Check>("check").filter((c) => !gone.has(c.id));
}

export function floor(app: App): TableView[] {
  const snap = app.snap();
  return floorView({
    tables: snap.list<DiningTable>("dining_table"),
    seatings: snap.list<Seating>("seating"),
    checks: liveChecks(app),
    presents: snap.list<CheckPresent>("check_present"),
    requests: snap.list<BillRequest>("bill_request"),
    kots: snap.list<Kot>("kot"),
    kotLines: snap.list<KotLine>("kot_line"),
    moves: snap.list<SeatingMove>("seating_move"),
    merges: snap.list<SeatingMerge>("seating_merge"),
    nowMs: app.nowMs(),
  });
}

export function linesOf(app: App, checkId: string | undefined): OrderLine[] {
  if (!checkId) return [];
  const snap = app.snap();
  return linesOfCheck(checkId, snap.list<OrderLine>("order_line"), snap.list<OrderLineCancel>("order_line_cancel"));
}

export function draftCount(lines: readonly OrderLine[]): number {
  return lines.filter((l) => l.state === "draft").length;
}

/** Total and tax breakdown of a check from the same calculation the bill will use; undefined for an empty check. */
export function totals(app: App, checkId: string | undefined): { c: Computation; total: number } | undefined {
  if (!checkId) return undefined;
  try {
    const p = previewCheck((e) => app.snap().list(e), app.rt.ctx.outletId, checkId, app.nowMs());
    return p ? { c: p.c, total: p.c.result.total_paise } : undefined;
  } catch {
    return undefined; // no rule set yet on this device: show lines at menu price instead of a wrong tax figure
  }
}

export function menuTotal(lines: readonly OrderLine[]): number {
  return lines.reduce((s, l) => s + lineTotalPaise(l), 0);
}

export function tableOfSeating(app: App, seatingId: string | undefined): DiningTable | undefined {
  if (!seatingId) return undefined;
  const snap = app.snap();
  const s = snap.get<Seating>("seating", seatingId);
  if (!s) return undefined;
  return snap.get<DiningTable>("dining_table", effectiveTableId(s, snap.list<SeatingMove>("seating_move")));
}

/** The open check a table's order screen works on: the selected bill tab, else the first open one. */
export function checksOfTable(app: App, tableId: string | undefined): Check[] {
  if (!tableId) return [];
  const v = floor(app).find((x) => x.table.id === tableId);
  return v?.checks ?? [];
}

/** Counter checks still open (held orders and pending pickups). */
export function openCounterChecks(app: App): Check[] {
  return liveChecks(app).filter((c) => !c.seating_id && c.status === "open");
}

export function minutesAgo(app: App, iso: string | undefined): number {
  return iso ? Math.max(0, Math.floor((app.nowMs() - Date.parse(iso)) / 60_000)) : 0;
}
