import { createEffect, createMemo, createSignal, For, Show } from "solid-js";
import type { JSX } from "@solidjs/web";
import { Button, Dialog, Input, parseRupeesToPaise, ReasonChips, SegmentedControl } from "@hostry/ui-kit";
import { percentToBp } from "../../domain/discount";
import type { Check, ReasonCode } from "../../domain/rows";
import { applyDiscount, compLine, discountDecision, removeServiceCharge } from "../../data/trading";
import { settingsFrom } from "../../data/context";
import { linesOf } from "../selectors";
import { useApp } from "../app-state";

/**
 * RS16: bill discount. Within the outlet limit it applies at once; above it the member re-enters their own PIN (if they hold
 * `bill.discount.over_limit`) or asks a manager, in the same single dialog (RS08). A reason is always required. Not offered
 * once the invoice is issued: use Re-bill or a credit note (AC 109).
 */
export function DiscountSheet(props: { checkId: string; open: boolean; onClose: () => void }): JSX.Element {
  const app = useApp();
  const [kind, setKind] = createSignal<"percent" | "amount">("percent");
  const [text, setText] = createSignal("");
  const [reason, setReason] = createSignal<string | undefined>(undefined);
  const reasons = createMemo(() => app.snap().list<ReasonCode>("reason_code").filter((r) => r.purpose === "discount" && r.active).map((r) => ({ id: r.id, label: app.t(r.label_key) })));
  const value = createMemo(() => (kind() === "percent" ? percentToBp(text()) : parseRupeesToPaise(text())));
  const check = createMemo(() => app.snap().get<Check>("check", props.checkId));
  const decision = createMemo(() => {
    const v = value();
    return v === undefined || v <= 0 ? undefined : discountDecision(app.rt.ctx, props.checkId, kind(), v);
  });

  createEffect(
    () => props.open,
    () => {
      setText("");
      setReason(undefined);
    },
  );

  // Comp needs `bill.line.comp` (own PIN) or a manager's approval, and a reason from the discount list.
  const comp = async (lineId: string) => {
    const r = reason();
    if (!r) return;
    const proof = await app.askProof({ target: lineId, reason: r, permission: "bill.line.comp", title: app.t("discount.comp.title") });
    if (!proof.ok) return;
    const ok = await app.run(() => compLine(app.rt.ctx, { lineId, reasonCodeId: r, ...(proof.approvalId ? { approvalId: proof.approvalId } : {}) }));
    if (ok) props.onClose();
  };

  const apply = async () => {
    const v = value();
    const r = reason();
    if (v === undefined || !r) return;
    let approvalId: string | undefined;
    if (decision() === "ask_manager" || decision() === "own_pin" || decision() === "comp") {
      // The approval binds this discount: the check it is on, its kind and its value. Another amount needs another approval.
      const proof = await app.askProof({
        permission: "bill.discount.over_limit",
        intent: "bill.discount.over_limit",
        target: `check:${props.checkId}`,
        reason: r,
        values: { discount_kind: kind(), discount_value: v },
        title: app.t("discount.title"),
        summary: app.t("discount.summary", { value: text() }),
      });
      if (!proof.ok) return;
      approvalId = proof.approvalId;
    }
    const ok = await app.run(() => applyDiscount(app.rt.ctx, { checkId: props.checkId, kind: kind(), value: v, reasonCodeId: r, ...(approvalId ? { approvalId } : {}) }));
    if (ok) props.onClose();
  };

  return (
    <Dialog open={props.open} title={app.t("discount.title")} onClose={props.onClose} data-testid="discount-sheet">
      <Show when={check()?.status === "open"} fallback={<p data-testid="discount-issued">{app.t("discount.issued")}</p>}>
        <SegmentedControl
          label={app.t("discount.kind")}
          options={[
            { id: "percent", label: app.t("discount.percent"), "data-testid": "discount-percent" },
            { id: "amount", label: app.t("discount.amount"), "data-testid": "discount-amount" },
          ]}
          selected={kind()}
          onSelect={(k) => setKind(k as "percent" | "amount")}
        />
        <Input label={app.t("discount.value")} inputmode="decimal" value={text()} data-testid="discount-value" onInput={(e) => setText(e.currentTarget.value)} />
        <ReasonChips label={app.t("discount.reason")} reasons={reasons()} selected={reason()} onSelect={setReason} />
        <Show when={decision() === "ask_manager" || decision() === "own_pin"}>
          <p data-testid="discount-overlimit">{app.t("discount.overlimit")}</p>
        </Show>
        <Button data-testid="discount-apply" disabled={value() === undefined || !reason()} onClick={() => void apply()}>
          {decision() === "ask_manager" ? app.t("discount.ask") : app.t("discount.apply")}
        </Button>
        <h3>{app.t("discount.comp.title")}</h3>
        <For each={linesOf(app, props.checkId)}>
          {(l) => (
            <Button variant="secondary" data-testid={`comp-${l.id}`} disabled={!reason()} onClick={() => void comp(l.id)}>
              {app.t("discount.comp", { item: l.name })}
            </Button>
          )}
        </For>
        <Show when={settingsFrom((e) => app.snap().list(e)).service_charge_bp > 0 && app.can("bill.service_charge.remove")}>
          <Button variant="secondary" data-testid="discount-service" onClick={() => void app.run(() => removeServiceCharge(app.rt.ctx, props.checkId), () => props.onClose())}>
            {app.t("discount.service")}
          </Button>
        </Show>
      </Show>
    </Dialog>
  );
}
