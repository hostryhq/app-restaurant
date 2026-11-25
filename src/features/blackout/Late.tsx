import { createMemo, createSignal, For, Show } from "solid-js";
import type { JSX } from "@solidjs/web";
import type { BillableLine } from "@hostry/client-core";
import { AmountField, Button, Input, LateTicketRow, Stepper, toasts } from "@hostry/ui-kit";
import { menuFrom } from "../../data/context";
import { bookEntry } from "../../data/trading";
import type { Item } from "../../domain/rows";
import { useApp } from "../app-state";
import { BackButton, Empty } from "../common";

/**
 * RS31: blackout tools. Late tickets are KOTs that arrived after the kitchen was already told by hand, or are older than 15
 * minutes: never printed automatically, a person prints (marked LATE) or dismisses. The paper bill-book entry is shown only
 * once the owner registered a book (P2D-7), to a manager, up to 2 days back; a total that differs is flagged, never forced.
 */
export function Late(): JSX.Element {
  const app = useApp();
  const [number, setNumber] = createSignal("");
  const [date, setDate] = createSignal(new Date(app.nowMs() + 330 * 60_000).toISOString().slice(0, 10));
  const [total, setTotal] = createSignal(0);
  const [qty, setQty] = createSignal<Record<string, number>>({});
  const books = createMemo(() => ((app.snap().list("billing_settings")[0]?.manual_book_codes as string[] | undefined) ?? []).length > 0);
  const items = createMemo(() => app.snap().list<Item>("item").slice(0, 12));

  const save = () => {
    const menu = menuFrom((e) => app.snap().list(e));
    const lines: BillableLine[] = Object.entries(qty())
      .filter(([, q]) => q > 0)
      .map(([id, q]) => {
        const d = menu.buildOrderLine({ itemId: id, qtyMilli: q * 1000, ...(menu.defaultVariant(id) ? { variantId: menu.defaultVariant(id)?.id as string } : {}) });
        return { id: `bk-${id}`, item_id: id, name: d.name, category_name: d.category_name, qty_milli: d.qty_milli, unit_price_paise: d.unit_price_paise, modifier_delta_paise: 0, tax_class: d.tax_class };
      });
    void app.run(
      () => bookEntry(app.rt.ctx, { number: number().trim(), invoiceDate: date(), bookTotalPaise: total(), header: { order_type: "counter" }, lines }),
      (r) => toasts.show(app.t(r.matchesBook ? "late.book.saved" : "late.book.flagged")),
    );
  };

  return (
    <section data-testid="late-screen">
      <BackButton />
      <h1>{app.t("late.title")}</h1>
      <Show when={app.late().length > 0} fallback={<Empty text={app.t("late.empty")} testid="late-empty" />}>
        <For each={app.late()}>
          {(t) => (
            <div>
              <LateTicketRow
                id={t.id}
                title={`${t.doc.tableLabel} - ${t.doc.kotNumber}`}
                summary={t.doc.lines.map((l) => `${l.qty} x ${l.name.en}`).join(", ")}
                ageText={app.t("floor.min", { n: t.ageMinutes })}
                actionLabel={app.t("late.print")}
                onAction={() => {
                  app.rt.fakes.hub.printLate(t.id);
                  void app.rt.fakes.hub.flush();
                }}
              />
              <Button variant="secondary" data-testid={`late-dismiss-${t.id}`} onClick={() => app.rt.fakes.hub.dismissLate(t.id)}>
                {app.t("late.dismiss")}
              </Button>
            </div>
          )}
        </For>
      </Show>
      <Show when={books() && app.can("bill.manual_entry")}>
        <h2>{app.t("late.book.title")}</h2>
        <Input label={app.t("late.book.number")} value={number()} data-testid="book-number" onInput={(e) => setNumber(e.currentTarget.value)} />
        <Input label={app.t("late.book.date")} value={date()} data-testid="book-date" onInput={(e) => setDate(e.currentTarget.value)} />
        <AmountField label={app.t("late.book.total")} valuePaise={total()} onChange={setTotal} data-testid="book-total" />
        <For each={items()}>{(i) => <Stepper label={i.name_en} value={qty()[i.id] ?? 0} min={0} max={99} onChange={(n) => setQty({ ...qty(), [i.id]: n })} data-testid={`book-qty-${i.code}`} />}</For>
        <Button data-testid="book-save" onClick={save}>
          {app.t("late.book.save")}
        </Button>
      </Show>
    </section>
  );
}
