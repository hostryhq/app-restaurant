/**
 * Counter keyboard (AC 92, P2D-8). The code box takes `12` (quantity 1) or `3*12` (quantity 3); Enter adds.
 * No shortcut fires inside a text field except Enter, Esc and the F-keys.
 */

export type CodeEntry = { qtyMilli: number; code: string };

/** "3*12" -> 3 x code 12; "12" -> 1 x code 12. Returns undefined for anything else (it is a search term instead). */
export function parseCodeEntry(text: string): CodeEntry | undefined {
  const m = /^(?:(\d{1,3})\*)?([A-Za-z0-9]{1,8})$/.exec(text.trim());
  if (!m) return undefined;
  const qty = m[1] ? Number(m[1]) : 1;
  if (qty < 1) return undefined;
  return { qtyMilli: qty * 1000, code: m[2]! };
}

export type ShortcutAction =
  | "new_order"
  | "search"
  | "discount"
  | "hold"
  | "held"
  | "pay"
  | "exact_cash"
  | "print"
  | "lock"
  | "help"
  | "escape";

const F_KEYS: Record<string, ShortcutAction> = { F2: "new_order", F3: "search", F4: "discount", F5: "hold", F6: "held", F8: "pay", F9: "exact_cash" };

export type KeyLike = { key: string; ctrlKey?: boolean; metaKey?: boolean; altKey?: boolean };

/** Map a key press to a counter action. `inField` is true when focus is in a text input. */
export function shortcutFor(e: KeyLike, inField: boolean): ShortcutAction | undefined {
  if (e.key === "Escape") return "escape";
  const f = F_KEYS[e.key];
  if (f) return f;
  if (e.ctrlKey || e.metaKey) {
    if (e.key.toLowerCase() === "p") return "print";
    if (e.key.toLowerCase() === "l") return "lock";
    return undefined;
  }
  if (inField) return undefined;
  if (e.key === "/") return "search";
  if (e.key === "?") return "help";
  return undefined;
}

export const SHORTCUT_SHEET: Array<{ keys: string; action: ShortcutAction }> = [
  { keys: "F2", action: "new_order" },
  { keys: "F3 /", action: "search" },
  { keys: "F4", action: "discount" },
  { keys: "F5", action: "hold" },
  { keys: "F6", action: "held" },
  { keys: "F8", action: "pay" },
  { keys: "F9", action: "exact_cash" },
  { keys: "Ctrl+P", action: "print" },
  { keys: "Ctrl+L", action: "lock" },
  { keys: "?", action: "help" },
  { keys: "Esc", action: "escape" },
];
