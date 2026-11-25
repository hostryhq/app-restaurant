import type { LocalStore, Row } from "@hostry/client-core";
import type { OpWriter, RecordedOp, RecordSpec } from "./ports";

/** Entities the screens read. Loaded into one snapshot after every commit; the UI reads the snapshot, never the network. */
export const ENTITIES = [
  "floor",
  "dining_table",
  "category",
  "item",
  "item_variant",
  "modifier_group",
  "modifier",
  "item_modifier_group",
  "price_entry",
  "item_outlet",
  "station",
  "seating",
  "check",
  "order",
  "order_line",
  "order_line_cancel",
  "order_line_modifier",
  "kot",
  "kot_line",
  "kot_handover",
  "kot_print",
  "bill_request",
  "check_present",
  "check_cancel",
  "seating_move",
  "seating_merge",
  "bill",
  "bill_line",
  "bill_tax_line",
  "payment",
  "refund",
  "credit_note",
  "credit_note_line",
  "credit_note_tax_line",
  "shift",
  "shift_close",
  "business_day",
  "day_open",
  "day_close",
  "business_day_revision",
  "cash_event",
  "reason_code",
  "tender_kind",
  "billing_settings",
  "outlet_settings",
  "outlet_tax_profile",
  "receipt_profile",
  "tax_rule_set",
  "tax_rule",
  "_op",
  "_local",
] as const;

export class Snapshot {
  constructor(private readonly tables: Readonly<Record<string, Row[]>> = {}) {}
  list<T = Row>(entity: string): T[] {
    return (this.tables[entity] ?? []) as T[];
  }
  get<T = Row>(entity: string, id: string | undefined): T | undefined {
    return id === undefined ? undefined : ((this.list<Row>(entity).find((r) => r.id === id) as unknown) as T | undefined);
  }
}

/** Where the snapshot's rows come from: the sync engine's visible rows, its op log, and the device-local table. */
export type RowSource = (entity: string) => Promise<Row[]>;

/**
 * The app's view of the local store. Writes go through `write` (an intent with mutations, committed locally first) and
 * the snapshot is reloaded before `write` resolves, so a screen always reads what was just written. Nothing here waits on
 * the network. Rows changed by a sync round (another device's ops) arrive through `refresh`, which the runtime calls when
 * the engine reports a change.
 */
export class AppData {
  private snap = new Snapshot();
  private listeners = new Set<() => void>();
  private chain: Promise<void> = Promise.resolve();
  private queued: Promise<void> | undefined;

  constructor(
    readonly store: LocalStore,
    readonly writer: OpWriter,
    private readonly source: RowSource,
  ) {}

  snapshot(): Snapshot {
    return this.snap;
  }

  subscribe(l: () => void): () => void {
    this.listeners.add(l);
    return () => void this.listeners.delete(l);
  }

  /**
   * Reload the snapshot from the store. Calls are serialised so the last one wins, and a call made while another is
   * waiting to start joins it (a write and the engine's change notice both ask for one reload).
   */
  refresh(): Promise<void> {
    if (this.queued) return this.queued;
    const run = this.chain.then(async () => {
      this.queued = undefined;
      const tables: Record<string, Row[]> = {};
      for (const e of ENTITIES) tables[e] = await this.source(e);
      this.snap = new Snapshot(tables);
      for (const l of this.listeners) l();
    });
    this.queued = run;
    this.chain = run.catch(() => undefined);
    return run;
  }

  async write(spec: RecordSpec): Promise<RecordedOp> {
    const op = await this.writer.record(spec);
    await this.refresh();
    return op;
  }

  /** Local-only row (never synced): UI helpers such as KDS acknowledgements and reprint counters. */
  async putLocal(id: string, fields: Record<string, unknown>): Promise<void> {
    await this.store.transact((tx) => tx.put("_local", { ...fields, id, tenant_id: this.store.tenantId }));
    await this.refresh();
  }
}
