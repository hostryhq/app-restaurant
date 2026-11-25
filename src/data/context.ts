import { Menu, loadRuleSet, type BillingSettings, type OutletBillingContext, type Regime, type Row, type RuleRow, type RuleSetDoc } from "@hostry/client-core";

/** Reads one entity's live rows. Both the UI snapshot and a store transaction provide this. */
export type ListFn = (entity: string) => Row[];

export function menuFrom(list: ListFn): Menu {
  return new Menu({
    categories: list("category") as never,
    items: list("item") as never,
    variants: list("item_variant") as never,
    modifierGroups: list("modifier_group") as never,
    modifiers: list("modifier") as never,
    itemModifierGroups: list("item_modifier_group") as never,
    prices: list("price_entry") as never,
    itemOutlets: list("item_outlet") as never,
    stations: list("station") as never,
  });
}

export const DEFAULT_SETTINGS: BillingSettings = {
  number_at: "settle",
  price_mode: "exclusive",
  round_off: false,
  service_charge_bp: 0,
  service_charge_dine_in: false,
  service_charge_takeaway: false,
  service_charge_counter: false,
  packing_charge_paise: 0,
  packing_tax_class: "fnb_standard",
  discount_limit_bp: 1000,
};

export type OutletSettings = BillingSettings & { shift_required: boolean; manual_entry_max_days_back: number; day_cutoff_minutes: number; rebill_allowance_per_shift: number };

export function settingsFrom(list: ListFn): OutletSettings {
  const b = (list("billing_settings")[0] ?? {}) as Partial<OutletSettings>;
  return {
    ...DEFAULT_SETTINGS,
    ...b,
    shift_required: b.shift_required ?? true,
    manual_entry_max_days_back: b.manual_entry_max_days_back ?? 2,
    day_cutoff_minutes: b.day_cutoff_minutes ?? 300,
    rebill_allowance_per_shift: b.rebill_allowance_per_shift ?? 0,
  };
}

/**
 * Everything an outlet contributes to a bill calculation, read from the local store. Rates come only from the rule
 * sets held on the device (published by Hostry, synced in); nothing is hard-coded. The regime is the outlet's
 * registration; until the tenancy registration rows sync it is read from `outlet_tax_profile.regime` (default regular).
 */
export function billingContextFrom(list: ListFn, outletId: string, manualBookCodes: string[] = []): OutletBillingContext {
  const ruleRows = list("tax_rule");
  const sets = list("tax_rule_set").map((s) => {
    const doc: RuleSetDoc = loadRuleSet({
      name: String(s.name),
      effective_date: String(s.effective_date),
      calc_v: Number(s.calc_v),
      rules: ruleRows
        .filter((r) => r.rule_set_id === s.id)
        .map((r): RuleRow => {
          const row: RuleRow = {
            tax_class: String(r.tax_class),
            regime: r.regime as Regime,
            specified_premises: Boolean(r.specified_premises),
            order_channel: r.order_channel as RuleRow["order_channel"],
            doc_type: r.doc_type as RuleRow["doc_type"],
            gst_applies: Boolean(r.gst_applies),
            cgst_bp: Number(r.cgst_bp),
            sgst_bp: Number(r.sgst_bp),
            igst_bp: 0,
          };
          if (typeof r.sac === "string" && r.sac) row.sac = r.sac;
          return row;
        }),
    });
    return { id: s.id, doc };
  });
  const profile = (list("outlet_tax_profile")[0] ?? {}) as { regime?: Regime; specified_premises?: boolean };
  return {
    outletId,
    settings: settingsFrom(list),
    regime: profile.regime ?? "regular",
    specifiedPremises: profile.specified_premises ?? false,
    ruleSets: sets,
    manualBookCodes,
  };
}
