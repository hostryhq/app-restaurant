import { createEffect, createMemo, createSignal, Show } from "solid-js";
import type { JSX } from "@solidjs/web";
import { Button, Dialog, Input, parseRupeesToPaise, ReasonChips, SegmentedControl } from "@hostry/ui-kit";
import { percentToBp } from "../../domain/discount";
import type { Check, ReasonCode } from "../../domain/rows";
import { applyDiscount, discountDecision } from "../../data/trading";
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

  const apply = async () => {
    const v = value();
    const r = reason();
    if (v === undefined || !r) return;
    let approvalId: string | undefined;
    if (decision() === "ask_manager" || decision() === "own_pin" || decision() === "comp") {
      const proof = await app.askProof({ permission: "bill.discount.over_limit", title: app.t("discount.title"), summary: app.t("discount.summary", { value: text() }) });
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
      </Show>
    </Dialog>
  );
}
