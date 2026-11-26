import {
  FakeCashDrawer,
  FakeKitchenPrinter,
  FakeReceiptPrinter,
  GENERIC_80,
  PrintService,
  type CashDrawer,
  type LateTicket,
  type PrintDocument,
  type PrintOutcome,
  type PrinterProfile,
  type PrintTrigger,
} from "@hostry/client-core";
import { BILL_PRINTER, KITCHEN_PRINTER } from "../data/trading/bill-printer";

/**
 * The app's printing seam (devices-and-printing). Documents go to a printer's queue and the screen never waits on the
 * paper: a failed job stays visible (RS17) and a tap retries it. The queue, late-ticket rule (ADR-0014 A1.6) and
 * once-only job ids are client-core's `PrintService`; this class adds listeners and the drawer.
 */
export type QueueJob = { printerId: string; id: string; kind: string; status: "pending" | "failed"; attempts: number; lastError: string | undefined };

export interface PrintPort {
  has(printerId: string): boolean;
  print(printerId: string, doc: PrintDocument, o: { jobId: string; trigger?: PrintTrigger }): PrintOutcome;
  flush(): Promise<number>;
  jobs(): QueueJob[];
  retry(printerId: string, jobId: string): boolean;
  /** Drop a queued job a person chose not to print (a KOT given by hand never prints as an original). */
  remove(printerId: string, jobId: string): boolean;
  lateTickets(): readonly LateTicket[];
  printLate(id: string): boolean;
  dismissLate(id: string): boolean;
  openDrawer(): Promise<void>;
  subscribe(l: () => void): () => void;
}

export type PrinterSpec = { id: string; profile: PrinterProfile; send: (bytes: Uint8Array) => Promise<void> };

export class PrintHub implements PrintPort {
  private readonly svc: PrintService;
  private readonly ids: string[] = [];
  private readonly listeners = new Set<() => void>();

  constructor(
    printers: readonly PrinterSpec[],
    private readonly drawer: CashDrawer,
    opts: { now?: () => number; staleAfterMs?: number } = {},
  ) {
    this.svc = new PrintService({
      ...(opts.now ? { now: opts.now } : {}),
      ...(opts.staleAfterMs !== undefined ? { staleAfterMs: opts.staleAfterMs } : {}),
      // No rasterizer until the shell supplies a canvas: Tamil and Malayalam lines print the English name.
      queue: { onChange: () => this.emit() },
    });
    for (const p of printers) {
      this.svc.addPrinter(p.id, p.profile, p.send);
      this.ids.push(p.id);
    }
  }

  private emit(): void {
    for (const l of this.listeners) l();
  }

  subscribe(l: () => void): () => void {
    this.listeners.add(l);
    return () => void this.listeners.delete(l);
  }

  has(printerId: string): boolean {
    return this.ids.includes(printerId);
  }

  print(printerId: string, doc: PrintDocument, o: { jobId: string; trigger?: PrintTrigger }): PrintOutcome {
    const r = this.svc.print(printerId, doc, o);
    this.emit();
    return r;
  }

  async flush(): Promise<number> {
    const n = await this.svc.flush();
    this.emit();
    return n;
  }

  jobs(): QueueJob[] {
    return this.ids.flatMap((printerId) =>
      this.svc.queue(printerId).pending().map((j) => ({ printerId, id: j.id, kind: j.kind ?? "doc", status: j.status, attempts: j.attempts, lastError: j.lastError })),
    );
  }

  retry(printerId: string, jobId: string): boolean {
    const ok = this.svc.queue(printerId).retry(jobId);
    return ok;
  }

  remove(printerId: string, jobId: string): boolean {
    const ok = this.svc.queue(printerId).remove(jobId);
    this.emit();
    return ok;
  }

  lateTickets(): readonly LateTicket[] {
    return this.svc.lateTickets();
  }

  printLate(id: string): boolean {
    const ok = this.svc.printLate(id);
    this.emit();
    return ok;
  }

  dismissLate(id: string): boolean {
    const ok = this.svc.dismissLate(id);
    this.emit();
    return ok;
  }

  openDrawer(): Promise<void> {
    return this.drawer.open();
  }
}


/** Browser and test wiring: two fake printers (counter bill printer, kitchen printer) and a fake drawer. */
export function createFakePrintHub(now?: () => number): { hub: PrintHub; bill: FakeReceiptPrinter; kitchen: FakeKitchenPrinter; drawer: FakeCashDrawer } {
  const bill = new FakeReceiptPrinter();
  const kitchen = new FakeKitchenPrinter();
  const drawer = new FakeCashDrawer();
  const hub = new PrintHub(
    [
      { id: BILL_PRINTER, profile: GENERIC_80, send: (b) => bill.print(b) },
      { id: KITCHEN_PRINTER, profile: GENERIC_80, send: (b) => kitchen.print(b, "kitchen") },
    ],
    drawer,
    now ? { now } : {},
  );
  return { hub, bill, kitchen, drawer };
}
