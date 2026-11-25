import type { PinProver } from "../data/auth/pack";

/**
 * Shell adapter seam (ADR-0007). The app is a plain browser app; a native shell (Tauri on Windows/Android/iOS) hosts the same
 * bundle and supplies real implementations of this interface. Nothing outside src/shell and src/devices knows which one runs.
 *
 * What the shell will own: the durable encrypted store, ESC/POS over USB/LAN/Bluetooth, the cash drawer pulse, the LAN hub
 * server/client, biometric app lock, the secure keystore for the device key, and window/fullscreen control.
 */
export type Shell = {
  kind: "browser" | "tauri";
  /**
   * The offline pack stored at activation (ADR-0005 s6), as parsed JSON, or undefined when the device was never activated.
   * Tenant, outlet, device, series and staff come from it. The browser build reads storage; the native shell reads its keystore.
   */
  loadPack(): unknown;
  /** Checks PINs against the pack's verifiers and makes session and action proofs. Native shell only (Argon2id, proof key); never in a browser. */
  pinProver?: PinProver;
  /** Keep the screen awake while a KDS is showing (no-op in a browser). */
  keepAwake(on: boolean): void;
  /** Play the bill-request chime (P2D-3). */
  chime(): void;
  /** True when the OS reports a network connection. Advisory only: the sync port decides what "online" means. */
  hasNetwork(): boolean;
  /** Where the device may persist small settings (theme, KDS station). The shell can swap this for secure storage. */
  storage: Pick<Storage, "getItem" | "setItem" | "removeItem">;
};

const memoryStorage = (): Shell["storage"] => {
  const m = new Map<string, string>();
  return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => void m.set(k, v), removeItem: (k) => void m.delete(k) };
};

export const PACK_STORAGE_KEY = "hostry.pack";

export function createShell(): Shell {
  const ls = typeof localStorage !== "undefined" ? localStorage : undefined;
  return {
    kind: "browser",
    loadPack: () => {
      const raw = (ls ?? memoryStorage()).getItem(PACK_STORAGE_KEY);
      return raw ? (JSON.parse(raw) as unknown) : undefined;
    },
    keepAwake: () => undefined,
    chime: () => undefined,
    hasNetwork: () => (typeof navigator !== "undefined" ? navigator.onLine : true),
    storage: ls ?? memoryStorage(),
  };
}
