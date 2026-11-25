import { ENTITIES } from "../data/app-data";
import { ensureDayOpen } from "../data/trading/orders";
import { createRuntime, type Runtime, type RuntimeOptions } from "../runtime";

const ENTITY_NAMES: readonly string[] = ENTITIES;

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

export type World = { rt: Runtime; clock: TestClock; signIn(name: "Asha" | "Ravi" | "Meena" | "Anand"): Promise<void> };

const PINS = { Asha: ["m-asha", "1111"], Ravi: ["m-ravi", "2222"], Meena: ["m-meena", "3333"], Anand: ["m-anand", "4444"] } as const;

export async function world(o: RuntimeOptions = {}): Promise<World> {
  const clock = new TestClock();
  const rt = await createRuntime({ now: clock.now, ...o });
  // A counter (pos) device opens the day when a member who may open it signs in; waiter handhelds cannot (day.open is pos-only).
  const day = await rt.identity.signIn("m-meena", "3333");
  if (day.ok) {
    rt.setSession(day.session);
    await ensureDayOpen(rt.ctx);
    rt.setSession(undefined);
  }
  return {
    rt,
    clock,
    async signIn(name) {
      const [id, pin] = PINS[name];
      const r = await rt.identity.signIn(id, pin);
      if (!r.ok) throw new Error(`sign-in failed: ${r.reason}`);
      rt.setSession(r.session);
    },
  };
}

/** Stand-in for a sync round: copy every synced row from one device's store to another's (the receiving device keeps its own ops). */
export async function relay(from: World, to: World): Promise<void> {
  const skip = new Set(["_op", "_meta", "_series", "_local"]);
  for (const [entity, list] of Object.entries(Object.fromEntries(ENTITY_NAMES.filter((e) => !skip.has(e)).map((e) => [e, from.rt.data.snapshot().list(e)])))) {
    await to.rt.store.transact((tx) => {
      for (const r of list) tx.put(entity, r);
    });
  }
  await to.rt.data.refresh();
}

export const rows =<T = Record<string, unknown>>(rt: Runtime, entity: string): T[] => rt.data.snapshot().list(entity) as unknown as T[];
