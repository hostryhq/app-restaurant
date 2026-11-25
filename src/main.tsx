import { render } from "@solidjs/web";
import { applyDensity, applyLang, applyTheme } from "@hostry/ui-kit";
import "@hostry/ui-kit/styles.css";
import "./app.css";
import { App } from "./features/App";
import { createAppTranslator } from "./i18n";
import { InMemoryStore, IndexedDbPersistence, type LocalStore } from "@hostry/client-core";
import { packFromJson, type DevicePack, type PinProver } from "./data/auth/pack";
import { createShell } from "./shell/shell";
import { createRuntime, deviceSession } from "./runtime";

// Touch density everywhere (the Windows counter is a desktop layout with touch-size controls). The device kind comes from
// activation in the native shell; in a browser it is a query parameter so ui-tester can open each mode: ?device=pos|waiter|kds.
applyDensity("touch");
applyLang("en");

const root = document.getElementById("root");
if (!root) throw new Error("missing #root");

/**
 * Where the device's identity comes from: the offline pack stored at activation (ADR-0005), through the shell. The demo
 * outlet is a dev fixture only: it is bundled (as a lazy chunk) only when the build sets VITE_HOSTRY_DEMO=1 or runs under
 * `vite dev`, and it never syncs. A production build with no pack says so and stops: no tenant or outlet is guessed.
 */
const DEMO = import.meta.env.DEV || import.meta.env.VITE_HOSTRY_DEMO === "1";

type Boot = { pack: DevicePack; prover: PinProver; devSeed?: (s: LocalStore) => Promise<void> };

async function boot(): Promise<Boot | undefined> {
  const shell = createShell();
  const stored = shell.loadPack();
  if (stored !== undefined && shell.pinProver) return { pack: packFromJson(stored), prover: shell.pinProver };
  if (!DEMO) return undefined;
  const q = new URLSearchParams(window.location.search).get("device");
  const { demoPack } = await import("./fixtures/demo-pack");
  const { seedDemoLocal } = await import("./fixtures/demo-outlet");
  const { pack, prover } = demoPack({ deviceKind: q === "waiter" || q === "kds" ? q : "pos", ...(q === "waiter" || q === "kds" ? { billing: false, deviceCode: q === "kds" ? "K9K" : "B3K" } : {}) });
  return { pack, prover, devSeed: (s) => seedDemoLocal(s, pack.outletId) };
}

/**
 * The browser build keeps its rows in IndexedDB (client-core `IndexedDbPersistence`, one database per tenant, outlet and device), so
 * a reload keeps the day. Without IndexedDB (a locked-down browser) the app still runs, on the in-memory store: offline-first never
 * depends on it. There are no transports here: the browser build is a single device, so it shows Offline; the native shell supplies
 * the hub and cloud transports.
 */
async function openStore(pack: DevicePack): Promise<LocalStore> {
  if (typeof indexedDB === "undefined") return new InMemoryStore(pack.tenantId);
  try {
    return await InMemoryStore.open(pack.tenantId, await IndexedDbPersistence.open(`hostry-restaurant-${pack.tenantId}-${pack.outletId}-${pack.deviceId}`));
  } catch {
    return new InMemoryStore(pack.tenantId);
  }
}

void boot().then(async (b) => {
  if (!b) {
    const { t } = createAppTranslator();
    root.textContent = createShell().loadPack() === undefined ? t("activation.missing") : t("activation.needs_shell");
    return;
  }
  const { pack, prover } = b;
  applyTheme(pack.deviceKind === "kds" ? "kds" : "system");
  const store = await openStore(pack);
  // Dev seeding only into an empty database.
  const empty = (await store.list("business_day")).length === 0 && (await store.list("item")).length === 0;
  const runtime = await createRuntime({ pack, prover, store, autoSync: true, ...(b.devSeed && empty ? { devSeed: b.devSeed } : {}) });
  runtime.sync.start();
  const session = pack.deviceKind === "kds" ? deviceSession(runtime) : undefined;
  if (session) runtime.setSession(session);
  render(() => <App runtime={runtime} translator={createAppTranslator()} {...(session ? { session } : {})} />, root);
});
