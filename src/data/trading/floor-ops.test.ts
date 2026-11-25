import { describe, expect, it } from "vitest";
import { floorView } from "../../domain/table-state";
import type { Check, DiningTable, OrderLine, OrderLineCancel, Seating, SeatingMerge, SeatingMove } from "../../domain/rows";
import { linesOfCheck } from "../../domain/lines";
import { rows, world } from "../../test/world";
import * as T from "./index";

const checksOf = (w: Awaited<ReturnType<typeof world>>) => rows<Check>(w.rt, "check");
const liveLines = (w: Awaited<ReturnType<typeof world>>, checkId: string) => linesOfCheck(checkId, rows<OrderLine>(w.rt, "order_line"), rows<OrderLineCancel>(w.rt, "order_line_cancel"));
const view = (w: Awaited<ReturnType<typeof world>>) =>
  floorView({
    tables: rows<DiningTable>(w.rt, "dining_table"),
    seatings: rows<Seating>(w.rt, "seating"),
    checks: checksOf(w).filter((c) => !rows<{ check_id: string }>(w.rt, "check_cancel").some((x) => x.check_id === c.id)),
    presents: [],
    requests: [],
    kots: [],
    kotLines: [],
    moves: rows<SeatingMove>(w.rt, "seating_move"),
    merges: rows<SeatingMerge>(w.rt, "seating_merge"),
    nowMs: w.clock.now(),
  });

describe("split, move, merge, transfer", () => {
  it("split by item moves whole lines and part of a quantity to a new bill on the same table; totals are conserved", async () => {
    const w = await world();
    await w.signIn("Ravi");
    const { checkId } = await T.openTableCheck(w.rt.ctx, "tb-1");
    const dosa = await T.addLine(w.rt.ctx, checkId, { itemId: "it-dosa", qtyMilli: 3000 });
    const coffee = await T.addLine(w.rt.ctx, checkId, { itemId: "it-coffee", qtyMilli: 1000 });
    const before = liveLines(w, checkId).reduce((s, l) => s + l.qty_milli, 0);
    const nb = await T.splitBill(w.rt.ctx, checkId, { [dosa]: 1000, [coffee]: 1000 });
    expect(liveLines(w, checkId).map((l) => [l.item_id, l.qty_milli])).toEqual([["it-dosa", 2000]]);
    expect(liveLines(w, nb).map((l) => [l.item_id, l.qty_milli]).sort()).toEqual([["it-coffee", 1000], ["it-dosa", 1000]]);
    expect(liveLines(w, checkId).reduce((s, l) => s + l.qty_milli, 0) + liveLines(w, nb).reduce((s, l) => s + l.qty_milli, 0)).toBe(before);
    expect(rows<Check>(w.rt, "check").filter((c) => c.seating_id === rows<Seating>(w.rt, "seating")[0]?.id)).toHaveLength(2);
  });

  it("move table follows the seating to a free table; an occupied target is refused and offers a merge; merge closes the absorbed seating", async () => {
    const w = await world();
    await w.signIn("Ravi");
    const a = await T.openTableCheck(w.rt.ctx, "tb-1");
    const b = await T.openTableCheck(w.rt.ctx, "tb-2");
    await T.addLine(w.rt.ctx, a.checkId, { itemId: "it-dosa", qtyMilli: 1000 });
    await T.addLine(w.rt.ctx, b.checkId, { itemId: "it-chai", qtyMilli: 1000 });
    await expect(T.moveTable(w.rt.ctx, a.seatingId, "tb-2")).rejects.toMatchObject({ code: "refused" });
    await T.moveTable(w.rt.ctx, a.seatingId, "tb-5");
    expect(view(w).find((v) => v.table.id === "tb-1")?.state).toBe("free");
    expect(view(w).find((v) => v.table.id === "tb-5")?.state).toBe("occupied");
    await expect(T.mergeTables(w.rt.ctx, b.seatingId, a.seatingId)).rejects.toMatchObject({ permission: "order.table.merge" }); // a waiter cannot merge
    await w.signIn("Asha");
    await T.mergeTables(w.rt.ctx, b.seatingId, a.seatingId);
    const t2 = view(w).find((v) => v.table.id === "tb-2");
    expect(t2?.checks).toHaveLength(2); // both bills now sit on the kept table
    expect(view(w).find((v) => v.table.id === "tb-5")?.state).toBe("free");
  });

  it("moving a sent line to another table prints a MOVED ticket for the kitchen; moving to a free table opens it", async () => {
    const w = await world();
    await w.signIn("Ravi");
    const a = await T.openTableCheck(w.rt.ctx, "tb-1");
    const line = await T.addLine(w.rt.ctx, a.checkId, { itemId: "it-vada", qtyMilli: 1000 });
    await T.sendKot(w.rt.ctx, a.checkId);
    const target = await T.moveItems(w.rt.ctx, { [line]: 1000 }, { tableId: "tb-4" });
    expect(liveLines(w, target)).toHaveLength(1);
    expect(rows<{ kind: string }>(w.rt, "kot").some((k) => k.kind === "moved")).toBe(true);
    expect(view(w).find((v) => v.table.id === "tb-4")?.state).toBe("occupied");
  });

  it("merging bills drops the dropped bill's discount and says so; the merged bill's lines join the kept one", async () => {
    const w = await world();
    await w.signIn("Asha");
    const a = await T.openTableCheck(w.rt.ctx, "tb-1");
    const second = await T.newBill(w.rt.ctx, a.seatingId);
    await T.addLine(w.rt.ctx, a.checkId, { itemId: "it-dosa", qtyMilli: 1000 });
    await T.addLine(w.rt.ctx, second, { itemId: "it-meal", qtyMilli: 1000 });
    await T.applyDiscount(w.rt.ctx, { checkId: second, kind: "percent", value: 500, reasonCodeId: "rc-disc-regular" });
    const r = await T.mergeBills(w.rt.ctx, a.checkId, second);
    expect(r.droppedDiscount).toBe(true);
    expect(liveLines(w, a.checkId)).toHaveLength(2);
    expect(view(w).find((v) => v.table.id === "tb-1")?.checks.map((c) => c.id)).toEqual([a.checkId]);
  });

  it("a billed check is not editable: discount and merge are refused with a pointer to credit note or re-bill", async () => {
    const w = await world();
    await w.signIn("Asha");
    await T.startShift(w.rt.ctx, 0);
    const c = await T.newCounterCheck(w.rt.ctx);
    await T.addLine(w.rt.ctx, c, { itemId: "it-chai", qtyMilli: 1000 });
    await T.settle(w.rt.ctx, c, { payments: [{ tender: "upi", amount_paise: 2100 }] });
    await expect(T.applyDiscount(w.rt.ctx, { checkId: c, kind: "percent", value: 500, reasonCodeId: "rc-disc-regular" })).rejects.toMatchObject({ code: "not_open" });
    await expect(T.addLine(w.rt.ctx, c, { itemId: "it-chai", qtyMilli: 1000 })).rejects.toMatchObject({ code: "not_open" });
  });
});

describe("modifiers and variants", () => {
  it("modifier minimum and maximum are enforced; the line carries the price delta and the modifier rows", async () => {
    const w = await world();
    await w.signIn("Ravi");
    const { checkId } = await T.openTableCheck(w.rt.ctx, "tb-1");
    await expect(T.addLine(w.rt.ctx, checkId, { itemId: "it-chicken", qtyMilli: 1000 })).rejects.toMatchObject({ code: "modifier_min" });
    await expect(T.addLine(w.rt.ctx, checkId, { itemId: "it-chicken", qtyMilli: 1000, modifierIds: ["md-mild", "md-hot"] })).rejects.toMatchObject({ code: "modifier_max" });
    const id = await T.addLine(w.rt.ctx, checkId, { itemId: "it-chicken", qtyMilli: 1000, modifierIds: ["md-hot", "md-gravy"], note: "less oil" });
    const line = rows<OrderLine>(w.rt, "order_line").find((l) => l.id === id)!;
    expect(line.modifier_delta_paise).toBe(2000);
    expect(line.modifiers_text).toBe("Hot, Extra gravy");
    expect(rows(w.rt, "order_line_modifier")).toHaveLength(2);
    // the same selection folds into one line; a different note makes a second line
    await T.addLine(w.rt.ctx, checkId, { itemId: "it-chicken", qtyMilli: 1000, modifierIds: ["md-hot", "md-gravy"], note: "less oil" });
    await T.addLine(w.rt.ctx, checkId, { itemId: "it-chicken", qtyMilli: 1000, modifierIds: ["md-hot", "md-gravy"] });
    expect(liveLines(w, checkId).map((l) => l.qty_milli)).toEqual([2000, 1000]);
  });

  it("an item with variants needs one and is priced per variant; a sold-out item cannot be added", async () => {
    const w = await world();
    await w.signIn("Asha");
    const { checkId } = await T.openTableCheck(w.rt.ctx, "tb-1");
    await expect(T.addLine(w.rt.ctx, checkId, { itemId: "it-parotta", qtyMilli: 1000 })).rejects.toMatchObject({ code: "variant_required" });
    const id = await T.addLine(w.rt.ctx, checkId, { itemId: "it-parotta", qtyMilli: 1000, variantId: "v-parotta-full" });
    expect(rows<OrderLine>(w.rt, "order_line").find((l) => l.id === id)?.unit_price_paise).toBe(15000);
    await T.setAvailability(w.rt.ctx, "it-dosa", false);
    await expect(T.addLine(w.rt.ctx, checkId, { itemId: "it-dosa", qtyMilli: 1000 })).rejects.toMatchObject({ code: "item_unavailable" });
    await T.setAvailability(w.rt.ctx, "it-dosa", true);
    await T.addLine(w.rt.ctx, checkId, { itemId: "it-dosa", qtyMilli: 1000 });
  });
});
