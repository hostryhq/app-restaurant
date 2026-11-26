import type { Session } from "@hostry/client-core";
import { INTENTS, approvalActionHash, can } from "@hostry/client-core";
import { afterAttempt, checkAttempt, emptyGuard, type GuardState } from "../../domain/pin-guard";
import type { ApprovalAbout, ApproveResult, IdentityPort, Member, OwnPinResult, PinResult } from "../ports";
import type { ApprovalProofInput, DevicePack, PinProver, SessionProofInput } from "./pack";

/**
 * Identity behind `IdentityPort`, built from the device's offline pack (ADR-0005): the staff list, their permissions and
 * PIN versions, the pack version and the pack expiry all come from `DevicePack`. The PIN check and the proofs come from
 * a `PinProver` (the native shell: Argon2id verifier and proof key); the browser dev build uses the fixture prover in
 * `src/fixtures/demo-pack.ts`. Permissions are checked, never role names. The local wrong-PIN delay and lock
 * (`pin-guard`) run here and never wait on the network.
 */

/** What a successful sign-in must record as `session.open` (ADR-0005 A3.1): the proof and the integers it binds. */
export type SessionOpen = { sid: string; memberId: string; proof: string; packV: number; pinV: number; openedAt: string };
/** What a successful approval must record as `approval.grant` (A3.1). */
export type ApprovalGrant = {
  approvalId: string;
  approverId: string;
  requesterId: string;
  permission: string;
  /** The intent the approval is for, and the row it concerns: both are in the record and bound into the action hash. */
  intent: string;
  target: string;
  reason: string;
  actionHash: string;
  proof: string;
  packV: number;
  pinV: number;
  /** The approval time the proof binds: the op's `at`. */
  at: string;
  /** Own-PIN reconfirmation: recorded as `approval.self_confirm`, requester = approver. */
  self: boolean;
};

/** The intent a permission is overridden through, when the screen does not name one (`override: true` in the intent registry). */
function overrideIntentOf(permission: string): string {
  return Object.entries(INTENTS).find(([, d]) => d.permission === permission && d.override)?.[0] ?? Object.entries(INTENTS).find(([, d]) => d.permission === permission)?.[0] ?? permission;
}

export type PackIdentityHooks = {
  sessionOpened?(o: SessionOpen): Promise<void>;
  approvalGranted?(a: ApprovalGrant): Promise<void>;
};

export type PackIdentityOptions = {
  pack: DevicePack;
  prover: PinProver;
  now?: () => number;
  /** Session lifetime in ms (shared device: 12 h at most). */
  sessionMs?: number;
  /** Time stamped on a proof-bearing op: the engine's own clock, so the `at` the op records is the `at` the proof binds. */
  stamp?: () => string;
  hooks?: PackIdentityHooks;
};

export class PackIdentity implements IdentityPort {
  private readonly guards = new Map<string, GuardState>();
  private readonly now: () => number;
  private n = 0;

  constructor(private readonly o: PackIdentityOptions) {
    this.now = o.now ?? Date.now;
  }

  private get pack(): DevicePack {
    return this.o.pack;
  }

  private stamp(): string {
    return this.o.stamp ? this.o.stamp() : new Date(this.now()).toISOString();
  }

  async members(): Promise<Member[]> {
    return this.pack.members.map((m) => ({ memberId: m.memberId, displayName: m.displayName, role: m.role }));
  }

  packExpiresAt(): string {
    return this.pack.expiresAt;
  }

  private guard(memberId: string): { ok: true } | { ok: false; reason: "delay" | "locked"; waitSeconds: number } {
    const a = checkAttempt(this.guards.get(memberId) ?? emptyGuard(), this.now());
    return a.allowed ? { ok: true } : { ok: false, reason: a.reason, waitSeconds: a.waitSeconds };
  }

  private after(memberId: string, correct: boolean): void {
    this.guards.set(memberId, afterAttempt(this.guards.get(memberId) ?? emptyGuard(), correct, this.now()));
  }

  async signIn(memberId: string, pin: string): Promise<PinResult> {
    if (Date.parse(this.pack.expiresAt) <= this.now()) return { ok: false, reason: "pack_expired" };
    const g = this.guard(memberId);
    if (!g.ok) return { ok: false, reason: g.reason, waitSeconds: g.waitSeconds };
    const m = this.pack.members.find((x) => x.memberId === memberId);
    const sid = this.sessionId();
    const openedAt = this.stamp();
    const input: SessionProofInput = { memberId, pin, sid, deviceId: this.pack.deviceId, packV: this.pack.packV, pinV: m?.pinV ?? 0, openedAt };
    const proof = m ? await this.o.prover.sessionProof(input) : undefined;
    this.after(memberId, proof !== undefined);
    if (!m || proof === undefined) return { ok: false, reason: "wrong" };
    const session = this.sessionFor(m.memberId, sid);
    await this.o.hooks?.sessionOpened?.({ sid, memberId, proof, packV: this.pack.packV, pinV: m.pinV, openedAt });
    return { ok: true, session };
  }

  private sessionId(): string {
    return `s-${this.pack.deviceId}-${this.now().toString(36)}-${++this.n}`;
  }

  private sessionFor(memberId: string, sessionId: string): Session {
    const m = this.pack.members.find((x) => x.memberId === memberId);
    return {
      tenantId: this.pack.tenantId,
      memberId,
      deviceId: this.pack.deviceId,
      sessionId,
      kind: "shared",
      grants: [{ outlets: [this.pack.outletId], perms: m?.perms ?? [] }],
      expiresAt: new Date(this.now() + (this.o.sessionMs ?? 12 * 3_600_000)).toISOString(),
      offline: true,
    };
  }

  async signOut(): Promise<void> {}

  private holds(memberId: string, permission: string): boolean {
    return can(this.sessionFor(memberId, "probe"), permission, this.pack.outletId, new Date(this.now()));
  }

  async approve(approverId: string, pin: string, permission: string, requesterId: string, about: ApprovalAbout = {}): Promise<ApproveResult> {
    if (approverId === requesterId) return { ok: false, reason: "same" };
    return this.grant(approverId, pin, permission, requesterId, about, false);
  }

  /**
   * One approval record and proof. The action hash binds the intent, permission, requester, the target row, the approval id,
   * the reason and the values the citing op will record (protocol "Action hash"); the proof message binds the hash, so an
   * approval for another amount or row cannot be used for this one.
   */
  private async grant(approverId: string, pin: string, permission: string, requesterId: string, about: ApprovalAbout, self: boolean): Promise<ApproveResult> {
    const m = this.pack.members.find((x) => x.memberId === approverId);
    if (!m) return { ok: false, reason: "wrong" };
    if (!this.holds(approverId, permission)) return { ok: false, reason: "not_allowed" };
    const g = this.guard(approverId);
    if (!g.ok) return { ok: false, reason: g.reason === "locked" ? "locked" : "wrong" };
    const approvalId = `appr-${this.pack.deviceId}-${this.now().toString(36)}-${++this.n}`;
    const at = this.stamp();
    const intent = about.intent ?? overrideIntentOf(permission);
    const target = about.target ?? "";
    const reason = about.reason ?? "";
    const actionHash = await approvalActionHash({ intent, permission, requester: requesterId, target, approvalId, reason, values: about.values ?? {} });
    const input: ApprovalProofInput = { approvalId, approverId, pin, permission, requesterId, actionHash, target, reason, deviceId: this.pack.deviceId, packV: this.pack.packV, pinV: m.pinV, at };
    const proof = await this.o.prover.approvalProof(input);
    this.after(approverId, proof !== undefined);
    if (proof === undefined) return { ok: false, reason: "wrong" };
    await this.o.hooks?.approvalGranted?.({ approvalId, approverId, requesterId, permission, intent, target, reason, actionHash, proof, packV: this.pack.packV, pinV: m.pinV, at, self });
    return { ok: true, approvalId, approverName: m.displayName };
  }

  async approversFor(permission: string, exceptMemberId: string): Promise<Member[]> {
    return this.pack.members
      .filter((m) => m.memberId !== exceptMemberId && this.holds(m.memberId, permission))
      .map((m) => ({ memberId: m.memberId, displayName: m.displayName, role: m.role }));
  }

  async confirmOwnPin(memberId: string, pin: string, permission: string, about: ApprovalAbout = {}): Promise<OwnPinResult> {
    const r = await this.grant(memberId, pin, permission, memberId, about, true);
    return r.ok ? { ok: true, approvalId: r.approvalId } : { ok: false, reason: r.reason === "same" ? "wrong" : r.reason };
  }
}
