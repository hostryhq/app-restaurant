import { createEffect, createMemo, createSignal, For, Show } from "solid-js";
import type { JSX } from "@solidjs/web";
import { Button, Dialog, LineSelectList, ReasonChips } from "@hostry/ui-kit";
import type { Check, ReasonCode } from "../../domain/rows";
import { cancelCheck, freeTable, mergeBills, mergeTables, moveItems, moveTable, newBill, splitBill, type Selection } from "../../data/trading";
import { useApp } from "../app-state";
import { floor, linesOf } from "../selectors";

type Step = "menu" | "split" | "move" | "target" | "movetable" | "mergetables" | "mergebills" | "cancelbill";

/**
 * RS09 table actions, with RS10 (select lines) and RS11 (pick a bill or table). Each action appears only when the member holds
 * its permission. A merge of bills names the discount it drops before it happens (AC 59).
 */
export function TableActions(props: { open: boolean; onClose: () => void; checkId: string; seatingId: string | undefined }): JSX.Element {
  const app = useApp();
  const [step, setStep] = createSignal<Step>("menu");
  const [sel, setSel] = createSignal<Selection>({});
  const [reason, setReason] = createSignal<string | undefined>(undefined);
  const [pendingMerge, setPendingMerge] = createSignal<string | undefined>(undefined);

  createEffect(
    () => props.open,
    () => {
      setStep("menu");
      setSel({});
      setReason(undefined);
      setPendingMerge(undefined);
    },
  );

  const lines = createMemo(() => linesOf(app, props.checkId));
  const selectable = createMemo(() => lines().map((l) => ({ id: l.id, label: l.name, qty: l.qty_milli / 1000 })));
  const selMilli = (): Selection => Object.fromEntries(Object.entries(sel()).map(([id, q]) => [id, q * 1000]));
  const others = createMemo(() => floor(app).filter((v) => v.seating?.id !== props.seatingId));
  const thisTable = createMemo(() => floor(app).find((v) => v.seating?.id === props.seatingId));
  const otherBills = createMemo(() => (thisTable()?.checks ?? []).filter((c) => c.id !== props.checkId));
  const cancelReasons = createMemo(() => app.snap().list<ReasonCode>("reason_code").filter((r) => r.purpose === "cancel" && r.active).map((r) => ({ id: r.id, label: app.t(r.label_key) })));
  const done = (ok: boolean) => ok && props.onClose();
  const picked = () => Object.keys(sel()).length > 0;

  return (
    <Dialog open={props.open} title={app.t("actions.title")} onClose={props.onClose} data-testid="table-actions-dialog">
      <Show when={step() === "menu"}>
        <div class="app-actions">
          <Show when={app.can("bill.new") && props.seatingId}>
            <Button variant="secondary" data-testid="act-newbill" onClick={() => void app.run(() => newBill(app.rt.ctx, props.seatingId as string), () => props.onClose())}>
              {app.t("actions.newbill")}
            </Button>
          </Show>
          <Show when={app.can("bill.split") && lines().length > 0}>
            <Button variant="secondary" data-testid="act-split" onClick={() => setStep("split")}>
              {app.t("actions.split")}
            </Button>
          </Show>
          <Show when={app.can("order.items.move") && lines().length > 0}>
            <Button variant="secondary" data-testid="act-move" onClick={() => setStep("move")}>
              {app.t("actions.move")}
            </Button>
          </Show>
          <Show when={app.can("order.table.move") && props.seatingId}>
            <Button variant="secondary" data-testid="act-movetable" onClick={() => setStep("movetable")}>
              {app.t("actions.movetable")}
            </Button>
          </Show>
          <Show when={app.can("order.table.merge") && props.seatingId}>
            <Button variant="secondary" data-testid="act-mergetables" onClick={() => setStep("mergetables")}>
              {app.t("actions.mergetables")}
            </Button>
          </Show>
          <Show when={app.can("bill.merge") && otherBills().length > 0}>
            <Button variant="secondary" data-testid="act-mergebills" onClick={() => setStep("mergebills")}>
              {app.t("actions.mergebills")}
            </Button>
          </Show>
          <Show when={app.can("order.edit") && props.seatingId && lines().length === 0}>
            <Button variant="secondary" data-testid="act-free" onClick={() => void app.run(() => freeTable(app.rt.ctx, props.seatingId as string), () => props.onClose())}>
              {app.t("actions.free")}
            </Button>
          </Show>
          <Show when={app.can("order.edit")}>
            <Button variant="danger" data-testid="act-cancelbill" onClick={() => setStep("cancelbill")}>
              {app.t("actions.cancelbill")}
            </Button>
          </Show>
        </div>
      </Show>

      <Show when={step() === "split" || step() === "move"}>
        <LineSelectList label={app.t("select.title")} lines={selectable()} selection={sel()} onChange={setSel} />
        <Show when={step() === "split"}>
          <Button
            data-testid="split-confirm"
            disabled={!picked()}
            onClick={() =>
              void app.run(
                () => splitBill(app.rt.ctx, props.checkId, selMilli()),
                () => props.onClose(),
              )
            }
          >
            {app.t("select.newbill")}
          </Button>
        </Show>
        <Show when={step() === "move"}>
          <Button data-testid="move-next" disabled={!picked()} onClick={() => setStep("target")}>
            {app.t("select.next")}
          </Button>
        </Show>
      </Show>

      <Show when={step() === "target"}>
        <p>{app.t("picker.title")}</p>
        <For each={otherBills()}>
          {(c) => (
            <Button variant="secondary" data-testid={`target-bill-${c.id}`} onClick={() => void app.run(() => moveItems(app.rt.ctx, selMilli(), { checkId: c.id }), () => props.onClose())}>
              {c.label ?? app.t("order.bill", { n: 1 })}
            </Button>
          )}
        </For>
        <For each={others()}>
          {(v) => (
            <Button
              variant="secondary"
              data-testid={`target-table-${v.table.name}`}
              onClick={() =>
                void app.run(
                  () => (v.checks[0] ? moveItems(app.rt.ctx, selMilli(), { checkId: v.checks[0].id }) : moveItems(app.rt.ctx, selMilli(), { tableId: v.table.id })),
                  () => props.onClose(),
                )
              }
            >
              {v.table.name}
            </Button>
          )}
        </For>
      </Show>

      <Show when={step() === "movetable"}>
        <p>{app.t("picker.free")}</p>
        <For each={others().filter((v) => v.state === "free")}>
          {(v) => (
            <Button variant="secondary" data-testid={`move-to-${v.table.name}`} onClick={() => void app.run(() => moveTable(app.rt.ctx, props.seatingId as string, v.table.id), () => props.onClose())}>
              {v.table.name}
            </Button>
          )}
        </For>
      </Show>

      <Show when={step() === "mergetables"}>
        <p>{app.t("picker.occupied")}</p>
        <For each={others().filter((v) => v.state !== "free" && v.seating)}>
          {(v) => (
            <Button variant="secondary" data-testid={`merge-with-${v.table.name}`} onClick={() => void app.run(() => mergeTables(app.rt.ctx, props.seatingId as string, (v.seating as { id: string }).id), () => props.onClose())}>
              {v.table.name}
            </Button>
          )}
        </For>
      </Show>

      <Show when={step() === "mergebills"}>
        <For each={otherBills()}>
          {(c) => (
            <Button variant="secondary" data-testid={`merge-bill-${c.id}`} onClick={() => setPendingMerge(c.id)}>
              {c.label ?? c.id}
            </Button>
          )}
        </For>
        <Show when={pendingMerge()}>
          <p data-testid="merge-warning">
            {app.snap().get<Check>("check", pendingMerge())?.discount_kind ? app.t("mergebills.drops") : app.t("mergebills.confirm")}
          </p>
          <Button
            data-testid="merge-confirm"
            onClick={() => void app.run(() => mergeBills(app.rt.ctx, props.checkId, pendingMerge() as string), () => props.onClose())}
          >
            {app.t("mergebills.do")}
          </Button>
        </Show>
      </Show>

      <Show when={step() === "cancelbill"}>
        <ReasonChips label={app.t("cancel.reason")} reasons={cancelReasons()} selected={reason()} onSelect={setReason} />
        <Button
          variant="danger"
          data-testid="cancelbill-confirm"
          disabled={!reason()}
          onClick={async () => {
            const proof = await app.askProof({ permission: "bill.cancel", title: app.t("actions.cancelbill") });
            if (!proof.ok) return;
            done(await app.run(() => cancelCheck(app.rt.ctx, props.checkId, reason() as string, proof.approvalId)));
          }}
        >
          {app.t("actions.cancelbill")}
        </Button>
      </Show>
    </Dialog>
  );
}
