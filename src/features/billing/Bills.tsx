import { createMemo, createSignal, For, Show } from "solid-js";
import type { JSX } from "@solidjs/web";
import type { BillRow } from "@hostry/client-core";
import { Button, Card, formatMoney, Input, StatusBadge, toasts } from "@hostry/ui-kit";
import { paidOf, recordPayment, reprintBill } from "../../data/trading";
import { useApp } from "../app-state";
import { BackButton, Empty } from "../common";

/** RS18: the day's bills, search by number, reprint (DUPLICATE, copy count), take payment on an unpaid bill, credit note. */
export function Bills(): JSX.Element {
  const app = useApp();
  const [q, setQ] = createSignal("");
  const [selected, setSelected] = createSignal<string | undefined>(undefined);
  const bills = createMemo(() =>
    app
      .snap()
      .list<BillRow & { id: string }>("bill")
      .filter((b) => !q().trim() || b.number.toLowerCase().includes(q().trim().toLowerCase()))
      .sort((a, b) => b.number.localeCompare(a.number)),
  );
  const sel = createMemo(() => bills().find((b) => b.id === selected()));
  const due = (b: BillRow) => b.total_paise - paidOf((e) => app.snap().list(e), b.id);
  const credited = (b: BillRow) => app.snap().list<{ bill_id: string }>("credit_note").some((n) => n.bill_id === b.id);

  return (
    <section data-testid="bills-screen">
      <BackButton />
      <h1>{app.t("bills.title")}</h1>
      <Input label={app.t("bills.search")} value={q()} data-testid="bills-search" onInput={(e) => setQ(e.currentTarget.value)} />
      <Show when={bills().length > 0} fallback={<Empty text={app.t("bills.empty")} testid="bills-empty" />}>
        <ul class="app-list">
          <For each={bills()}>
            {(b) => (
              <li>
                <Button variant={selected() === b.id ? "primary" : "secondary"} data-testid={`bill-row-${b.number}`} onClick={() => setSelected(b.id)}>
                  {b.number} - {formatMoney(b.total_paise)} {due(b) > 0 ? `- ${app.t("bills.unpaid")}` : ""} {credited(b) ? `- ${app.t("bills.credited")}` : ""}
                </Button>
              </li>
            )}
          </For>
        </ul>
      </Show>
      <Show when={sel()}>
        <Card title={sel()?.number ?? ""} data-testid="bill-detail">
          <p>
            {formatMoney(sel()?.total_paise ?? 0)} <StatusBadge kind={(sel() ? due(sel() as BillRow) : 0) > 0 ? "warning" : "success"} label={(sel() ? due(sel() as BillRow) : 0) > 0 ? app.t("bills.unpaid") : app.t("bills.paid")} />
          </p>
          <p>{sel()?.invoice_date}</p>
          <Show when={app.can("bill.reprint")}>
            <Button
              data-testid="bill-reprint"
              onClick={() =>
                void app.run(
                  () => reprintBill(app.rt.ctx, selected() as string),
                  (copy) => toasts.show(app.t("bills.reprinted", { n: copy })),
                )
              }
            >
              {app.t("bills.reprint")}
            </Button>
          </Show>
          <Show when={sel() && due(sel() as BillRow) > 0 && app.can("payment.record")}>
            <Button variant="secondary" data-testid="bill-pay-upi" onClick={() => void app.run(() => recordPayment(app.rt.ctx, selected() as string, [{ tender: "upi", amount_paise: due(sel() as BillRow) }]))}>
              {app.t("bills.payupi")}
            </Button>
            <Button variant="secondary" data-testid="bill-pay-cash" onClick={() => void app.run(() => recordPayment(app.rt.ctx, selected() as string, [{ tender: "cash", amount_paise: due(sel() as BillRow) }]))}>
              {app.t("bills.paycash")}
            </Button>
          </Show>
          <Show when={app.can("bill.credit_note.create") || app.can("bill.rebill")}>
            <Button variant="secondary" data-testid="bill-credit" onClick={() => app.go({ id: "credit", billId: selected() as string })}>
              {app.t("bills.credit")}
            </Button>
          </Show>
        </Card>
      </Show>
    </section>
  );
}
