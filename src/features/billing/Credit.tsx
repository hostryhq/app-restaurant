import { createMemo, createSignal, Show } from "solid-js";
import type { JSX } from "@solidjs/web";
import type { BillLineRow, RefundTender } from "@hostry/client-core";
import { Button, Input, LineSelectList, ReasonChips, SegmentedControl, toasts } from "@hostry/ui-kit";
import type { ReasonCode } from "../../domain/rows";
import { creditNote, loadOriginal, previouslyCredited, rebillBill, validGstin } from "../../data/trading";
import { useApp } from "../app-state";
import { BackButton } from "../common";

/**
 * RS19: credit note (chosen lines or the whole bill) or Re-bill (credit note and replacement bill in one op, for example to add
 * a GSTIN). The manager's own PIN, or the member's if they hold the permission, is the one confirmation (AC 124, 138, 139).
 */
export function Credit(props: { billId: string }): JSX.Element {
  const app = useApp();
  const [mode, setMode] = createSignal<"credit" | "rebill">(app.can("bill.credit_note.create") ? "credit" : "rebill");
  const [sel, setSel] = createSignal<Record<string, number>>({});
  const [reason, setReason] = createSignal<string | undefined>(undefined);
  const [refund, setRefund] = createSignal<RefundTender>("cash");
  const [gstin, setGstin] = createSignal("");
  const original = createMemo(() => loadOriginal((e) => app.snap().list(e), props.billId));
  const prev = createMemo(() => previouslyCredited((e) => app.snap().list(e), props.billId));
  const selectable = createMemo(() => original().lines.map((l: BillLineRow) => ({ id: l.id, label: l.item_name, qty: (l.qty_milli - (prev()[l.id] ?? 0)) / 1000 })).filter((l) => l.qty > 0));
  const reasons = createMemo(() => app.snap().list<ReasonCode>("reason_code").filter((r) => r.purpose === "credit_note" && r.active).map((r) => ({ id: r.id, label: app.t(r.label_key) })));
  const gstinBad = () => gstin().trim() !== "" && !validGstin(gstin());

  const submit = async () => {
    const r = reason();
    if (!r) return;
    const perm = mode() === "credit" ? "bill.credit_note.create" : "bill.rebill";
    const proof = await app.askProof({ permission: perm, title: app.t(mode() === "credit" ? "credit.title" : "credit.rebill") });
    if (!proof.ok) return;
    const approval = proof.approvalId ? { approvalId: proof.approvalId } : {};
    if (mode() === "credit") {
      const lines = Object.keys(sel()).length ? Object.entries(sel()).map(([id, q]) => ({ bill_line_id: id, qty_milli: q * 1000 })) : undefined;
      await app.run(
        () => creditNote(app.rt.ctx, { billId: props.billId, ...(lines ? { lines } : {}), reasonCodeId: r, refundTender: refund(), ...approval }),
        (n) => {
          toasts.show(app.t("credit.done", { number: n.number }));
          app.back();
        },
      );
    } else {
      await app.run(
        () => rebillBill(app.rt.ctx, { billId: props.billId, ...(gstin().trim() ? { gstin: gstin() } : {}), reasonCodeId: r, ...approval }),
        (n) => {
          toasts.show(app.t("credit.rebilled", { credit: n.credit, bill: n.bills.join(", ") }));
          app.back();
        },
      );
    }
  };

  return (
    <section data-testid="credit-screen">
      <BackButton />
      <h1>{original().bill.number}</h1>
      <SegmentedControl
        label={app.t("credit.mode")}
        options={[
          ...(app.can("bill.credit_note.create") ? [{ id: "credit", label: app.t("credit.title"), "data-testid": "mode-credit" }] : []),
          ...(app.can("bill.rebill") ? [{ id: "rebill", label: app.t("credit.rebill"), "data-testid": "mode-rebill" }] : []),
        ]}
        selected={mode()}
        onSelect={(m) => setMode(m as "credit" | "rebill")}
      />
      <Show when={mode() === "credit"}>
        <LineSelectList label={app.t("credit.lines")} lines={selectable()} selection={sel()} onChange={setSel} />
        <p>{app.t("credit.whole")}</p>
        <SegmentedControl
          label={app.t("credit.refund")}
          options={(["cash", "upi", "card", "adjusted"] as const).map((k) => ({ id: k, label: app.t(`credit.refund.${k}`), "data-testid": `refund-${k}` }))}
          selected={refund()}
          onSelect={(k) => setRefund(k as RefundTender)}
        />
      </Show>
      <Show when={mode() === "rebill"}>
        <Input label={app.t("tender.gstin")} value={gstin()} data-testid="rebill-gstin" {...(gstinBad() ? { error: app.t("error.bad_gstin") } : {})} onInput={(e) => setGstin(e.currentTarget.value)} />
      </Show>
      <ReasonChips label={app.t("credit.reason")} reasons={reasons()} selected={reason()} onSelect={setReason} />
      <Button data-testid="credit-submit" disabled={!reason() || (mode() === "rebill" && gstinBad())} onClick={() => void submit()}>
        {mode() === "credit" ? app.t("credit.submit") : app.t("credit.rebill.submit")}
      </Button>
    </section>
  );
}
