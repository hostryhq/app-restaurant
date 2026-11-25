# Integration notes (Phase 2 app build)

What this app is wired to, what is stood in for, and what each client-core work stream must still provide. The app codes to interfaces
(`src/data/ports.ts`, `src/devices/print-hub.ts`, `src/shell/shell.ts`) so the three client-core lines compose without a screen changing.

## Dependency lines and how they compose

| Piece | Where it lives | Used here |
|---|---|---|
| Tax engine, catalog (`Menu`, KOT routing), documents (finalize, pre-bill, credit note, re-bill, manual book, business day, print mapping), printing (`PrintService`, ESC/POS, queue, fakes), in-memory store, device fakes | client-core `feat/phase2-domain` (includes `feat/phase2-printing`) | Imported as `@hostry/client-core` (`link:../client-core`) |
| Sync engine (`SyncEngine.record`, `SyncRunner`, hub transport, series allocator, test kit) | client-core `feat/phase1-sync` (a separate line from the scaffold; no common tip with the domain line) | **Not imported.** Coded to through `OpWriter`, `SyncPort`; stood in for by `LocalOpWriter` and `SyncSim` |
| POS, KDS, shift components | ui-kit `feat/phase2-components` | Imported as `@hostry/ui-kit` (`link:../ui-kit`) |

**Multi-branch dependency problem.** `link:` dependencies resolve to a sibling folder, so one checkout of client-core can hold only one
branch, and the domain line and the sync line cannot both be in it. CI works around it for what this app imports (`ci.yml` pins
`ui-kit@feat/phase2-components` and `client-core@feat/phase2-domain`; the shared `ts-ci.yml` supports `name@ref`). It cannot solve the sync
line. Needed from the client-core owner: an integration branch (for example `feat/phase2-integration`) that merges
phase1-sync + phase2-domain, then change `ci.yml` to pin it and replace `LocalOpWriter`/`SyncSim` with the real engine and runner.

## What stands in for the sync engine

`LocalOpWriter` (`src/data/local-writer.ts`) has the engine's `record({ intent, build })` contract: one local transaction allocates the legal
number, applies the mutations, appends the op. `SyncSim` (`src/data/sync-sim.ts`) has the `SyncClient` surface plus the fields
the screens need (`atHubOps`, `upstream`, `state`, `clockWrong`). Replacement is: pass a `SyncEngine` as `OpWriter` and a `SyncRunner`
adapter as `SyncPort` in `src/runtime.ts`. Known differences the engine owner must resolve (TODO items; the first two need a ruling):

1. **Several legal numbers in one op.** `bill.rebill` allocates a credit note number and one or more bill numbers in one op (api-specs
   `sync/intents/billing.yaml`). `SyncEngine.record` throws on a second `number()` call ("an op allocates at most one legal number") and
   an op envelope has one `doc`. `LocalOpWriter` allows several and records the first in `doc`. ADR-0002 item: `ADR needed: op envelope with
   several document numbers (re-bill)`.
2. **Mixed-policy entities.** `check` and `order_line` mix last-writer-wins fields (discount, note) and forward-only fields (`status`, `state`);
   the engine's schema has one policy per entity (`rank` entities ignore `set` of non-rank fields). `LocalOpWriter` applies per-field
   ranks (`RANKS` in `local-writer.ts`). The engine needs per-field policy or the entities need splitting. `DEMO_SCHEMAS` also lacks every restaurant
   entity; the schemas must be generated from `api-specs/entities/restaurant`.
3. Delivery of an op (`local`, `at_hub`, `in_cloud`) comes from `SyncEngine.delivery(seq)`; the sim stores it on the op row.
4. `ids`: `monotonicIds` (`src/data/ids.ts`) is a UUIDv7 with a counter in `rand_a`, so rows created in one millisecond sort in creation order.
   client-core `uuidv7` is not monotonic; the app sorts lines, moves and tickets by id. Suggest adopting it in client-core.

## Identity and approvals (stub)

`StubIdentity` implements `IdentityPort`: tap-your-name PIN sign-in from an offline pack, 5-wrong delay and 10-wrong lock (`src/domain/pin-guard.ts`),
own-PIN action proof, manager approval on the same device with an approval id (valid two minutes, approver differs from requester).
Role to permission templates in `identity-stub.ts` are assumptions to be confirmed by ADR-0005 role templates and the security review. Real
`PinLogin`, the offline pack and the proof stamped on ops arrive with client-core auth. Demo PINs are fixtures (1111, 2222, 3333, 4444), not secrets.

- **ui-kit gap.** `PinPad` is fixed length (default 4) and submits at that length; the design says "at least 4 digits, 6 for managers". The
  demo uses 4 digits for everyone. Needs a variable-length mode (Enter to submit).
- **ui-kit gap.** The toast dismiss button has no `data-testid` (the testid test allow-lists it).

## Printing

`PrintHub` wraps client-core `PrintService`: per-printer queue with backoff, once-only job ids, and the A1.6 late-ticket rule (a KOT that is
handed over or older than 15 minutes when it arrives is held for a person, never auto-printed). Printers and the drawer are the client-core
fakes (`FakeReceiptPrinter`, `FakeKitchenPrinter`, `FakeCashDrawer`) behind `createFakePrintHub`; the native shell supplies real transports
(ESC/POS over USB, LAN, Bluetooth) per `devices-and-printing`. No rasterizer is wired (no canvas in a browser test): Tamil and Malayalam
station lines print the English kitchen name until the shell provides one.

## Shell seam (ADR-0007)

`src/shell/shell.ts` is the only place the app asks the host for anything (storage, network hint, chime, keep-awake). Tauri will implement it
and also replace the store, printers, drawer and sync port in `src/runtime.ts`. There is no Rust or Tauri code here. `?device=pos|waiter|kds`
selects the device kind in a browser (the shell reads it from activation later).

## Contract mapping

Every UI action records one intent from `api-specs sync/intents` through `data.write` (`src/data/trading/*`). Used: `seating.open`, `check.create`,
`order.create`, `order.line.add`, `order.line.edit`, `order.line.void`, `order.line.cancel`, `order.items.move`, `order.table.move`, `order.table.merge`,
`bill.new`, `bill.split`, `bill.merge`, `bill.cancel`, `bill.request`, `bill.present`, `bill.discount.apply`, `bill.discount.over_limit`, `bill.line.comp`,
`bill.service_charge.remove`, `bill.customer_details.edit`, `kot.send`, `kds.status`, `kds.recall`, `kot.handover`, `kot.reprint`, `kot.print.ack`, `seating.close`,
`bill.finalize`, `bill.manual_entry`, `payment.record`, `creditnote.issue`, `bill.rebill`, `drawer.cash_move`, `shift.open`, `shift.close`, `shift.close.any`,
`day.open`, `day.close`, `menu.availability.set`.
Not built: `bill.present.change` (reason chip after a Present), `payment.refund`, `drawer.open_no_sale`, `check.close_internal`, `menu.open_item`,
`order.line.cancel.grace`, `bill.line.comp.allowance`, `series.activate`, `device.clock.confirm`, and every online-only action.

- **Bill reprint has no intent or permission in the registry.** The app checks `bill.reprint` (assumed) and counts copies in a device-local row.
  `ADR needed: audit of bill reprint (intent and permission)`; AC 119 wants "DUPLICATE, Copy n".
- Regime (`regular`, `composition`, `unregistered`), `specified_premises` and the bill-book series codes are read from `outlet_tax_profile` and
  `billing_settings.manual_book_codes` until tenancy registrations sync; the entity files do not carry them on those rows.
- The demo rule set (`src/data/seed.ts`) is a fixture, not tax advice; rates in production come only from the published rule set.

## Performance and bundle

Initial JS 83.6 KB gzip (CSS 5.7 KB) against the 250 KB budget (`pnpm build` runs `scripts/check-bundle.mjs`). Cold start to billing screen and the
100 ms interaction budget are not measured here (needs the reference low-end Android device, ADR-0007); the data path is in-memory and every
write is local.
