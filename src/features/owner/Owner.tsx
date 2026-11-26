import { createMemo, For, Show } from "solid-js";
import type { JSX } from "@solidjs/web";
import type { BillRow, CreditNoteRow, PaymentRow } from "@hostry/client-core";
import { Button, EmptyState, ExceptionRow, formatMoney, StatTile } from "@hostry/ui-kit";
import { zTotals } from "../../domain/shift-day";
import type { OpRow, OrderLineCancel } from "../../domain/rows";
import { openDayOf } from "../../data/trading";
import { useApp } from "../app-state";
import { BackButton } from "../common";

/** Today's figures from this device (data as of now), computed from the document rows of the open business date. */
function useToday() {
  const app = useApp();
  return createMemo(() => {
    const snap = app.snap();
    const day = openDayOf((e) => snap.list(e));
    const date = day?.business_date ?? snap.list<BillRow>("bill").map((b) => b.business_date).sort().pop() ?? "";
    return { date, z: zTotals(date, snap.list<BillRow & { id: string }>("bill"), snap.list<PaymentRow & { id: string }>("payment"), snap.list<CreditNoteRow & { id: string }>("credit_note")) };
  });
}

/** RS25: owner home. Live day figures from this device, and the way to reports, exceptions, settings, menu and day close. */
export function OwnerHome(): JSX.Element {
  const app = useApp();
  const today = useToday();
  return (
    <section data-testid="owner-screen">
      <h1>{app.t("owner.title")}</h1>
      <p data-testid="owner-asof">{app.t("owner.asof", { date: today().date })}</p>
      <StatTile label={app.t("owner.sales")} value={formatMoney(today().z.total)} data-testid="owner-sales" />
      <StatTile label={app.t("owner.bills")} value={String(today().z.billCount)} data-testid="owner-bills" />
      <For each={Object.entries(today().z.tenders)}>{([k, v]) => <StatTile label={app.t(`tender.kind.${k}`)} value={formatMoney(v)} data-testid={`owner-tender-${k}`} />}</For>
      <div class="app-actions">
        <Button variant="secondary" data-testid="owner-reports" onClick={() => app.go({ id: "reports" })}>
          {app.t("owner.reports")}
        </Button>
        <Button variant="secondary" data-testid="owner-exceptions" onClick={() => app.go({ id: "exceptions" })}>
          {app.t("owner.exceptions")}
        </Button>
        <Button variant="secondary" data-testid="owner-bills-list" onClick={() => app.go({ id: "bills" })}>
          {app.t("bills.title")}
        </Button>
        <Button variant="secondary" data-testid="owner-menu" onClick={() => app.go({ id: "menu" })}>
          {app.t("owner.menu")}
        </Button>
        <Button variant="secondary" data-testid="owner-settings" onClick={() => app.go({ id: "settings" })}>
          {app.t("owner.settings")}
        </Button>
        <Button variant="secondary" data-testid="owner-setup" onClick={() => app.go({ id: "setup" })}>
          {app.t("owner.setup")}
        </Button>
        <Show when={app.can("day.close")}>
          <Button data-testid="owner-dayclose" onClick={() => app.go({ id: "dayclose" })}>
            {app.t("dayclose.title")}
          </Button>
        </Show>
        <Show when={app.can("shift.close")}>
          <Button variant="secondary" data-testid="owner-shiftclose" onClick={() => app.go({ id: "shiftclose" })}>
            {app.t("shiftclose.title")}
          </Button>
        </Show>
        <Button variant="secondary" data-testid="owner-print" onClick={() => app.go({ id: "print" })}>
          {app.t("print.title")}
        </Button>
      </div>
    </section>
  );
}

/** RS26: the open-day report from this device. A multi-day report needs the internet and says so (RM-X5). */
export function Reports(): JSX.Element {
  const app = useApp();
  const today = useToday();
  const items = createMemo(() => {
    const snap = app.snap();
    const date = today().date;
    const billIds = new Set(snap.list<BillRow & { id: string }>("bill").filter((b) => b.business_date === date).map((b) => b.id));
    const by = new Map<string, { qty: number; net: number }>();
    for (const l of snap.list<{ bill_id: string; item_name: string; qty_milli: number; net_paise: number }>("bill_line")) {
      if (!billIds.has(l.bill_id)) continue;
      const cur = by.get(l.item_name) ?? { qty: 0, net: 0 };
      by.set(l.item_name, { qty: cur.qty + l.qty_milli, net: cur.net + l.net_paise });
    }
    return [...by.entries()].sort((a, b) => b[1].net - a[1].net).slice(0, 10);
  });
  return (
    <section data-testid="reports-screen">
      <BackButton />
      <h1>{app.t("reports.title")}</h1>
      <p data-testid="reports-asof">{app.t("owner.asof", { date: today().date })}</p>
      <StatTile label={app.t("owner.sales")} value={formatMoney(today().z.total)} />
      <StatTile label={app.t("reports.tax")} value={formatMoney(today().z.cgst + today().z.sgst)} />
      <StatTile label={app.t("reports.creditnotes")} value={formatMoney(today().z.creditNoteTotal)} />
      <h2>{app.t("reports.top")}</h2>
      <ul class="app-list" data-testid="reports-items">
        <For each={items()}>
          {([name, v]) => (
            <li>
              {name} x{v.qty / 1000} - {formatMoney(v.net)}
            </li>
          )}
        </For>
      </ul>
      <Show when={app.sync().upstream === "none" || app.sync().upstream === "hub"}>
        <p data-testid="reports-needs-internet">{app.t("reports.multiday.offline")}</p>
      </Show>
    </section>
  );
}

/** RS24: exceptions a manager should look at: book totals that differ, cancels after the kitchen started, approved over-limit discounts. */
export function Exceptions(): JSX.Element {
  const app = useApp();
  const list = createMemo(() => {
    const snap = app.snap();
    const out: Array<{ id: string; message: string; kind: "warning" | "danger" }> = [];
    for (const b of snap.list<BillRow & { id: string }>("bill")) {
      if (b.book_total_paise !== undefined && b.book_total_paise !== b.total_paise) out.push({ id: `book-${b.id}`, kind: "danger", message: app.t("exceptions.book", { number: b.number, book: formatMoney(b.book_total_paise), ours: formatMoney(b.total_paise) }) });
    }
    for (const c of snap.list<OrderLineCancel>("order_line_cancel")) {
      if (c.kind === "cancel" && c.wastage) out.push({ id: `waste-${c.id}`, kind: "warning", message: app.t("exceptions.wastage") });
    }
    for (const o of snap.list<OpRow>("_op")) {
      if (o.intent === "bill.discount.over_limit") out.push({ id: `disc-${o.id}`, kind: "warning", message: app.t("exceptions.discount", { who: app.nameOf(o.actor) }) });
    }
    return out;
  });
  return (
    <section data-testid="exceptions-screen">
      <BackButton />
      <h1>{app.t("exceptions.title")}</h1>
      <Show when={list().length > 0} fallback={<EmptyState title={app.t("exceptions.empty")} />}>
        <For each={list()}>{(e) => <ExceptionRow id={e.id} message={e.message} kind={e.kind} />}</For>
      </Show>
    </section>
  );
}
