import { createMemo, createSignal, For, Show, onCleanup } from "solid-js";
import type { JSX } from "@solidjs/web";
import { Menu, type LineSelection } from "@hostry/client-core";
import {
  BillTabs,
  Button,
  CategoryTabs,
  Dialog,
  InlineAlert,
  ItemTile,
  OrderPanel,
  QuickItemGrid,
  type OrderLineData,
  type SentLevel,
  type VegMark,
} from "@hostry/ui-kit";
import { parseCodeEntry, shortcutFor, SHORTCUT_SHEET } from "../../domain/keys";
import type { Check, Item, KotHandover, KotLine, OpRow, OrderLine } from "../../domain/rows";
import { lineTotalPaise } from "../../domain/lines";
import { menuFrom, settingsFrom } from "../../data/context";
import { addLine, billPlease, handover, newCounterCheck, openTableCheck, present, removeDraft, sendKot, setLineQty } from "../../data/trading";
import { useApp } from "../app-state";
import { BackButton, Empty } from "../common";
import { checksOfTable, draftCount, linesOf, totals } from "../selectors";
import { CancelDialog } from "./CancelDialog";
import { DiscountSheet } from "./DiscountSheet";
import { ItemSheet } from "./ItemSheet";
import { TableActions } from "./TableActions";

const VEG: Record<string, VegMark | undefined> = { veg: "veg", non_veg: "nonveg", egg: "egg", none: undefined };

/**
 * RS04 (table order screen) and RS13 (counter order screen): one component, two targets. A table's seating, check and order
 * exist only once the first item is added (AC 39); the counter's order does too. Add, send and settle write locally and
 * return; no spinner (principle 1).
 */
export function Order(props: { tableId?: string | undefined; checkId?: string | undefined }): JSX.Element {
  const app = useApp();
  const counter = () => props.tableId === undefined;
  const [current, setCurrent] = createSignal<string | undefined>(props.checkId);
  const [category, setCategory] = createSignal<string | undefined>(undefined);
  const [search, setSearch] = createSignal("");
  const [sheetItem, setSheetItem] = createSignal<string | undefined>(undefined);
  const [cancelLine, setCancelLine] = createSignal<string | undefined>(undefined);
  const [actions, setActions] = createSignal(false);
  const [discount, setDiscount] = createSignal(false);
  const [help, setHelp] = createSignal(false);
  const [unsent, setUnsent] = createSignal(false);
  let searchEl!: HTMLInputElement;

  const menu = createMemo(() => menuFrom((e) => app.snap().list(e)));
  const table = createMemo(() => (props.tableId ? app.snap().get("dining_table", props.tableId) : undefined));
  const checks = createMemo(() => checksOfTable(app, props.tableId));
  // The selected check: explicit choice, else the table's first open check, else none yet.
  const checkId = createMemo(() => {
    const c = current();
    if (c && app.snap().get<Check>("check", c)?.status === "open") return c;
    return counter() ? undefined : checks()[0]?.id;
  });
  const check = createMemo(() => (checkId() ? app.snap().get<Check>("check", checkId()) : undefined));
  const lines = createMemo(() => linesOf(app, checkId()));
  const sum = createMemo(() => totals(app, checkId()));
  const tableBilled = createMemo(() => !counter() && checks().length === 0 && app.snap().list<Check>("check").some((c) => c.status === "billed"));
  const categories = createMemo(() => app.snap().list<{ id: string; name_en: string; sort_order: number; status: string }>("category").filter((c) => c.status === "active").sort((a, b) => a.sort_order - b.sort_order));
  const items = createMemo<Item[]>(() => {
    const q = search().trim().toLowerCase();
    const m: Menu = menu();
    if (q) {
      return app
        .snap()
        .list<Item>("item")
        .filter((i) => m.isSellable(i.id) && (i.name_en.toLowerCase().includes(q) || (i.code ?? "").toLowerCase() === q))
        .sort((a, b) => a.sort_order - b.sort_order);
    }
    const c = category();
    return c ? m.itemsIn(c) : m.quickItems();
  });

  const ensureCheck = async (): Promise<string | undefined> => {
    const have = checkId();
    if (have) return have;
    let id: string | undefined;
    const ok = await app.run(async () => {
      id = props.tableId ? (await openTableCheck(app.rt.ctx, props.tableId)).checkId : await newCounterCheck(app.rt.ctx);
    });
    if (ok && id) setCurrent(id);
    return id;
  };

  // Adds run one after another: a fast second tap or key press must find the check the first one opened, never open another.
  let chain: Promise<unknown> = Promise.resolve();
  const add = (sel: LineSelection): Promise<void> => {
    const next = chain.then(async () => {
      const id = await ensureCheck();
      if (!id) return;
      await app.run(() => addLine(app.rt.ctx, id, sel));
    });
    chain = next.catch(() => undefined);
    return next;
  };

  const tapItem = (item: Item) => {
    const m = menu();
    const needsSheet = m.variantsOf(item.id).length > 0 || m.modifierGroupsOf(item.id).length > 0;
    if (needsSheet) setSheetItem(item.id);
    else void add({ itemId: item.id, qtyMilli: 1000 });
  };

  const submitCode = () => {
    const text = search().trim();
    const entry = parseCodeEntry(text);
    const item = entry ? app.snap().list<Item>("item").find((i) => i.code === entry.code) : undefined;
    if (entry && item && menu().isSellable(item.id)) {
      setSearch("");
      if (menu().variantsOf(item.id).length > 0 || menu().modifierGroupsOf(item.id).length > 0) setSheetItem(item.id);
      else void add({ itemId: item.id, qtyMilli: entry.qtyMilli });
    }
  };

  const sentLevel = (l: OrderLine): SentLevel => {
    const snap = app.snap();
    const kl = snap.list<KotLine>("kot_line").find((k) => k.order_line_id === l.id);
    if (!kl) return "local";
    if (snap.list<KotHandover>("kot_handover").some((h) => h.kot_id === kl.kot_id)) return "hand";
    const op = snap.list<OpRow>("_op").find((o) => o.intent === "kot.send" && o.muts.some((m) => m.e === "kot" && m.id === kl.kot_id));
    return op?.delivery === "in_cloud" ? "cloud" : op?.delivery === "at_hub" ? "hub" : "local";
  };

  const panelLines = createMemo<OrderLineData[]>(() =>
    lines().map((l) => ({
      id: l.id,
      name: l.name,
      qty: l.qty_milli / 1000,
      totalPaise: lineTotalPaise(l),
      state: l.state,
      ...(l.state === "sent" ? { sent: sentLevel(l) } : {}),
      ...(l.modifiers_text ? { modifiers: [l.modifiers_text] } : {}),
      ...(l.note ? { note: l.note } : {}),
    })),
  );

  const sendNow = () => {
    const id = checkId();
    if (id) void app.run(() => sendKot(app.rt.ctx, id));
  };
  const pay = (exact = false) => {
    const id = checkId();
    if (!id || lines().length === 0) return;
    if (!counter() && draftCount(lines()) > 0 && !unsent()) return setUnsent(true);
    app.go({ id: "tender", checkId: id, exact });
  };
  const doPresent = () => {
    const id = checkId();
    if (!id) return;
    void app.run(
      () => present(app.rt.ctx, id),
      (r) => {
        if (r.kind === "invoice") app.go({ id: "bills" });
      },
    );
  };
  const newOrder = () => {
    setCurrent(undefined);
    setCategory(undefined);
    setSearch("");
  };

  const onKey = (e: KeyboardEvent) => {
    if (!counter()) return;
    const target = e.target as HTMLElement | null;
    const inField = target?.tagName === "INPUT" || target?.tagName === "TEXTAREA";
    const a = shortcutFor(e, inField);
    if (!a) return;
    e.preventDefault();
    if (a === "new_order") newOrder();
    else if (a === "search") searchEl?.focus();
    else if (a === "discount" && app.can("bill.discount.apply")) setDiscount(true);
    else if (a === "hold") newOrder();
    else if (a === "held") app.go({ id: "held" });
    else if (a === "pay") pay(false);
    else if (a === "exact_cash") pay(true);
    else if (a === "print") doPresent();
    else if (a === "lock") app.lock();
    else if (a === "help") setHelp(true);
    else if (a === "escape") {
      setHelp(false);
      setDiscount(false);
    }
  };
  document.addEventListener("keydown", onKey);
  onCleanup(() => document.removeEventListener("keydown", onKey));

  const billTabs = createMemo(() => checks().map((c, i) => ({ id: c.id, label: c.label ?? app.t("order.bill", { n: i + 1 }), totalPaise: totals(app, c.id)?.total ?? 0 })));
  const printMode = () => settingsFrom((e) => app.snap().list(e)).number_at === "print";
  const title = () => (counter() ? app.t("counter.title") : (table() as { name?: string } | undefined)?.name ?? "");
  const tokenLabel = () => (check()?.token_no ? app.t("counter.token", { n: check()?.token_no ?? 0 }) : "");
  const sentLines = () => lines().filter((l) => l.state === "sent");
  // RS06: KOTs of this check the kitchen printer has not taken. Never a modal, never blocks the next order.
  const failedKots = createMemo(() => {
    const snap = app.snap();
    return app.jobs().filter((j) => j.kind === "kot" && j.lastError && snap.get<{ check_id: string }>("kot", j.id)?.check_id === checkId());
  });
  const giveByHand = (mode: "by_hand" | "verbal") => {
    for (const j of failedKots()) {
      void app.run(async () => {
        await handover(app.rt.ctx, j.id, mode);
        app.rt.fakes.hub.remove(j.printerId, j.id);
      });
    }
  };
  const retryKots = () => {
    for (const j of failedKots()) app.rt.fakes.hub.retry(j.printerId, j.id);
    void app.rt.fakes.hub.flush();
  };

  return (
    <section class="app-order" data-testid={counter() ? "counter-screen" : "order-screen"}>
      <header class="app-order__head">
        <Show when={!counter()}>
          <BackButton />
        </Show>
        <h1 data-testid="order-title">{title()}</h1>
        <span data-testid="order-token">{tokenLabel()}</span>
        <Show when={!counter()}>
          <Button variant="secondary" data-testid="table-actions" onClick={() => setActions(true)}>
            {app.t("order.actions")}
          </Button>
        </Show>
        <Show when={counter()}>
          <Button variant="secondary" data-testid="new-order" onClick={newOrder}>
            {app.t("counter.new")}
          </Button>
          <Button variant="secondary" data-testid="open-held" onClick={() => app.go({ id: "held" })}>
            {app.t("held.title")}
          </Button>
        </Show>
      </header>

      <Show when={!counter() && billTabs().length > 0}>
        <BillTabs label={app.t("order.bills")} bills={billTabs()} selected={checkId()} onSelect={setCurrent} data-testid="bill-tabs" />
      </Show>
      <Show when={tableBilled()}>
        <InlineAlert kind="info" data-testid="billed-notice">
          {app.t("order.billed.notice")}
        </InlineAlert>
      </Show>
      <Show when={failedKots().length > 0}>
        <InlineAlert kind="danger" data-testid="send-notdelivered">
          {app.t("send.notdelivered")}
          <Button variant="secondary" data-testid="send-retry" onClick={retryKots}>
            {app.t("send.retry")}
          </Button>
          <Button variant="secondary" data-testid="send-by-hand" onClick={() => giveByHand("by_hand")}>
            {app.t("send.byhand")}
          </Button>
          <Button variant="secondary" data-testid="send-verbal" onClick={() => giveByHand("verbal")}>
            {app.t("send.verbal")}
          </Button>
        </InlineAlert>
      </Show>

      <div class="app-order__body">
        <div class="app-order__menu">
          <label class="hy-field">
            <span class="hy-field__label">{app.t("order.search")}</span>
            <input
              ref={searchEl}
              class="hy-input"
              type="text"
              autocomplete="off"
              data-testid="code-input"
              value={search()}
              onInput={(e) => setSearch(e.currentTarget.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  e.stopPropagation();
                  submitCode();
                }
              }}
            />
          </label>
          <CategoryTabs
            label={app.t("order.categories")}
            categories={[{ id: "", label: app.t("order.quick") }, ...categories().map((c) => ({ id: c.id, label: c.name_en }))]}
            selected={category() ?? ""}
            onSelect={(id) => {
              setSearch("");
              setCategory(id || undefined);
            }}
          />
          <QuickItemGrid label={app.t("order.items")}>
            <For each={items()}>
              {(i) => (
                <ItemTile
                  name={i.name_en}
                  pricePaise={menuPrice(menu(), i.id)}
                  {...(i.code ? { code: i.code } : {})}
                  {...(VEG[i.veg_mark] ? { veg: VEG[i.veg_mark] as VegMark } : {})}
                  onAdd={() => tapItem(i)}
                />
              )}
            </For>
          </QuickItemGrid>
        </div>

        <OrderPanel
          label={app.t("order.panel")}
          lines={panelLines()}
          totalPaise={sum()?.total ?? lines().reduce((s, l) => s + lineTotalPaise(l), 0)}
          empty={<Empty text={app.t("order.empty")} testid="order-empty" />}
          onQtyChange={(id, q) => void app.run(() => setLineQty(app.rt.ctx, id, q * 1000))}
          onRemove={(id) => void app.run(() => removeDraft(app.rt.ctx, id))}
          actions={
            <>
              <Show when={draftCount(lines()) > 0}>
                <Button data-testid="send" onClick={sendNow}>
                  {app.t("order.send", { n: draftCount(lines()) })}
                </Button>
              </Show>
              <Show when={!counter() && lines().length > 0 && app.can("bill.request") && !app.can("bill.finalize")}>
                <Button
                  variant="secondary"
                  data-testid="bill-please"
                  onClick={() => {
                    const id = checkId();
                    if (id) void app.run(() => billPlease(app.rt.ctx, id));
                  }}
                >
                  {app.t("order.billplease")}
                </Button>
              </Show>
              <Show when={lines().length > 0 && app.can("bill.present")}>
                <Button variant="secondary" data-testid="present" onClick={doPresent}>
                  {printMode() ? app.t("order.printbill") : app.t("order.present")}
                </Button>
              </Show>
              <Show when={lines().length > 0 && app.can("bill.discount.apply")}>
                <Button variant="secondary" data-testid="discount" onClick={() => setDiscount(true)}>
                  {app.t("order.discount")}
                </Button>
              </Show>
              <Show when={lines().length > 0 && app.can("bill.finalize")}>
                <Button data-testid="pay" onClick={() => pay(false)}>
                  {app.t("order.pay")}
                </Button>
              </Show>
            </>
          }
        />
        <ul class="app-order__cancel" aria-label={app.t("order.sent.title")}>
          <For each={sentLines()}>
            {(l) => (
              <li>
                <Button variant="secondary" data-testid={`cancel-line-${l.id}`} onClick={() => setCancelLine(l.id)}>
                  {app.t("order.cancelitem", { item: l.name })}
                </Button>
              </li>
            )}
          </For>
        </ul>
      </div>

      <ItemSheet itemId={sheetItem()} onClose={() => setSheetItem(undefined)} onAdd={(sel) => void add(sel).then(() => setSheetItem(undefined))} />
      <CancelDialog lineId={cancelLine()} onClose={() => setCancelLine(undefined)} />
      <Show when={checkId()}>
        <DiscountSheet checkId={checkId() as string} open={discount()} onClose={() => setDiscount(false)} />
        <TableActions open={actions()} onClose={() => setActions(false)} checkId={checkId() as string} seatingId={check()?.seating_id} />
      </Show>
      <Dialog open={unsent()} title={app.t("pay.unsent.title")} onClose={() => setUnsent(false)} data-testid="unsent-dialog">
        <p>{app.t("pay.unsent.body", { n: draftCount(lines()) })}</p>
        <Button
          data-testid="unsent-send-pay"
          onClick={() => {
            const id = checkId();
            if (!id) return;
            void app.run(
              () => sendKot(app.rt.ctx, id),
              () => {
                setUnsent(false);
                app.go({ id: "tender", checkId: id });
              },
            );
          }}
        >
          {app.t("pay.unsent.send")}
        </Button>
      </Dialog>
      <Dialog open={help()} title={app.t("keys.title")} onClose={() => setHelp(false)} data-testid="shortcuts-dialog">
        <ul>
          <For each={SHORTCUT_SHEET}>
            {(s) => (
              <li>
                <kbd>{s.keys}</kbd> {app.t(`keys.${s.action}`)}
              </li>
            )}
          </For>
        </ul>
      </Dialog>
    </section>
  );
}

function menuPrice(m: Menu, itemId: string): number {
  try {
    const v = m.defaultVariant(itemId);
    return m.unitPrice(itemId, v?.id);
  } catch {
    return 0;
  }
}
