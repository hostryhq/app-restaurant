import { createEffect, createMemo, createSignal } from "solid-js";
import type { JSX } from "@solidjs/web";
import { Button, Dialog, ReasonChips, Stepper } from "@hostry/ui-kit";
import type { OrderLine, OrderLineCancel, ReasonCode } from "../../domain/rows";
import { liveQty } from "../../domain/lines";
import { cancelSentLine } from "../../data/trading";
import { useApp } from "../app-state";

/**
 * RS07: cancel a sent line. One dialog is the confirmation: quantity, a required reason, then the member's own PIN, or a
 * manager's PIN when the member lacks `order.line.cancel` (button reads "Ask manager"). A draft line never reaches it.
 */
export function CancelDialog(props: { lineId: string | undefined; onClose: () => void }): JSX.Element {
  const app = useApp();
  const [qty, setQty] = createSignal(1);
  const [reason, setReason] = createSignal<string | undefined>(undefined);
  const line = createMemo(() => (props.lineId ? app.snap().get<OrderLine>("order_line", props.lineId) : undefined));
  const live = createMemo(() => {
    const l = line();
    return l ? liveQty(l, app.snap().list<OrderLineCancel>("order_line_cancel")) / 1000 : 1;
  });
  const reasons = createMemo(() => app.snap().list<ReasonCode>("reason_code").filter((r) => r.purpose === "cancel" && r.active).map((r) => ({ id: r.id, label: app.t(r.label_key) })));
  const may = () => app.can("order.line.cancel");

  createEffect(
    () => props.lineId,
    () => {
      setQty(1);
      setReason(undefined);
    },
  );

  const submit = async () => {
    const l = line();
    const r = reason();
    if (!l || !r) return;
    const proof = await app.askProof({ target: l.id, reason: r, permission: "order.line.cancel", title: app.t("cancel.title", { qty: qty(), item: l.name }), summary: app.t("cancel.title", { qty: qty(), item: l.name }) });
    if (!proof.ok) return;
    const done = await app.run(() => cancelSentLine(app.rt.ctx, { lineId: l.id, qtyMilli: qty() * 1000, reasonCodeId: r, ...(proof.approvalId ? { approvalId: proof.approvalId } : {}) }));
    if (done) props.onClose();
  };

  return (
    <Dialog open={props.lineId !== undefined} title={app.t("cancel.title", { qty: qty(), item: line()?.name ?? "" })} onClose={props.onClose} data-testid="cancel-dialog">
      <Stepper label={app.t("cancel.qty")} value={qty()} min={1} max={Math.max(1, live())} onChange={setQty} data-testid="cancel-qty" />
      <ReasonChips label={app.t("cancel.reason")} reasons={reasons()} selected={reason()} onSelect={setReason} />
      <p>{app.t("cancel.wastage")}</p>
      <Button variant="secondary" data-testid="cancel-back" onClick={props.onClose}>
        {app.t("common.back")}
      </Button>
      <Button variant="danger" data-testid="cancel-submit" disabled={reason() === undefined} onClick={() => void submit()}>
        {may() ? app.t("cancel.submit") : app.t("cancel.ask")}
      </Button>
    </Dialog>
  );
}
