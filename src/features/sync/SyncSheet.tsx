import { Show } from "solid-js";
import type { JSX } from "@solidjs/web";
import { Button, CheckRow, formatIst, StatTile } from "@hostry/ui-kit";
import type { OpRow } from "../../domain/rows";
import { useApp } from "../app-state";
import { BackButton } from "../common";

/**
 * RS23: sync status. Hub, cloud, last sync, oldest pending, failed prints. The two switches below drive the sync simulator
 * (browser and test builds); the native shell replaces the simulator with the real runner and this block disappears.
 */
export function SyncSheet(): JSX.Element {
  const app = useApp();
  const s = () => app.sync();
  const oldest = () => app.snap().list<OpRow>("_op").filter((o) => o.delivery === "local").sort((a, b) => a.at.localeCompare(b.at))[0];
  const sim = app.rt.sync;
  const hub = () => (s(), sim.hubUp);
  const cloud = () => (s(), sim.cloudUp);
  return (
    <section data-testid="sync-screen">
      <BackButton />
      <h1>{app.t("sync.title")}</h1>
      <StatTile label={app.t("sync.state")} value={app.t(`sync.state.${s().state}`)} data-testid="sync-state" />
      <StatTile label={app.t("sync.pending")} value={String(s().pendingOps)} data-testid="sync-pending" />
      <StatTile label={app.t("sync.athub")} value={String(s().atHubOps)} data-testid="sync-athub" />
      <StatTile label={app.t("sync.upstream")} value={app.t(`sync.upstream.${s().upstream}`)} data-testid="sync-upstream" />
      <StatTile label={app.t("sync.last")} value={s().lastSyncAt ? formatIst(s().lastSyncAt as string) : app.t("sync.never")} data-testid="sync-last" />
      <Show when={oldest()}>
        <p data-testid="sync-oldest">{app.t("sync.oldest", { time: formatIst(oldest()?.at ?? "") })}</p>
      </Show>
      <p data-testid="sync-failed-prints">{app.t("sync.failedprints", { n: app.jobs().filter((j) => j.lastError).length })}</p>
      <h2>{app.t("sync.sim")}</h2>
      <CheckRow label={app.t("sync.sim.hub")} checked={hub()} data-testid="sim-hub" onChange={(on) => void sim.setLinks({ hub: on })} />
      <CheckRow label={app.t("sync.sim.cloud")} checked={cloud()} data-testid="sim-cloud" onChange={(on) => void sim.setLinks({ cloud: on })} />
      <Button variant="secondary" data-testid="sync-now" onClick={() => void sim.syncNow()}>
        {app.t("sync.now")}
      </Button>
    </section>
  );
}
