/**
 * Entitlement snapshot carried in the offline pack's signed claims (api-specs `EntitlementSnapshot`; ADR-0003 s7, ADR-0008 S5).
 * It decides which OPTIONAL features a device offers and, per ADR-0014 A1.2, when a suspended or closed organisation stops
 * starting new trading. It never gates a sale in progress: an absent, stale or expired snapshot changes optional features
 * only (ADR-0014 T10, RM-N1). Billing state (overdue, unpaid) is not in it and never cuts off anything.
 */

export type OrganisationStatus = "trial" | "active" | "suspended" | "closed";

export type EntitlementSnapshot = {
  entitlements_v: number;
  plan_key?: string;
  plan_version?: number;
  /** Feature keys granted, sorted. Unknown keys are ignored, unlisted keys are not granted. */
  features: string[];
  limits: Record<string, number>;
  organisation_status: OrganisationStatus;
  /** Informational: stale never removes a feature or blocks trading. */
  valid_until?: string;
  as_of: string;
};

/** Feature keys this app knows (admin-a1-spec BR-A1-13). Core billing has no key: it is always allowed. */
export const FEATURE = { kds: "restaurant.kds", captain: "restaurant.captain", reportsCore: "restaurant.reports.core" } as const;

const STATUSES: readonly string[] = ["trial", "active", "suspended", "closed"];

/** Reads the `entitlements` claim. Anything malformed is treated as absent (`undefined`): a bad claim never stops trading. */
export function parseEntitlements(raw: unknown): EntitlementSnapshot | undefined {
  const s = raw as Partial<EntitlementSnapshot> | null | undefined;
  if (!s || typeof s !== "object") return undefined;
  if (!Number.isInteger(s.entitlements_v) || (s.entitlements_v as number) < 1) return undefined;
  if (!Array.isArray(s.features) || !s.features.every((f) => typeof f === "string")) return undefined;
  if (typeof s.organisation_status !== "string" || !STATUSES.includes(s.organisation_status)) return undefined;
  if (typeof s.as_of !== "string" || s.as_of.length === 0) return undefined;
  if (!s.limits || typeof s.limits !== "object") return undefined;
  return s as EntitlementSnapshot;
}

/** A device keeps the highest version it has seen: the newer snapshot wins only when its version is strictly higher. */
export function adoptEntitlements(current: EntitlementSnapshot | undefined, next: EntitlementSnapshot | undefined): EntitlementSnapshot | undefined {
  if (!next) return current;
  if (!current || next.entitlements_v > current.entitlements_v) return next;
  return current;
}

/** Whether an optional feature is offered. No snapshot: no optional feature is known, so none is offered (core billing is never asked). */
export function featureOn(snap: EntitlementSnapshot | undefined, key: string): boolean {
  return snap?.features.includes(key) === true;
}

const IST_MS = 330 * 60_000;
const istDate = (ms: number): string => new Date(ms + IST_MS).toISOString().slice(0, 10);

/** ADR-0014 A1.2: a day is "in progress" when it is open with a business date of today or yesterday in IST; one left open longer protects nothing. */
export function dayInProgress(openDates: readonly string[], nowMs: number): boolean {
  const today = istDate(nowMs);
  const yesterday = istDate(nowMs - 86_400_000);
  return openDates.some((d) => d === today || d === yesterday);
}

export type TradingStanding =
  | { startNew: true; status: OrganisationStatus; ending: boolean }
  /** Suspended or closed, and no day in progress: new trading does not start. */
  | { startNew: false; status: "suspended" | "closed"; ending: false };

/**
 * Suspension and closure apply on a device only after the trading day ends (A1.2). While a day is in progress trading goes
 * on (`ending: true` lets the UI say the day is the last). An absent snapshot or any other status never limits anything.
 */
export function tradingStanding(snap: EntitlementSnapshot | undefined, openDates: readonly string[], nowMs: number): TradingStanding {
  const status = snap?.organisation_status ?? "active";
  if (status !== "suspended" && status !== "closed") return { startNew: true, status, ending: false };
  if (dayInProgress(openDates, nowMs)) return { startNew: true, status, ending: true };
  return { startNew: false, status, ending: false };
}
