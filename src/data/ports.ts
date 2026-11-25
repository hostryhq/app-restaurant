import type { MemberSummary, PinLogin, Session } from "@hostry/client-core";

/**
 * Seams between this app and client-core. The op and sync seams are client-core's own types (`ops/ports.ts`), re-exported
 * here so a screen imports one place. Only identity is still a stub; see docs/integration-notes.md.
 */
export type { BuildCtx, Delivery, OpWriter, RecordedOp, RecordSpec, SeriesDocType, SyncPort, SyncView } from "@hostry/client-core";

/** A person who can sign in on this device (from the offline pack). Extends client-core's `MemberSummary` with the role. */
export type Member = MemberSummary & { role: string };

export type PinResult =
  | { ok: true; session: Session }
  | { ok: false; reason: "wrong" | "delay" | "locked" | "pack_expired"; waitSeconds?: number };

export type ApproveResult =
  | { ok: true; approvalId: string; approverName: string }
  | { ok: false; reason: "wrong" | "same" | "not_allowed" | "locked" };

/**
 * Identity seam (ADR-0005). Stubbed until client-core auth lands its PIN verification and offline pack. Shaped like
 * client-core's `PinLogin`: `members()` and `signOut()` are the same; `signIn` returns a result instead of throwing, so a
 * screen can show the delay and lock states, and `asPinLogin` adapts it to the throwing form the core interface has.
 */
/** The record the approval is for and the reason, when the screen knows them: bound into the approval proof and recorded on `approval.grant`. */
export type ApprovalAbout = {
  /** The intent of the op that will cite the approval; when absent, the override intent of the permission. The action hash binds it. */
  intent?: string;
  /** `<entity>:<row id>` of the row the citing op inserts or sets. The action hash binds it. */
  target?: string;
  reason?: string;
  /** The values the citing op will record for the intent's `proof.binds` (ADR-0014 A3.3). An approval for another amount is `mismatch`. */
  values?: Record<string, unknown>;
};

export type OwnPinResult = { ok: true; approvalId: string } | { ok: false; reason: "wrong" | "locked" | "not_allowed" };

export interface IdentityPort extends Pick<PinLogin, "signOut"> {
  members(): Promise<Member[]>;
  signIn(memberId: string, pin: string): Promise<PinResult>;
  /** Approver check on the same device: the approver does not become the session user (ADR-0005 s8). */
  approve(approverId: string, pin: string, permission: string, requesterId: string, about?: ApprovalAbout): Promise<ApproveResult>;
  /** Members who hold `permission` and are not `exceptMemberId`. */
  approversFor(permission: string, exceptMemberId: string): Promise<Member[]>;
  /**
   * Own-PIN re-entry for an action the member may do themselves (ADR-0005 s8): records `approval.self_confirm` (requester =
   * approver = the member) and returns its id for the citing op. It never stands in for a manager's approval.
   */
  confirmOwnPin(memberId: string, pin: string, permission: string, about?: ApprovalAbout): Promise<OwnPinResult>;
  /** When the offline pack expires, RFC 3339 UTC. */
  packExpiresAt(): string;
}

export class PinLoginError extends Error {
  constructor(
    readonly reason: Exclude<PinResult, { ok: true }>["reason"],
    readonly waitSeconds?: number,
  ) {
    super(`pin login: ${reason}`);
    this.name = "PinLoginError";
  }
}

/** The client-core `PinLogin` view of an identity port: swap in the real implementation without touching callers of that interface. */
export function asPinLogin(id: IdentityPort): PinLogin {
  return {
    members: () => id.members(),
    signOut: () => id.signOut(),
    async signIn(memberId, pin) {
      const r = await id.signIn(memberId, pin);
      if (!r.ok) throw new PinLoginError(r.reason, r.waitSeconds);
      return r.session;
    },
  };
}
