import { render } from "@solidjs/web";
import { applyDensity, applyLang, applyTheme } from "@hostry/ui-kit";
import "@hostry/ui-kit/styles.css";
import "./app.css";
import { App } from "./features/App";
import { createAppTranslator } from "./i18n";
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

void createRuntime({ deviceKind }).then((runtime) => {
  const session = deviceKind === "kds" ? deviceSession(runtime) : undefined;
  if (session) runtime.setSession(session);
  render(() => <App runtime={runtime} translator={createAppTranslator()} {...(session ? { session } : {})} />, root);
});
