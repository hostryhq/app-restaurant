import type { Check, CheckPresent, BillRequest, DiningTable, Kot, KotLine, Seating, SeatingMerge, SeatingMove } from "./rows";

export type TableTileState = "free" | "occupied" | "billed" | "ready" | "attention";

export type TableView = {
  table: DiningTable;
  state: TableTileState;
  /** Open seating, when occupied. */
  seating?: Seating;
  checks: Check[];
  /** The waiter pressed Bill please and no one has presented since. */
  billRequested: boolean;
  /** Minutes since the seating opened (0 when free). */
  minutes: number;
};

/** Table a seating sits at now: the latest move (ids are time-sortable), else where it opened. */
export function effectiveTableId(seating: Seating, moves: readonly SeatingMove[]): string {
  const m = moves.filter((x) => x.seating_id === seating.id).sort((a, b) => a.id.localeCompare(b.id));
  return m.length ? m[m.length - 1]!.to_table_id : seating.table_id;
}

/** absorbed seating id -> kept seating id (ADR-0014: merge is an append; the absorbed seating is closed by rank). */
export function mergeMap(merges: readonly SeatingMerge[]): Map<string, string> {
  return new Map(merges.map((m) => [m.absorbed_seating_id, m.kept_seating_id]));
}

export type FloorInput = {
  tables: readonly DiningTable[];
  seatings: readonly Seating[];
  checks: readonly Check[];
  presents: readonly CheckPresent[];
  requests: readonly BillRequest[];
  kots: readonly Kot[];
  kotLines: readonly KotLine[];
  moves?: readonly SeatingMove[];
  merges?: readonly SeatingMerge[];
  nowMs: number;
};

/**
 * Tile state of every table (RS03, RM-F2), derived from the rows, never stored. Order of precedence: attention (two open
 * seatings on one table), ready (a kitchen item is ready and not served), billed (every check presented or billed),
 * occupied, free. State is shown as icon + text + colour by the tile; this function only decides which.
 */
export function floorView(i: FloorInput): TableView[] {
  return [...i.tables]
    .filter((t) => t.active !== false)
    .sort((a, b) => a.name.localeCompare(b.name, "en", { numeric: true }))
    .map((table) => {
      const open = i.seatings.filter((s) => effectiveTableId(s, i.moves ?? []) === table.id && s.status !== "closed");
      const seating = open[0];
      const absorbed = seating ? [...mergeMap(i.merges ?? [])].filter(([, kept]) => kept === seating.id).map(([a]) => a) : [];
      const mine = (c: Check) => seating !== undefined && c.seating_id !== undefined && (c.seating_id === seating.id || absorbed.includes(c.seating_id));
      const checks = seating ? i.checks.filter((c) => mine(c) && c.status === "open") : [];
      const allChecks = seating ? i.checks.filter(mine) : [];
      const checkIds = new Set(allChecks.map((c) => c.id));
      const kotIds = new Set(i.kots.filter((k) => checkIds.has(k.check_id)).map((k) => k.id));
      const ready = i.kotLines.some((l) => kotIds.has(l.kot_id) && l.status === "ready");
      const presented = checks.length > 0 && checks.every((c) => i.presents.some((p) => p.check_id === c.id));
      const requested = checks.some((c) => i.requests.some((r) => r.check_id === c.id) && !i.presents.some((p) => p.check_id === c.id));
      const billed = seating !== undefined && (seating.status === "billed" || (allChecks.length > 0 && checks.length === 0) || presented);
      const state: TableTileState = open.length > 1 ? "attention" : !seating ? "free" : ready && !billed ? "ready" : billed ? "billed" : "occupied";
      const opened = seating?.opened_at ? Date.parse(seating.opened_at) : i.nowMs;
      return {
        table,
        state,
        ...(seating ? { seating } : {}),
        checks,
        billRequested: requested,
        minutes: seating ? Math.max(0, Math.floor((i.nowMs - opened) / 60_000)) : 0,
      };
    });
}
