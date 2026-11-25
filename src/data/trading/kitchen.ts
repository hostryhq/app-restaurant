import { formatKotNo, linesToSend, routeToStations, toKotDoc, type KotDoc, type Mutation, type PrintTrigger, type SendableLine, type Station as CoreStation } from "@hostry/client-core";
import { effectiveTableId } from "../../domain/table-state";
import { nextKdsStatus } from "../../domain/kds";
import { liveQty } from "../../domain/lines";
import type { Check, DiningTable, Kot, KotHandover, KotLine, OrderLine, OrderLineCancel, Seating, SeatingMove, Station } from "../../domain/rows";
import { menuFrom } from "../context";
import { KITCHEN_PRINTER } from "./bill-printer";
import { need, holds, requireDay, TradingError, isoNow, type ListFn, type TradingCtx } from "./ctx";
import { orderIdOf } from "./orders";

const ORDER_TYPE_LABEL: Record<string, string> = { dine_in: "Dine-in", takeaway: "Takeaway", counter: "Counter" };

/** "T6" for a table, "TAKEAWAY #27" or "COUNTER #12" for a token (printed large on the KOT). */
export function tableLabelOf(list: ListFn, check: Check): string {
  if (check.seating_id) {
    const seating = (list("seating") as Seating[]).find((s) => s.id === check.seating_id);
    if (seating) {
      const tid = effectiveTableId(seating, list("seating_move") as SeatingMove[]);
      const t = (list("dining_table") as DiningTable[]).find((x) => x.id === tid);
      if (t) return t.name;
    }
  }
  return `${check.order_type.toUpperCase()} #${check.token_no ?? ""}`.trim();
}

/** The printing model of one stored KOT row. Prices never appear on a KOT (client-core toKotDoc). */
export function kotDocFor(ctx: TradingCtx, list: ListFn, kotId: string, variant: KotDoc["variant"] = "original", extra: Partial<KotDoc> = {}, linesOf?: Array<Pick<KotLine, "order_line_id" | "name" | "qty_milli">>): KotDoc {
  const kot = (list("kot") as Kot[]).find((k) => k.id === kotId);
  if (!kot) throw new TradingError("not_found", `kot ${kotId}`);
  const check = (list("check") as Check[]).find((c) => c.id === kot.check_id);
  const station = ((list("station") as Station[]).find((s) => s.code === kot.station_code) ?? { id: "", code: kot.station_code, name: "Kitchen", output: "both", language: "en" }) as CoreStation;
  // A MOVED ticket has no kot_line rows (order.items.move writes the kot only); the mover passes the moved lines to print.
  const lines = (linesOf ?? (list("kot_line") as KotLine[]).filter((l) => l.kot_id === kotId)) as KotLine[];
  const orderLines = list("order_line") as OrderLine[];
  const sendable: SendableLine[] = lines.map((l) => {
    const ol = orderLines.find((o) => o.id === l.order_line_id);
    return {
      id: l.order_line_id,
      item_id: ol?.item_id ?? "",
      ...(ol?.variant_id ? { variant_id: ol.variant_id } : {}),
      name: ol?.name ?? l.name,
      kitchen_name: l.name,
      qty_milli: l.qty_milli,
      ...(ol?.modifiers_text ? { modifiers_text: ol.modifiers_text } : {}),
      ...(l.note ? { note: l.note } : {}),
      station_code: kot.station_code,
      state: "sent" as const,
    };
  });
  const menu = menuFrom(list);
  const waiter = check?.waiter_id ? ctx.nameOf(check.waiter_id) : undefined;
  const doc = toKotDoc(
    { station, lines: sendable },
    {
      kotNumber: kot.kot_no,
      tableLabel: kot.table_name ?? (check ? tableLabelOf(list, check) : ""),
      orderTypeLabel: ORDER_TYPE_LABEL[kot.order_type] ?? kot.order_type,
      ...(waiter ? { waiter } : {}),
      createdAt: kot.created_at,
      localName: (id, lang) => menu.localName(id, lang),
    },
  );
  const handed = (list("kot_handover") as KotHandover[]).some((h) => h.kot_id === kotId);
  return { ...doc, variant, ...(handed ? { handedOver: true } : {}), ...extra };
}

/** Prints a stored KOT on its station's printer, if it has one. Returns false for a KDS-only station. */
export function printKot(ctx: TradingCtx, list: ListFn, kotId: string, trigger: PrintTrigger = "auto", variant: KotDoc["variant"] = "original", extra: Partial<KotDoc> = {}, jobId = kotId, linesOf?: Array<Pick<KotLine, "order_line_id" | "name" | "qty_milli">>): boolean {
  const kot = (list("kot") as Kot[]).find((k) => k.id === kotId);
  if (!kot) return false;
  const station = (list("station") as Station[]).find((s) => s.code === kot.station_code);
  if (!station || station.output === "kds") return false;
  const printerId = station.printer_id ?? KITCHEN_PRINTER;
  if (!ctx.print.has(printerId)) return false;
  ctx.print.print(printerId, kotDocFor(ctx, list, kotId, variant, extra, linesOf), { jobId, trigger });
  return true;
}

/**
 * Send: one KOT per station (RM-O5). The lines move to `sent` in the same op, the KDS reads the rows, and a station with
 * a printer gets the ticket on its queue. The screen does not wait for the paper (RM-X2).
 */
export async function sendKot(ctx: TradingCtx, checkId: string): Promise<string[]> {
  const s = need(ctx, "order.edit");
  const snap = ctx.data.snapshot();
  const check = snap.get<Check>("check", checkId);
  if (!check) throw new TradingError("not_found", checkId);
  const cancels = snap.list<OrderLineCancel>("order_line_cancel");
  const draft = snap.list<OrderLine>("order_line").filter((l) => l.check_id === checkId).map((l) => ({ ...l, qty_milli: liveQty(l, cancels) }));
  const send = linesToSend(draft as unknown as SendableLine[]) as unknown as OrderLine[];
  if (send.length === 0) throw new TradingError("nothing_to_send");
  const list: ListFn = (e) => snap.list(e);
  const date = requireDay(list);
  const tickets = routeToStations(send as unknown as SendableLine[], snap.list<Station>("station") as unknown as CoreStation[]);
  const orderId = orderIdOf(list, check) ?? "";
  const todays = snap.list<Kot>("kot").filter((k) => k.business_date === date && k.kot_no.startsWith(`${ctx.deviceCode}-`)).length;
  const label = tableLabelOf(list, check);
  const kotIds: string[] = [];
  await ctx.data.write({
    intent: "kot.send",
    build: (b) => {
      const muts: Mutation[] = [];
      tickets.forEach((t, i) => {
        const id = b.newId();
        kotIds.push(id);
        muts.push({
          e: "kot",
          id,
          k: "insert",
          f: {
            check_id: checkId,
            order_id: orderId,
            station_code: t.station.code,
            kot_no: formatKotNo(ctx.deviceCode, todays + i + 1),
            kind: "original",
            order_type: check.order_type,
            table_name: label,
            ...(check.token_no !== undefined ? { token_no: check.token_no } : {}),
            business_date: date,
          },
        });
        for (const l of t.lines) {
          const ol = l as unknown as OrderLine;
          muts.push({ e: "kot_line", id: b.newId(), k: "insert", f: { kot_id: id, order_line_id: ol.id, name: ol.kitchen_name, qty_milli: ol.qty_milli, ...(ol.note ? { note: ol.note } : {}), status: "new" } });
          muts.push({ e: "order_line", id: ol.id, k: "rank", f: { state: "sent" } });
        }
      });
      return muts;
    },
  });
  void s;
  const fresh: ListFn = (e) => ctx.data.snapshot().list(e);
  for (const id of kotIds) printKot(ctx, fresh, id);
  await ctx.print.flush();
  await ackPrinted(ctx, kotIds);
  return kotIds;
}

/** Record `kot.print.ack` for KOTs whose print job left the queue (the printer accepted it): "Printed in kitchen" (AC 85). */
export async function ackPrinted(ctx: TradingCtx, kotIds: readonly string[]): Promise<void> {
  const queued = new Set(ctx.print.jobs().map((j) => j.id));
  const list: ListFn = (e) => ctx.data.snapshot().list(e);
  const done = kotIds.filter((id) => !queued.has(id) && stationPrints(list, id));
  for (const id of done) {
    await ctx.data.write({ intent: "kot.print.ack", build: (b) => [{ e: "kot_print", id: b.newId(), k: "insert", f: { kot_id: id, printer_id: stationPrinter(list, id), copy_no: 1, fallback: false } }] });
  }
}

function stationOf(list: ListFn, kotId: string): Station | undefined {
  const code = (list("kot") as Kot[]).find((k) => k.id === kotId)?.station_code;
  return (list("station") as Station[]).find((s) => s.code === code);
}
const stationPrints = (list: ListFn, kotId: string): boolean => {
  const s = stationOf(list, kotId);
  return !!s && s.output !== "kds";
};
const stationPrinter = (list: ListFn, kotId: string): string => stationOf(list, kotId)?.printer_id ?? KITCHEN_PRINTER;

/**
 * Cancel part or all of a sent line (RS07). Needs `order.line.cancel`, or a manager's approval id from the dialog. A cancel
 * ticket goes to the station; if the kitchen had started, the cancel is marked wastage (kitchen_status_at_cancel).
 */
export async function cancelSentLine(ctx: TradingCtx, o: { lineId: string; qtyMilli: number; reasonCodeId: string; approvalId?: string; kotId?: string }): Promise<void> {
  need(ctx, "order.line.cancel", o.approvalId);
  const snap = ctx.data.snapshot();
  const line = snap.get<OrderLine>("order_line", o.lineId);
  if (!line) throw new TradingError("not_found", o.lineId);
  if (line.state !== "sent") throw new TradingError("refused", "draft lines are removed, not cancelled");
  const live = liveQty(line, snap.list<OrderLineCancel>("order_line_cancel"));
  const qty = Math.min(o.qtyMilli, live);
  if (qty < 1) throw new TradingError("refused", "nothing to cancel");
  const list: ListFn = (e) => snap.list(e);
  const kotLine = snap.list<KotLine>("kot_line").find((k) => k.order_line_id === o.lineId);
  const status = kotLine?.status ?? "new";
  const check = snap.get<Check>("check", line.check_id);
  const kotId = o.kotId ?? ctx.newId();
  await ctx.data.write({
    intent: "order.line.cancel",
    ...(o.approvalId ? { approval: o.approvalId } : {}),
    build: (b) => {
      const date = requireDay(list);
      return [
        { e: "kot", id: kotId, k: "insert", f: { check_id: line.check_id, order_id: line.order_id, station_code: line.station_code, kot_no: `${ctx.deviceCode}-C${String(snap.list("kot").length + 1).padStart(3, "0")}`.slice(0, 12), kind: "cancel", order_type: check?.order_type ?? "dine_in", table_name: check ? tableLabelOf(list, check) : "", business_date: date } },
        { e: "order_line_cancel", id: b.newId(), k: "insert", f: { order_line_id: line.id, kind: "cancel", qty_milli: qty, reason_code_id: o.reasonCodeId, ...(o.approvalId ? { approval_id: o.approvalId } : {}), kitchen_status_at_cancel: status, wastage: status !== "new", kot_id: kotId } },
      ];
    },
  });
  const fresh: ListFn = (e) => ctx.data.snapshot().list(e);
  const reason = snap.get("reason_code", o.reasonCodeId)?.label_key as string | undefined;
  printKot(ctx, fresh, kotId, "manual", "cancel", reason ? { reason } : {}, kotId, [{ order_line_id: line.id, name: line.kitchen_name, qty_milli: qty }]);
  await ctx.print.flush();
}

/** KDS: one forward step for one item (RS22). Needs `kds.bump`; a KDS device session holds it. */
export async function stepItem(ctx: TradingCtx, kotLineId: string): Promise<void> {
  need(ctx, "kds.bump");
  const l = ctx.data.snapshot().get<KotLine>("kot_line", kotLineId);
  if (!l) throw new TradingError("not_found", kotLineId);
  const next = nextKdsStatus(l.status);
  if (next === l.status) return;
  await ctx.data.write({ intent: "kds.status", build: () => [{ e: "kot_line", id: kotLineId, k: "rank", f: { status: next } }] });
}

/** Bump: every item of the ticket ready, one tap (AC 76). */
export async function bump(ctx: TradingCtx, kotId: string): Promise<void> {
  need(ctx, "kds.bump");
  if (ctx.data.snapshot().get<Kot>("kot", kotId)?.kind === "recall") return acknowledge(ctx, kotId);
  const lines = ctx.data.snapshot().list<KotLine>("kot_line").filter((l) => l.kot_id === kotId && l.status !== "ready" && l.status !== "served");
  if (lines.length === 0) return;
  await ctx.data.write({ intent: "kds.status", build: () => lines.map((l): Mutation => ({ e: "kot_line", id: l.id, k: "rank", f: { status: "ready" } })) });
}

/**
 * Recall a bumped ticket: a new ticket marked RECALL that points at the old one (AC 78). The contract writes the ticket
 * row only; the KDS shows the old ticket's items on it, and a bump of the recall ticket is a local acknowledgement.
 */
export async function recall(ctx: TradingCtx, kotId: string): Promise<string> {
  need(ctx, "kds.bump");
  const snap = ctx.data.snapshot();
  const k = snap.get<Kot>("kot", kotId);
  if (!k) throw new TradingError("not_found", kotId);
  const id = ctx.newId();
  await ctx.data.write({
    intent: "kds.recall",
    build: () => [
      { e: "kot", id, k: "insert", f: { check_id: k.check_id, order_id: k.order_id, station_code: k.station_code, kot_no: k.kot_no, kind: "recall", recall_of_kot_id: kotId, order_type: k.order_type, table_name: k.table_name ?? "", business_date: k.business_date } },
    ],
  });
  return id;
}

/** Cancel and move banners stay on a KDS ticket until a person taps acknowledge (a local, device-only mark). */
export async function acknowledge(ctx: TradingCtx, kotId: string): Promise<void> {
  await ctx.data.putLocal(`kds-ack-${kotId}`, { kind: "kds_ack", kot_id: kotId });
}

/** Blackout (ADR-0014 A1.6): the waiter handed the order to the kitchen by hand or told them. The printing device never prints an original for it. */
export async function handover(ctx: TradingCtx, kotId: string, mode: "by_hand" | "verbal"): Promise<void> {
  need(ctx, "kot.handover");
  if (!ctx.data.snapshot().get("kot", kotId)) throw new TradingError("not_found", kotId);
  await ctx.data.write({ intent: "kot.handover", build: (b) => [{ e: "kot_handover", id: b.newId(), k: "insert", f: { kot_id: kotId, mode } }] });
}

/** Reprint a KOT as a duplicate (RM-K11). */
export async function reprintKot(ctx: TradingCtx, kotId: string): Promise<void> {
  need(ctx, "kot.reprint");
  const list: ListFn = (e) => ctx.data.snapshot().list(e);
  const copy = ctx.data.snapshot().list("kot_print").filter((p) => p.kot_id === kotId).length + 1;
  await ctx.data.write({ intent: "kot.reprint", build: (b) => [{ e: "kot_print", id: b.newId(), k: "insert", f: { kot_id: kotId, printer_id: stationPrinter(list, kotId), copy_no: copy, fallback: false } }] });
  printKot(ctx, list, kotId, "manual", "duplicate", { reprintedAt: isoNow(ctx) }, `${kotId}-dup-${copy}`);
  await ctx.print.flush();
}

/**
 * The printing device sees a KOT that arrived from elsewhere (a handheld's send relayed after a blackout, RS31). The
 * stale-and-handover rule lives in PrintService: a handed-over or older-than-15-minutes ticket goes to the late list and is
 * never printed by itself; a recent one prints once. Returns what happened.
 */
export function ingestArrivedKot(ctx: TradingCtx, kotId: string): "queued" | "late" | "already_handled" | "no_printer" {
  const list: ListFn = (e) => ctx.data.snapshot().list(e);
  const st = stationOf(list, kotId);
  if (!st || st.output === "kds") return "no_printer";
  const printerId = st.printer_id ?? KITCHEN_PRINTER;
  if (!ctx.print.has(printerId)) return "no_printer";
  return ctx.print.print(printerId, kotDocFor(ctx, list, kotId), { jobId: kotId, trigger: "auto" });
}

export const canKds = (ctx: TradingCtx): boolean => holds(ctx, "kds.bump");
