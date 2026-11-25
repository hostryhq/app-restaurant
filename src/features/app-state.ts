import { createContext, createMemo, createSignal, onCleanup, useContext, type Accessor } from "solid-js";
import { can as coreCan, type LateTicket, type Session } from "@hostry/client-core";
import { toasts, type Translator } from "@hostry/ui-kit";
import type { QueueJob } from "../devices/print-hub";
import type { Snapshot } from "../data/app-data";
import type { SyncView } from "../data/ports";
import { PermissionError, TradingError } from "../data/trading/ctx";
import { ensureDayOpen } from "../data/trading/orders";
import type { Runtime } from "../runtime";

export type Mode = "tables" | "counter" | "kitchen" | "owner";

/** Screens, by id from docs/design/restaurant-app-flows.md. Sheets and dialogs are local to their screen. */
export type View =
  | { id: "floor" }
  | { id: "order"; tableId?: string; checkId?: string }
  | { id: "review" }
  | { id: "tender"; checkId: string; exact?: boolean }
  | { id: "held" }
  | { id: "bills" }
  | { id: "credit"; billId: string }
  | { id: "print" }
  | { id: "shiftclose" }
  | { id: "dayclose" }
  | { id: "sync" }
  | { id: "exceptions" }
  | { id: "late" }
  | { id: "kds" }
  | { id: "owner" }
  | { id: "reports" }
  | { id: "settings" }
  | { id: "menu" }
  | { id: "setup" };

export type ProofRequest = { permission: string; title: string; summary?: string };
export type ProofResult = { ok: true; approvalId?: string } | { ok: false };

export type App = {
  rt: Runtime;
  t: Translator["t"];
  snap: Accessor<Snapshot>;
  nowMs: Accessor<number>;
  session: Accessor<Session | undefined>;
  sync: Accessor<SyncView>;
  jobs: Accessor<QueueJob[]>;
  late: Accessor<readonly LateTicket[]>;
  mode: Accessor<Mode>;
  setMode(m: Mode): void;
  view: Accessor<View>;
  go(v: View): void;
  back(): void;
  can(permission: string): boolean;
  nameOf(memberId: string): string;
  /** Runs a trading action; a refusal becomes a message, never a crash. Returns true when it succeeded. */
  run<T>(fn: () => Promise<T>, then?: (r: T) => void): Promise<boolean>;
  /** Ask for a manager's approval, or the member's own PIN, before a sensitive action (RS08). */
  proof: Accessor<ProofRequest | undefined>;
  askProof(r: ProofRequest): Promise<ProofResult>;
  resolveProof(r: ProofResult): void;
  signIn(r: { memberId: string; pin: string }): Promise<{ ok: true } | { ok: false; reason: string; waitSeconds?: number }>;
  lock(): void;
  touch(): void;
};

const AppContext = createContext<App>();

export const AppProvider = AppContext;

export function useApp(): App {
  const a = useContext(AppContext);
  if (!a) throw new Error("App context missing");
  return a;
}

/** Message key for an error from a trading action. */
export function errorKey(e: unknown): string {
  if (e instanceof PermissionError) return "error.permission";
  if (e instanceof TradingError) return `error.${e.code}`;
  const code = (e as { code?: unknown })?.code;
  if (typeof code === "string") return `error.${code}`;
  return "error.generic";
}

const IDLE_SECONDS: Record<Runtime["deviceKind"], number> = { pos: 300, waiter: 120, kds: 0 };

export function createApp(rt: Runtime, t: Translator["t"], initial?: { session?: Session }): App {
  const [snap, setSnap] = createSignal<Snapshot>(rt.data.snapshot(), { equals: false });
  const [nowMs, setNow] = createSignal(rt.now());
  const [session, setSession] = createSignal<Session | undefined>(initial?.session ?? rt.session());
  const [sync, setSync] = createSignal<SyncView>(rt.sync.status(), { equals: false });
  const [jobs, setJobs] = createSignal<QueueJob[]>(rt.fakes.hub.jobs(), { equals: false });
  const [late, setLate] = createSignal<readonly LateTicket[]>(rt.fakes.hub.lateTickets(), { equals: false });
  const initialMode: Mode = rt.deviceKind === "kds" ? "kitchen" : rt.deviceKind === "waiter" ? "tables" : "counter";
  const [mode, setModeSig] = createSignal<Mode>(initialMode);
  const [stack, setStack] = createSignal<View[]>([defaultView(initialMode)]);
  const [proof, setProof] = createSignal<ProofRequest | undefined>(undefined);
  let proofResolve: ((r: ProofResult) => void) | undefined;
  let lastActive = rt.now();

  const offData = rt.data.subscribe(() => {
    setSnap(rt.data.snapshot());
    setNow(rt.now());
  });
  const offSync = rt.sync.onStatus((s) => setSync(s));
  const offPrint = rt.fakes.hub.subscribe(() => {
    setJobs(rt.fakes.hub.jobs());
    setLate(rt.fakes.hub.lateTickets());
  });
  const tick = setInterval(() => {
    setNow(rt.now());
    const limit = IDLE_SECONDS[rt.deviceKind];
    if (limit > 0 && rt.session() && rt.now() - lastActive > limit * 1000) app.lock();
  }, 5_000);
  onCleanup(() => {
    offData();
    offSync();
    offPrint();
    clearInterval(tick);
  });

  const holds = createMemo(() => session());
  const app: App = {
    rt,
    t,
    snap,
    nowMs,
    session,
    sync,
    jobs,
    late,
    mode,
    setMode(m) {
      setModeSig(m);
      setStack([defaultView(m)]);
    },
    view: () => stack()[stack().length - 1]!,
    go(v) {
      setStack((s) => [...s, v]);
    },
    back() {
      setStack((s) => (s.length > 1 ? s.slice(0, -1) : s));
    },
    can: (p) => coreCan(holds(), p, rt.ctx.outletId, new Date(rt.now())),
    nameOf: (id) => rt.names.get(id) ?? id,
    async run(fn, then) {
      try {
        const r = await fn();
        then?.(r);
        return true;
      } catch (e) {
        toasts.show(t(errorKey(e)));
        return false;
      }
    },
    proof,
    askProof(r) {
      return new Promise<ProofResult>((resolve) => {
        proofResolve = resolve;
        setProof(r);
      });
    },
    resolveProof(r) {
      setProof(undefined);
      proofResolve?.(r);
      proofResolve = undefined;
    },
    async signIn({ memberId, pin }) {
      const r = await rt.identity.signIn(memberId, pin);
      if (!r.ok) return { ok: false, reason: r.reason, ...(r.waitSeconds !== undefined ? { waitSeconds: r.waitSeconds } : {}) };
      rt.setSession(r.session);
      setSession(r.session);
      lastActive = rt.now();
      // A counter device opens the business day when someone who may opens the app (day.open is pos-only).
      if (rt.deviceKind === "pos") await app.run(() => ensureDayOpen(rt.ctx));
      return { ok: true };
    },
    lock() {
      rt.setSession(undefined);
      setSession(undefined);
    },
    touch() {
      lastActive = rt.now();
    },
  };
  return app;
}

export function defaultView(m: Mode): View {
  return m === "tables" ? { id: "floor" } : m === "counter" ? { id: "order" } : m === "kitchen" ? { id: "kds" } : { id: "owner" };
}
