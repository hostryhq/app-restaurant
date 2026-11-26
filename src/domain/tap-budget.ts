/**
 * Tap and keystroke budgets from docs/design/restaurant-app-flows.md section 3. The tap-budget test drives the real
 * screens and counts events against these numbers, so a screen change that adds a tap fails the build.
 */
export const TAP_BUDGET = {
  /** Add an item at the counter, touch (AC 12): quick item = 1, category + item = 2. */
  addItem: 2,
  /** Counter bill, 3 single items, exact cash (AC 91). */
  counterBillThreeItems: 10,
  /** Open table, add one item, send. */
  tableOrderSend: 3,
  /** Remove a draft item: no prompt. */
  removeDraft: 1,
  /** Bill please (waiter): table, Bill please. */
  billPlease: 2,
  /** Present then take exact cash: request row, Present, Pay, Exact. */
  presentThenExact: 4,
  /** Guest pays without a pre-bill: table, Pay, Exact. */
  payWithoutPreBill: 3,
  /** Keyboard-only counter bill (AC 92): F2, 3 x code+Enter, F8, F9 = 6 key groups. */
  counterBillKeyGroups: 6,
  /** Bump a ticket on the KDS. */
  bump: 1,
  /** Reprint a bill: Bills, row, Reprint. */
  reprint: 3,
} as const;
