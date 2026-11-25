import { InMemoryStore, type LocalStore, type Session } from "@hostry/client-core";
import { AppData } from "./data/app-data";
import { monotonicIds } from "./data/ids";
import { StubIdentity, DEMO_MEMBERS, type StubMember } from "./data/identity-stub";
import { LocalOpWriter } from "./data/local-writer";
import type { IdentityPort } from "./data/ports";
import { seedDemo, TENANT_ID, OUTLET_ID } from "./data/seed";
import { SyncSim } from "./data/sync-sim";
import type { TradingCtx } from "./data/trading/ctx";
import { createFakePrintHub } from "./devices/print-hub";
import { createShell, type Shell } from "./shell/shell";

/**
 * Everything the app needs, wired once. The browser build and the tests both call this; the native shell (ADR-0007)
 * will replace the store, printers, drawer and sync port with real adapters without touching a screen.
 */
export type Runtime = {
  data: AppData;
  writer: LocalOpWriter;
  store: LocalStore;
  sync: SyncSim;
  identity: IdentityPort;
  fakes: ReturnType<typeof createFakePrintHub>;
  shell: Shell;
  ctx: TradingCtx;
  /** Member names for printed documents. */
  names: Map<string, string>;
  setSession(s: Session | undefined): void;
  session(): Session | undefined;
  /** Device role from activation: waiter handheld, pos counter or kds (RM-A10). */
  deviceKind: "pos" | "waiter" | "kds";
  now: () => number;
};

export type RuntimeOptions = {
  now?: () => number;
  members?: StubMember[];
  seed?: boolean;
  deviceKind?: Runtime["deviceKind"];
  deviceCode?: string;
  /** Offline pack expiry (RFC 3339 UTC). */
  packExpiresAt?: string;
  /** Start with hub and cloud reachable. Default false: the app starts offline and works. */
  online?: boolean;
};

export async function createRuntime(o: RuntimeOptions = {}): Promise<Runtime> {
  const now = o.now ?? Date.now;
  const store = new InMemoryStore(TENANT_ID);
  const deviceCode = o.deviceCode ?? "A07";
  let current: Session | undefined;
  const newId = monotonicIds(now);
  const writer = new LocalOpWriter({
    store,
    deviceId: "dev-1",
    actor: () => current?.memberId ?? "system",
    now,
    newId,
    series: { tax_invoice: deviceCode, bill_of_supply: deviceCode, plain_bill: deviceCode, credit_note: "C07" },
  });
  const data = new AppData(store, writer, (l) => writer.onCommit(l));
  const members = o.members ?? DEMO_MEMBERS;
  const identity = new StubIdentity({ members, now, ...(o.packExpiresAt ? { packExpiresAt: o.packExpiresAt } : {}) });
  const names = new Map(members.map((m) => [m.memberId, m.displayName]));
  const fakes = createFakePrintHub(now);
  const sync = new SyncSim(data, writer, now);
  if (o.seed !== false) await seedDemo(store);
  await data.refresh();
  if (o.online) await sync.setLinks({ hub: true, cloud: true });
  const ctx: TradingCtx = { data, session: () => current, now, newId, print: fakes.hub, outletId: OUTLET_ID, deviceCode, nameOf: (id) => names.get(id) ?? id };
  return {
    data,
    writer,
    store,
    sync,
    identity,
    fakes,
    shell: createShell(),
    ctx,
    names,
    setSession: (s) => {
      current = s;
    },
    session: () => current,
    deviceKind: o.deviceKind ?? "pos",
    now,
  };
}

/** Device session of a KDS screen: no member, no PIN, only the kitchen's permissions (AC 191). */
export function deviceSession(rt: Runtime): Session {
  return {
    tenantId: TENANT_ID,
    memberId: "device-kds",
    deviceId: "dev-kds",
    sessionId: "s-device",
    kind: "shared",
    grants: [{ outlets: [OUTLET_ID], perms: ["kds.bump", "menu.availability.set"] }],
    expiresAt: new Date(rt.now() + 365 * 86_400_000).toISOString(),
    offline: true,
  };
}
