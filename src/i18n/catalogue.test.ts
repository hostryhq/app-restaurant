import { describe, expect, it } from "vitest";
import { en as uiEn } from "@hostry/ui-kit";
import { createAppTranslator, en } from "./index";
import { demoRows } from "../data/seed";

const sources = import.meta.glob("/src/**/*.{ts,tsx}", { query: "?raw", import: "default", eager: true }) as Record<string, string>;
const files = Object.entries(sources).filter(([path]) => !/\.test\.tsx?$/.test(path) && !path.includes("/test/") && !path.endsWith("/i18n/en.ts"));
const all = { ...uiEn, ...en };

describe("catalogue (no string is hard-coded, keys only)", () => {
  it("every literal message key used with t(...) exists in the English catalogue", () => {
    const missing: string[] = [];
    for (const [path, text] of files) {
      for (const m of text.matchAll(/\bt\(\s*"([a-z0-9_.]+)"/g)) {
        const key = m[1] as string;
        if (!(key in all)) missing.push(`${path}: ${key}`);
      }
    }
    expect(missing).toEqual([]);
  });

  it("every templated key family resolves for each value the code can produce", () => {
    const families: Record<string, string[]> = {
      role: ["waiter", "cashier", "manager", "owner", "kitchen"],
      "floor.state": ["free", "occupied", "billed", "ready", "attention"],
      "tender.kind": ["cash", "upi", "card", "other", "eco"],
      "credit.refund": ["cash", "upi", "card", "adjusted"],
      "print.kind": ["kot", "bill", "pre_bill", "credit_note", "z_report", "doc"],
      "sync.state": ["synced", "pending", "offline", "conflict"],
      "sync.upstream": ["hub", "cloud", "none"],
      "settings.number_at": ["settle", "print"],
      "shiftclose": ["cash_in", "cash_out", "owner_cash_drop"],
      keys: ["new_order", "search", "discount", "hold", "held", "pay", "exact_cash", "print", "lock", "help", "escape"],
      setup: ["menu", "tables", "rules", "stations", "printer", "business_day"],
      settings: ["discount_limit", "number_at", "round_off", "service_charge", "packing"],
      // error codes of the trading actions, the document functions (client-core documents), the catalogue and the tax engine
      error: [
        "permission", "generic", "no_open_day", "no_open_shift", "not_found", "not_open", "nothing_to_send", "bad_gstin", "payment_short", "approval_needed", "approval_expired", "day_blocked", "refused",
        "empty_check", "check_not_open", "discount_over_limit", "payment_exceeds_total", "no_rule_set", "no_rules_for_context", "credit_exceeds_original", "nothing_to_credit", "not_a_manual_book", "book_number_invalid", "wrong_financial_year",
        "item_unavailable", "modifier_min", "modifier_max", "unknown_item", "no_price", "variant_required", "invalid_qty",
      ],
    };
    const unresolved: string[] = [];
    for (const [family, values] of Object.entries(families)) for (const v of values) if (!(`${family}.${v}` in all)) unresolved.push(`${family}.${v}`);
    expect(unresolved).toEqual([]);
  });

  it("every reason code in the demo data has a label key in the catalogue", () => {
    const missing = demoRows().reason_code!.map((r) => r.label_key as string).filter((k) => !(k in all));
    expect(missing).toEqual([]);
  });

  it("falls back to English then the key itself for an unknown locale entry", () => {
    const t = createAppTranslator();
    expect(t.t("login.title")).toBe("Who is working?");
    expect(t.t("does.not.exist")).toBe("does.not.exist");
    expect(t.t("tender.done", { number: "A07/2627/000001" })).toBe("Settled. Bill A07/2627/000001.");
  });

  it("uses Western digits and no amounts in message text (money goes through formatMoney)", () => {
    for (const [k, v] of Object.entries(en)) {
      expect(v, k).not.toMatch(/[०-९௦-௯൦-൯]/); // Devanagari, Tamil, Malayalam digits
      expect(v, k).not.toMatch(/₹\s?\d/); // no rupee amount baked in
    }
  });
});
