import { createSignal, Show } from "solid-js";
import type { JSX } from "@solidjs/web";
import { AmountField, BlindCountForm, Button, formatMoney, SegmentedControl, toasts } from "@hostry/ui-kit";
import { countedTotal, INR_DENOMINATIONS } from "../../domain/shift-day";
import { cashMove, closeShift, openShift } from "../../data/trading";
import { useApp } from "../app-state";
import { BackButton, Empty } from "../common";

/**
 * RS20: close the shift with a blind count. The expected cash is never shown before the count is submitted (AC 147); the
 * variance is recorded, and only members who may close any shift (managers) see it afterwards (AC 148). Cash movements with a note.
 */
export function ShiftClose(): JSX.Element {
  const app = useApp();
  const [counts, setCounts] = createSignal<Record<string, number>>({});
  const [result, setResult] = createSignal<number | undefined>(undefined);
  const [moveKind, setMoveKind] = createSignal<"cash_in" | "cash_out" | "owner_cash_drop">("cash_in");
  const [moveAmount, setMoveAmount] = createSignal(0);
  const shift = () => openShift((e) => app.snap().list(e));

  const submit = () => {
    const s = shift();
    if (!s) return;
    void app.run(
      () => closeShift(app.rt.ctx, s.id, countedTotal(counts())),
      (r) => {
        setResult(r.variancePaise);
        toasts.show(app.t("shiftclose.done"));
      },
    );
  };

  return (
    <section data-testid="shiftclose-screen">
      <BackButton />
      <h1>{app.t("shiftclose.title")}</h1>
      <Show when={shift()} fallback={<Empty text={result() === undefined ? app.t("shiftclose.none") : app.t("shiftclose.done")} testid="shiftclose-none" />}>
        <p data-testid="shiftclose-counted">{app.t("shiftclose.counted", { amount: formatMoney(countedTotal(counts())) })}</p>
        <BlindCountForm denominations={INR_DENOMINATIONS} counts={counts()} onChange={setCounts} onSubmit={submit} />
        <h2>{app.t("shiftclose.moves")}</h2>
        <SegmentedControl
          label={app.t("shiftclose.moves")}
          options={(["cash_in", "cash_out", "owner_cash_drop"] as const).map((k) => ({ id: k, label: app.t(`shiftclose.${k}`), "data-testid": `move-${k}` }))}
          selected={moveKind()}
          onSelect={(k) => setMoveKind(k as "cash_in" | "cash_out" | "owner_cash_drop")}
        />
        <AmountField label={app.t("tender.amount")} valuePaise={moveAmount()} onChange={setMoveAmount} data-testid="move-amount" />
        <Button variant="secondary" data-testid="move-submit" disabled={moveAmount() <= 0} onClick={() => void app.run(() => cashMove(app.rt.ctx, moveKind(), moveAmount(), ""), () => setMoveAmount(0))}>
          {app.t("shiftclose.move")}
        </Button>
      </Show>
      <Show when={result() !== undefined && app.can("shift.close.any")}>
        <p data-testid="shiftclose-variance">{app.t("shiftclose.variance", { amount: formatMoney(result() ?? 0) })}</p>
      </Show>
    </section>
  );
}
