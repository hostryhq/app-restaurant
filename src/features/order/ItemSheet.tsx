import { createEffect, createMemo, createSignal, For, Show } from "solid-js";
import type { JSX } from "@solidjs/web";
import type { LineSelection } from "@hostry/client-core";
import { Button, Dialog, formatMoney, Input, ModifierGroup, SegmentedControl, Stepper } from "@hostry/ui-kit";
import { menuFrom } from "../../data/context";
import { useApp } from "../app-state";

/** RS05: variant, modifiers and note. Add stays disabled until every group's minimum is met, with the reason shown. */
export function ItemSheet(props: { itemId: string | undefined; onClose: () => void; onAdd: (sel: LineSelection) => void }): JSX.Element {
  const app = useApp();
  const [variantId, setVariantId] = createSignal<string | undefined>(undefined);
  const [picked, setPicked] = createSignal<Record<string, string[]>>({});
  const [note, setNote] = createSignal("");
  const [qty, setQty] = createSignal(1);
  const menu = createMemo(() => menuFrom((e) => app.snap().list(e)));
  const variants = createMemo(() => (props.itemId ? menu().variantsOf(props.itemId) : []));
  const groups = createMemo(() => (props.itemId ? menu().modifierGroupsOf(props.itemId) : []));

  createEffect(
    () => props.itemId,
    (id) => {
      setVariantId(id ? menu().defaultVariant(id)?.id : undefined);
      setPicked({});
      setNote("");
      setQty(1);
    },
  );

  const chosenIds = () => Object.values(picked()).flat();
  const delta = createMemo(() => groups().flatMap((g) => g.options).filter((o) => chosenIds().includes(o.id)).reduce((s, o) => s + o.price_delta_paise, 0));
  const unit = createMemo(() => {
    try {
      return props.itemId ? menu().unitPrice(props.itemId, variantId()) : 0;
    } catch {
      return 0;
    }
  });
  const missing = createMemo(() => groups().find((g) => (picked()[g.group.id]?.length ?? 0) < g.group.min_select));
  const total = () => (unit() + delta()) * qty();

  return (
    <Dialog open={props.itemId !== undefined} title={props.itemId ? menu().item(props.itemId).name_en : ""} onClose={props.onClose} data-testid="item-sheet">
      <Show when={variants().length > 0}>
        <SegmentedControl
          label={app.t("item.variant")}
          options={variants().map((v) => ({ id: v.id, label: v.name, "data-testid": `variant-${v.id}` }))}
          selected={variantId()}
          onSelect={setVariantId}
        />
      </Show>
      <For each={groups()}>
        {(g) => (
          <ModifierGroup
            name={g.group.name}
            min={g.group.min_select}
            max={g.group.max_select}
            options={g.options.map((o) => ({ id: o.id, label: o.name, ...(o.price_delta_paise ? { pricePaise: o.price_delta_paise } : {}) }))}
            selected={picked()[g.group.id] ?? []}
            onChange={(sel) => setPicked({ ...picked(), [g.group.id]: sel })}
            data-testid={`modifier-group-${g.group.id}`}
          />
        )}
      </For>
      <Input label={app.t("item.note")} maxlength={100} value={note()} data-testid="item-note" onInput={(e) => setNote(e.currentTarget.value)} />
      <Stepper label={app.t("item.qty")} value={qty()} min={1} max={99} onChange={setQty} data-testid="item-qty" />
      <Show when={missing()}>
        <p role="alert" data-testid="item-required">
          {app.t("item.required", { group: missing()?.group.name ?? "" })}
        </p>
      </Show>
      <Button
        data-testid="item-add"
        disabled={missing() !== undefined}
        onClick={() =>
          props.itemId &&
          props.onAdd({ itemId: props.itemId, qtyMilli: qty() * 1000, ...(variantId() ? { variantId: variantId() as string } : {}), ...(chosenIds().length ? { modifierIds: chosenIds() } : {}), ...(note().trim() ? { note: note().trim() } : {}) })
        }
      >
        {app.t("item.add", { amount: formatMoney(total()) })}
      </Button>
    </Dialog>
  );
}
