# Screens built against docs/design/restaurant-app-flows.md

Status: **built** (works end to end, covered by a test), **partial** (what is missing is stated), **not built**.

| Screen | Status | Where | Notes |
|---|---|---|---|
| RS00 Shell, chip, banners, mode switcher | built | `features/shell/Shell.tsx` | Banners: printer failed, clock wrong, day close overdue, pack expiring, working alone, late tickets. FSSAI-missing banner not built. Never a subscription banner (tested). |
| RS01 Lock and PIN login | built | `features/shell/Lock.tsx` | Delay after 5, lock after 10, idle lock (counter 5 min, handheld 2 min), Ctrl+L. KDS has no lock. |
| RS02 Open shift | built | `features/shell/OpenShiftSheet.tsx` | At the first cash payment, float prefilled. |
| RS03 Floor | built | `features/floor/Floor.tsx` | All / Mine, bill requests, derived tile state. No long press (the Order screen has a Table actions button). |
| RS04 Order screen | built | `features/order/Order.tsx` | Draft fold, send per station, bill tabs, Bill please, Present or Print bill, billed notice. Reason chip after a Present is not built. |
| RS05 Item sheet | built | `features/order/ItemSheet.tsx` | |
| RS06 Send result | built | `Order.tsx` | Not delivered alert with Retry, Given by hand, Told verbally; `SentIndicator` per line. |
| RS07 Cancel sent line | built | `features/order/CancelDialog.tsx` | Own PIN or Ask manager; wastage if the kitchen had started. |
| RS08 Approval | built | `features/common.tsx` | Requester not offered; approver does not become the session user. |
| RS09 Table actions | built | `features/order/TableActions.tsx` | New bill, split, move items, move table, merge tables, merge bills, free, cancel bill. |
| RS10, RS11 Select lines, picker | built | `TableActions.tsx` | |
| RS12 Bill requests, check review, Present, Issue invoice | partial | `Floor.tsx`, `Order.tsx`, `Tender.tsx` | Requests list on the floor; review is the order screen itself (discount, GSTIN on tender). No separate review screen. |
| RS13 Counter | built | `Order.tsx` | Quick items, code entry `3*12`, keyboard map. No scale or barcode wiring. |
| RS14 Held and pending pickup | built | `features/billing/Held.tsx` | |
| RS15 Tender | built | `features/billing/Tender.tsx` | Cash default, Exact (F9), quick cash, mixed tenders, N shares, GSTIN, Issue invoice, shift prompt. |
| RS16 Discount, comp, charges | built | `features/order/DiscountSheet.tsx` | Percent or amount, reason, limit, approval; comp per line; remove service charge. Packing removal not built. |
| RS17 Print queue | built | `features/print/PrintQueue.tsx` | |
| RS18 Bills and reprint | built | `features/billing/Bills.tsx` | DUPLICATE with copy count; pay an unpaid bill. |
| RS19 Credit note, re-bill | partial | `features/billing/Credit.tsx` | Credit note (lines or whole) and re-bill with GSTIN. Refund payment and credit-and-reopen not built. |
| RS20 Shift close, cash moves | built | `features/shift/ShiftClose.tsx` | Blind count by denomination. |
| RS21 Day close | partial | `features/shift/DayClose.tsx` | Blockers, carry over, force close shift, Z-report printed. Per-item Bill / Cancel buttons are the table actions; late-document revisions (`Z/.../R1`) not built. |
| RS22 KDS | built | `features/kds/Kds.tsx` | Station filter, step, bump, recall, cancel and moved banners, Already given. |
| RS23 Sync sheet | built | `features/sync/SyncSheet.tsx` | Includes the simulator switches (removed when the real runner lands). |
| RS24 Exceptions | partial | `features/owner/Owner.tsx` | Book total mismatch, wastage cancels, over-limit discounts. Online conflicts and quarantine need the real engine. |
| RS25 Owner home | built | `Owner.tsx` | |
| RS26 Reports | partial | `Owner.tsx` | Open-day report from the device; multi-day says it needs the internet. |
| RS27 Settings | partial | `features/owner/Settings.tsx` | Read only, `strong_only` rows locked with the reason. |
| RS28 Setup assistant | partial | `Settings.tsx` | Ready-to-trade check only; setup itself is online. |
| RS29 Menu quick manage | partial | `features/owner/MenuManage.tsx` | Sold out toggle. Price and new item are online. |
| RS30 Access log, My plan, menu-loading request | not built | | Shown as locked online-only rows in Settings. |
| RS31 Late tickets, bill book entry | partial | `features/blackout/Late.tsx` | Late list (print marked LATE, dismiss), book entry with the 2-day and total-mismatch rules. Activating a dormant series offline is not built. |

## Acceptance criteria exercised by tests

`src/data/trading/trading.test.ts`, `floor-ops.test.ts`, `src/trading-day.test.ts`, `src/features/flows.test.tsx`, `src/domain/domain.test.ts`.

- Order entry and modifiers: AC 2, 3, 39, 47, 50 (variants, min and max, fold, draft remove).
- Kitchen: AC 75, 76, 78, 79, 83, 85, 87, 88 (station routing, bump, recall, cancel after KOT with wastage, failed print stays queued, Given by hand),
  226, 227 (late tickets, handover never prints as an original).
- Billing: AC 12 (add in at most 2 taps), 91 (counter bill within 10 taps), 92 (keyboard only, 6 key groups), 101 to 112 (limit, approval, comp), 119
  (duplicate copy count), 124, 125 (printer failure never blocks), 133 to 137 (tenders), 138, 139 (credit note, re-bill in one op), 220, 221, 233 (Present unnumbered, number at settlement).
- Shift and day: AC 145, 146 (shift at first cash payment), 147, 148 (blind count and variance), 155, 157 (day close blockers, Z-report, next date after close).
- Security and offline: AC 169, 172 (PIN rules), 173, 174 (approval), 178 (offline sign-in), 190 (`data-testid`), 191 (KDS with no PIN), 198 to 200 (sync chip states offline, at hub, synced; nothing blocks on the network).
- Offline-first: whole trading day with no network, then reconnect: no op lost, op sequence and bill numbers gapless, delivery moves local to hub to cloud.

Not covered (stated, not skipped silently): AC 177 (Tamil and Malayalam layout: catalogues pending), AC 192 and 99 (cold start and 100 ms budgets need the reference device), AC 63 and 132 (UPI QR on the pre-bill), 142 (no-sale drawer open).
