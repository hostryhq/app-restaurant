import { For, Show } from "solid-js";
import type { JSX } from "@solidjs/web";
import { PrintJobRow } from "@hostry/ui-kit";
import { useApp } from "../app-state";
import { BackButton, Empty } from "../common";

/** RS17: every job still waiting for paper, with its state and a one-tap retry. A failed print is never invisible (AC 124, 125). */
export function PrintQueue(): JSX.Element {
  const app = useApp();
  const retry = (printerId: string, id: string) => {
    app.rt.fakes.hub.retry(printerId, id);
    void app.rt.fakes.hub.flush();
  };
  return (
    <section data-testid="print-screen">
      <BackButton />
      <h1>{app.t("print.title")}</h1>
      <Show when={app.jobs().length > 0} fallback={<Empty text={app.t("print.empty")} testid="print-empty" />}>
        <ul class="app-list">
          <For each={app.jobs()}>
            {(j) => (
              <PrintJobRow
                title={`${app.t(`print.kind.${j.kind}`)} ${j.id.slice(-6)}`}
                status={j.status === "failed" ? "failed" : j.lastError ? "failed" : "queued"}
                onRetry={() => retry(j.printerId, j.id)}
                data-testid={`print-job-${j.id}`}
              />
            )}
          </For>
        </ul>
      </Show>
    </section>
  );
}
