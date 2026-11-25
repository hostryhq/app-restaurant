import { createMemo, createSignal, For, Show } from "solid-js";
import type { JSX } from "@solidjs/web";
import { BillRequestList, Button, FloorGrid, SegmentedControl, TableTile } from "@hostry/ui-kit";
import type { BillRequest, Check, DiningTable } from "../../domain/rows";
import { useApp } from "../app-state";
import { Empty } from "../common";
import { floor, liveChecks, minutesAgo, tableOfSeating, totals } from "../selectors";

/** RS03: the floor grid (Tables mode). Tile state is derived, never stored, and shown as icon + text + colour. */
export function Floor(): JSX.Element {
  const app = useApp();
  const [filter, setFilter] = createSignal<"all" | "mine">("all");
  const tiles = createMemo(() => {
    const me = app.session()?.memberId;
    return floor(app).filter((v) => filter() === "all" || v.checks.some((c) => c.waiter_id === me));
  });
  const requests = createMemo(() => {
    const snap = app.snap();
    const open = new Set(liveChecks(app).filter((c) => c.status === "open").map((c) => c.id));
    const presented = new Set(snap.list("check_present").map((p) => p.check_id as string));
    return snap
      .list<BillRequest>("bill_request")
      .filter((r) => open.has(r.check_id) && !presented.has(r.check_id))
      .map((r) => {
        const c = snap.get<Check>("check", r.check_id);
        const t = tableOfSeating(app, c?.seating_id);
        return { id: r.check_id, table: t?.name ?? `#${c?.token_no ?? ""}`, ageText: app.t("floor.min", { n: minutesAgo(app, r.requested_at) }) };
      });
  });

  return (
    <section data-testid="floor-screen">
      <h1>{app.t("floor.title")}</h1>
      <SegmentedControl
        label={app.t("floor.filter")}
        options={[
          { id: "all", label: app.t("floor.filter.all"), "data-testid": "filter-all" },
          { id: "mine", label: app.t("floor.filter.mine"), "data-testid": "filter-mine" },
        ]}
        selected={filter()}
        onSelect={(id) => setFilter(id as "all" | "mine")}
      />
      <Show when={app.can("bill.finalize") && requests().length > 0}>
        <BillRequestList
          label={app.t("floor.requests")}
          requests={requests()}
          onOpen={(checkId) => {
            const c = app.snap().get<Check>("check", checkId);
            const t = tableOfSeating(app, c?.seating_id);
            if (t) app.go({ id: "order", tableId: t.id, checkId });
          }}
        />
      </Show>
      <Show when={tiles().length > 0} fallback={<Empty text={app.t("floor.empty")} testid="floor-empty" />}>
        <FloorGrid label={app.t("floor.title")} data-testid="floor-grid">
          <For each={tiles()}>
            {(v) => (
              <TableTile
                name={v.table.name}
                state={v.state}
                meta={v.billRequested ? app.t("floor.billrequested") : v.state === "free" ? app.t("floor.state.free") : `${app.t(`floor.state.${v.state}`)} - ${app.t("floor.min", { n: v.minutes })}`}
                {...(v.checks.length ? { totalPaise: v.checks.reduce((s, c) => s + (totals(app, c.id)?.total ?? 0), 0) } : {})}
                data-testid={`table-${v.table.name}`}
                onSelect={() => app.go({ id: "order", tableId: (v.table as DiningTable).id })}
              />
            )}
          </For>
        </FloorGrid>
      </Show>
      <Show when={app.can("order.create")}>
        <Button variant="secondary" data-testid="open-held" onClick={() => app.go({ id: "held" })}>
          {app.t("held.title")}
        </Button>
      </Show>
    </section>
  );
}
