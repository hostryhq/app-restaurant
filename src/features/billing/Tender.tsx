import { createMemo, createSignal, For, onSettled, Show } from "solid-js";
import type { JSX } from "@solidjs/web";
import type { PaymentInput, Tender as TenderKind } from "@hostry/client-core";
import { AmountBreakdown, AmountField, Button, Input, PaymentRow, QuickAmountChips, ShareList, Stepper, TenderTabs, toasts, type BreakdownRow, type Share } from "@hostry/ui-kit";
import { openShift, settle, settingsFrom, validGstin } from "../../data/trading";
import { useApp } from "../app-state";
import { BackButton } from "../common";
import { OpenShiftSheet } from "../shell/OpenShiftSheet";
import { totals } from "../selectors";

type Pay = PaymentInput & { key: number };

/** Quick cash amounts above the due amount: the next 100, 500 and 2,000 notes (paise). */
export function quickCash(due: number): number[] {
  const up = (step: number) => Math.ceil(due / step) * step;
  return [...new Set([due, up(10_000), up(50_000), up(200_000)].filter((n) => n >= due))];
}

/**
 * RS15: settle. Cash is preselected; Exact (F9) pays the due amount in one tap and settles. Several tender rows or N equal
 * shares can make up one invoice. The invoice number is taken when this settles (ADR-0014 A1.5) and printing never holds the
 * screen: a failed print is queued (RS17) and the bill is settled anyway.
 */
export function Tender(props: { checkId: string; exact?: boolean }): JSX.Element {
  const app = useApp();
  const [pays, setPays] = createSignal<Pay[]>([]);
  const [tender, setTender] = createSignal<TenderKind>("cash");
  const [entered, setEntered] = createSignal<number | undefined>(undefined);
  const [gstin, setGstin] = createSignal("");
  const [shares, setShares] = createSignal(1);
  const [paidShares, setPaidShares] = createSignal<number[]>([]);
  const [shiftOpen, setShiftOpen] = createSignal(false);
  const [pending, setPending] = createSignal<PaymentInput[] | undefined>(undefined);
  const [key, setKey] = createSignal(0);
  const sum = createMemo(() => totals(app, props.checkId));
  const due = () => sum()?.total ?? 0;
  const paid = () => pays().reduce((s, p) => s + p.amount_paise, 0);
  const remaining = () => Math.max(0, due() - paid());
  const kinds = createMemo(() => app.snap().list<{ id: string; kind: string; name: string; enabled: boolean }>("tender_kind").filter((k) => k.enabled));
  const gstinBad = () => gstin().trim() !== "" && !validGstin(gstin());

  const rows = createMemo<BreakdownRow[]>(() => {
    const r = sum()?.c.result;
    if (!r) return [];
    const out: BreakdownRow[] = [{ id: "gross", label: app.t("tender.subtotal"), amountPaise: r.gross_paise }];
    const disc = r.line_discount_paise + r.bill_discount_paise;
    if (disc > 0) out.push({ id: "discount", label: app.t("tender.discount"), amountPaise: -disc });
    if (r.service_charge_paise > 0) out.push({ id: "service", label: app.t("tender.service"), amountPaise: r.service_charge_paise });
    if (r.packing_paise > 0) out.push({ id: "packing", label: app.t("tender.packing"), amountPaise: r.packing_paise });
    if (r.cgst_paise > 0) out.push({ id: "cgst", label: "CGST", amountPaise: r.cgst_paise });
    if (r.sgst_paise > 0) out.push({ id: "sgst", label: "SGST", amountPaise: r.sgst_paise });
    if (r.round_off_paise !== 0) out.push({ id: "round", label: app.t("tender.roundoff"), amountPaise: r.round_off_paise });
    return out;
  });

  const methodLabel = (t: string) => app.t(`tender.kind.${t}`);

  const finish = (list: PaymentInput[]) => {
    const needShift = list.some((p) => p.tender === "cash") && settingsFrom((e) => app.snap().list(e)).shift_required && !openShift((e) => app.snap().list(e));
    if (needShift) {
      setPending(list);
      setShiftOpen(true);
      return;
    }
    void app.run(
      () => settle(app.rt.ctx, props.checkId, { payments: list, ...(gstin().trim() ? { customerGstin: gstin() } : {}) }),
      (r) => {
        toasts.show(app.t("tender.done", { number: r.number }));
        app.back();
      },
    );
  };

  const payment = (t: TenderKind, amount: number, tendered?: number): Pay => {
    setKey(key() + 1);
    return {
      key: key(),
      tender: t,
      amount_paise: amount,
      ...(t === "cash" && tendered !== undefined && tendered > amount ? { tendered_paise: tendered, change_paise: tendered - amount } : {}),
    };
  };

  const exact = () => finish([...pays(), payment(tender(), remaining())].map(({ key: _k, ...p }) => (void _k, p)));
  const addRow = () => {
    const amount = Math.min(entered() ?? remaining(), remaining());
    if (amount <= 0) return;
    setPays([...pays(), payment(tender(), amount, tender() === "cash" ? entered() : undefined)]);
    setEntered(undefined);
  };
  const settleNow = () => finish(pays().map(({ key: _k, ...p }) => (void _k, p)));
  const shareList = createMemo<Share[]>(() => {
    const n = shares();
    const base = Math.floor(due() / n);
    return Array.from({ length: n }, (_, i) => ({ id: String(i), label: app.t("tender.share", { n: i + 1 }), amountPaise: i === n - 1 ? due() - base * (n - 1) : base, paid: paidShares().includes(i) }));
  });

  onSettled(() => {
    if (props.exact && sum()) exact();
  });

  return (
    <section data-testid="tender-screen">
      <BackButton />
      <h1>{app.t("tender.title")}</h1>
      <AmountBreakdown label={app.t("tender.title")} rows={rows()} totalPaise={due()} totalLabel={app.t("tender.due")} data-testid="tender-breakdown" />
      <TenderTabs label={app.t("tender.method")} tenders={kinds().map((k) => ({ id: k.kind, label: methodLabel(k.kind) }))} selected={tender()} onSelect={(id) => setTender(id as TenderKind)} />
      <AmountField label={app.t("tender.amount")} valuePaise={entered() ?? remaining()} onChange={setEntered} data-testid="tender-amount" />
      <Show when={tender() === "cash"}>
        <QuickAmountChips amountsPaise={quickCash(remaining())} onPick={setEntered} />
        <Show when={(entered() ?? 0) > remaining() && remaining() > 0}>
          <p data-testid="tender-change">{app.t("tender.change", { amount: String(((entered() ?? 0) - remaining()) / 100) })}</p>
        </Show>
      </Show>
      <For each={pays()}>
        {(p) => <PaymentRow id={String(p.key)} method={methodLabel(p.tender)} amountPaise={p.amount_paise} onRemove={() => setPays(pays().filter((x) => x.key !== p.key))} />}
      </For>
      <div class="app-tender__actions">
        <Button variant="secondary" data-testid="tender-add" disabled={remaining() <= 0} onClick={addRow}>
          {app.t("tender.add")}
        </Button>
        <Button data-testid="tender-exact" disabled={remaining() <= 0 && due() > 0} onClick={exact}>
          {app.t("tender.exact")}
        </Button>
        <Button data-testid="tender-settle" disabled={due() > 0 && remaining() > 0} onClick={settleNow}>
          {app.t("tender.settle")}
        </Button>
        <Show when={app.can("bill.finalize")}>
          <Button variant="secondary" data-testid="tender-issue" disabled={pays().length > 0} onClick={() => finish([])}>
            {app.t("tender.issue")}
          </Button>
        </Show>
      </div>
      <details>
        <summary>{app.t("tender.customer")}</summary>
        <Input label={app.t("tender.gstin")} value={gstin()} data-testid="tender-gstin" {...(gstinBad() ? { error: app.t("error.bad_gstin") } : {})} onInput={(e) => setGstin(e.currentTarget.value)} />
      </details>
      <details>
        <summary>{app.t("tender.split")}</summary>
        <Stepper label={app.t("tender.shares")} value={shares()} min={1} max={8} onChange={(n) => { setShares(n); setPaidShares([]); setPays([]); }} data-testid="tender-shares" />
        <Show when={shares() > 1}>
          <ShareList
            label={app.t("tender.split")}
            shares={shareList()}
            onPay={(id) => {
              const s = shareList().find((x) => x.id === id);
              if (!s || s.paid) return;
              setPays([...pays(), payment(tender(), s.amountPaise)]);
              setPaidShares([...paidShares(), Number(id)]);
            }}
          />
        </Show>
      </details>
      <OpenShiftSheet
        open={shiftOpen()}
        onClose={() => setShiftOpen(false)}
        onOpened={() => {
          setShiftOpen(false);
          const list = pending();
          setPending(undefined);
          if (list) finish(list);
        }}
      />
    </section>
  );
}
