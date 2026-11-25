import type { BillableLine, CheckHeader } from "@hostry/client-core";
import type { Check, OrderLine, OrderLineCancel } from "./rows";

/** Quantity of a line still standing after cancels and voids (thousandths). */
export function liveQty(line: OrderLine, cancels: readonly OrderLineCancel[]): number {
  const gone = cancels.filter((c) => c.order_line_id === line.id).reduce((s, c) => s + c.qty_milli, 0);
  return Math.max(0, line.qty_milli - gone);
}

/** Lines of a check with their live quantity; lines with nothing left are dropped. */
export function linesOfCheck(checkId: string, lines: readonly OrderLine[], cancels: readonly OrderLineCancel[]): OrderLine[] {
  return lines
    .filter((l) => l.check_id === checkId)
    .map((l) => ({ ...l, qty_milli: liveQty(l, cancels) }))
    .filter((l) => l.qty_milli > 0)
    .sort((a, b) => String(a.id).localeCompare(String(b.id)));
}

/** A draft line the same selection folds into (same item, variant, modifiers and note): tap twice, quantity 2 (AC 50). */
export function matchingDraft(lines: readonly OrderLine[], draft: Pick<OrderLine, "item_id" | "variant_id" | "modifiers_text" | "note">): OrderLine | undefined {
  return lines.find(
    (l) =>
      l.state === "draft" &&
      l.item_id === draft.item_id &&
      (l.variant_id ?? "") === (draft.variant_id ?? "") &&
      (l.modifiers_text ?? "") === (draft.modifiers_text ?? "") &&
      (l.note ?? "") === (draft.note ?? "") &&
      !l.comp,
  );
}

/** The calculation input for one stored line. Names, prices and tax class are the snapshot taken when it was added. */
export function toBillable(l: OrderLine): BillableLine {
  const b: BillableLine = {
    id: l.id,
    item_id: l.item_id,
    name: l.name,
    category_name: l.category_name,
    qty_milli: l.qty_milli,
    unit_price_paise: l.unit_price_paise,
    modifier_delta_paise: l.modifier_delta_paise,
    tax_class: l.tax_class,
  };
  if (l.category_id) b.category_id = l.category_id;
  if (l.hsn_sac) b.hsn_sac = l.hsn_sac;
  if (l.discount_kind && l.discount_value !== undefined) {
    b.discount_kind = l.discount_kind;
    b.discount_value = l.discount_value;
  }
  if (l.comp) b.comp = true;
  return b;
}

export function toHeader(c: Check): CheckHeader {
  const h: CheckHeader = { id: c.id, order_type: c.order_type, status: c.status };
  if (c.token_no !== undefined) h.token_no = c.token_no;
  if (c.discount_kind && c.discount_value !== undefined) {
    h.discount_kind = c.discount_kind;
    h.discount_value = c.discount_value;
  }
  if (c.service_charge_removed) h.service_charge_removed = true;
  if (c.packing_charge_removed) h.packing_charge_removed = true;
  if (c.customer_name) h.customer_name = c.customer_name;
  if (c.customer_gstin) h.customer_gstin = c.customer_gstin;
  if (c.waiter_id) h.waiter_id = c.waiter_id;
  return h;
}

/** Display price of a line: (unit price + modifier delta) x quantity, before discounts, in paise. */
export function lineTotalPaise(l: Pick<OrderLine, "qty_milli" | "unit_price_paise" | "modifier_delta_paise">): number {
  return Math.round(((l.unit_price_paise + l.modifier_delta_paise) * l.qty_milli) / 1000);
}
