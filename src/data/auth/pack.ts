import type { SeriesGrant, StoreProtection } from "@hostry/client-core";
import { parseEntitlements, type EntitlementSnapshot } from "../../domain/entitlements";

/**
 * What the device holds after activation (ADR-0005 s5 and s6): the offline pack. Tenant, outlet, device, series and the
 * staff list come from here, never from a constant in the app. The native shell hands the pack over (`Shell.loadPack`);
 * the identity service signs it. `DevicePack` is the app's view of it: client-core's auth module will export the
 * canonical type; until it does this is the minimal shape the app needs, and `packFromJson` is the only place that
 * reads the wire form.
 */

/** The credential kinds a device of this app can have (api-specs `Credential.kind`; a `hub` is not an app). `kds` never receives customer details. */
export type DeviceKind = "pos" | "waiter" | "personal" | "kds";

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
  /** Key id of this device's own credential (pack `device.kid`): the seals and endorsements it makes name it (ADR-0014 A3.4). */
  kid: string;
  /**
   * Where this device keeps its rows (pack `device.store`, ADR-0002 A3.5): `protected` only for the native shell's encrypted
   * store. Decides whether another device's customer details may be kept here. Absent in the pack counts as `unprotected`.
   */
  store: StoreProtection;
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
  /** The pack's signed `entitlements` claim. Absent (or malformed) means no optional feature is known; trading continues (ADR-0014 T10). */
  entitlements?: EntitlementSnapshot;
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
  for (const k of ["tenantId", "brandId", "outletId", "deviceId", "deviceCode", "expiresAt", "kid"] as const) if (!isStr(p[k])) throw new PackError(`missing ${k}`);
  if (p.deviceKind !== "pos" && p.deviceKind !== "waiter" && p.deviceKind !== "personal" && p.deviceKind !== "kds") throw new PackError("bad deviceKind");
  if (p.store === undefined) p.store = "unprotected";
  if (p.store !== "protected" && p.store !== "unprotected") throw new PackError("bad store");
  if (!Number.isInteger(p.packV) || (p.packV as number) < 1) throw new PackError("packV must be an integer >= 1");
  if (!Array.isArray(p.members) || !Array.isArray(p.series)) throw new PackError("members and series are required");
  p.manualBooks = Array.isArray(p.manualBooks) ? p.manualBooks : [];
  const ent = parseEntitlements(p.entitlements);
  if (ent) p.entitlements = ent;
  else delete p.entitlements;
  for (const g of p.series) if (!isStr(g?.seriesId)) throw new PackError("series without seriesId");
  for (const m of p.members) if (!isStr(m?.memberId) || !Number.isInteger(m.pinV) || m.pinV < 1 || !Array.isArray(m.perms)) throw new PackError("bad member");
  return p as DevicePack;
}

/** The stream of the device's outlet (ADR-0002). */
export const outletStreamOf = (pack: Pick<DevicePack, "outletId">): string => `outlet:${pack.outletId}`;

/** The stream of the device's tenant (`tenant:<id>`): tenant-level ops (tax rule sets, tenant configuration) are recorded and synced here, never on the outlet stream (F4b). */
export const tenantStreamOf = (pack: Pick<DevicePack, "tenantId">): string => `tenant:${pack.tenantId}`;

/** The stream of the device's brand (`brand:<id>`), from the pack's `brand_id`: brand-level ops (menu, prices, reasons) are recorded here, never on the outlet stream. */
export const brandStreamOf = (pack: Pick<DevicePack, "brandId">): string => `brand:${pack.brandId}`;

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
