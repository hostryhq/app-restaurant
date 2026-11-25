import { fireEvent, render } from "@solidjs/testing-library";
import { flush } from "solid-js";
import { expect } from "vitest";
import { App } from "../features/App";
import { createAppTranslator } from "../i18n";
import { deviceSession } from "../runtime";
import { world, type World, type WorldOptions } from "./world";

export const byId = (id: string): HTMLElement => {
  const el = document.querySelector<HTMLElement>(`[data-testid="${id}"]`);
  if (!el) throw new Error(`no element with data-testid=${id}`);
  return el;
};
export const queryById = (id: string): HTMLElement | null => document.querySelector<HTMLElement>(`[data-testid="${id}"]`);
export const text = (id: string): string => byId(id).textContent ?? "";

/** Poll until `fn` stops throwing (no sleeps: local writes finish in a few microtask turns). */
export async function until<T>(fn: () => T, ms = 4000): Promise<T> {
  const end = Date.now() + ms;
  let last: unknown;
  for (;;) {
    flush();
    try {
      return fn();
    } catch (e) {
      last = e;
    }
    if (Date.now() > end) throw last;
    await new Promise((r) => setTimeout(r, 5));
  }
}
export const find = (id: string): Promise<HTMLElement> => until(() => byId(id));

export type Ui = World & {
  /** Number of touch taps since the last `reset()`: every click on a control counts once. */
  taps: () => number;
  reset(): void;
  tap(id: string): Promise<void>;
  /** A key press (keyboard-only budgets count key groups, not individual characters). */
  keys: () => number;
  press(key: string, init?: KeyboardEventInit): void;
  /** Type an item code in the counter code box and press Enter: one key group (AC 92). */
  enter(code: string): Promise<void>;
  pin(digits: string, scope?: string): Promise<void>;
  login(name: "Asha" | "Ravi" | "Meena" | "Anand"): Promise<void>;
};

const IDS = { Asha: "m-asha", Ravi: "m-ravi", Meena: "m-meena", Anand: "m-anand" } as const;
const PINS = { Asha: "1111", Ravi: "2222", Meena: "3333", Anand: "4444" } as const;

export async function mountApp(o: WorldOptions & { signedIn?: keyof typeof IDS; world?: World } = {}): Promise<Ui> {
  const w = o.world ?? (await world(o));
  let taps = 0;
  let keys = 0;
  const translator = createAppTranslator();
  const device = w.rt.deviceKind === "kds" ? deviceSession(w.rt) : undefined;
  if (device) w.rt.setSession(device);
  render(() => <App runtime={w.rt} translator={translator} {...(device ? { session: device } : {})} />);
  const ui: Ui = {
    ...w,
    taps: () => taps,
    keys: () => keys,
    reset() {
      taps = 0;
      keys = 0;
    },
    async tap(id) {
      const el = await find(id);
      taps++;
      fireEvent.click(el);
      flush();
      await until(() => true);
    },
    async enter(code) {
      const input = (await find("code-input")) as HTMLInputElement;
      keys++;
      input.value = code;
      fireEvent.input(input);
      flush();
      fireEvent.keyDown(input, { key: "Enter" });
      flush();
      await until(() => true);
    },
    press(key, init = {}) {
      keys++;
      fireEvent.keyDown(document.body, { key, ...init });
      flush();
    },
    async pin(digits, scope = "login-pin-numpad") {
      for (const d of digits) {
        fireEvent.click(await find(`${scope}-${d}`));
        flush();
      }
      // The PIN check makes a proof (async crypto), so the pad stays disabled for a moment: wait until it is idle again or gone.
      await until(() => {
        const key = queryById(`${scope}-1`) as HTMLButtonElement | null;
        if (key?.disabled) throw new Error("pin pad busy");
      });
    },
    async login(name) {
      await ui.tap(`login-user-${IDS[name]}`);
      await ui.pin(PINS[name]);
      await until(() => expect(queryById("app-header")).not.toBeNull());
      ui.reset();
    },
  };
  if (o.signedIn) await ui.login(o.signedIn);
  return ui;
}

/** Interactive elements without a data-testid (AC 190). */
export function missingTestIds(root: ParentNode = document): string[] {
  return Array.from(root.querySelectorAll<HTMLElement>("button, input, select, textarea, a[href]"))
    .filter((el) => !el.dataset.testid && !el.closest("[data-testid-exempt]"))
    .map((el) => `${el.tagName.toLowerCase()}${el.className ? `.${String(el.className).split(" ")[0]}` : ""}:${(el.textContent ?? "").trim().slice(0, 20)}`);
}
