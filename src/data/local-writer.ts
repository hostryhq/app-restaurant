import { financialYearOfDate, istDateOf, type LocalStore, type Mutation, type Row, type StoreTx } from "@hostry/client-core";
import type { BuildCtx, Delivery, OpWriter, RecordedOp, RecordSpec, SeriesDocType } from "./ports";

/**
 * Forward-only fields (rank policy). A `set` or `rank` that would move one of these backwards is ignored, the same
 * rule the sync engine applies, so replaying or reordering ops never reopens a billed check.
 */
export const RANKS: Record<string, Record<string, readonly string[]>> = {
  seating: { status: ["open", "billed", "closed"] },
  check: { status: ["open", "closed_internal", "billed"] },
  order_line: { state: ["draft", "sent"] },
  kot_line: { status: ["new", "preparing", "ready", "served"] },
  shift: { status: ["open", "closed"] },
  business_day: { status: ["open", "closed"] },
};

export type Series = Partial<Record<SeriesDocType, string>>;

export type LocalWriterOptions = {
  store: LocalStore;
  deviceId: string;
  /** Member id stamped on every op. */
  actor: () => string;
  now: () => number;
  newId: () => string;
  /** Active series code per document type on this device (from the offline pack). */
  series: Series;
};

function applyMutation(tx: StoreTx, tenantId: string, m: Mutation): void {
  const existing = tx.get(m.e, m.id);
  const f = m.f ?? {};
  switch (m.k) {
    case "insert": {
      if (existing) return; // replay of an insert is a no-op (append, idempotent)
      tx.put(m.e, { ...f, id: m.id, tenant_id: tenantId });
      return;
    }
    case "set":
    case "rank": {
      const row: Row = existing ? { ...existing } : { id: m.id, tenant_id: tenantId };
      for (const [k, v] of Object.entries(f)) {
        const order = RANKS[m.e]?.[k];
        if (order && row[k] !== undefined) {
          if (order.indexOf(v as string) <= order.indexOf(row[k] as string)) continue; // never backwards
        }
        row[k] = v;
      }
      tx.put(m.e, row);
      return;
    }
    case "delta": {
      const row: Row = existing ? { ...existing } : { id: m.id, tenant_id: tenantId };
      for (const [k, v] of Object.entries(f)) {
        if (typeof v === "number" && Number.isInteger(v)) row[k] = ((row[k] as number | undefined) ?? 0) + v;
      }
      tx.put(m.e, row);
      return;
    }
    case "del":
      tx.del(m.e, m.id);
      return;
    case "undel":
      if (existing) tx.put(m.e, { ...existing, deleted: false });
      return;
  }
}

/**
 * Stand-in for the sync engine's `record`: the same contract (one transaction allocates the number, applies the
 * mutations, appends the op), so the app runs in a browser and in tests with no network. The real engine in
 * client-core (feat/phase1-sync) replaces it behind `OpWriter`; see docs/integration-notes.md.
 *
 * Differences from the engine, all noted there: it allows several legal numbers in one op (bill.rebill needs a
 * credit note and replacement bills), and `check` / `order_line` mix last-writer-wins and forward-only fields.
 */
export class LocalOpWriter implements OpWriter {
  private listeners = new Set<() => void>();

  constructor(private readonly o: LocalWriterOptions) {}

  onCommit(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => void this.listeners.delete(listener);
  }

  async record(spec: RecordSpec): Promise<RecordedOp> {
    const { store } = this.o;
    const recorded = await store.transact((tx) => {
      const head = tx.get("_meta", "head");
      const seq = ((head?.seq as number | undefined) ?? 0) + 1;
      const nowMs = this.o.now();
      const docs: Array<{ type: string; number: string }> = [];
      const ctx: BuildCtx = {
        now: nowMs,
        number: (docType) => {
          const code = this.o.series[docType];
          if (!code) throw new Error(`no active ${docType} series on this device`);
          const fy = financialYearOfDate(istDateOf(nowMs));
          const id = `${code}|${docType}|${fy}`;
          const next = ((tx.get("_series", id)?.next as number | undefined) ?? 0) + 1;
          if (next > 999_999) throw new Error(`series ${code} exhausted`);
          tx.put("_series", { id, tenant_id: store.tenantId, next });
          const number = `${code}/${fy}/${String(next).padStart(6, "0")}`;
          docs.push({ type: docType, number });
          return number;
        },
        get: (e, id) => tx.get(e, id),
        list: (e) => tx.list(e),
        newId: this.o.newId,
      };
      const muts = spec.build(ctx);
      for (const m of muts) applyMutation(tx, store.tenantId, m);
      const at = new Date(nowMs).toISOString();
      tx.put("_op", {
        id: `op-${String(seq).padStart(9, "0")}`,
        tenant_id: store.tenantId,
        seq,
        intent: spec.intent,
        at,
        actor: this.o.actor(),
        delivery: "local",
        muts: muts.map((m) => ({ e: m.e, id: m.id, k: m.k })),
        ...(spec.approval ? { approval: spec.approval } : {}),
        ...(docs.length ? { doc: docs[0] } : {}),
      });
      tx.put("_meta", { id: "head", tenant_id: store.tenantId, seq });
      return { seq, intent: spec.intent, at, ...(docs[0] ? { doc: docs[0] } : {}) } satisfies RecordedOp;
    });
    for (const l of this.listeners) l();
    return recorded;
  }

  /** Mark every op up to `upTo` (all when omitted) as having reached `level`. Used by the sync simulator. */
  async deliver(level: Exclude<Delivery, "local">, upTo?: number): Promise<number> {
    const rank: Record<Delivery, number> = { local: 0, at_hub: 1, in_cloud: 2 };
    let moved = 0;
    await this.o.store.transact((tx) => {
      for (const r of tx.list("_op")) {
        if (upTo !== undefined && (r.seq as number) > upTo) continue;
        if (rank[r.delivery as Delivery] < rank[level]) {
          tx.put("_op", { ...r, delivery: level });
          moved++;
        }
      }
    });
    if (moved) for (const l of this.listeners) l();
    return moved;
  }
}
