import { createMemo, createSignal, Show } from "solid-js";
import type { JSX } from "@solidjs/web";
import type { BillLineRow, RefundTender } from "@hostry/client-core";
import { AmountField, Button, formatMoney, Input, LineSelectList, ReasonChips, SegmentedControl, toasts } from "@hostry/ui-kit";
import type { ReasonCode } from "../../domain/rows";
import { creditAndReopen, creditNote, creditNoteBinding, loadOriginal, paidOf, paymentsOf, planRebill, previouslyCredited, rebillBill, rebillBinding, type RebillPlan, refundBinding, refundPayment, validGstin } from "../../data/trading";
import { useApp } from "../app-state";
import { BackButton } from "../common";

/**
 * RS19: credit note (chosen lines or the whole bill) or Re-bill (credit note and replacement bill in one op, for example to add
 * a GSTIN). The manager's own PIN, or the member's if they hold the permission, is the one confirmation (AC 124, 138, 139).
 */
export function Credit(props: { billId: string }): JSX.Element {
  const app = useApp();
  type Mode = "credit" | "rebill" | "reopen" | "refund";
  const [mode, setMode] = createSignal<Mode>(app.can("bill.credit_note.create") ? "credit" : app.can("bill.rebill") ? "rebill" : "refund");
  const [sel, setSel] = createSignal<Record<string, number>>({});
  const [reason, setReason] = createSignal<string | undefined>(undefined);
  const [refund, setRefund] = createSignal<RefundTender>("cash");
  const [gstin, setGstin] = createSignal("");
  const original = createMemo(() => loadOriginal((e) => app.snap().list(e), props.billId));
  const prev = createMemo(() => previouslyCredited((e) => app.snap().list(e), props.billId));
  const selectable = createMemo(() => original().lines.map((l: BillLineRow) => ({ id: l.id, label: l.item_name, qty: (l.qty_milli - (prev()[l.id] ?? 0)) / 1000 })).filter((l) => l.qty > 0));
  const reasons = createMemo(() => app.snap().list<ReasonCode>("reason_code").filter((r) => r.purpose === "credit_note" && r.active).map((r) => ({ id: r.id, label: app.t(r.label_key) })));
  const payments = createMemo(() => paymentsOf((e) => app.snap().list(e), props.billId));
  const refunds = createMemo(() => app.snap().list<{ payment_id?: string; amount_paise: number }>("refund"));
  const left = (paymentId: string) => (payments().find((p) => p.id === paymentId)?.amount_paise ?? 0) - refunds().filter((r) => r.payment_id === paymentId).reduce((s, r) => s + r.amount_paise, 0);
  const [payment, setPayment] = createSignal<string | undefined>(undefined);
  const [amount, setAmount] = createSignal<number | undefined>(undefined);
  const refundPaise = () => Math.min(amount() ?? left(payment() ?? ""), left(payment() ?? ""));
  const unpaid = createMemo(() => paidOf((e) => app.snap().list(e), props.billId) === 0);
  const gstinBad = () => gstin().trim() !== "" && !validGstin(gstin());

  const submit = async () => {
    const r = reason();
    if (!r) return;
    const perm = { credit: "bill.credit_note.create", rebill: "bill.rebill", reopen: "bill.credit_note.create", refund: "payment.refund" }[mode()];
    const title = app.t({ credit: "credit.title", rebill: "credit.rebill", reopen: "credit.reopen", refund: "credit.refund.mode" }[mode()]);
    const lines = Object.keys(sel()).length ? Object.entries(sel()).map(([id, q]) => ({ bill_line_id: id, qty_milli: q * 1000 })) : undefined;
    // An approval binds the row the op inserts and the amounts it records, so another amount needs another approval: the id
    // of the credit note or refund and its total are fixed here and used by the op.
    let noteId: string | undefined;
    let refundId: string | undefined;
    let rebillPlan: RebillPlan | undefined;
    let ask: Parameters<typeof app.askProof>[0] = { permission: perm, target: props.billId, reason: r, title };
    if (mode() === "credit" || mode() === "reopen") {
      const b = creditNoteBinding(app.rt.ctx, { billId: props.billId, ...(mode() === "credit" && lines ? { lines } : {}), reasonCodeId: r, refundTender: mode() === "credit" ? refund() : "adjusted" });
      noteId = b.noteId;
      ask = { permission: b.permission, intent: b.intent, target: b.target, reason: b.reason, values: b.values, title };
    } else if (mode() === "rebill") {
      // After payment or past the allowance the re-bill is bill.rebill.approved: the approval names the bill, the group, the value
      // withdrawn and the replacement value. Within the allowance it stays a plain session proof for bill.rebill.
      rebillPlan = planRebill(app.rt.ctx, { billId: props.billId, ...(gstin().trim() ? { gstin: gstin() } : {}), reasonCodeId: r });
      const b = rebillBinding(props.billId, r, rebillPlan);
      if (b) ask = { permission: b.permission, intent: b.intent, target: b.target, reason: b.reason, values: b.values, title };
    } else if (mode() === "refund") {
      refundId = app.rt.ctx.newId();
      ask = { ...refundBinding(refundId, props.billId, payment() ?? "", refundPaise(), r), title };
    }
    const proof = await app.askProof(ask);
    if (!proof.ok) return;
    const approval = proof.approvalId ? { approvalId: proof.approvalId } : {};
    if (mode() === "refund") {
      const p = payment();
      if (!p) return;
      await app.run(
        () => refundPayment(app.rt.ctx, { paymentId: p, amountPaise: refundPaise(), reasonCodeId: r, ...(refundId ? { refundId } : {}), ...approval }),
        () => {
          toasts.show(app.t("credit.refunded", { amount: formatMoney(refundPaise()) }));
          app.back();
        },
      );
    } else if (mode() === "reopen") {
      await app.run(
        () => creditAndReopen(app.rt.ctx, { billId: props.billId, reasonCodeId: r, ...(noteId ? { noteId } : {}), ...approval }),
        (n) => {
          toasts.show(app.t("credit.reopened", { credit: n.credit }));
          app.back();
        },
      );
    } else if (mode() === "credit") {
      await app.run(
        () => creditNote(app.rt.ctx, { billId: props.billId, ...(lines ? { lines } : {}), reasonCodeId: r, refundTender: refund(), ...(noteId ? { noteId } : {}), ...approval }),
        (n) => {
          toasts.show(app.t("credit.done", { number: n.number }));
          app.back();
        },
      );
    } else {
      await app.run(
        () => rebillBill(app.rt.ctx, { billId: props.billId, ...(gstin().trim() ? { gstin: gstin() } : {}), reasonCodeId: r, ...(rebillPlan ? { plan: rebillPlan } : {}), ...approval }),
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
          ...(app.can("bill.credit_note.create") && unpaid() ? [{ id: "reopen", label: app.t("credit.reopen"), "data-testid": "mode-reopen" }] : []),
          ...(app.can("payment.refund") && payments().length > 0 ? [{ id: "refund", label: app.t("credit.refund.mode"), "data-testid": "mode-refund" }] : []),
        ]}
        selected={mode()}
        onSelect={(m) => setMode(m as Mode)}
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
      <Show when={mode() === "reopen"}>
        <p data-testid="reopen-help">{app.t("credit.reopen.help")}</p>
      </Show>
      <Show when={mode() === "refund"}>
        <SegmentedControl
          label={app.t("credit.refund.payment")}
          options={payments().map((p) => ({ id: p.id, label: `${p.tender} ${formatMoney(left(p.id))}`, "data-testid": `refund-pay-${p.id}` }))}
          selected={payment()}
          onSelect={(id) => (setPayment(id), setAmount(undefined))}
        />
        <Show when={payment()}>
          <AmountField label={app.t("credit.refund.amount")} valuePaise={refundPaise()} onChange={(v) => setAmount(v)} data-testid="refund-amount" />
        </Show>
        <p data-testid="refund-usecredit">{app.t("credit.refund.usecredit")}</p>
      </Show>
      <ReasonChips label={app.t("credit.reason")} reasons={reasons()} selected={reason()} onSelect={setReason} />
      <Button data-testid="credit-submit" disabled={!reason() || (mode() === "rebill" && gstinBad()) || (mode() === "refund" && (!payment() || refundPaise() < 1))} onClick={() => void submit()}>
        {app.t({ credit: "credit.submit", rebill: "credit.rebill.submit", reopen: "credit.reopen.submit", refund: "credit.refund.submit" }[mode()])}
      </Button>
    </section>
  );
}
