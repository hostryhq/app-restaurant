import { KeyRing, SoftwareSigner } from "@hostry/client-core";
import { FakeNode } from "@hostry/client-core/testing";
import { ensureDayOpen } from "../data/trading/orders";
import { OUTLET_STREAM, createRuntime, type Runtime, type RuntimeOptions } from "../runtime";
import { TENANT_ID } from "../data/seed";

/** Deterministic clock: 2026-11-24 13:05 IST. */
export class TestClock {
  constructor(public ms = Date.parse("2026-11-24T07:35:00Z")) {}
  now = (): number => this.ms;
  advance(ms: number): void {
    this.ms += ms;
  }
  minutes(n: number): void {
    this.advance(n * 60_000);
  }
}

export type Name = "Asha" | "Ravi" | "Meena" | "Anand";
export type World = { rt: Runtime; clock: TestClock; net: Net; signIn(name: Name): Promise<void> };

const PINS = { Asha: ["m-asha", "1111"], Ravi: ["m-ravi", "2222"], Meena: ["m-meena", "3333"], Anand: ["m-anand", "4444"] } as const;

/**
 * The outlet's network as client-core's sync simulator provides it: a LAN hub node and a cloud node (FakeNode: verifies
 * the chain and seals like the real ones), and one pair of switchable links per device. Every device starts disconnected:
 * the app starts offline and works.
 */
export class Net {
  readonly ring = new KeyRing();
  readonly hubCloud = { up: false };
  readonly worlds: World[] = [];
  cloud!: FakeNode;
  hub!: FakeNode;

  private constructor(readonly clock: TestClock) {}

  static async create(clock = new TestClock()): Promise<Net> {
    const n = new Net(clock);
    const cloudSigner = await SoftwareSigner.generate("cloud-key");
    await n.ring.addCloudKey("cloud-key", cloudSigner.publicB64);
    const common = { tenantId: TENANT_ID, streams: [OUTLET_STREAM], verifier: n.ring, now: clock.now };
    n.cloud = new FakeNode({ role: "cloud", nodeId: "cloud", cloudSigner, ...common });
    n.hub = new FakeNode({ role: "hub", nodeId: "hub-1", ...common });
    return n;
  }

  /** A device on this network. The first device (the counter, in most tests) opens the business day; the others receive it by sync. */
  async add(o: RuntimeOptions & { openDay?: boolean } = {}): Promise<World> {
    const links = { hub: { up: false }, cloud: { up: false } };
    const id = o.deviceId ?? `dev-${o.deviceKind ?? "pos"}-${o.deviceCode ?? "A07"}`;
    const rt = await createRuntime({
      now: this.clock.now,
      // The first device holds the demo configuration (what the cloud would publish); the others receive it by sync.
      seed: this.worlds.length === 0,
      ...o,
      deviceId: id,
      upstream: { hub: this.hub.connect(id, links.hub), cloud: this.cloud.connect(id, links.cloud), verifier: this.ring, links },
    });
    if (o.openDay ?? this.worlds.length === 0) {
      const day = await rt.identity.signIn("m-meena", "3333");
      if (day.ok) {
        rt.setSession(day.session);
        await ensureDayOpen(rt.ctx);
        rt.setSession(undefined);
      }
    }
    const w: World = {
      rt,
      clock: this.clock,
      net: this,
      async signIn(name) {
        const [mid, pin] = PINS[name];
        const r = await rt.identity.signIn(mid, pin);
        if (!r.ok) throw new Error(`sign-in failed: ${r.reason}`);
        rt.setSession(r.session);
      },
    };
    this.worlds.push(w);
    return w;
  }

  /** Cut or restore every device's link to the hub (the LAN) and to the cloud (the internet), and the hub's own link to the cloud. */
  async links(l: { hub?: boolean; cloud?: boolean; hubCloud?: boolean }): Promise<void> {
    if (l.hubCloud !== undefined) this.hubCloud.up = l.hubCloud;
    const sw = { ...(l.hub !== undefined ? { hub: l.hub } : {}), ...(l.cloud !== undefined ? { cloud: l.cloud } : {}) };
    for (const w of this.worlds) await w.rt.links?.set(sw, false);
    await this.sync();
  }

  /** One round for every device, twice, so what the others sent in the first pass is pulled in the second. */
  async sync(): Promise<void> {
    for (let i = 0; i < 2; i++) for (const w of this.worlds) await w.rt.sync.syncNow();
    for (const w of this.worlds) await w.rt.data.refresh();
  }

  /** The hub relays what it holds to the cloud and back (a hub round). */
  async relay(): Promise<void> {
    await this.hub.relayWith(this.cloud, this.hubCloud).catch(() => undefined);
  }

  /** Everything reconnects and rounds repeat until nothing moves any more: the end-of-day convergence. */
  async settle(): Promise<void> {
    this.hubCloud.up = true;
    let last = "";
    for (let i = 0; i < 40; i++) {
      this.clock.advance(20_000);
      for (const w of this.worlds) await w.rt.links?.set({ hub: true, cloud: true });
      await this.relay();
      for (const w of this.worlds) await w.rt.sync.syncNow();
      const vs = await Promise.all(this.worlds.map((w) => w.rt.engine.vector()));
      const sig = JSON.stringify([vs, this.cloud.vector(), this.hub.vector()]);
      if (sig === last) {
        for (const w of this.worlds) await w.rt.data.refresh();
        return;
      }
      last = sig;
    }
    throw new Error("settle: did not quiesce in 40 rounds");
  }
}

/** One counter device on its own network (most tests). */
export async function world(o: RuntimeOptions = {}): Promise<World> {
  const net = await Net.create(new TestClock());
  return net.add(o);
}

export const rows = <T = Record<string, unknown>>(rt: Runtime, entity: string): T[] => rt.data.snapshot().list(entity) as unknown as T[];
