import type { Mutation } from "@hostry/client-core";
import { liveQty } from "../../domain/lines";
import type { Check, OrderLine, OrderLineCancel, Seating } from "../../domain/rows";
import { need, requireDay, TradingError, type ListFn, type TradingCtx } from "./ctx";
import { openTableCheck, orderIdOf } from "./orders";
import { printKot } from "./kitchen";

/** Quantities chosen per line (RS10): the whole line, or part of its quantity (thousandths). */
export type Selection = Readonly<Record<string, number>>;

function chosen(ctx: TradingCtx, sel: Selection): Array<{ line: OrderLine; qty: number; whole: boolean }> {
  const snap = ctx.data.snapshot();
  const cancels = snap.list<OrderLineCancel>("order_line_cancel");
  const out: Array<{ line: OrderLine; qty: number; whole: boolean }> = [];
  for (const [id, q] of Object.entries(sel)) {
    const line = snap.get<OrderLine>("order_line", id);
    if (!line || q < 1) continue;
    const live = liveQty(line, cancels);
    const qty = Math.min(q, live);
    if (qty >= 1) out.push({ line, qty, whole: qty === live && line.qty_milli === live });
  }
  if (out.length === 0) throw new TradingError("refused", "nothing selected");
  return out;
}

/**
 * Split by item (RS10): the chosen lines, or part of a line's quantity, go to a new bill on the same table. A whole line
 * changes its check; a part splits the line (the original shrinks by a delta, a copy carries the part). One op.
 */
export async function splitBill(ctx: TradingCtx, fromCheckId: string, sel: Selection): Promise<string> {
  need(ctx, "bill.split");
  const snap = ctx.data.snapshot();
  const from = snap.get<Check>("check", fromCheckId);
  if (!from || from.status !== "open") throw new TradingError("not_open", fromCheckId);
  const picks = chosen(ctx, sel);
  const n = snap.list<Check>("check").filter((c) => c.seating_id === from.seating_id).length + 1;
  const newId = ctx.newId();
  const date = requireDay((e) => snap.list(e));
  await ctx.data.write({
    intent: "bill.split",
    build: (b) => {
      const muts: Mutation[] = [{ e: "check", id: newId, k: "insert", f: { ...(from.seating_id ? { seating_id: from.seating_id } : {}), order_type: from.order_type, ...(from.token_no !== undefined ? { token_no: from.token_no } : {}), label: `Bill ${n}`, business_date: date, status: "open", ...(from.waiter_id ? { waiter_id: from.waiter_id } : {}) } }];
      for (const p of picks) {
        if (p.whole) muts.push({ e: "order_line", id: p.line.id, k: "set", f: { check_id: newId } });
        else {
          const { id: _id, tenant_id: _t, ...rest } = p.line;
          void _id;
          void _t;
          muts.push({ e: "order_line", id: p.line.id, k: "delta", f: { qty_milli: -p.qty } });
          muts.push({ e: "order_line", id: b.newId(), k: "insert", f: { ...rest, qty_milli: p.qty, check_id: newId, split_from_line_id: p.line.id } });
        }
      }
      return muts;
    },
  });
  return newId;
}

/**
 * Move items to another bill, or to another table (RS10, RS11). Sent lines that change table print a MOVED ticket so the
 * kitchen knows (RM-O10). A free target table is opened first.
 */
export async function moveItems(ctx: TradingCtx, sel: Selection, target: { checkId: string } | { tableId: string }): Promise<string> {
  need(ctx, "order.items.move");
  const picks = chosen(ctx, sel);
  const snap0 = ctx.data.snapshot();
  const targetCheckId = "checkId" in target ? target.checkId : (await openTableCheck(ctx, target.tableId)).checkId;
  const snap = ctx.data.snapshot();
  const list: ListFn = (e) => snap.list(e);
  const to = snap.get<Check>("check", targetCheckId);
  if (!to || to.status !== "open") throw new TradingError("not_open", targetCheckId);
  const toOrder = orderIdOf(list, to) ?? "";
  const sentPicks = picks.filter((p) => p.line.state === "sent");
  const fromCheck = snap0.get<Check>("check", picks[0]!.line.check_id);
  const movedKot = sentPicks.length > 0 && fromCheck?.seating_id !== to.seating_id ? ctx.newId() : undefined;
  await ctx.data.write({
    intent: "order.items.move",
    build: (b) => {
      const muts: Mutation[] = [];
      for (const p of picks) {
        if (p.whole) muts.push({ e: "order_line", id: p.line.id, k: "set", f: { check_id: targetCheckId, order_id: toOrder } });
        else {
          const { id: _id, tenant_id: _t, ...rest } = p.line;
          void _id;
          void _t;
          muts.push({ e: "order_line", id: p.line.id, k: "delta", f: { qty_milli: -p.qty } });
          muts.push({ e: "order_line", id: b.newId(), k: "insert", f: { ...rest, qty_milli: p.qty, check_id: targetCheckId, order_id: toOrder, split_from_line_id: p.line.id } });
        }
      }
      if (movedKot) {
        muts.push({ e: "kot", id: movedKot, k: "insert", f: { check_id: targetCheckId, order_id: toOrder, station_code: sentPicks[0]!.line.station_code, kot_no: `${ctx.deviceCode}-M${String(snap.list("kot").length + 1).padStart(3, "0")}`.slice(0, 12), kind: "moved", order_type: to.order_type, business_date: requireDay(b.list), created_at: new Date(b.now).toISOString() } });
        for (const p of sentPicks) muts.push({ e: "kot_line", id: b.newId(), k: "insert", f: { kot_id: movedKot, order_line_id: p.line.id, name: p.line.kitchen_name, qty_milli: p.qty, status: "new" } });
      }
      return muts;
    },
  });
  if (movedKot) {
    printKot(ctx, (e) => ctx.data.snapshot().list(e), movedKot, "manual", "moved");
    await ctx.print.flush();
  }
  return targetCheckId;
}

/** Move a whole table's seating to a free table (RS11). An occupied target is a merge, not a move. */
export async function moveTable(ctx: TradingCtx, seatingId: string, toTableId: string): Promise<void> {
  need(ctx, "order.table.move");
  const snap = ctx.data.snapshot();
  const s = snap.get<Seating>("seating", seatingId);
  if (!s) throw new TradingError("not_found", seatingId);
  const occupied = snap.list<Seating>("seating").some((x) => x.status !== "closed" && x.id !== seatingId && x.table_id === toTableId);
  if (occupied) throw new TradingError("refused", "table occupied: merge instead");
  await ctx.data.write({ intent: "order.table.move", build: (b) => [{ e: "seating_move", id: b.newId(), k: "insert", f: { seating_id: seatingId, from_table_id: s.table_id, to_table_id: toTableId } }] });
}

/** Merge table `absorbed` into `kept` (RS11): the absorbed seating closes, its bills show on the kept table. */
export async function mergeTables(ctx: TradingCtx, keptSeatingId: string, absorbedSeatingId: string): Promise<void> {
  need(ctx, "order.table.merge");
  const snap = ctx.data.snapshot();
  const kept = snap.get<Seating>("seating", keptSeatingId);
  if (!kept || !snap.get("seating", absorbedSeatingId)) throw new TradingError("not_found", "seating");
  await ctx.data.write({
    intent: "order.table.merge",
    build: (b) => [
      { e: "seating_merge", id: b.newId(), k: "insert", f: { kept_seating_id: keptSeatingId, absorbed_seating_id: absorbedSeatingId, kept_table_id: kept.table_id } },
      { e: "seating", id: absorbedSeatingId, k: "rank", f: { status: "closed" } },
    ],
  });
}

/** Merge bill `dropId` into `keepId` (RS09): the dropped bill's discount is lost and the screen says so first (AC 59). */
export async function mergeBills(ctx: TradingCtx, keepId: string, dropId: string): Promise<{ droppedDiscount: boolean }> {
  need(ctx, "bill.merge");
  const snap = ctx.data.snapshot();
  const keep = snap.get<Check>("check", keepId);
  const drop = snap.get<Check>("check", dropId);
  if (!keep || !drop || keep.status !== "open" || drop.status !== "open") throw new TradingError("not_open", "check");
  const lines = snap.list<OrderLine>("order_line").filter((l) => l.check_id === dropId);
  await ctx.data.write({
    intent: "bill.merge",
    build: (b) => [
      { e: "check_cancel", id: b.newId(), k: "insert", f: { check_id: dropId, merged_into_check_id: keepId, presented: false } },
      ...lines.map((l): Mutation => ({ e: "order_line", id: l.id, k: "set", f: { check_id: keepId } })),
    ],
  });
  return { droppedDiscount: drop.discount_kind !== undefined };
}

/** Cancel an unbilled check (bill.cancel): reason and a manager's approval; lines already sent stay in the kitchen record. */
export async function cancelCheck(ctx: TradingCtx, checkId: string, reasonCodeId: string, approvalId?: string): Promise<void> {
  need(ctx, "bill.cancel", approvalId);
  const snap = ctx.data.snapshot();
  const c = snap.get<Check>("check", checkId);
  if (!c || c.status !== "open") throw new TradingError("not_open", checkId);
  const presented = snap.list("check_present").some((p) => p.check_id === checkId);
  await ctx.data.write({ intent: "bill.cancel", ...(approvalId ? { approval: approvalId } : {}), build: (b) => [{ e: "check_cancel", id: b.newId(), k: "insert", f: { check_id: checkId, reason_code_id: reasonCodeId, ...(approvalId ? { approval_id: approvalId } : {}), presented } }] });
}

/** Sold out / available at this outlet (RS29, menu.availability.set). The kitchen and counter hold the permission. */
export async function setAvailability(ctx: TradingCtx, itemId: string, available: boolean): Promise<void> {
  need(ctx, "menu.availability.set");
  const rowId = `io-${itemId}`;
  const exists = ctx.data.snapshot().get("item_outlet", rowId);
  await ctx.data.write({
    intent: "menu.availability.set",
    build: () => [exists ? { e: "item_outlet", id: rowId, k: "set", f: { available } } : { e: "item_outlet", id: rowId, k: "insert", f: { item_id: itemId, available } }],
  });
}

