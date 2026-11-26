import { describe, expect, it } from "vitest";
import { APPROVAL_VALID_MS, decideDiscount, effectiveBp, isApprovalValid, percentToBp } from "./discount";
import { kdsTickets, nextKdsStatus } from "./kds";
import { parseCodeEntry, shortcutFor } from "./keys";
import { afterAttempt, checkAttempt, emptyGuard } from "./pin-guard";
import type { Kot, KotLine } from "./rows";
import { countedTotal, dayBlockers, dayCloseOverdue, expectedCash, INR_DENOMINATIONS, zNumber } from "./shift-day";

describe("discount rules", () => {
  it.each([
    [{ bp: 500, limitBp: 1000, canApply: true, canOverLimit: false }, "apply"],
    [{ bp: 1000, limitBp: 1000, canApply: true, canOverLimit: false }, "apply"], // the limit itself is allowed
    [{ bp: 1001, limitBp: 1000, canApply: true, canOverLimit: false }, "ask_manager"],
    [{ bp: 2000, limitBp: 1000, canApply: true, canOverLimit: true }, "own_pin"],
    [{ bp: 10000, limitBp: 1000, canApply: true, canOverLimit: true }, "comp"],
    [{ bp: 100, limitBp: 1000, canApply: false, canOverLimit: false }, "refuse"],
  ] as const)("%j -> %s", (input, expected) => {
    expect(decideDiscount({ ...input })).toBe(expected);
  });

  it("converts an amount discount to its effective percentage, rounding up so a limit is never slipped under", () => {
    expect(effectiveBp("percent", 1250, 99_999)).toBe(1250);
    expect(effectiveBp("amount", 1000, 10_000)).toBe(1000); // 10.00 of 100.00 is 10%
    expect(effectiveBp("amount", 1001, 10_000)).toBe(1001);
    expect(effectiveBp("amount", 3, 7)).toBe(Math.ceil(30_000 / 7));
    expect(effectiveBp("amount", 500, 0)).toBe(10_000);
  });

  it("reads a typed percentage into basis points and refuses nonsense", () => {
    expect(percentToBp("12.5")).toBe(1250);
    expect(percentToBp("100")).toBe(10_000);
    for (const bad of ["", "101", "-5", "1e2", "12,5", "abc", "10.555"]) expect(percentToBp(bad)).toBeUndefined();
  });

  it("an approval is valid for two minutes", () => {
    expect(isApprovalValid(1_000, 1_000 + APPROVAL_VALID_MS)).toBe(true);
    expect(isApprovalValid(1_000, 1_001 + APPROVAL_VALID_MS)).toBe(false);
    expect(isApprovalValid(2_000, 1_000)).toBe(false);
  });
});

describe("PIN guard (RS01)", () => {
  it("delays after 5 wrong, locks after 10, resets on a correct PIN", () => {
    let g = emptyGuard();
    for (let i = 0; i < 4; i++) g = afterAttempt(g, false, 0);
    expect(checkAttempt(g, 0).allowed).toBe(true);
    g = afterAttempt(g, false, 0); // the 5th wrong
    expect(checkAttempt(g, 1_000)).toEqual({ allowed: false, reason: "delay", waitSeconds: 59 });
    expect(checkAttempt(g, 60_000).allowed).toBe(true);
    for (let i = 0; i < 5; i++) g = afterAttempt(g, false, 60_000);
    expect(checkAttempt(g, 10_000_000)).toMatchObject({ allowed: false, reason: "locked" });
    expect(checkAttempt(afterAttempt(afterAttempt(emptyGuard(), false, 0), true, 0), 0).allowed).toBe(true);
  });
});

describe("shift and day", () => {
  it("expected cash is float plus cash taken, less refunds, plus cash in, less cash out and drops", () => {
    expect(expectedCash({ openingFloat: 200_000, cashPayments: 50_000, cashRefunds: 5_000, cashIn: 10_000, cashOut: 2_000, ownerDrops: 100_000 })).toBe(153_000);
  });

  it("counts denominations in paise", () => {
    expect(countedTotal({ d500: 2, d100: 3, d1: 7 }, INR_DENOMINATIONS)).toBe(2 * 50_000 + 3 * 10_000 + 7 * 100);
  });

  it("an open shift and unbilled checks block the day; carried and force-closed ones do not; presented ones are named", () => {
    const input = { openShiftIds: ["s1", "s2"], openChecks: [{ checkId: "c1", lines: 2, presented: false }, { checkId: "c2", lines: 1, presented: true }, { checkId: "c3", lines: 1, presented: false }] };
    expect(dayBlockers(input).map((b) => b.kind)).toEqual(["open_shift", "open_shift", "unresolved_lines", "presented_unbilled", "unresolved_lines"]);
    expect(dayBlockers({ ...input, forcedShiftIds: ["s1", "s2"], carriedCheckIds: ["c1", "c2", "c3"] })).toEqual([]);
  });

  it("numbers a Z-report and its revisions; a day left open past the cut-off the next morning is overdue", () => {
    expect(zNumber("2026-11-24", "A07")).toBe("Z/2026-11-24/A07");
    expect(zNumber("2026-11-24", "A07", 2)).toBe("Z/2026-11-24/A07/R2");
    const cutoff = Date.parse("2026-11-25T05:00:00+05:30");
    expect(dayCloseOverdue("2026-11-24", cutoff - 1, 300)).toBe(false);
    expect(dayCloseOverdue("2026-11-24", cutoff + 1, 300)).toBe(true);
    expect(dayCloseOverdue(undefined, cutoff + 1, 300)).toBe(false);
  });
});

describe("KDS tickets (RS22)", () => {
  const kot = (id: string, created: string, extra: Partial<Kot> = {}): Kot => ({ id, tenant_id: "t", check_id: "c", order_id: "o", station_code: "KITCHEN", kot_no: id, kind: "original", order_type: "dine_in", business_date: "2026-11-24", created_at: created, ...extra });
  const line = (id: string, kotId: string, status: KotLine["status"]): KotLine => ({ id, tenant_id: "t", kot_id: kotId, order_line_id: id, name: id, qty_milli: 1000, status });
  const now = Date.parse("2026-11-24T08:00:00Z");

  it("shows the station's tickets oldest first, moves done ones to the done strip and keeps cancel banners until acknowledged", () => {
    const kots = [kot("k2", "2026-11-24T07:50:00Z"), kot("k1", "2026-11-24T07:40:00Z"), kot("k3", "2026-11-24T07:55:00Z", { station_code: "BAR" }), kot("k4", "2026-11-24T07:56:00Z", { kind: "cancel" })];
    const lines = [line("a", "k1", "ready"), line("b", "k2", "new"), line("c", "k3", "new")];
    // a cancel ticket has no kot_line rows: its items are the cancels that name it
    const cancels = [{ id: "cx", tenant_id: "t", order_line_id: "ol-d", kind: "cancel" as const, qty_milli: 1000, kot_id: "k4" }];
    const orderLines = [{ id: "ol-d", kitchen_name: "TEA" }] as never;
    const v = kdsTickets({ kots, lines, cancels, orderLines, handovers: [], acked: new Set(), stationCodes: ["KITCHEN"], nowMs: now });
    expect(v.active[1]?.lines.map((l) => [l.name, l.qty_milli])).toEqual([["TEA", 1000]]);
    expect(v.active.map((t) => t.kot.id)).toEqual(["k2", "k4"]);
    expect(v.active[0]?.minutes).toBe(10);
    expect(v.active[1]?.alert).toBe("cancelled");
    expect(v.done.map((t) => t.kot.id)).toEqual(["k1"]);
    const acked = kdsTickets({ kots, lines, cancels, orderLines, handovers: [], acked: new Set(["k4"]), stationCodes: ["KITCHEN"], nowMs: now });
    expect(acked.active.map((t) => t.kot.id)).toEqual(["k2"]);
    expect(acked.done.map((t) => t.kot.id)).toEqual(["k4", "k1"]); // newest first
  });

  it("marks a ticket given by hand and steps items one forward at a time", () => {
    const v = kdsTickets({ kots: [kot("k1", "2026-11-24T07:59:00Z")], lines: [line("a", "k1", "new")], handovers: [{ id: "h", tenant_id: "t", kot_id: "k1", mode: "by_hand" }], acked: new Set(), stationCodes: [], nowMs: now });
    expect(v.active[0]?.alreadyGiven).toBe(true);
    expect([nextKdsStatus("new"), nextKdsStatus("preparing"), nextKdsStatus("ready"), nextKdsStatus("served")]).toEqual(["preparing", "ready", "ready", "served"]);
  });
});

describe("counter keyboard (AC 92)", () => {
  it("parses a code with and without quantity and refuses anything else", () => {
    expect(parseCodeEntry("12")).toEqual({ qtyMilli: 1000, code: "12" });
    expect(parseCodeEntry("3*12")).toEqual({ qtyMilli: 3000, code: "12" });
    for (const bad of ["", "*12", "0*12", "3*", "a b", "1234567890"]) expect(parseCodeEntry(bad)).toBeUndefined();
  });

  it("maps keys; no shortcut fires inside a text field except Enter, Esc and the F-keys", () => {
    expect(shortcutFor({ key: "F8" }, false)).toBe("pay");
    expect(shortcutFor({ key: "F9" }, true)).toBe("exact_cash");
    expect(shortcutFor({ key: "/" }, true)).toBeUndefined();
    expect(shortcutFor({ key: "/" }, false)).toBe("search");
    expect(shortcutFor({ key: "p", ctrlKey: true }, true)).toBe("print");
    expect(shortcutFor({ key: "F1" }, false)).toBeUndefined(); // F1 and F10 are not used (Windows)
    expect(shortcutFor({ key: "F10" }, false)).toBeUndefined();
    expect(shortcutFor({ key: "Escape" }, true)).toBe("escape");
  });
});
