import { createMemo, createSignal, For, Show } from "solid-js";
import type { JSX } from "@solidjs/web";
import { Button, formatMoney, Input, StatTile, toasts } from "@hostry/ui-kit";
import { lineTotalPaise } from "../../domain/lines";
import type { Check } from "../../domain/rows";
import { present, setCustomer, validGstin } from "../../data/trading";
import { useApp } from "../app-state";
import { BackButton } from "../common";
import { DiscountSheet } from "../order/DiscountSheet";
import { linesOf, tableOfSeating, totals } from "../selectors";

/**
 * RS12 check review: what a cashier checks before a bill goes to the guest. Opened from a bill request. Shows the lines and the
 * figures the bill will carry (the same calculation, so Present and Pay never disagree), and the three things that may change
 * first: discount or service charge, customer name and GSTIN, then Present (unnumbered pre-bill) or Pay. A check that is already
 * billed is not editable here: the screen says so and points at Bills (credit note or re-bill, AC 109).
 */
export function Review(props: { checkId: string }): JSX.Element {
  const app = useApp();
  const check = createMemo(() => app.snap().get<Check>("check", props.checkId));
  const lines = createMemo(() => linesOf(app, props.checkId));
  const sum = createMemo(() => totals(app, props.checkId));
  const open = () => check()?.status === "open";
  const label = () => tableOfSeating(app, check()?.seating_id)?.name ?? app.t("counter.token", { n: check()?.token_no ?? 0 });
  const [discount, setDiscount] = createSignal(false);
  const [name, setName] = createSignal(check()?.customer_name ?? "");
  const [gstin, setGstin] = createSignal(check()?.customer_gstin ?? "");
  const gstinBad = () => gstin().trim() !== "" && !validGstin(gstin());

  const saveCustomer = () =>
    void app.run(
      () => setCustomer(app.rt.ctx, props.checkId, { ...(name().trim() ? { name: name().trim() } : {}), ...(gstin().trim() ? { gstin: gstin() } : {}) }),
      () => toasts.show(app.t("review.customer.saved")),
    );
  const doPresent = () =>
    void app.run(
      () => present(app.rt.ctx, props.checkId),
      (r) => {
        if (r.kind === "invoice") app.go({ id: "bills" });
      },
    );

  return (
    <section data-testid="review-screen">
      <BackButton />
      <h1>{app.t("review.title", { table: label() })}</h1>
      <Show when={!open()}>
        <p data-testid="review-billed">{app.t("review.billed")}</p>
      </Show>
      <ul data-testid="review-lines" aria-label={app.t("review.lines")}>
        <For each={lines()}>
          {(l) => (
            <li data-testid={`review-line-${l.id}`}>
              {l.name} x {l.qty_milli / 1000} - {formatMoney(lineTotalPaise(l))}
            </li>
          )}
        </For>
      </ul>
      <Show when={sum()}>
        <StatTile label={app.t("review.total")} value={formatMoney(sum()?.total ?? 0)} data-testid="review-total" />
      </Show>
      <Show when={open()}>
        <Input label={app.t("review.customer.name")} value={name()} data-testid="review-name" onInput={(e) => setName(e.currentTarget.value)} />
        <Input label={app.t("tender.gstin")} value={gstin()} data-testid="review-gstin" {...(gstinBad() ? { error: app.t("error.bad_gstin") } : {})} onInput={(e) => setGstin(e.currentTarget.value)} />
        <Show when={app.can("bill.customer_details.edit")}>
          <Button variant="secondary" data-testid="review-save" disabled={gstinBad()} onClick={saveCustomer}>
            {app.t("review.customer.save")}
          </Button>
        </Show>
        <Show when={lines().length > 0 && app.can("bill.present")}>
          <Button variant="secondary" data-testid="present" onClick={doPresent}>
            {app.t("order.present")}
          </Button>
        </Show>
        <Show when={lines().length > 0 && app.can("bill.discount.apply")}>
          <Button variant="secondary" data-testid="discount" onClick={() => setDiscount(true)}>
            {app.t("order.discount")}
          </Button>
        </Show>
        <Show when={lines().length > 0 && app.can("bill.finalize")}>
          <Button data-testid="pay" onClick={() => app.go({ id: "tender", checkId: props.checkId, exact: false })}>
            {app.t("order.pay")}
          </Button>
        </Show>
      </Show>
      <Button variant="secondary" data-testid="review-open-order" onClick={() => app.go({ id: "order", ...(check()?.seating_id ? { tableId: tableOfSeating(app, check()?.seating_id)?.id as string } : {}), checkId: props.checkId })}>
        {app.t("review.open.order")}
      </Button>
      <DiscountSheet checkId={props.checkId} open={discount()} onClose={() => setDiscount(false)} />
    </section>
  );
}
