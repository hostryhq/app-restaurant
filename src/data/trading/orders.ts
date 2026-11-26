import { businessDayId, dateToOpen, type LineSelection, type Mutation } from "@hostry/client-core";
import { matchingDraft, liveQty } from "../../domain/lines";
import type { BusinessDay, Check, Order, OrderLine, OrderLineCancel, Seating } from "../../domain/rows";
import { menuFrom } from "../context";
import { need, requireDay, TradingError, type ListFn, type TradingCtx } from "./ctx";

/** Opens today's business day if none is open (a device opens a day only when it knows of none; ADR-0014 A1.1). */
export async function ensureDayOpen(ctx: TradingCtx): Promise<string> {
  const days = ctx.data.snapshot().list<BusinessDay>("business_day");
  if (days.some((d) => d.status === "open")) return requireDay((e) => ctx.data.snapshot().list(e));
  need(ctx, "shift.open");
  const date = dateToOpen(days.map((d) => ({ business_date: d.business_date, status: d.status })), ctx.now());
  if (!date) throw new TradingError("no_open_day");
  const id = businessDayId(ctx.outletId, date);
  await ctx.data.write({
    intent: "day.open",
    build: (b) => [
      { e: "business_day", id, k: "insert", f: { business_date: date, status: "open" } },
      { e: "day_open", id: b.newId(), k: "insert", f: { business_day_id: id, business_date: date } },
    ],
  });
  return date;
}

/** The order a check's lines hang on: the seating's order, or a counter order with the same token and date. */
export function orderIdOf(list: ListFn, check: Check): string | undefined {
  const orders = list("order") as Order[];
  if (check.seating_id) return orders.find((o) => o.seating_id === check.seating_id)?.id;
  return orders.find((o) => !o.seating_id && o.token_no === check.token_no && o.business_date === check.business_date)?.id;
}

export function openSeatingOf(list: ListFn, tableId: string): Seating | undefined {
  return (list("seating") as Seating[]).find((s) => s.table_id === tableId && s.status !== "closed");
}

/** Open seating and its first open check for a table; created together on the first item (AC 39). */
export async function openTableCheck(ctx: TradingCtx, tableId: string): Promise<{ seatingId: string; checkId: string }> {
  need(ctx, "order.create");
  const date = await ensureDayOpen(ctx);
  const snap = () => ctx.data.snapshot();
  const existing = openSeatingOf((e) => snap().list(e), tableId);
  if (existing) {
    const c = snap().list<Check>("check").find((x) => x.seating_id === existing.id && x.status === "open");
    if (c) return { seatingId: existing.id, checkId: c.id };
    const checkId = ctx.newId();
    await ctx.data.write({
      intent: "check.create",
      build: () => [{ e: "check", id: checkId, k: "insert", f: { seating_id: existing.id, order_type: "dine_in", business_date: date, status: "open" } }],
    });
    return { seatingId: existing.id, checkId };
  }
  const seatingId = ctx.newId();
  const checkId = ctx.newId();
  await ctx.data.write({ intent: "seating.open", build: () => [{ e: "seating", id: seatingId, k: "insert", f: { table_id: tableId, business_date: date, status: "open" } }] });
  await ctx.data.write({
    intent: "check.create",
    build: () => [{ e: "check", id: checkId, k: "insert", f: { seating_id: seatingId, order_type: "dine_in", business_date: date, status: "open" } }],
  });
  await ctx.data.write({ intent: "order.create", build: () => [{ e: "order", id: ctx.newId(), k: "insert", f: { seating_id: seatingId, order_type: "dine_in", business_date: date, source: "pos" } }] });
  return { seatingId, checkId };
}

/** A new counter or takeaway order with the next token of the business date. */
export async function newCounterCheck(ctx: TradingCtx, orderType: "counter" | "takeaway" = "counter"): Promise<string> {
  need(ctx, "order.create");
  const date = await ensureDayOpen(ctx);
  const tokens = ctx.data.snapshot().list<Check>("check").filter((c) => c.business_date === date && c.token_no !== undefined).map((c) => c.token_no as number);
  const token = (tokens.length ? Math.max(...tokens) : 0) + 1;
  const checkId = ctx.newId();
  await ctx.data.write({ intent: "check.create", build: () => [{ e: "check", id: checkId, k: "insert", f: { order_type: orderType, token_no: token, business_date: date, status: "open" } }] });
  await ctx.data.write({ intent: "order.create", build: () => [{ e: "order", id: ctx.newId(), k: "insert", f: { order_type: orderType, token_no: token, business_date: date, source: "pos" } }] });
  return checkId;
}

/** A second bill on an occupied table (RS09 New bill). */
export async function newBill(ctx: TradingCtx, seatingId: string): Promise<string> {
  need(ctx, "bill.new");
  const date = requireDay((e) => ctx.data.snapshot().list(e));
  const n = ctx.data.snapshot().list<Check>("check").filter((c) => c.seating_id === seatingId).length + 1;
  const id = ctx.newId();
  await ctx.data.write({ intent: "bill.new", build: () => [{ e: "check", id, k: "insert", f: { seating_id: seatingId, order_type: "dine_in", label: `Bill ${n}`, business_date: date, status: "open" } }] });
  return id;
}

/**
 * Add an item. The line snapshots price, names, tax class and station now (RM-M6), so a later menu edit never changes
 * an open check. The same selection again folds into the draft line (AC 50).
 */
export async function addLine(ctx: TradingCtx, checkId: string, sel: LineSelection): Promise<string> {
  need(ctx, "order.edit");
  const snap = ctx.data.snapshot();
  const check = snap.get<Check>("check", checkId);
  if (!check) throw new TradingError("not_found", checkId);
  if (check.status !== "open") throw new TradingError("not_open", checkId);
  const list: ListFn = (e) => snap.list(e);
  const menu = menuFrom(list);
  const draft = menu.buildOrderLine(sel); // throws CatalogError (unavailable, modifier min/max, ...)
  const lines = snap.list<OrderLine>("order_line").filter((l) => l.check_id === checkId);
  const live = lines.map((l) => ({ ...l, qty_milli: liveQty(l, snap.list<OrderLineCancel>("order_line_cancel")) })).filter((l) => l.qty_milli > 0);
  const same = matchingDraft(live, draft);
  if (same) {
    await ctx.data.write({ intent: "order.line.edit", build: () => [{ e: "order_line", id: same.id, k: "delta", f: { qty_milli: draft.qty_milli } }] });
    return same.id;
  }
  const orderId = orderIdOf(list, check);
  if (!orderId) throw new TradingError("not_found", "order");
  const id = ctx.newId();
  const groups = menu.modifierGroupsOf(sel.itemId).flatMap((g) => g.options).filter((o) => (sel.modifierIds ?? []).includes(o.id));
  await ctx.data.write({
    intent: "order.line.add",
    build: (b) => {
      const muts: Mutation[] = [{ e: "order_line", id, k: "insert", f: { ...draft, order_id: orderId, check_id: checkId } }];
      for (const m of groups) muts.push({ e: "order_line_modifier", id: b.newId(), k: "insert", f: { order_line_id: id, modifier_id: m.id, name: m.name, price_delta_paise: m.price_delta_paise } });
      return muts;
    },
  });
  return id;
}

/** Change the quantity of a draft line. Sent lines change only through the cancel flow. */
export async function setLineQty(ctx: TradingCtx, lineId: string, qtyMilli: number): Promise<void> {
  need(ctx, "order.edit");
  const l = ctx.data.snapshot().get<OrderLine>("order_line", lineId);
  if (!l) throw new TradingError("not_found", lineId);
  if (l.state !== "draft") throw new TradingError("refused", "sent line");
  if (qtyMilli < 1) return removeDraft(ctx, lineId);
  await ctx.data.write({ intent: "order.line.edit", build: () => [{ e: "order_line", id: lineId, k: "set", f: { qty_milli: qtyMilli } }] });
}

/** Remove a draft line: gone, no prompt (AC 47). */
export async function removeDraft(ctx: TradingCtx, lineId: string): Promise<void> {
  need(ctx, "order.edit");
  const snap = ctx.data.snapshot();
  const l = snap.get<OrderLine>("order_line", lineId);
  if (!l) throw new TradingError("not_found", lineId);
  if (l.state !== "draft") throw new TradingError("refused", "sent line needs the cancel flow");
  const qty = liveQty(l, snap.list<OrderLineCancel>("order_line_cancel"));
  if (qty < 1) return;
  await ctx.data.write({ intent: "order.line.void", build: (b) => [{ e: "order_line_cancel", id: b.newId(), k: "insert", f: { order_line_id: lineId, kind: "void", qty_milli: qty } }] });
}

/** Mark a table's seating closed when nothing live is left on any of its checks ("Free table"). */
export async function freeTable(ctx: TradingCtx, seatingId: string): Promise<void> {
  need(ctx, "order.edit");
  const snap = ctx.data.snapshot();
  const cancels = snap.list<OrderLineCancel>("order_line_cancel");
  const checks = snap.list<Check>("check").filter((c) => c.seating_id === seatingId && c.status === "open");
  const hasLines = checks.some((c) => snap.list<OrderLine>("order_line").some((l) => l.check_id === c.id && liveQty(l, cancels) > 0));
  if (hasLines) throw new TradingError("refused", "table has lines");
  await ctx.data.write({ intent: "seating.close", build: () => [{ e: "seating", id: seatingId, k: "rank", f: { status: "closed" } }] });
}
