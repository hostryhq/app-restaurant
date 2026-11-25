import type { Row } from "@hostry/client-core";

/**
 * Typed views of the store rows this app reads (api-specs entities/restaurant, snake_case). Only the fields the app
 * reads are listed. A row is always `Row` underneath; `as<T>()` narrows after the entity is known.
 */

export type Base = Row;

export type Floor = Base & { name: string; sort_order: number };
export type DiningTable = Base & { floor_id: string; name: string; seats: number; active: boolean };
export type Seating = Base & { table_id: string; business_date: string; covers?: number; status: "open" | "billed" | "closed"; opened_at?: string };
export type Check = Base & {
  seating_id?: string;
  order_type: "dine_in" | "takeaway" | "counter";
  label?: string;
  token_no?: number;
  business_date: string;
  status: "open" | "closed_internal" | "billed";
  bill_id?: string;
  discount_kind?: "percent" | "amount";
  discount_value?: number;
  discount_reason_code_id?: string;
  service_charge_removed?: boolean;
  packing_charge_removed?: boolean;
  customer_name?: string;
  customer_gstin?: string;
  waiter_id?: string;
  held?: boolean;
};
export type Order = Base & { seating_id?: string; order_type: string; token_no?: number; business_date: string };
export type OrderLine = Base & {
  order_id: string;
  check_id: string;
  item_id: string;
  variant_id?: string;
  name: string;
  kitchen_name: string;
  category_id: string;
  category_name: string;
  qty_milli: number;
  unit_price_paise: number;
  modifier_delta_paise: number;
  modifiers_text?: string;
  note?: string;
  tax_class: string;
  hsn_sac?: string;
  station_code: string;
  state: "draft" | "sent";
  discount_kind?: "percent" | "amount";
  discount_value?: number;
  comp?: boolean;
  comp_reason_code_id?: string;
  added_at?: string;
};
export type OrderLineCancel = Base & { order_line_id: string; kind: "void" | "cancel" | "grace_cancel"; qty_milli: number; reason_code_id?: string; kot_id?: string; wastage?: boolean };
export type Kot = Base & {
  check_id: string;
  order_id: string;
  station_code: string;
  kot_no: string;
  kind: "original" | "cancel" | "moved" | "recall";
  recall_of_kot_id?: string;
  order_type: string;
  table_name?: string;
  token_no?: number;
  business_date: string;
  created_at: string;
};
export type KotLine = Base & { kot_id: string; order_line_id: string; name: string; qty_milli: number; note?: string; status: "new" | "preparing" | "ready" | "served" };
export type SeatingMove = Base & { seating_id: string; from_table_id: string; to_table_id: string };
export type SeatingMerge = Base & { kept_seating_id: string; absorbed_seating_id: string; kept_table_id?: string };
export type KotHandover = Base & { kot_id: string; mode: "by_hand" | "verbal" };
export type BillRequest = Base & { check_id: string; seating_id?: string; requested_at: string };
export type CheckPresent = Base & { check_id: string; present_count: number; total_paise: number; mode: "printed" | "displayed"; presented_at: string };
export type Station = Base & { code: string; name: string; output: "printer" | "kds" | "both"; language: "en" | "ta" | "ml"; printer_id?: string };
export type Shift = Base & { business_date: string; opening_float_paise: number; status: "open" | "closed"; opened_by: string; opened_at: string };
export type ShiftClose = Base & { shift_id: string; counted_paise: number; expected_paise: number; variance_paise: number; force_closed?: boolean };
export type BusinessDay = Base & { business_date: string; status: "open" | "closed" };
export type DayClose = Base & { business_day_id: string; z_number: string; total_paise: number; bill_count: number; cutoff: string };
export type CashEvent = Base & { kind: "cash_in" | "cash_out" | "owner_cash_drop" | "no_sale"; amount_paise: number; shift_id?: string; business_date: string; note?: string };
export type ReasonCode = Base & { purpose: string; label_key: string; active: boolean };
export type OpRow = Base & { seq: number; intent: string; at: string; actor: string; delivery: "local" | "at_hub" | "in_cloud"; origin: string; own: boolean; muts: Array<{ e: string; id: string; k: string }>; approval?: string; doc?: { type: string; number: string } };

export type { Item, Category } from "@hostry/client-core";

export const as = <T extends Row>(rows: Row[]): T[] => rows as T[];
