import type { Kot, KotHandover, KotLine, OrderLine, OrderLineCancel } from "./rows";

export type KdsTicketView = {
  kot: Kot;
  lines: KotLine[];
  minutes: number;
  /** Every line ready or served. */
  done: boolean;
  /** Printed or given by hand elsewhere: the KDS shows it as "Already given" (A1.6). */
  alreadyGiven: boolean;
  /** Cancel and move tickets keep a red banner until acknowledged. */
  alert: "cancelled" | "moved" | undefined;
  recall: boolean;
};

export const minutesSince = (iso: string, nowMs: number): number => Math.max(0, Math.floor((nowMs - Date.parse(iso)) / 60_000));

/**
 * Tickets of one station, oldest first (RS22). Filtering is a local read of the synced rows: a KDS tablet needs no server
 * query (AC 75 to 79). `stationCodes` empty means all stations. Done tickets move to the done strip, newest first.
 */
export function kdsTickets(i: { kots: readonly Kot[]; lines: readonly KotLine[]; cancels?: readonly OrderLineCancel[]; orderLines?: readonly OrderLine[]; handovers: readonly KotHandover[]; acked: ReadonlySet<string>; stationCodes: readonly string[]; nowMs: number }): { active: KdsTicketView[]; done: KdsTicketView[] } {
  const views = i.kots
    .filter((k) => i.stationCodes.length === 0 || i.stationCodes.includes(k.station_code))
    .map<KdsTicketView>((kot) => {
      // A recall ticket is a row of its own that shows the items of the ticket it recalls; a person bumping it acknowledges it.
      const isRecall = kot.kind === "recall" && kot.recall_of_kot_id !== undefined;
      // A cancel ticket has no kot_line rows either: its items are the cancels that name it.
      const lines: KotLine[] =
        kot.kind === "cancel"
          ? (i.cancels ?? [])
              .filter((c) => c.kot_id === kot.id)
              .map((c) => ({ id: c.id, tenant_id: c.tenant_id, kot_id: kot.id, order_line_id: c.order_line_id, name: (i.orderLines ?? []).find((o) => o.id === c.order_line_id)?.kitchen_name ?? "", qty_milli: c.qty_milli, status: "new" as const }))
          : i.lines.filter((l) => l.kot_id === (isRecall ? kot.recall_of_kot_id : kot.id)).sort((a, b) => a.id.localeCompare(b.id));
      return {
        kot,
        lines,
        minutes: minutesSince(kot.created_at, i.nowMs),
        done: isRecall ? i.acked.has(kot.id) : lines.length > 0 && lines.every((l) => l.status === "ready" || l.status === "served"),
        alreadyGiven: i.handovers.some((h) => h.kot_id === kot.id),
        alert: i.acked.has(kot.id) ? undefined : kot.kind === "cancel" ? "cancelled" : kot.kind === "moved" ? "moved" : undefined,
        recall: kot.kind === "recall",
      };
    });
  const byAge = (a: KdsTicketView, b: KdsTicketView) => a.kot.created_at.localeCompare(b.kot.created_at) || a.kot.id.localeCompare(b.kot.id);
  const active = views.filter((v) => !v.done || v.alert).sort(byAge);
  const done = views.filter((v) => v.done && !v.alert).sort((a, b) => byAge(b, a));
  return { active, done };
}

/** One tap moves an item one step: new, preparing, ready (served is the waiter's). */
export function nextKdsStatus(s: KotLine["status"]): KotLine["status"] {
  return s === "new" ? "preparing" : s === "preparing" ? "ready" : s;
}
