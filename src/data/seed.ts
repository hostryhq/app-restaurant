import { itemOutletId, type Mutation, type Row, type SyncEngine } from "@hostry/client-core";

/**
 * Demo outlet for the browser build and tests: what a device holds after the first sync (menu, tables, stations,
 * settings, a tax rule set). Every figure here is a fixture, not tax or price configuration: in production these rows
 * arrive from catalog, billing and the rule-set publisher (client-core sync). Ids are readable on purpose.
 */

export const TENANT_ID = "tenant-1";
export const OUTLET_ID = "outlet-1";

type Seeded = Record<string, Row[]>;

const r = (id: string, f: Record<string, unknown>): Row => ({ id, tenant_id: TENANT_ID, ...f });

/** Rule rows for the three regimes x two premises x four channels, so any outlet profile resolves. Demo rates only. */
function ruleRows(): Row[] {
  const rows: Row[] = [];
  const channels = ["dine_in", "takeaway", "counter", "eco"] as const;
  const regimes = [
    ["regular", "tax_invoice"],
    ["composition", "bill_of_supply"],
    ["unregistered", "plain_bill"],
  ] as const;
  const classes: Array<[string, boolean, number]> = [
    ["fnb_standard", true, 250],
    ["fnb_non_gst", false, 0],
    ["exempt", true, 0],
  ];
  for (const [regime, doc] of regimes) {
    for (const sp of [false, true]) {
      for (const ch of channels) {
        for (const [cls, gst, bp] of classes) {
          const applies = gst && regime === "regular";
          const id = `rule-${regime}-${sp ? "sp" : "ns"}-${ch}-${cls}`;
          rows.push(
            r(id, {
              rule_set_id: "rs-1",
              tax_class: cls,
              regime,
              specified_premises: sp,
              order_channel: ch,
              doc_type: doc,
              gst_applies: applies,
              cgst_bp: applies ? bp : 0,
              sgst_bp: applies ? bp : 0,
              igst_bp: 0,
            }),
          );
        }
      }
    }
  }
  return rows;
}

export function demoRows(): Seeded {
  const items: Array<[string, string, string, string, string, string, number, string?]> = [
    // id, category, name, code, station, veg, price, tax_class
    ["it-dosa", "cat-dosa", "Masala Dosa", "12", "KITCHEN", "veg", 8000],
    ["it-plain", "cat-dosa", "Plain Dosa", "13", "KITCHEN", "veg", 6000],
    ["it-roast", "cat-dosa", "Ghee Roast", "14", "KITCHEN", "veg", 9500],
    ["it-meal", "cat-meals", "Veg Meal", "21", "KITCHEN", "veg", 15000],
    ["it-parotta", "cat-meals", "Parotta", "22", "KITCHEN", "veg", 0],
    ["it-chicken", "cat-meals", "Chicken Curry", "23", "KITCHEN", "non_veg", 18000],
    ["it-coffee", "cat-drinks", "Filter Coffee", "31", "BAR", "veg", 3000],
    ["it-chai", "cat-drinks", "Chai", "32", "BAR", "veg", 2000],
    ["it-lime", "cat-drinks", "Fresh Lime", "33", "BAR", "veg", 4000],
    ["it-vada", "cat-starters", "Medu Vada", "01", "KITCHEN", "veg", 5000],
    ["it-bajji", "cat-starters", "Mirchi Bajji", "02", "KITCHEN", "veg", 6000],
    ["it-water", "cat-drinks", "Packaged Water", "34", "BAR", "none", 2000, "fnb_non_gst"],
  ];
  const variants = [
    r("v-parotta-half", { item_id: "it-parotta", name: "Half", is_default: true, sort_order: 1 }),
    r("v-parotta-full", { item_id: "it-parotta", name: "Full", is_default: false, sort_order: 2 }),
  ];
  const prices: Row[] = items.filter((i) => i[6] > 0).map((i) => r(`pr-${i[0]}`, { item_id: i[0], price_paise: i[6] }));
  prices.push(r("pr-parotta-half", { item_id: "it-parotta", variant_id: "v-parotta-half", price_paise: 8000 }));
  prices.push(r("pr-parotta-full", { item_id: "it-parotta", variant_id: "v-parotta-full", price_paise: 15000 }));
  const quick = ["it-dosa", "it-coffee", "it-meal", "it-chai", "it-vada", "it-lime"];
  return {
    floor: [r("fl-1", { name: "Ground floor", sort_order: 1 })],
    dining_table: Array.from({ length: 8 }, (_, i) => r(`tb-${i + 1}`, { floor_id: "fl-1", name: `T${i + 1}`, seats: 4, active: true })),
    category: [
      r("cat-starters", { name_en: "Starters", sort_order: 1, status: "active", default_tax_class: "fnb_standard" }),
      r("cat-dosa", { name_en: "Dosa", sort_order: 2, status: "active", default_tax_class: "fnb_standard" }),
      r("cat-meals", { name_en: "Meals", sort_order: 3, status: "active", default_tax_class: "fnb_standard" }),
      r("cat-drinks", { name_en: "Drinks", sort_order: 4, status: "active", default_tax_class: "fnb_standard" }),
    ],
    item: items.map((i, n) =>
      r(i[0], { category_id: i[1], name_en: i[2], code: i[3], kitchen_name: i[2].toUpperCase(), station_code: i[4], veg_mark: i[5], tax_class: i[7] ?? "", status: "active", sort_order: n + 1 }),
    ),
    item_variant: variants,
    modifier_group: [
      r("mg-spice", { name: "Spice", min_select: 1, max_select: 1 }),
      r("mg-extra", { name: "Add-ons", min_select: 0, max_select: 2 }),
    ],
    modifier: [
      r("md-mild", { group_id: "mg-spice", name: "Mild", price_delta_paise: 0, sort_order: 1 }),
      r("md-hot", { group_id: "mg-spice", name: "Hot", price_delta_paise: 0, sort_order: 2 }),
      r("md-gravy", { group_id: "mg-extra", name: "Extra gravy", price_delta_paise: 2000, sort_order: 1 }),
      r("md-ghee", { group_id: "mg-extra", name: "Extra ghee", price_delta_paise: 1500, sort_order: 2 }),
    ],
    item_modifier_group: [
      r("img-1", { item_id: "it-chicken", group_id: "mg-spice", sort_order: 1 }),
      r("img-2", { item_id: "it-chicken", group_id: "mg-extra", sort_order: 2 }),
    ],
    price_entry: prices,
    item_outlet: quick.map((id, n) => r(itemOutletId(OUTLET_ID, id), { item_id: id, available: true, quick_item: true, quick_sort: n + 1 })),
    station: [
      r("st-kitchen", { code: "KITCHEN", name: "Kitchen", output: "both", language: "en", printer_id: "prn-kitchen" }),
      r("st-bar", { code: "BAR", name: "Bar", output: "kds", language: "en" }),
      r("st-default", { code: "DEFAULT", name: "Kitchen", output: "both", language: "en", printer_id: "prn-kitchen" }),
    ],
    reason_code: [
      r("rc-cancel-mind", { purpose: "cancel", label_key: "reason.cancel.mind", active: true }),
      r("rc-cancel-wrong", { purpose: "cancel", label_key: "reason.cancel.wrong", active: true }),
      r("rc-cancel-kitchen", { purpose: "cancel", label_key: "reason.cancel.kitchen", active: true }),
      r("rc-cancel-wait", { purpose: "cancel", label_key: "reason.cancel.wait", active: true }),
      r("rc-disc-regular", { purpose: "discount", label_key: "reason.discount.regular", active: true }),
      r("rc-disc-complaint", { purpose: "discount", label_key: "reason.discount.complaint", active: true }),
      r("rc-disc-staff", { purpose: "discount", label_key: "reason.discount.staff", active: true }),
      r("rc-comp-owner", { purpose: "comp", label_key: "reason.comp.owner", active: true }),
      r("rc-cn-wrong", { purpose: "credit_note", label_key: "reason.credit.wrong", active: true }),
      r("rc-cn-gstin", { purpose: "credit_note", label_key: "reason.credit.gstin", active: true }),
      r("rc-present-change", { purpose: "present_change", label_key: "reason.present.change", active: true }),
    ],
    tender_kind: [
      r("tk-cash", { kind: "cash", name: "Cash", enabled: true }),
      r("tk-upi", { kind: "upi", name: "UPI", enabled: true }),
      r("tk-card", { kind: "card", name: "Card", enabled: true }),
    ],
    billing_settings: [
      r("bs-1", {
        number_at: "settle",
        price_mode: "exclusive",
        round_off: true,
        service_charge_bp: 0,
        service_charge_dine_in: false,
        service_charge_takeaway: false,
        service_charge_counter: false,
        packing_charge_paise: 0,
        packing_tax_class: "fnb_standard",
        discount_limit_bp: 1000,
        rebill_allowance_per_shift: 0,
        comp_allowance_paise: 0,
        open_item_limit_paise: 0,
        manual_entry_max_days_back: 2,
        shift_required: true,
        handover_count: false,
        day_cutoff_minutes: 300,
        // Paper bill-book series typed in after a power cut (not an entity field yet: tenancy registrations will carry it).
        manual_book_codes: ["MB1"],
      }),
    ],
    outlet_settings: [r("os-1", { cancel_grace_seconds: 0, kot_stale_after_seconds: 900, send_timeout_seconds: 3, kot_fallback_print: "auto", covers_required: false, idle_lock_seconds: 300, soldout_resets_daily: true, kds_amber_minutes: 10, kds_red_minutes: 20 })],
    outlet_tax_profile: [r("otp-1", { financial_year: "2627", specified_premises: false, fssai_number: "" })],
    receipt_profile: [r("rp-1", { trade_name: "Demo Bhavan", address: "Main Road", phone: "", footer_text: "Thank you. Visit again.", upi_id: "" })],
    tax_rule_set: [r("rs-1", { version: 1, name: "Demo rule set (fixture, not tax advice)", effective_date: "2026-04-01", calc_v: 1, review_status: "draft" })],
    tax_rule: ruleRows(),
  };
}

/**
 * Record the demo rows as one op, standing in for the configuration the cloud publishes (menu, floor, settings, rule
 * set). They go through the engine, not into the store directly, so the sync engine owns every row it later merges
 * (last-writer-wins candidates) and other devices on the network receive them like any other op. The op is a demo
 * fixture ("seed.demo", not in the intent registry): a device with a real pack gets this configuration from sync instead.
 */
export async function seedDemo(engine: SyncEngine, extra: Seeded = {}): Promise<void> {
  const all = { ...demoRows(), ...extra };
  await engine.record({
    intent: "seed.demo",
    actor: "system",
    sid: "system",
    build: () =>
      Object.entries(all).flatMap(([entity, rows]) =>
        rows.map((row): Mutation => {
          const f: Record<string, unknown> = { ...row };
          delete f.id;
          delete f.tenant_id;
          return { e: entity, id: row.id, k: "insert", f };
        }),
      ),
  });
}

/** Rows of a business day opened by an earlier day.open, for tests that start mid-trading. */
export function openDayRows(businessDate: string): Seeded {
  return {
    business_day: [r(`bd-${businessDate}`, { business_date: businessDate, status: "open" })],
  };
}
