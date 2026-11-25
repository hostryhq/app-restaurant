import type { Session } from "@hostry/client-core";
import { can } from "@hostry/client-core";
import { afterAttempt, checkAttempt, emptyGuard, type GuardState } from "../../domain/pin-guard";
import { approvalActionHash } from "@hostry/client-core";
import type { ApprovalAbout, ApproveResult, IdentityPort, Member, PinResult } from "../ports";
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
export type ApprovalGrant = { approvalId: string; approverId: string; requesterId: string; permission: string; target: string; reason: string; actionHash: string; proof: string; packV: number; pinV: number; at: string };

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
    const m = this.pack.members.find((x) => x.memberId === approverId);
    if (!m) return { ok: false, reason: "wrong" };
    if (!this.holds(approverId, permission)) return { ok: false, reason: "not_allowed" };
    const g = this.guard(approverId);
    if (!g.ok) return { ok: false, reason: g.reason === "locked" ? "locked" : "wrong" };
    const approvalId = `appr-${this.pack.deviceId}-${this.now().toString(36)}-${++this.n}`;
    const at = this.stamp();
    const target = about.target ?? "";
    const reason = about.reason ?? "";
    const actionHash = await approvalActionHash({ approvalId, permission, requesterId, target });
    const input: ApprovalProofInput = { approvalId, approverId, pin, permission, requesterId, actionHash, target, reason, deviceId: this.pack.deviceId, packV: this.pack.packV, pinV: m.pinV, at };
    const proof = await this.o.prover.approvalProof(input);
    this.after(approverId, proof !== undefined);
    if (proof === undefined) return { ok: false, reason: "wrong" };
    await this.o.hooks?.approvalGranted?.({ approvalId, approverId, requesterId, permission, target, reason, actionHash, proof, packV: this.pack.packV, pinV: m.pinV, at });
    return { ok: true, approvalId, approverName: m.displayName };
  }

  async approversFor(permission: string, exceptMemberId: string): Promise<Member[]> {
    return this.pack.members
      .filter((m) => m.memberId !== exceptMemberId && this.holds(m.memberId, permission))
      .map((m) => ({ memberId: m.memberId, displayName: m.displayName, role: m.role }));
  }

  async confirmOwnPin(memberId: string, pin: string): Promise<boolean> {
    const m = this.pack.members.find((x) => x.memberId === memberId);
    const g = this.guard(memberId);
    if (!m || !g.ok) return false;
    // The check only: an own-action proof needs the action record (not wired in this app yet; see docs/integration-notes.md).
    const proof = await this.o.prover.sessionProof({ memberId, pin, sid: "own-pin-check", deviceId: this.pack.deviceId, packV: this.pack.packV, pinV: m.pinV, openedAt: this.stamp() });
    this.after(memberId, proof !== undefined);
    return proof !== undefined;
  }
}
