import { createMemo, createSignal, For, Show } from "solid-js";
import type { JSX } from "@solidjs/web";
import { Button, KdsBoard, KdsItemRow, KdsTicket, StationSelect } from "@hostry/ui-kit";
import { kdsTickets, type KdsTicketView } from "../../domain/kds";
import type { Kot, KotHandover, KotLine, OrderLine, OrderLineCancel, Station } from "../../domain/rows";
import { acknowledge, bump, recall, stepItem } from "../../data/trading";
import { useApp } from "../app-state";
import { Empty } from "../common";

const STATION_KEY = "kds.station";

/**
 * RS22: kitchen display. Tickets of the chosen station, oldest first, read from the local store (no server query), large type,
 * one tap bumps a ticket. Cancelled and moved tickets keep a red banner until acknowledged; a ticket given by hand shows
 * "Already given" (ADR-0014 A1.6). Works with no network: the tickets on screen stay.
 */
export function Kds(): JSX.Element {
  const app = useApp();
  const stations = createMemo(() => app.snap().list<Station>("station").filter((s) => s.output !== "printer"));
  const [station, setStation] = createSignal<string | undefined>(app.rt.shell.storage.getItem(STATION_KEY) ?? undefined);
  const view = createMemo(() => {
    const snap = app.snap();
    const acked = new Set(snap.list<{ kind?: string; kot_id?: string }>("_local").filter((r) => r.kind === "kds_ack").map((r) => r.kot_id as string));
    const codes = station() ? [station() as string] : [];
    return kdsTickets({ kots: snap.list<Kot>("kot"), lines: snap.list<KotLine>("kot_line"), cancels: snap.list<OrderLineCancel>("order_line_cancel"), orderLines: snap.list<OrderLine>("order_line"), handovers: snap.list<KotHandover>("kot_handover"), acked, stationCodes: codes, nowMs: app.nowMs() });
  });
  const pick = (id: string) => {
    const code = id || undefined;
    setStation(code);
    if (code) app.rt.shell.storage.setItem(STATION_KEY, code);
    else app.rt.shell.storage.removeItem(STATION_KEY);
  };
  const title = (v: KdsTicketView) => `${v.kot.table_name ?? ""} - ${v.kot.kot_no}`;

  const ticket = (v: KdsTicketView): JSX.Element => (
    <KdsTicket id={v.kot.id} title={title(v)} minutes={v.minutes} bumpLabel={app.t("kds.bump")} onBump={() => void app.run(() => bump(app.rt.ctx, v.kot.id))}>
      <Show when={v.alert}>
        <div role="alert" class="app-kds-alert" data-testid={`kds-alert-${v.kot.id}`}>
          {app.t(v.alert === "cancelled" ? "kds.cancelled" : "kds.moved")}
          <Button variant="secondary" data-testid={`kds-ack-${v.kot.id}`} onClick={() => void app.run(() => acknowledge(app.rt.ctx, v.kot.id))}>
            {app.t("kds.ack")}
          </Button>
        </div>
      </Show>
      <Show when={v.recall}>
        <p data-testid={`kds-recall-${v.kot.id}`}>{app.t("kds.recall.mark")}</p>
      </Show>
      <Show when={v.alreadyGiven}>
        <p data-testid={`kds-given-${v.kot.id}`}>{app.t("kds.given")}</p>
      </Show>
      <For each={v.lines}>
        {(l) => <KdsItemRow id={l.id} qty={l.qty_milli / 1000} name={l.name} {...(l.note ? { note: l.note } : {})} done={l.status === "ready" || l.status === "served"} onToggleDone={() => void app.run(() => stepItem(app.rt.ctx, l.id))} />}
      </For>
    </KdsTicket>
  );

  return (
    <section class="app-kds" data-testid="kds-screen">
      <header class="app-kds__head">
        <StationSelect label={app.t("kds.station")} stations={[{ id: "", label: app.t("kds.all") }, ...stations().map((s) => ({ id: s.code, label: s.name }))]} selected={station() ?? ""} onSelect={pick} />
        <Show when={app.sync().upstream === "none"}>
          <span data-testid="kds-offline">{app.t("kds.offline")}</span>
        </Show>
      </header>
      <KdsBoard label={app.t("kds.board")} count={view().active.length} empty={<Empty text={app.t("kds.empty")} testid="kds-empty" />}>
        <For each={view().active}>{(v) => ticket(v)}</For>
      </KdsBoard>
      <h2>{app.t("kds.done")}</h2>
      <ul class="app-list" data-testid="kds-done">
        <For each={view().done.slice(0, 8)}>
          {(v) => (
            <li>
              {title(v)}
              <Button variant="secondary" data-testid={`kds-recall-${v.kot.id}-btn`} onClick={() => void app.run(() => recall(app.rt.ctx, v.kot.id))}>
                {app.t("kds.recall")}
              </Button>
            </li>
          )}
        </For>
      </ul>
    </section>
  );
}
