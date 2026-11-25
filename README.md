# app-restaurant

Hostry restaurant app: POS (counter), captain (tables), KDS (kitchen) and owner modes in one SolidJS 2.0 app, offline-first. It runs in a
browser today; a native shell (ADR-0007) will host the same bundle later through `src/shell`.

Read `docs/integration-notes.md` (what is wired and what is stood in for) and `docs/screens-and-ac.md` (screens built against the design).

## Run

Needs Node 22 and pnpm 12. The app links two sibling folders, so check them out next to this repo and build them first:

```
../ui-kit        branch feat/phase2-components   (pnpm install && pnpm build)
../client-core   branch feat/phase2-integration  (pnpm install && pnpm build; domain, printing and the sync engine)
pnpm install
pnpm dev                    # http://localhost:5173  (?device=pos | waiter | kds)
pnpm lint && pnpm typecheck && pnpm test && pnpm build
```

`pnpm build` also checks the bundle against the 250 KB gzip budget (`scripts/check-bundle.mjs`).

The demo opens with seeded menu, tables, stations and a demo tax rule set (fixtures, `src/data/seed.ts`). Demo members: Asha (cashier, PIN 1111),
Ravi (waiter, 2222), Meena (manager, 3333), Anand (owner, 4444). Add `?device=waiter` for a handheld (Tables only) or `?device=kds` for a
kitchen screen (no PIN).

## Layout

```
src/domain/    pure rules: table state, discounts, PIN guard, KDS views, shift and day, counter keys, tap budgets (no UI, no I/O)
src/data/      AppData snapshot over the sync engine's rows and op log, identity stub, demo configuration (seed)
src/data/trading/   one function per user action, each records one sync intent (orders, kitchen, billing, shift, floor)
src/devices/   printing and drawer wiring (client-core PrintService, fakes)
src/shell/     the seam to the native shell
src/features/  screens by area (shell, floor, order, billing, kds, shift, owner, blackout, sync, print)
src/i18n/      English catalogue (keys only; Tamil and Malayalam pending founder confirmation)
```

## Device fakes and the browser store

There is no hardware in the browser build. Printers, the cash drawer, scanner and scale are client-core fakes behind the adapter interfaces
(`src/devices/print-hub.ts`). The store is client-core's `InMemoryStore` over IndexedDB (`IndexedDbPersistence`, one database per device kind), so a
reload keeps the day. The engine is client-core's real `SyncEngine` and `SyncRunner`; the browser build is one device with no hub or cloud
transport, so it shows Offline and works. Tests run three devices against client-core's simulated hub and cloud (`src/test/world.ts`, `Net`), and the
Sync status screen shows hub and cloud switches only when a runtime is built with those simulated links. Every control has a `data-testid`.

Tests read client-core's sources (a vitest alias and a `tsconfig` path to `../client-core/src`) because the published build leaves out its sync
simulator. On a Windows-mounted drive vitest can be very slow: copy the three repos to a Linux folder and run there.

## Browser build is a test target (ADR-0002 A3.3)

The build declares what it is (`dist/hostry-build.json`, written by `vite.config.ts`): the default is the **browser** target, which keeps rows in
unencrypted IndexedDB, claims `store: unprotected` and **refuses a live pack** (`src/shell/target.ts`, checked at boot and in `createRuntime`).
`HOSTRY_TARGET=native` is for the native shell's bundle (not built yet); `HOSTRY_RELEASE=1` marks a build meant to ship. `pnpm build` ends with
`scripts/release-lint.mjs`, which fails a browser build that lacks its refusal, any browser build marked release, and a native build that still
bundles the browser shell or the IndexedDB store. Another device's customer details are kept only when the pack says `store: protected`.

## Rules this app keeps

Writes go to the local store first and return; nothing waits on the network. Money is integer paise (`formatMoney` for display), times are UTC
stored and IST shown, ids are client-generated UUIDv7, strings are i18n keys, digits are Western. Permissions are checked on the permission,
never the role name, against the last-synced grants.
