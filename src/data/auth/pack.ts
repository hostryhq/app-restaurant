import type { SeriesGrant } from "@hostry/client-core";

/**
 * What the device holds after activation (ADR-0005 s5 and s6): the offline pack. Tenant, outlet, device, series and the
 * staff list come from here, never from a constant in the app. The native shell hands the pack over (`Shell.loadPack`);
 * the identity service signs it. `DevicePack` is the app's view of it: client-core's auth module will export the
 * canonical type; until it does this is the minimal shape the app needs, and `packFromJson` is the only place that
 * reads the wire form.
 */

export type DeviceKind = "pos" | "waiter" | "kds";

export type PackMember = {
  memberId: string;
  displayName: string;
  role: string;
  /** Permission strings the pack grants this member at this outlet (last synced; never trusted beyond that). */
  perms: string[];
  /** The member's PIN version (sealed integer, ADR-0005 A3.1). Changes when the PIN is reset. */
  pinV: number;
};

export type DevicePack = {
  tenantId: string;
  brandId: string;
  outletId: string;
  deviceId: string;
  deviceKind: DeviceKind;
  /** Series code of this device's bills ("A07"); absent on a device that never bills. */
  deviceCode: string;
  /** Pack version, a JSON integer >= 1 (ADR-0005 A3.1); every device-origin op carries it. */
  packV: number;
  /** Offline pack expiry, RFC 3339 UTC. */
  expiresAt: string;
  /** Number series granted to this device (empty on a handheld or KDS). */
  series: SeriesGrant[];
  members: PackMember[];
  /** Active paper bill books of the outlet, entry-only (pack `manual_books`; typed, never allocated). Absent in the pack means none. */
  manualBooks: string[];
};

export class PackError extends Error {
  constructor(detail: string) {
    super(`offline pack: ${detail}`);
    this.name = "PackError";
  }
}

const isStr = (v: unknown): v is string => typeof v === "string" && v.length > 0;

/** Reads the pack the shell stored at activation (JSON). Fails loudly: a device with a bad pack must not trade. */
export function packFromJson(raw: unknown): DevicePack {
  const p = raw as Partial<DevicePack> | null;
  if (!p || typeof p !== "object") throw new PackError("not an object");
  for (const k of ["tenantId", "brandId", "outletId", "deviceId", "deviceCode", "expiresAt"] as const) if (!isStr(p[k])) throw new PackError(`missing ${k}`);
  if (p.deviceKind !== "pos" && p.deviceKind !== "waiter" && p.deviceKind !== "kds") throw new PackError("bad deviceKind");
  if (!Number.isInteger(p.packV) || (p.packV as number) < 1) throw new PackError("packV must be an integer >= 1");
  if (!Array.isArray(p.members) || !Array.isArray(p.series)) throw new PackError("members and series are required");
  p.manualBooks = Array.isArray(p.manualBooks) ? p.manualBooks : [];
  for (const g of p.series) if (!isStr(g?.seriesId)) throw new PackError("series without seriesId");
  for (const m of p.members) if (!isStr(m?.memberId) || !Number.isInteger(m.pinV) || m.pinV < 1 || !Array.isArray(m.perms)) throw new PackError("bad member");
  return p as DevicePack;
}

/** The stream of the device's outlet (ADR-0002). */
export const outletStreamOf = (pack: Pick<DevicePack, "outletId">): string => `outlet:${pack.outletId}`;

/** The shell's side of PIN entry: checks the PIN against the pack's verifier and makes proofs while the PIN is in hand (ADR-0005 s7, s8). */
export type SessionProofInput = { memberId: string; pin: string; sid: string; deviceId: string; packV: number; pinV: number; openedAt: string };
export type ApprovalProofInput = {
  approvalId: string;
  approverId: string;
  pin: string;
  permission: string;
  requesterId: string;
  /** What the approval record holds and the proof binds (ADR-0005 A3.1 item 2): the action hash, the record the approval is for and the reason. */
  actionHash: string;
  target: string;
  reason: string;
  deviceId: string;
  packV: number;
  pinV: number;
  at: string;
};

export interface PinProver {
  /** `undefined` when the PIN does not match the member's verifier; otherwise the opaque session proof. */
  sessionProof(i: SessionProofInput): Promise<string | undefined>;
  /** `undefined` when the PIN does not match; otherwise the opaque action proof of one approval. */
  approvalProof(i: ApprovalProofInput): Promise<string | undefined>;
}
