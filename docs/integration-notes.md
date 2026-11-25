# Integration notes (Phase 2 app build)

What this app is wired to, what is still stood in for, and what client-core and ui-kit still owe it.

## What is wired

| Piece | Where it lives | Used here |
|---|---|---|
| Sync engine (`SyncEngine`, `SyncRunner`, series allocator), `EngineOpWriter`, `createSyncPort`, intent registry, restaurant entity schemas | client-core `feat/phase2-integration` (client-core PR 5) | `src/runtime.ts` builds `new EngineOpWriter(engine, { streams })`, `createSyncPort(runner, engine)`, sets `engine.session` on every sign-in and sign-out |
| Tax engine, catalog, documents, printing, in-memory store, device fakes | same branch | imported as `@hostry/client-core` (`link:../client-core`) |
| POS, KDS, shift components | ui-kit `feat/phase2-components` | imported as `@hostry/ui-kit` (`link:../ui-kit`) |
| Sync simulator (`FakeNode` hub and cloud) | client-core `@hostry/client-core/testing` | tests only |

CI pins `ui-kit@feat/phase2-components` and `client-core@feat/phase2-integration`. The stand-ins `LocalOpWriter` and `SyncSim` are gone.

How the app sits on the engine:

- **Rows.** `AppData` reads `engine.rows(entity)` (visible rows, candidates stripped). `_local` is a device-only table in the same store (KDS acknowledgements, day carry-over marks).
- **Op log.** `src/data/op-log.ts` exposes every op the device holds as `_op` rows (intent, actor, time, muts, first legal number, own or pulled, delivery of own ops from `engine.delivery`). It uses only `engine.vector` and `engine.opAt`.
- **Provenance.** The entity files carry no `waiter_id`, `opened_by`, `opened_at`, `created_at`, `requested_at` or `presented_at`. The snapshot adds them from the op that inserted the row (`PROVENANCE` in `runtime.ts`), the same on every device. Builders no longer write them.
- **Numbers.** `seriesFor(deviceCode)` is the offline pack's grants (sale series on the device code, a credit-note series `C..`). A device that never bills (handheld, KDS) has none.
- **Demo configuration.** `seedDemo` records the menu, floor, settings and rule set as one op (`seed.demo`, not in the intent registry) instead of writing rows into the store, so the engine owns every row it merges and other devices get the configuration by sync. In tests only the first device seeds.
- **Sync.** `runner.syncNow()` runs on demand and, with `autoSync`, after a write while an upstream answered. `sync.start()` runs the background timer. The browser build has no transports, so it is one device showing Offline.
- **Storage.** The browser build opens `InMemoryStore.open(tenant, IndexedDbPersistence)` (one database per device kind) and seeds an empty one. The signer is regenerated on load (`SoftwareSigner`), which is fine with no upstream; a durable device key needs the shell's keystore (ADR-0005 A1, not built).
- **Contract check.** Every op is checked against its intent before it is recorded. This caught builders that wrote fields outside the entity files and entities outside an intent; they were fixed rather than the check relaxed.

## Defects found in client-core (fixed in `feat/phase2-integration`)

1. **`rank` mutations** on `seating`, `shift`, `business_day`, `kot_line` are now applied (forward only). The `rankAsSet` workaround is removed.
2. **Rows put straight into the store** now survive their first `set` or `del` (adopted with the lowest stamp). The app still seeds the demo configuration as one op (`seed.demo`), because a direct `put` is local only and other devices would not get it.
3. **Sync simulator** is exported as `@hostry/client-core/testing`; the vitest alias and tsconfig path are gone.
4. **`ids`:** `monotonicIds` (`src/data/ids.ts`) is the app's UUIDv7 with a counter in `rand_a`, passed to the engine as `newId`, so rows created in one millisecond sort in creation order. client-core `uuidv7` is not monotonic and the screens sort by id. Suggest adopting it (still open).

ADR items still open from client-core's notes: op envelope with several document numbers (`docs`; svc-sync reads only `doc`); shape of the op's `pii` object (the builders still write customer name and phone into the op body); `op_too_large` is not enforced before recording; `session.open` is not recorded, so `sid` is the PIN session id, not a `session.open` op id (ADR-0005).

## Where the app had to follow the contract

- **Tickets without lines.** `order.items.move`, `order.line.cancel` and `kds.recall` write the `kot` row only. The MOVED and CANCEL paper tickets are built from the lines in hand at that moment (`kotDocFor(..., linesOf)`); the KDS shows a cancel ticket's items from the cancels that name it, a recall ticket shows the recalled ticket's items, and bumping a recall, cancel or moved ticket is a local acknowledgement. A MOVED ticket on the KDS shows its banner and table, no items.
- **Availability** uses `availabilitySpec` (deterministic row id), so two devices meet on one `item_outlet` row.
- **Reprint** records `bill.reprint` (`bill_reprint`: copy 1 is the first reprint, printed as Copy 2). The "ADR needed: audit of bill reprint" item is closed by the contract.
- **Discount approval check** reads the snapshot before the write (inside the engine's transaction the op log is not a table).
- `billing_settings.manual_book_codes` is still not an entity field; the seed carries it so book entry works. Tenancy registrations will carry it.

## Identity and approvals (stub)

`StubIdentity` implements `IdentityPort`: tap-your-name PIN sign-in from an offline pack, 5-wrong delay and 10-wrong lock (`src/domain/pin-guard.ts`), own-PIN action proof, manager approval on the same device with an approval id (valid two minutes, approver differs from requester). `IdentityPort` extends client-core's `PinLogin` (`members`, `signOut`; `Member` extends `MemberSummary`) and `asPinLogin()` gives the throwing `signIn` that interface has; `Runtime.sessions` is a client-core `SessionStore`. Role to permission templates in `identity-stub.ts` are assumptions for ADR-0005 role templates and the security review. Demo PINs are fixtures (1111, 2222, 3333, 4444), not secrets. The action `proof` is not stamped on ops yet.

## ui-kit

`PinPad` takes `length` 4 to 6 and submits early on Enter or OK (at least 4 digits). The demo still uses 4 digits for everyone; managers can move to 6 when ADR-0005 role templates say so. The toast dismiss button has `data-testid="toast-dismiss"` and the testid test no longer allow-lists it.

## Printing

`PrintHub` wraps client-core `PrintService`: per-printer queue with backoff, once-only job ids, and the A1.6 late-ticket rule (a KOT that is handed over or older than 15 minutes when it arrives is held for a person, never auto-printed). Printers and the drawer are client-core fakes; the native shell supplies real transports. No rasterizer is wired: Tamil and Malayalam station lines print the English kitchen name until the shell provides one. The device that prints KOTs calls `ingestArrivedKot` for a ticket it did not create (the scripted trading day does this for the KDS station after a blackout); nothing calls it automatically from a sync round yet.

## Shell seam (ADR-0007)

`src/shell/shell.ts` is the only place the app asks the host for anything (storage, network hint, chime, keep-awake). Tauri will implement it and also replace the store, printers, drawer, signer and the hub and cloud transports in `src/runtime.ts` (`RuntimeOptions.store`, `signer`, `upstream`). `?device=pos|waiter|kds` selects the device kind in a browser.

## Contract mapping

Every UI action records one intent from `api-specs sync/intents` through `data.write` (`src/data/trading/*`). Used: `seating.open`, `check.create`, `order.create`, `order.line.add`, `order.line.edit`, `order.line.void`, `order.line.cancel`, `order.items.move`, `order.table.move`, `order.table.merge`, `bill.new`, `bill.split`, `bill.merge`, `bill.cancel`, `bill.request`, `bill.present`, `bill.discount.apply`, `bill.discount.over_limit`, `bill.line.comp`, `bill.service_charge.remove`, `bill.customer_details.edit`, `kot.send`, `kds.status`, `kds.recall`, `kot.handover`, `kot.reprint`, `kot.print.ack`, `seating.close`, `bill.finalize`, `bill.manual_entry`, `bill.reprint`, `payment.record`, `payment.refund`, `creditnote.issue`, `bill.rebill`, `drawer.cash_move`, `shift.open`, `shift.close`, `shift.close.any`, `day.open`, `day.close`, `menu.availability.set`. Read, not written: `business_day_revision` (cloud intent `day.revision.record`).
Not built: `bill.present.change` (reason chip after a Present), `drawer.open_no_sale`, `check.close_internal`, `menu.open_item`, `order.line.cancel.grace`, `bill.line.comp.allowance`, `series.activate`, `device.clock.confirm`, `session.open`, `approval.grant`, and every online-only action.

The demo rule set (`src/data/seed.ts`) is a fixture, not tax advice; rates in production come only from the published rule set.
