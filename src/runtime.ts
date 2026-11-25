import {
  EngineOpWriter,
  InMemoryStore,
  KeyRing,
  SoftwareSigner,
  SyncEngine,
  SyncRunner,
  approvalGrantSpec,
  createSyncPort,
  deviceSessionDue,
  restaurantRegistry,
  sessionOpenSpec,
  type LocalStore,
  type SealVerifier,
  type Session,
  type SessionStore,
  type Signer,
  type SyncTransport,
} from "@hostry/client-core";
import { AppData } from "./data/app-data";
import { monotonicIds } from "./data/ids";
import { adoptEntitlements, parseEntitlements, type EntitlementSnapshot } from "./domain/entitlements";
import { PackIdentity } from "./data/auth/pack-identity";
import { brandStreamOf, outletStreamOf, tenantStreamOf, type DeviceKind, type DevicePack, type PinProver } from "./data/auth/pack";
import { OpLog } from "./data/op-log";
import type { IdentityPort, OpWriter, RecordSpec, SyncPort } from "./data/ports";
import type { TradingCtx } from "./data/trading/ctx";
import { createFakePrintHub } from "./devices/print-hub";
import { createShell, type Shell } from "./shell/shell";
import { assertPackAllowed, type BuildTarget } from "./shell/target";


/** Where this device's ops go. The native shell gives real transports (LAN hub URL, cloud gateway); tests give a simulated pair. */
export type Upstream = {
  hub?: SyncTransport;
  cloud?: SyncTransport;
  /** Seal verifier: the key ring of the outlet's devices and the cloud key (from the offline pack). */
  verifier?: SealVerifier & { add?: KeyRing["add"] };
  /** Switches the simulated links, when the transports are simulated; the sync sheet shows them only then. */
  links?: { hub: { up: boolean }; cloud: { up: boolean } };
};

/**
 * Everything the app needs, wired once. The browser build and the tests both call this; the native shell (ADR-0007)
 * replaces the store, printers, drawer, signer and transports without touching a screen.
 */
export type Runtime = {
  data: AppData;
  /** Records intents through the sync engine: numbers, rows and op commit in one local transaction. */
  writer: OpWriter;
  engine: SyncEngine;
  store: LocalStore;
  sync: SyncPort;
  /** Simulated links, when the runtime was built with them. */
  links: { hubUp(): boolean; cloudUp(): boolean; set(l: { hub?: boolean; cloud?: boolean }, syncNow?: boolean): Promise<void> } | undefined;
  identity: IdentityPort;
  sessions: SessionStore;
  fakes: ReturnType<typeof createFakePrintHub>;
  shell: Shell;
  ctx: TradingCtx;
  /** Member names for printed documents. */
  names: Map<string, string>;
  setSession(s: Session | undefined): void;
  session(): Session | undefined;
  /** Device role from activation: waiter handheld, pos counter or kds (RM-A10). */
  deviceKind: DeviceKind;
  deviceId: string;
  /** The offline pack this runtime was built from: tenant, outlet, device, series and staff all come from it. */
  pack: DevicePack;
  /** The entitlement snapshot held now (from the pack claim, raised by `adoptPack`). `undefined`: none known, trading continues. */
  entitlements(): EntitlementSnapshot | undefined;
  /** Adopts the entitlements of a refreshed pack when `entitlements_v` is higher than the one held; true when it did. Nothing else of the pack changes here. */
  adoptPack(refreshed: unknown): boolean;
  onEntitlements(fn: () => void): () => void;
  now: () => number;
};

export type RuntimeOptions = {
  /** The device's offline pack (activation). Required: the app has no built-in tenant, outlet, device or series. */
  pack: DevicePack;
  /** Checks PINs and makes the session and action proofs (the native shell; a fixture in dev and tests). */
  prover: PinProver;
  now?: () => number;
  /**
   * Dev only: seed the demo menu and settings straight into this device's store (never recorded as an op, never
   * synced). A real device gets configuration through the configuration intents over sync.
   */
  devSeed?: (store: LocalStore) => Promise<void>;
  /** Durable store (IndexedDB in the browser build). Default: client-core's in-memory store. */
  store?: LocalStore;
  signer?: Signer;
  upstream?: Upstream;
  /** Push new ops as soon as an upstream answered (the background timer runs in any case once `sync.start()` is called). */
  autoSync?: boolean;
  /** What this bundle is; default the build's own. A browser build refuses a pack that is not `store: unprotected` (ADR-0002 A3.3). Tests of the native placement pass `native`. */
  target?: BuildTarget;
};

/**
 * Fields the screens read that the entity contracts leave to the op log: who created a row and when. The writer of the
 * insert is the waiter of a check, the time of the insert is when a ticket was sent, a table seated, a bill asked for.
 */
const PROVENANCE: Record<string, { actor?: string; at?: string }> = {
  check: { actor: "waiter_id" },
  seating: { at: "opened_at" },
  shift: { actor: "opened_by", at: "opened_at" },
  kot: { at: "created_at" },
  bill_request: { at: "requested_at" },
  check_present: { at: "presented_at" },
};

export async function createRuntime(o: RuntimeOptions): Promise<Runtime> {
  const now = o.now ?? Date.now;
  const pack = o.pack;
  assertPackAllowed(pack, o.target);
  const deviceKind = pack.deviceKind;
  const deviceCode = pack.deviceCode;
  const deviceId = pack.deviceId;
  const outletStream = outletStreamOf(pack);
  const brandStream = brandStreamOf(pack);
  const tenantStream = tenantStreamOf(pack);
  const store = o.store ?? new InMemoryStore(pack.tenantId);
  const newId = monotonicIds(now);

  // The key id comes from the pack (`device.kid`): the gateway holds one key per device id under that kid (ADR-0014 A3.4).
  const signer = o.signer ?? (await SoftwareSigner.generate(pack.kid));
  const verifier = o.upstream?.verifier ?? new KeyRing();
  if (signer instanceof SoftwareSigner && "add" in verifier && typeof verifier.add === "function") await verifier.add(deviceId, signer.kid, signer.publicB64);
  const engine = await SyncEngine.open({
    store,
    schemas: restaurantRegistry(),
    deviceId,
    outletStream,
    streams: [outletStream, brandStream, tenantStream],
    signer,
    verifier,
    packVersion: pack.packV,
    // The credential kind decides whether personal data reaches this device: a `kds` never receives it (ADR-0014 A3.1).
    deviceKind: pack.deviceKind,
    // Another device's customer details are kept only when the pack says this store is protected (ADR-0002 A3.5 item 2).
    storeClaim: pack.store,
    now,
    newId,
  });
  await engine.setSeriesGrants(pack.series);

  let current: Session | undefined;
  const sessionListeners = new Set<(s: Session | undefined) => void>();
  const sessions: SessionStore = {
    current: () => current,
    onChange: (l) => {
      sessionListeners.add(l);
      return () => void sessionListeners.delete(l);
    },
  };
  const setSession = (s: Session | undefined): void => {
    current = s;
    // Every op carries the member and the session that wrote it. With nobody signed in, system writes (opening the day
    // from seed data, tests) are stamped "system".
    engine.session = { actor: s?.memberId ?? "system", sid: s?.sessionId ?? "system" };
    for (const l of sessionListeners) l(s);
  };
  setSession(undefined);

  const runner = new SyncRunner({
    engine,
    ...(o.upstream?.hub ? { hub: o.upstream.hub } : {}),
    ...(o.upstream?.cloud ? { cloud: o.upstream.cloud } : {}),
    now,
    onError: () => undefined, // offline is the normal state; the status says so
  });
  const sync = createSyncPort(runner, engine);
  const engineWriter = new EngineOpWriter(engine, { streams: { brand: brandStream, tenant: tenantStream } });
  const autoSync = o.autoSync ?? false;
  // Holds the runtime once it exists: the writer re-opens a KDS device session through it.
  const ref: { rt?: Runtime } = {};
  const openBusinessDate = (): string | undefined => data.snapshot().list<{ business_date: string; status: string }>("business_day").find((d) => d.status === "open")?.business_date;
  const writer: OpWriter = {
    async record(spec: RecordSpec) {
      // A KDS device session lasts one business day, at most 26 hours: the screen opens a new one on its first op after it
      // sees a new open day (or after 26 hours), with no person involved (protocol "Device-session lifetime").
      if (ref.rt && deviceKind === "kds" && spec.intent !== "session.open") {
        const meta = current && deviceSessions.get(current);
        const bd = openBusinessDate();
        if (meta && deviceSessionDue(meta, { ms: now(), ...(bd !== undefined ? { businessDate: bd } : {}) })) await openDeviceSession(ref.rt);
      }
      const op = await engineWriter.record(spec);
      if (autoSync && engine.status().online) void runner.syncNow();
      return op;
    },
  };

  const opLog = new OpLog(engine, store.tenantId);
  const data = new AppData(store, writer, async (e) => {
    if (e === "_op") return opLog.rows();
    if (e === "_local") return store.list("_local");
    const rows = await engine.rows(e);
    // Provenance the entity contracts leave to the op log: the waiter of a check, when a table was seated, who opened a shift.
    const prov = PROVENANCE[e];
    if (prov) {
      await opLog.rows(); // brings the index up to date
      return rows.map((r) => {
        const p = opLog.insertedBy(e, r.id);
        if (!p) return r;
        return { ...r, ...(prov.actor ? { [prov.actor]: p.actor } : {}), ...(prov.at ? { [prov.at]: p.at } : {}) };
      });
    }
    return rows;
  });
  // Rows from other devices arrive while a sync round runs: reload the snapshot when the engine says something changed.
  engine.onStatus(() => void data.refresh());

  // Proof-bearing ops (ADR-0005 A2.1, A3.1): `session.open` on every PIN sign-in and `approval.grant` on every approval, each
  // carrying the opaque proof the shell made while the PIN was in hand. The proof and the integers it binds travel once, on
  // that op; every later op names the `sid` (or the approval id). Recorded under the member the proof is for.
  const identity = new PackIdentity({
    pack,
    prover: o.prover,
    now,
    stamp: () => engine.stampTime(),
    hooks: {
      sessionOpened: async (s) => {
        await writer.record(sessionOpenSpec({ sid: s.sid, actor: s.memberId, type: "pin", proof: s.proof, pinV: s.pinV, at: s.openedAt }));
      },
      approvalGranted: async (a) => {
        // The grant belongs to the session of the device in use (the requester's), under the approver's name.
        const sid = current?.sessionId ?? "system";
        await writer.record(
          approvalGrantSpec({
            approvalId: a.approvalId,
            approverId: a.approverId,
            requesterId: a.requesterId,
            permission: a.permission,
            intent: a.intent,
            target: a.target,
            reason: a.reason,
            actionHash: a.actionHash,
            sid,
            proof: a.proof,
            pinV: a.pinV,
            at: a.at,
            self: a.self,
          }),
        );
      },
    },
  });
  const names = new Map(pack.members.map((m) => [m.memberId, m.displayName]));
  const fakes = createFakePrintHub(now);
  if (o.devSeed) await o.devSeed(store);
  await data.refresh();
  const ctx: TradingCtx = { data, session: () => current, now, newId, print: fakes.hub, outletId: pack.outletId, deviceCode, manualBookCodes: pack.manualBooks, nameOf: (id) => names.get(id) ?? id, vector: () => engine.vector() };

  let ent = pack.entitlements;
  const entListeners = new Set<() => void>();

  const links = o.upstream?.links;
  const rt: Runtime = {
    data,
    writer,
    engine,
    store,
    sync,
    links: links
      ? {
          hubUp: () => links.hub.up,
          cloudUp: () => links.cloud.up,
          set: async (l, syncNow = true) => {
            if (l.hub !== undefined) links.hub.up = l.hub;
            if (l.cloud !== undefined) links.cloud.up = l.cloud;
            if (!syncNow) return;
            await runner.syncNow();
            await data.refresh();
          },
        }
      : undefined,
    identity,
    sessions,
    fakes,
    shell: createShell(),
    ctx,
    names,
    setSession,
    session: () => current,
    deviceKind,
    deviceId,
    pack,
    entitlements: () => ent,
    adoptPack(refreshed) {
      const next = adoptEntitlements(ent, parseEntitlements((refreshed as { entitlements?: unknown } | null)?.entitlements));
      if (next === ent) return false;
      ent = next;
      for (const fn of entListeners) fn();
      return true;
    },
    onEntitlements(fn) {
      entListeners.add(fn);
      return () => void entListeners.delete(fn);
    },
    now,
  };
  ref.rt = rt;
  return rt;
}

/** When and under which business day each device session was opened: the KDS re-opens at a new day or after 26 hours. */
const deviceSessions = new WeakMap<Session, { openedAtMs: number; businessDate?: string }>();
let sidSeq = 0;

/**
 * Device session of a KDS screen: no member, no PIN, only the kitchen's permissions (AC 191). The session id carries the
 * device id, so one origin never reuses another device's `sid` (identity refuses a sid seen with another device). It lasts
 * one business day and at most 26 hours (protocol "Device-session lifetime"), then the screen opens a new one.
 */
export function deviceSession(rt: Runtime, sid = `s-${rt.pack.deviceId}-device`): Session {
  return {
    tenantId: rt.pack.tenantId,
    memberId: `device:${rt.pack.deviceId}`,
    deviceId: rt.pack.deviceId,
    sessionId: sid,
    kind: "shared",
    grants: [{ outlets: [rt.pack.outletId], perms: ["kds.bump", "menu.availability.set"] }],
    // The Session never lapses by itself: the 26 hour rule is the writer's (it opens a new session before the next op), and a lapsed one here would refuse the very op that re-opens it.
    expiresAt: new Date(rt.now() + 365 * 86_400_000).toISOString(),
    offline: true,
  };
}

/**
 * Opens the KDS device session: makes it the current session, then records `session.open` of type device (actor
 * `device:<origin>`, no proof). The sync gateway types a session from that record and attributes the screen's ops to the
 * device (finding F15). A fresh session id on every start.
 */
export async function openDeviceSession(rt: Runtime): Promise<Session> {
  const s = deviceSession(rt, `s-${rt.pack.deviceId}-${rt.now().toString(36)}-${(++sidSeq).toString(36)}`);
  const day = rt.data.snapshot().list<{ business_date: string; status: string }>("business_day").find((d) => d.status === "open")?.business_date;
  deviceSessions.set(s, { openedAtMs: rt.now(), ...(day !== undefined ? { businessDate: day } : {}) });
  rt.setSession(s);
  await rt.writer.record(sessionOpenSpec({ sid: s.sessionId, actor: s.memberId, type: "device" }));
  return s;
}
