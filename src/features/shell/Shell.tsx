import { createMemo, For, Show } from "solid-js";
import type { JSX } from "@solidjs/web";
import { AppShell, Banner, Button, ModeBar, PrinterStatus, SyncStatus, ToastRegion, type ModeItem } from "@hostry/ui-kit";
import { dayCloseOverdue } from "../../domain/shift-day";
import { lateDays } from "../../data/trading";
import type { BusinessDay } from "../../domain/rows";
import { settingsFrom } from "../../data/context";
import { useApp, type Mode } from "../app-state";
import { ProofHost } from "../common";

type Notice = { id: string; kind: "info" | "warning" | "danger"; text: string; action?: { label: string; run: () => void } };

/** RS00: status chip, banners, mode switcher. Never a banner about subscription, payment or plan (AC 211). */
export function Shell(props: { children?: JSX.Element }): JSX.Element {
  const app = useApp();
  const business = createMemo(() => (app.snap().list("receipt_profile")[0]?.trade_name as string | undefined) ?? "");

  const notices = createMemo<Notice[]>(() => {
    const out: Notice[] = [];
    const failed = app.jobs().filter((j) => j.lastError).length;
    if (failed > 0 && app.sync().state === "offline") {
      out.push({ id: "blackout", kind: "warning", text: app.t("shell.blackout"), action: { label: app.t("shell.late.open", { n: app.late().length }), run: () => app.go({ id: "late" }) } });
    }
    if (app.sync().clockWrong) out.push({ id: "clock", kind: "warning", text: app.t("shell.clock.wrong") });
    const day = app.snap().list<BusinessDay>("business_day").filter((d) => d.status === "open").sort((a, b) => a.business_date.localeCompare(b.business_date))[0];
    if (app.can("day.close") && dayCloseOverdue(day?.business_date, app.nowMs(), settingsFrom((e) => app.snap().list(e)).day_cutoff_minutes)) {
      out.push({ id: "day", kind: "info", text: app.t("shell.day.close"), action: { label: app.t("shell.day.close.action"), run: () => app.go({ id: "dayclose" }) } });
    }
    const lateDocs = app.can("day.close") ? lateDays((e) => app.snap().list(e)).reduce((n, d) => n + d.billNumbers.length + d.noteNumbers.length, 0) : 0;
    if (lateDocs > 0) out.push({ id: "docs-late", kind: "info", text: app.t("shell.docs.late", { n: lateDocs }), action: { label: app.t("shell.docs.late.open"), run: () => app.go({ id: "dayclose" }) } });
    const packMs = Date.parse(app.rt.identity.packExpiresAt()) - app.nowMs();
    if (packMs < 48 * 3_600_000) out.push({ id: "pack", kind: "warning", text: app.t("shell.pack.expiring", { date: app.rt.identity.packExpiresAt().slice(0, 10) }) });
    if (app.late().length > 0 && !out.some((n) => n.id === "blackout")) {
      out.push({ id: "late", kind: "info", text: app.t("shell.late.some", { n: app.late().length }), action: { label: app.t("shell.late.open", { n: app.late().length }), run: () => app.go({ id: "late" }) } });
    }
    return out;
  });

  const modes = createMemo<ModeItem[]>(() => {
    const m: ModeItem[] = [];
    if (app.rt.deviceKind !== "kds" && app.can("order.create")) m.push({ id: "tables", label: app.t("mode.tables") });
    if (app.rt.deviceKind === "pos" && app.can("order.create")) m.push({ id: "counter", label: app.t("mode.counter") });
    if (app.can("kds.bump")) m.push({ id: "kitchen", label: app.t("mode.kitchen") });
    if (app.can("report.view") || app.can("*")) m.push({ id: "owner", label: app.t("mode.owner") });
    return m;
  });

  const failedJobs = createMemo(() => app.jobs().filter((j) => j.lastError).length);
  const member = createMemo(() => {
    const s = app.session();
    return s ? app.nameOf(s.memberId) : "";
  });

  return (
    <AppShell
      header={
        <div class="app-header" data-testid="app-header">
          <span class="app-header__biz" data-testid="business-name">
            {business()}
          </span>
          <span class="app-header__member" data-testid="member-name">
            {member()}
          </span>
          <button type="button" class="app-chip" data-testid="sync-chip" aria-label={app.t("sync.open")} onClick={() => app.go({ id: "sync" })}>
            <SyncStatus state={app.sync().state} pendingCount={app.sync().pendingOps + app.sync().atHubOps} data-testid="sync-status" />
          </button>
          <Show when={app.rt.deviceKind !== "kds"}>
            <Button variant="secondary" data-testid="lock" onClick={() => app.lock()}>
              {app.t("shell.lock")}
            </Button>
          </Show>
        </div>
      }
      banners={
        <div data-testid="banners">
          <Show when={failedJobs() > 0}>
            <PrinterStatus failedCount={failedJobs()} onRetry={() => app.go({ id: "print" })} data-testid="printer-status" />
          </Show>
          <For each={notices().slice(0, 2)}>
            {(n) => (
              <Banner
                kind={n.kind}
                data-testid={`notice-${n.id}`}
                actions={
                  n.action ? (
                    <Button variant="secondary" data-testid={`notice-${n.id}-action`} onClick={() => n.action?.run()}>
                      {n.action.label}
                    </Button>
                  ) : undefined
                }
              >
                {n.text}
              </Banner>
            )}
          </For>
          <Show when={notices().length > 2}>
            <p data-testid="notice-more">{app.t("shell.notices.more", { n: notices().length - 2 })}</p>
          </Show>
        </div>
      }
    >
      {props.children}
      <Show when={modes().length > 1}>
        <nav class="app-modebar">
          <ModeBar label={app.t("mode.label")} modes={modes()} selected={app.mode()} onSelect={(id) => app.setMode(id as Mode)} data-testid="mode-bar" />
        </nav>
      </Show>
      <ProofHost />
      <ToastRegion />
    </AppShell>
  );
}
