import type { OpEnvelope, SyncEngine } from "@hostry/client-core";
import type { OpRow } from "../domain/rows";

/**
 * The op log as screens read it (`_op` in the snapshot): every op this device holds, its own and the ones it pulled.
 * Ops are immutable, so each is fetched once through the engine's public `opAt`; only delivery of the device's own ops
 * changes, and that is read fresh from `engine.delivery` on every call. A placeholder (an op the hub or cloud held back
 * from this device) has no body and is skipped until it arrives.
 */
export class OpLog {
  private readonly ops = new Map<string, OpEnvelope>();
  private readonly done = new Map<string, number>();
  private readonly inserted = new Map<string, { actor: string; at: string }>();

  constructor(
    private readonly engine: SyncEngine,
    private readonly tenantId: string,
  ) {}

  /**
   * Who created a row and when: the actor and time of the op that inserted it. The entity contracts carry no `waiter_id`,
   * `opened_by` or `opened_at`; the op already says it, on every device alike.
   */
  insertedBy(entity: string, id: string): { actor: string; at: string } | undefined {
    return this.inserted.get(`${entity}|${id}`);
  }

  async rows(): Promise<OpRow[]> {
    const stream = this.engine.outletStream;
    const vv = await this.engine.vector(stream);
    for (const [origin, high] of Object.entries(vv)) {
      let n = this.done.get(origin) ?? 0;
      while (n < high) {
        const op = await this.engine.opAt({ origin, stream, seq: n + 1 });
        if (!op) break; // placeholder: retry next time
        this.ops.set(`${origin}|${n + 1}`, op);
        for (const m of op.muts) if (m.k === "insert" && !this.inserted.has(`${m.e}|${m.id}`)) this.inserted.set(`${m.e}|${m.id}`, { actor: op.actor, at: op.at });
        n++;
      }
      this.done.set(origin, n);
    }
    const out: OpRow[] = [];
    for (const [id, op] of this.ops) {
      const own = op.origin === this.engine.deviceId;
      out.push({
        id,
        tenant_id: this.tenantId,
        seq: op.seq,
        intent: op.intent,
        at: op.at,
        actor: op.actor,
        origin: op.origin,
        own,
        // An op from another device reached this one through the hub or the cloud; which one is not known here.
        delivery: own ? this.engine.delivery(op.seq, stream) : "at_hub",
        muts: op.muts.map((m) => ({ e: m.e, id: m.id, k: m.k })),
        ...(op.approval ? { approval: op.approval } : {}),
        ...(op.doc ? { doc: op.doc } : {}),
      });
    }
    return out;
  }
}
