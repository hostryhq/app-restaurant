import type { Session } from "@hostry/client-core";
import { can } from "@hostry/client-core";
import { afterAttempt, checkAttempt, emptyGuard, type GuardState } from "../domain/pin-guard";
import type { ApproveResult, IdentityPort, Member, PinResult } from "./ports";
import { OUTLET_ID, TENANT_ID } from "./seed";

/**
 * Identity stub behind `IdentityPort` until client-core auth (ADR-0005 offline pack, PIN verification, approvals) lands.
 * Roles map to permission strings from api-specs sync/intents (permissions are checked, never role names). The role
 * templates are assumptions the security review and ADR-0005 role templates must confirm. PINs here are demo fixtures.
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

export type StubMember = { memberId: string; displayName: string; role: keyof typeof ROLE_PERMS | string; pin: string };

export const DEMO_MEMBERS: StubMember[] = [
  { memberId: "m-asha", displayName: "Asha", role: "cashier", pin: "1111" },
  { memberId: "m-ravi", displayName: "Ravi", role: "waiter", pin: "2222" },
  { memberId: "m-meena", displayName: "Meena", role: "manager", pin: "333333" },
  { memberId: "m-anand", displayName: "Anand", role: "owner", pin: "444444" },
];

export type StubOptions = {
  members?: StubMember[];
  now?: () => number;
  deviceId?: string;
  /** Offline pack expiry, RFC 3339 UTC. */
  packExpiresAt?: string;
  /** Session lifetime in ms (shared device: 12 h at most). */
  sessionMs?: number;
};

export class StubIdentity implements IdentityPort {
  private readonly members_: StubMember[];
  private readonly guards = new Map<string, GuardState>();
  private readonly now: () => number;
  private readonly pack: string;
  private n = 0;

  constructor(private readonly o: StubOptions = {}) {
    this.members_ = o.members ?? DEMO_MEMBERS;
    this.now = o.now ?? Date.now;
    this.pack = o.packExpiresAt ?? new Date(this.now() + 7 * 86_400_000).toISOString();
  }

  async members(): Promise<Member[]> {
    return this.members_.map((m) => ({ memberId: m.memberId, displayName: m.displayName, role: m.role }));
  }

  packExpiresAt(): string {
    return this.pack;
  }

  private try(memberId: string, pin: string): { ok: true; m: StubMember } | { ok: false; reason: "wrong" | "delay" | "locked"; waitSeconds?: number } {
    const m = this.members_.find((x) => x.memberId === memberId);
    const g = this.guards.get(memberId) ?? emptyGuard();
    const a = checkAttempt(g, this.now());
    if (!a.allowed) return { ok: false, reason: a.reason, waitSeconds: a.waitSeconds };
    const correct = m !== undefined && m.pin === pin;
    this.guards.set(memberId, afterAttempt(g, correct, this.now()));
    return correct && m ? { ok: true, m } : { ok: false, reason: "wrong" };
  }

  async signIn(memberId: string, pin: string): Promise<PinResult> {
    if (Date.parse(this.pack) <= this.now()) return { ok: false, reason: "pack_expired" };
    const r = this.try(memberId, pin);
    if (!r.ok) return { ok: false, reason: r.reason, ...(r.waitSeconds !== undefined ? { waitSeconds: r.waitSeconds } : {}) };
    return { ok: true, session: this.sessionFor(r.m) };
  }

  private sessionFor(m: StubMember): Session {
    return {
      tenantId: TENANT_ID,
      memberId: m.memberId,
      deviceId: this.o.deviceId ?? "dev-1",
      sessionId: `s-${++this.n}`,
      kind: "shared",
      grants: [{ outlets: [OUTLET_ID], perms: ROLE_PERMS[m.role] ?? [] }],
      expiresAt: new Date(this.now() + (this.o.sessionMs ?? 12 * 3_600_000)).toISOString(),
      offline: true,
    };
  }

  async signOut(): Promise<void> {}

  async approve(approverId: string, pin: string, permission: string, requesterId: string): Promise<ApproveResult> {
    if (approverId === requesterId) return { ok: false, reason: "same" };
    const m = this.members_.find((x) => x.memberId === approverId);
    if (!m) return { ok: false, reason: "wrong" };
    if (!can(this.sessionFor(m), permission, OUTLET_ID, new Date(this.now()))) return { ok: false, reason: "not_allowed" };
    const r = this.try(approverId, pin);
    if (!r.ok) return { ok: false, reason: r.reason === "locked" ? "locked" : "wrong" };
    return { ok: true, approvalId: `appr-${++this.n}`, approverName: m.displayName };
  }

  async approversFor(permission: string, exceptMemberId: string): Promise<Member[]> {
    return this.members_
      .filter((m) => m.memberId !== exceptMemberId && can(this.sessionFor(m), permission, OUTLET_ID, new Date(this.now())))
      .map((m) => ({ memberId: m.memberId, displayName: m.displayName, role: m.role }));
  }

  async confirmOwnPin(memberId: string, pin: string): Promise<boolean> {
    return this.try(memberId, pin).ok;
  }
}
