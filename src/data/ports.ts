import type { Mutation, Row, StoreTx, SyncClient, SyncStatus as CoreSyncStatus, Session } from "@hostry/client-core";

/**
 * Seams between this app and the rest of client-core. The app codes to these interfaces so the three client-core
 * work streams (sync engine, printing, domain) compose; see docs/integration-notes.md for what is wired to what.
 */

/** Document types that take a number from a device series (client-core sync/schema DocType). */
export type SeriesDocType = "tax_invoice" | "bill_of_supply" | "plain_bill" | "credit_note";

/** Context handed to a build function inside the single-writer transaction. Same shape as the sync engine's BuildCtx. */
export type BuildCtx = {
  /** Corrected wall clock, ms. */
  now: number;
  /** Next legal number of the first active series of `docType`; allocated in the op's transaction. */
  number(docType: SeriesDocType): string;
  get(entity: string, id: string): Row | undefined;
  list(entity: string): Row[];
  newId(): string;
};

/** Same shape as the sync engine's RecordSpec (the part the app uses). */
export type RecordSpec = {
  intent: string;
  intentV?: number;
  /** Approval id when the action needed a manager's approval. */
  approval?: string;
  pii?: Record<string, unknown>;
  build: (ctx: BuildCtx) => Mutation[];
};

export type RecordedOp = { seq: number; intent: string; at: string; doc?: { type: string; number: string } };

/** The one way the UI changes data: an intent with mutations, written locally first. The sync engine implements this. */
export interface OpWriter {
  record(spec: RecordSpec): Promise<RecordedOp>;
}

export type { StoreTx };

/** Delivery of one of this device's own ops (client-core sync DeliveryState). */
export type Delivery = "local" | "at_hub" | "in_cloud";

/** What every screen shows (offline-first-sync invariant 9). Superset of the client-core SyncStatus stub. */
export type SyncView = CoreSyncStatus & {
  atHubOps: number;
  upstream: "hub" | "cloud" | "none";
  state: "synced" | "pending" | "offline" | "conflict";
  clockWrong: boolean;
};

export interface SyncPort extends Omit<SyncClient, "status" | "onStatus"> {
  status(): SyncView;
  onStatus(listener: (s: SyncView) => void): () => void;
}

/** A person who can sign in on this device (from the offline pack). */
export type Member = { memberId: string; displayName: string; role: string };

export type PinResult =
  | { ok: true; session: Session }
  | { ok: false; reason: "wrong" | "delay" | "locked" | "pack_expired"; waitSeconds?: number };

export type ApproveResult =
  | { ok: true; approvalId: string; approverName: string }
  | { ok: false; reason: "wrong" | "same" | "not_allowed" | "locked" };

/** Identity seam (ADR-0005). The real PinLogin and offline pack land with client-core auth; this app uses a stub. */
export interface IdentityPort {
  members(): Promise<Member[]>;
  signIn(memberId: string, pin: string): Promise<PinResult>;
  signOut(): Promise<void>;
  /** Approver check on the same device: the approver does not become the session user (ADR-0005 s8). */
  approve(approverId: string, pin: string, permission: string, requesterId: string): Promise<ApproveResult>;
  /** Members who hold `permission` and are not `exceptMemberId`. */
  approversFor(permission: string, exceptMemberId: string): Promise<Member[]>;
  /** Own-PIN re-entry for an action proof in a PIN session. */
  confirmOwnPin(memberId: string, pin: string): Promise<boolean>;
  /** When the offline pack expires, RFC 3339 UTC. */
  packExpiresAt(): string;
}
