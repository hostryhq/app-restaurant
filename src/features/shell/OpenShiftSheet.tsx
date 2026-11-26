import { createSignal } from "solid-js";
import type { JSX } from "@solidjs/web";
import { AmountField, Button, Dialog } from "@hostry/ui-kit";
import { lastClosingFloat, startShift } from "../../data/trading";
import { useApp } from "../app-state";

/**
 * RS02: open the shift at the first cash payment, with the float prefilled from the last close: one tap when it is right.
 * It interrupts nothing already typed; the tender screen stays behind it and resumes (AC 145).
 */
export function OpenShiftSheet(props: { open: boolean; onOpened: () => void; onClose: () => void }): JSX.Element {
  const app = useApp();
  const last = () => lastClosingFloat((e) => app.snap().list(e));
  const [float, setFloat] = createSignal<number | undefined>(undefined);
  const value = () => float() ?? last();
  return (
    <Dialog open={props.open} title={app.t("shift.open.title")} onClose={props.onClose} data-testid="open-shift-sheet">
      <AmountField label={app.t("shift.open.float")} valuePaise={value()} onChange={setFloat} data-testid="shift-float" />
      <p data-testid="shift-float-last">{app.t("shift.open.float.last")}</p>
      <Button
        data-testid="shift-open-submit"
        onClick={() =>
          void app.run(
            () => startShift(app.rt.ctx, value()),
            () => props.onOpened(),
          )
        }
      >
        {app.t("shift.open.submit")}
      </Button>
    </Dialog>
  );
}
