/**
 * Shell adapter seam (ADR-0007). The app is a plain browser app; a native shell (Tauri on Windows/Android/iOS) hosts the same
 * bundle and supplies real implementations of this interface. Nothing outside src/shell and src/devices knows which one runs.
 *
 * What the shell will own: the durable encrypted store, ESC/POS over USB/LAN/Bluetooth, the cash drawer pulse, the LAN hub
 * server/client, biometric app lock, the secure keystore for the device key, and window/fullscreen control.
 */
export type Shell = {
  kind: "browser" | "tauri";
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

export function createShell(): Shell {
  const ls = typeof localStorage !== "undefined" ? localStorage : undefined;
  return {
    kind: "browser",
    keepAwake: () => undefined,
    chime: () => undefined,
    hasNetwork: () => (typeof navigator !== "undefined" ? navigator.onLine : true),
    storage: ls ?? memoryStorage(),
  };
}
