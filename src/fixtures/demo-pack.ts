import { approvalProofMessage, sessionProofMessage, type SeriesGrant } from "@hostry/client-core";
import type { ApprovalProofInput, DeviceKind, DevicePack, PackMember, PinProver, SessionProofInput } from "../data/auth/pack";
import { DEMO_OUTLET_ID, DEMO_TENANT_ID } from "./demo-outlet";

/**
 * DEV FIXTURE ONLY: a stand-in offline pack and PIN prover for the browser dev build (?demo) and tests. A real device
 * gets its pack at activation and its proofs from the native shell (Argon2id verifier, proof key); nothing here is
 * secret. Role to permission templates are assumptions for the ADR-0005 role templates and the security review.
 */

const WAITER = ["order.create", "order.edit", "bill.request", "bill.present", "bill.new", "bill.split", "order.items.move", "order.table.move", "kot.handover", "menu.availability.set"];
const CASHIER = [
  ...WAITER,
  "bill.finalize",
  "payment.record",
  "bill.discount.apply",
  "bill.service_charge.remove",
  "bill.customer_details.edit",
  "order.table.merge",
  "bill.merge",
  "shift.open",
  "shift.close",
  "drawer.cash_move",
  "drawer.open_no_sale",
  "kot.reprint",
  "kds.bump",
  "bill.reprint",
];
const MANAGER = [
  ...CASHIER,
  "order.line.cancel",
  "bill.discount.over_limit",
  "bill.line.comp",
  "bill.credit_note.create",
  "bill.rebill",
  "bill.cancel",
  "payment.refund",
  "day.close",
  "shift.close.any",
  "bill.manual_entry",
  "report.view",
];

export const ROLE_PERMS: Record<string, string[]> = {
  waiter: WAITER,
  cashier: CASHIER,
  manager: MANAGER,
  owner: ["*"],
  kitchen: ["kds.bump", "menu.availability.set"],
};

export type DemoMember = { memberId: string; displayName: string; role: string; pin: string; pinV?: number };

/** Demo PINs are fixtures, not secrets. */
export const DEMO_MEMBERS: DemoMember[] = [
  { memberId: "m-asha", displayName: "Asha", role: "cashier", pin: "1111" },
  { memberId: "m-ravi", displayName: "Ravi", role: "waiter", pin: "2222" },
  { memberId: "m-meena", displayName: "Meena", role: "manager", pin: "3333" },
  { memberId: "m-anand", displayName: "Anand", role: "owner", pin: "4444" },
];

/** Offline-pack series grants of one billing device: its sale series and a credit-note series. */
export function demoSeries(deviceCode: string): SeriesGrant[] {
  const credit = `C${deviceCode.slice(1)}`;
  return [
    { code: deviceCode, docType: "tax_invoice", state: "active", seriesId: `ser-${deviceCode}-inv` },
    { code: deviceCode, docType: "bill_of_supply", state: "active", seriesId: `ser-${deviceCode}-inv` },
    { code: deviceCode, docType: "plain_bill", state: "active", seriesId: `ser-${deviceCode}-inv` },
    { code: credit, docType: "credit_note", state: "active", seriesId: `ser-${credit}-cn` },
  ];
}

export type DemoPackOptions = {
  deviceKind?: DeviceKind;
  deviceCode?: string;
  deviceId?: string;
  billing?: boolean;
  manualBooks?: string[];
  members?: DemoMember[];
  packV?: number;
  expiresAt?: string;
  tenantId?: string;
  outletId?: string;
  now?: () => number;
};

export function demoPack(o: DemoPackOptions = {}): { pack: DevicePack; prover: DemoProver } {
  const deviceKind = o.deviceKind ?? "pos";
  const deviceCode = o.deviceCode ?? "A07";
  const members = o.members ?? DEMO_MEMBERS;
  const now = o.now ?? Date.now;
  const pack: DevicePack = {
    tenantId: o.tenantId ?? DEMO_TENANT_ID,
    brandId: "brand-1",
    outletId: o.outletId ?? DEMO_OUTLET_ID,
    deviceId: o.deviceId ?? `dev-${deviceKind}-${deviceCode}`,
    deviceKind,
    kid: `k-${o.deviceId ?? `dev-${deviceKind}-${deviceCode}`}`,
    deviceCode,
    packV: o.packV ?? 1,
    expiresAt: o.expiresAt ?? new Date(now() + 7 * 86_400_000).toISOString(),
    manualBooks: o.manualBooks ?? ["MB1"],
    series: o.billing !== false && deviceKind !== "kds" ? demoSeries(deviceCode) : [],
    members: members.map((m): PackMember => ({ memberId: m.memberId, displayName: m.displayName, role: m.role, perms: ROLE_PERMS[m.role] ?? [], pinV: m.pinV ?? 1 })),
  };
  return { pack, prover: new DemoProver(members) };
}

const hex = (b: ArrayBuffer): string => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("");
const enc = new TextEncoder();

async function hmac(pin: string, memberId: string, pinV: number, msg: string): Promise<string> {
  // The proof key is derived from the PIN, as the real one is (ADR-0005 s5); the derivation here is a fixture, not Argon2id.
  const key = await crypto.subtle.importKey("raw", await crypto.subtle.digest("SHA-256", enc.encode(`demo-proof-key|${memberId}|${pinV}|${pin}`)), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return `d1:${hex(await crypto.subtle.sign("HMAC", key, enc.encode(msg)))}`;
}

// The message bytes are the contract's (api-specs sync/protocol-v1.md, Proof messages): client-core builds them, so the
// fixture and the identity service sign the same text. Only the key derivation and the output encoding are fixture.
const sessionMsg = (i: Omit<SessionProofInput, "pin">): string => sessionProofMessage({ sessionId: i.sid, deviceId: i.deviceId, memberId: i.memberId, packV: i.packV, pinV: i.pinV, openedAt: i.openedAt });
const approvalMsg = (i: Omit<ApprovalProofInput, "pin">): string =>
  approvalProofMessage({ actionHash: i.actionHash, deviceId: i.deviceId, memberId: i.approverId, packV: i.packV, pinV: i.pinV, approvalId: i.approvalId, permission: i.permission, target: i.target, requesterId: i.requesterId, approvedAt: i.at, reason: i.reason });

/** Fixture prover: checks the PIN against the demo list and makes an HMAC proof. `verify*` stands in for the identity service (tests). */
export class DemoProver implements PinProver {
  constructor(private readonly members: DemoMember[]) {}

  private pinOf(memberId: string): string | undefined {
    return this.members.find((m) => m.memberId === memberId)?.pin;
  }

  async sessionProof(i: SessionProofInput): Promise<string | undefined> {
    return this.pinOf(i.memberId) === i.pin ? hmac(i.pin, i.memberId, i.pinV, sessionMsg(i)) : undefined;
  }

  async approvalProof(i: ApprovalProofInput): Promise<string | undefined> {
    return this.pinOf(i.approverId) === i.pin ? hmac(i.pin, i.approverId, i.pinV, approvalMsg(i)) : undefined;
  }

  /** What the identity service would answer for a session proof taken from an op. */
  async verifySession(i: Omit<SessionProofInput, "pin"> & { proof: string }): Promise<boolean> {
    const pin = this.pinOf(i.memberId);
    return pin !== undefined && (await hmac(pin, i.memberId, i.pinV, sessionMsg(i))) === i.proof;
  }

  async verifyApproval(i: Omit<ApprovalProofInput, "pin"> & { proof: string }): Promise<boolean> {
    const pin = this.pinOf(i.approverId);
    return pin !== undefined && (await hmac(pin, i.approverId, i.pinV, approvalMsg(i))) === i.proof;
  }
}
