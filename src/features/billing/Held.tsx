import { For, Show } from "solid-js";
import type { JSX } from "@solidjs/web";
import { Button, formatMoney } from "@hostry/ui-kit";
import { useApp } from "../app-state";
import { BackButton, Empty } from "../common";
import { linesOf, minutesAgo, openCounterChecks, totals } from "../selectors";

/** RS14: held counter orders and takeaways waiting for pickup (AC 94, 95). Tap one to carry on. */
export function Held(): JSX.Element {
  const app = useApp();
  const checks = () => openCounterChecks(app).filter((c) => linesOf(app, c.id).length > 0);
  return (
    <section data-testid="held-screen">
      <BackButton />
      <h1>{app.t("held.title")}</h1>
      <Show when={checks().length > 0} fallback={<Empty text={app.t("held.empty")} testid="held-empty" />}>
        <ul class="app-list">
          <For each={checks()}>
            {(c) => (
              <li>
                <Button variant="secondary" data-testid={`held-${c.token_no}`} onClick={() => app.go({ id: "order", checkId: c.id })}>
                  {app.t(c.order_type === "takeaway" ? "held.pickup" : "held.token", { n: c.token_no ?? 0 })} - {formatMoney(totals(app, c.id)?.total ?? 0)} - {app.t("floor.min", { n: minutesAgo(app, undefined) })}
                </Button>
              </li>
            )}
          </For>
        </ul>
      </Show>
    </section>
  );
}
