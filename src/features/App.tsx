import { Match, Show, Switch } from "solid-js";
import type { JSX } from "@solidjs/web";
import { I18nProvider, type Translator } from "@hostry/ui-kit";
import type { Session } from "@hostry/client-core";
import type { Runtime } from "../runtime";
import { AppProvider, createApp, useApp } from "./app-state";
import { Late } from "./blackout/Late";
import { Bills } from "./billing/Bills";
import { Credit } from "./billing/Credit";
import { Held } from "./billing/Held";
import { Review } from "./billing/Review";
import { Tender } from "./billing/Tender";
import { Floor } from "./floor/Floor";
import { Kds } from "./kds/Kds";
import { Order } from "./order/Order";
import { Exceptions, OwnerHome, Reports } from "./owner/Owner";
import { MenuManage } from "./owner/MenuManage";
import { Settings, Setup } from "./owner/Settings";
import { PrintQueue } from "./print/PrintQueue";
import { DayClose } from "./shift/DayClose";
import { ShiftClose } from "./shift/ShiftClose";
import { Lock } from "./shell/Lock";
import { Shell } from "./shell/Shell";
import { SyncSheet } from "./sync/SyncSheet";

/** The screen for the current view. Screens are added by id from docs/design/restaurant-app-flows.md. */
function Screen(): JSX.Element {
  const app = useApp();
  const v = () => app.view();
  const orderView = () => {
    const x = v();
    return x.id === "order" ? x : undefined;
  };
  return (
    <Switch>
      <Match when={v().id === "floor"}>
        <Floor />
      </Match>
      <Match when={v().id === "order"}>
        <Show when={orderView()} keyed>
          {(ov) => <Order tableId={ov.tableId} checkId={ov.checkId} />}
        </Show>
      </Match>
      <Match when={v().id === "review"}>
        <Review checkId={(v() as { checkId: string }).checkId} />
      </Match>
      <Match when={v().id === "tender"}>
        <Tender checkId={(v() as { checkId: string }).checkId} exact={(v() as { exact?: boolean }).exact === true} />
      </Match>
      <Match when={v().id === "held"}>
        <Held />
      </Match>
      <Match when={v().id === "bills"}>
        <Bills />
      </Match>
      <Match when={v().id === "credit"}>
        <Credit billId={(v() as { billId: string }).billId} />
      </Match>
      <Match when={v().id === "print"}>
        <PrintQueue />
      </Match>
      <Match when={v().id === "shiftclose"}>
        <ShiftClose />
      </Match>
      <Match when={v().id === "dayclose"}>
        <DayClose />
      </Match>
      <Match when={v().id === "sync"}>
        <SyncSheet />
      </Match>
      <Match when={v().id === "exceptions"}>
        <Exceptions />
      </Match>
      <Match when={v().id === "late"}>
        <Late />
      </Match>
      <Match when={v().id === "kds"}>
        <Kds />
      </Match>
      <Match when={v().id === "owner"}>
        <OwnerHome />
      </Match>
      <Match when={v().id === "reports"}>
        <Reports />
      </Match>
      <Match when={v().id === "settings"}>
        <Settings />
      </Match>
      <Match when={v().id === "menu"}>
        <MenuManage />
      </Match>
      <Match when={v().id === "setup"}>
        <Setup />
      </Match>
    </Switch>
  );
}

/**
 * Providers, then the lock screen or the shell with the current screen. Everything is injected (runtime, translator) so tests
 * and the native shell drive the same tree. A KDS device has a device session and never sees the lock screen (AC 191).
 */
export function App(props: { runtime: Runtime; translator: Translator; session?: Session }): JSX.Element {
  const app = createApp(props.runtime, props.translator.t, props.session ? { session: props.session } : {});
  return (
    <I18nProvider value={props.translator}>
      <AppProvider value={app}>
        <div onPointerDown={() => app.touch()} onKeyDown={() => app.touch()} style={{ display: "contents" }}>
          <Show when={app.session()} fallback={<Lock />}>
            <Shell>
              <Screen />
            </Shell>
          </Show>
        </div>
      </AppProvider>
    </I18nProvider>
  );
}
