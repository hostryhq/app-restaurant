import { createMemo, createSignal, For } from "solid-js";
import type { JSX } from "@solidjs/web";
import { itemOutletId } from "@hostry/client-core";
import { CheckRow, Input } from "@hostry/ui-kit";
import type { Item } from "../../domain/rows";
import { setAvailability } from "../../data/trading";
import { useApp } from "../app-state";
import { BackButton } from "../common";

/** RS29: mark an item sold out or available (menu.availability.set). Search first, then one tap per item. Prices change online. */
export function MenuManage(): JSX.Element {
  const app = useApp();
  const [q, setQ] = createSignal("");
  const items = createMemo(() => {
    const snap = app.snap();
    const text = q().trim().toLowerCase();
    return snap
      .list<Item>("item")
      .filter((i) => !text || i.name_en.toLowerCase().includes(text) || (i.code ?? "") === text)
      .sort((a, b) => a.sort_order - b.sort_order)
      .map((i) => ({ item: i, available: snap.get<{ available?: boolean }>("item_outlet", itemOutletId(app.rt.pack.outletId, i.id))?.available !== false }));
  });
  return (
    <section data-testid="menu-screen">
      <BackButton />
      <h1>{app.t("menu.title")}</h1>
      <Input label={app.t("order.search")} value={q()} data-testid="menu-search" onInput={(e) => setQ(e.currentTarget.value)} />
      <ul class="app-list">
        <For each={items()}>
          {(r) => (
            <li>
              <CheckRow
                label={r.item.name_en}
                hint={r.available ? "" : app.t("order.soldout")}
                checked={!r.available}
                disabled={!app.can("menu.availability.set")}
                data-testid={`soldout-${r.item.id}`}
                onChange={(soldOut) => void app.run(() => setAvailability(app.rt.ctx, r.item.id, !soldOut))}
              />
            </li>
          )}
        </For>
      </ul>
    </section>
  );
}
