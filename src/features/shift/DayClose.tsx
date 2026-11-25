import { createMemo, createSignal, For, Show } from "solid-js";
import type { JSX } from "@solidjs/web";
import { Button, ChecklistPanel, formatMoney, InlineAlert, toasts, type ChecklistItem } from "@hostry/ui-kit";
import type { Check, Shift } from "../../domain/rows";
import { carryOver, closeDay, closeShift, dayBlockersNow, openDayOf, paidOf } from "../../data/trading";
import { useApp } from "../app-state";
import { BackButton } from "../common";
import { tableOfSeating } from "../selectors";

/**
 * RS21: close the day. Blocked by an open shift (close or force close with a reason) and by checks with unbilled lines (Bill,
 * Cancel with approval, or Carry over). Unpaid numbered bills never block: they are listed on the Z-report. No reopen: a
 * correction is a credit note dated when made (ADR-0014 A1.1).
 */
export function DayClose(): JSX.Element {
  const app = useApp();
  const [carried, setCarried] = createSignal<string[]>([]);
  const [z, setZ] = createSignal<{ zNumber: string; totalPaise: number; billCount: number } | undefined>(undefined);
  const day = createMemo(() => openDayOf((e) => app.snap().list(e)));
  const blockers = createMemo(() => dayBlockersNow((e) => app.snap().list(e), carried()));
  const label = (checkId: string) => {
    const c = app.snap().get<Check>("check", checkId);
    return tableOfSeating(app, c?.seating_id)?.name ?? app.t("counter.token", { n: c?.token_no ?? 0 });
  };
  const items = createMemo<ChecklistItem[]>(() =>
    blockers().map((b) =>
      b.kind === "open_shift"
        ? { id: `shift-${b.shiftId}`, label: app.t("dayclose.openshift"), status: "blocking" as const, fixLabel: app.t("dayclose.closeshift"), onFix: () => app.go({ id: "shiftclose" }) }
        : { id: `check-${b.checkId}`, label: app.t(b.kind === "presented_unbilled" ? "dayclose.presented" : "dayclose.unresolved", { table: label(b.checkId) }), status: "blocking" as const, fixLabel: app.t("dayclose.carry"), onFix: () => void app.run(() => carryOver(app.rt.ctx, b.checkId), () => setCarried([...carried(), b.checkId])) },
    ),
  );
  const unpaid = createMemo(() => app.snap().list<{ id: string; total_paise: number }>("bill").filter((b) => b.total_paise > paidOf((e) => app.snap().list(e), b.id)).length);

  const close = () => void app.run(() => closeDay(app.rt.ctx), (r) => (setZ(r), toasts.show(app.t("dayclose.done", { z: r.zNumber }))));
  const forceClose = (s: Shift) => void app.run(() => closeShift(app.rt.ctx, s.id, 0, { force: true }));

  return (
    <section data-testid="dayclose-screen">
      <BackButton />
      <h1>{app.t("dayclose.title")}</h1>
      <Show when={day()} fallback={<p data-testid="dayclose-none">{app.t("dayclose.none")}</p>}>
        <p data-testid="dayclose-date">{day()?.business_date}</p>
        <ChecklistPanel label={app.t("dayclose.checks")} items={items().length ? items() : [{ id: "clear", label: app.t("dayclose.clear"), status: "done" }]} />
        <Show when={app.can("shift.close.any")}>
          <For each={app.snap().list<Shift>("shift").filter((s) => s.status === "open")}>
            {(s) => (
              <Button variant="danger" data-testid={`force-close-${s.id}`} onClick={() => forceClose(s)}>
                {app.t("dayclose.force")}
              </Button>
            )}
          </For>
        </Show>
        <Show when={unpaid() > 0}>
          <InlineAlert kind="info" data-testid="dayclose-unpaid">
            {app.t("dayclose.unpaid")}
          </InlineAlert>
        </Show>
        <Button data-testid="dayclose-submit" disabled={blockers().length > 0} onClick={close}>
          {app.t("dayclose.submit")}
        </Button>
      </Show>
      <Show when={z()}>
        <p data-testid="dayclose-z">
          {z()?.zNumber} - {z()?.billCount} - {formatMoney(z()?.totalPaise ?? 0)}
        </p>
      </Show>
    </section>
  );
}
