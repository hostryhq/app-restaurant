import { createMemo, For } from "solid-js";
import type { JSX } from "@solidjs/web";
import { ChecklistPanel, formatBasisPoints, formatMoney, LockedRow, SettingsList, type ChecklistItem } from "@hostry/ui-kit";
import { settingsFrom } from "../../data/context";
import { useApp } from "../app-state";
import { BackButton } from "../common";

/**
 * RS27: settings, read only on this device. `strong_only` items (discount limit, numbering mode, tax profile) open only on the
 * owner's device online and are shown locked with the reason in a PIN session (RM-A5, AC 176). RS30 items need the internet.
 */
export function Settings(): JSX.Element {
  const app = useApp();
  const s = createMemo(() => settingsFrom((e) => app.snap().list(e)));
  const locked: Array<[string, string]> = [
    ["discount_limit", formatBasisPoints(s().discount_limit_bp)],
    ["number_at", app.t(`settings.number_at.${s().number_at}`)],
    ["round_off", s().round_off ? app.t("common.on") : app.t("common.off")],
    ["service_charge", formatBasisPoints(s().service_charge_bp)],
    ["packing", formatMoney(s().packing_charge_paise)],
  ];
  return (
    <section data-testid="settings-screen">
      <BackButton />
      <h1>{app.t("settings.title")}</h1>
      <SettingsList label={app.t("settings.title")}>
        <For each={locked}>{([id, value]) => <LockedRow id={id} label={app.t(`settings.${id}`)} value={value} reason={app.t("settings.locked.reason")} />}</For>
        <LockedRow id="plan" label={app.t("settings.plan")} value="-" reason={app.t("settings.online.reason")} />
        <LockedRow id="access" label={app.t("settings.access")} value="-" reason={app.t("settings.online.reason")} />
      </SettingsList>
    </section>
  );
}

/** RS28: ready-to-trade check, computed from what this device holds. Setup itself is online (members, printers, menu loading). */
export function Setup(): JSX.Element {
  const app = useApp();
  const items = createMemo<ChecklistItem[]>(() => {
    const snap = app.snap();
    const check = (id: string, ok: boolean, warn = false): ChecklistItem => ({ id, label: app.t(`setup.${id}`), status: ok ? "done" : warn ? "warning" : "blocking" });
    return [
      check("menu", snap.list("item").length > 0),
      check("tables", snap.list("dining_table").length > 0, true),
      check("rules", snap.list("tax_rule_set").length > 0),
      check("stations", snap.list("station").length > 0),
      check("printer", app.rt.fakes.hub.has("prn-bill")),
      check("business_day", snap.list("business_day").some((d) => d.status === "open")),
    ];
  });
  return (
    <section data-testid="setup-screen">
      <BackButton />
      <h1>{app.t("setup.title")}</h1>
      <ChecklistPanel label={app.t("setup.title")} items={items()} />
    </section>
  );
}
