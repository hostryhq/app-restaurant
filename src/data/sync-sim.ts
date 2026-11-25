import type { LocalWriter } from "./local-writer-type";
import type { SyncPort, SyncView } from "./ports";
import type { OpRow } from "../domain/rows";
import type { AppData } from "./app-data";

/**
 * Sync simulator for the browser build and tests: two switches (hub reachable, cloud reachable) decide how far a local
 * op travels. It stands in for client-core's SyncRunner (feat/phase1-sync), which exposes the same `SyncClient` surface;
 * the app only reads `SyncPort`, so the runner replaces this class without a screen changing. See docs/integration-notes.md.
 */
export class SyncSim implements SyncPort {
  hubUp = false;
  cloudUp = false;
  /** Device clock minus upstream time, ms (the "clock wrong" banner shows above 2 minutes). */
  clockSkewMs = 0;
  private lastSyncAt: string | undefined;
  private view: SyncView = SyncSim.view(0, 0, false, "none", false);
  private listeners = new Set<(s: SyncView) => void>();
  private running = false;
  private syncing = false;

  constructor(
    private readonly data: AppData,
    private readonly writer: LocalWriter,
    private readonly now: () => number = Date.now,
  ) {
    data.subscribe(() => {
      this.recount();
      // Like the runner: while an upstream is reachable, new local ops go up without being asked.
      if ((this.hubUp || this.cloudUp) && this.view.pendingOps + (this.cloudUp ? this.view.atHubOps : 0) > 0 && !this.syncing) {
        this.syncing = true;
        void this.syncNow().finally(() => {
          this.syncing = false;
        });
      }
    });
  }

  private static view(pending: number, atHub: number, online: boolean, upstream: SyncView["upstream"], clockWrong: boolean, lastSyncAt?: string): SyncView {
    const state: SyncView["state"] = !online ? "offline" : pending + atHub > 0 ? "pending" : "synced";
    return {
      online,
      pendingOps: pending,
      atHubOps: atHub,
      attentionOps: 0,
      upstream,
      state,
      clockWrong,
      ...(lastSyncAt ? { lastSyncAt } : {}),
    };
  }

  private recount(): void {
    const ops = this.data.snapshot().list<OpRow>("_op");
    const pending = ops.filter((o) => o.delivery === "local").length;
    const atHub = ops.filter((o) => o.delivery === "at_hub").length;
    const upstream: SyncView["upstream"] = this.cloudUp ? "cloud" : this.hubUp ? "hub" : "none";
    this.view = SyncSim.view(pending, atHub, upstream !== "none", upstream, Math.abs(this.clockSkewMs) > 120_000, this.lastSyncAt);
    for (const l of this.listeners) l(this.view);
  }

  /** Flip links; reconnecting syncs at once (the runner does the same on reconnect). */
  async setLinks(links: { hub?: boolean; cloud?: boolean }): Promise<void> {
    if (links.hub !== undefined) this.hubUp = links.hub;
    if (links.cloud !== undefined) this.cloudUp = links.cloud;
    await this.syncNow();
  }

  start(): void {
    this.running = true;
    void this.syncNow();
  }
  stop(): void {
    this.running = false;
  }

  status(): SyncView {
    return this.view;
  }

  onStatus(l: (s: SyncView) => void): () => void {
    this.listeners.add(l);
    return () => void this.listeners.delete(l);
  }

  /** One round: ops reach the hub if it is up, the cloud if it is. Never needed for the UI to work. */
  async syncNow(): Promise<void> {
    if (this.hubUp) await this.writer.deliver("at_hub");
    if (this.cloudUp) await this.writer.deliver("in_cloud");
    if (this.hubUp || this.cloudUp) this.lastSyncAt = new Date(this.now()).toISOString();
    await this.data.refresh();
    this.recount();
  }

  get isRunning(): boolean {
    return this.running;
  }
}
