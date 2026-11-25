import { render } from "@solidjs/web";
import { applyDensity, applyLang, applyTheme } from "@hostry/ui-kit";
import "@hostry/ui-kit/styles.css";
import "./app.css";
import { App } from "./features/App";
import { createAppTranslator } from "./i18n";
import { InMemoryStore, IndexedDbPersistence } from "@hostry/client-core";
import { TENANT_ID } from "./data/seed";
import { createRuntime, deviceSession } from "./runtime";

// Touch density everywhere (the Windows counter is a desktop layout with touch-size controls). The device kind comes from
// activation in the native shell; in a browser it is a query parameter so ui-tester can open each mode: ?device=pos|waiter|kds.
applyDensity("touch");
applyLang("en");

const root = document.getElementById("root");
if (!root) throw new Error("missing #root");

const kind = new URLSearchParams(window.location.search).get("device");
const deviceKind = kind === "waiter" || kind === "kds" ? kind : "pos";
applyTheme(deviceKind === "kds" ? "kds" : "system");

/**
 * The browser build keeps its rows in IndexedDB (client-core `IndexedDbPersistence`, one database per device kind), so a reload
 * keeps the day. The demo configuration is recorded only into an empty database. Without IndexedDB (a locked-down browser) the
 * app still runs, on the in-memory store, and says nothing: offline-first never depends on it. There are no transports here:
 * the browser build is a single device, so it shows Offline; the native shell supplies the hub and cloud transports.
 */
async function openStore(kind: string): Promise<InMemoryStore> {
  if (typeof indexedDB === "undefined") return new InMemoryStore(TENANT_ID);
  try {
    return await InMemoryStore.open(TENANT_ID, await IndexedDbPersistence.open(`hostry-restaurant-${kind}`));
  } catch {
    return new InMemoryStore(TENANT_ID);
  }
}

void openStore(deviceKind)
  .then(async (store) => createRuntime({ deviceKind, store, seed: (await store.list("business_day")).length === 0 && (await store.list("item")).length === 0, autoSync: true }))
  .then((runtime) => {
    runtime.sync.start();
    const session = deviceKind === "kds" ? deviceSession(runtime) : undefined;
    if (session) runtime.setSession(session);
    render(() => <App runtime={runtime} translator={createAppTranslator()} {...(session ? { session } : {})} />, root);
  });
