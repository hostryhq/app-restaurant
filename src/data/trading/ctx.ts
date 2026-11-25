import { allocatorFromFn, can, istDateOf, stampingDate, type DocumentDeps, type Row, type Session } from "@hostry/client-core";
import type { PrintPort } from "../../devices/print-hub";
import type { AppData } from "../app-data";
import type { BuildCtx, SeriesDocType } from "../ports";
import type { BusinessDay, Check, OrderLine, OrderLineCancel } from "../../domain/rows";
import { linesOfCheck } from "../../domain/lines";

/** What every trading action needs. Built once by the app; tests build their own with fakes. */
export type TradingCtx = {
  data: AppData;
  session: () => Session | undefined;
  now: () => number;
  newId: () => string;
  print: PrintPort;
  outletId: string;
  /** Series/device prefix on KOT numbers and Z-reports ("A07"). */
  deviceCode: string;
  /** Paper bill-book series codes registered for this outlet, entry-only (from the offline pack `manual_books`, never from a constant). */
  manualBookCodes: string[];
  /** Member display name for printed documents. */
  nameOf: (memberId: string) => string;
  /** The outlet stream's version vector this device holds now `{origin: seq}`: what a Z-report covers (day_close.cutoff). */
  vector: () => Promise<Record<string, number>>;
};

export class PermissionError extends Error {
  constructor(readonly permission: string) {
    super(`permission: ${permission}`);
    this.name = "PermissionError";
  }
}

export type TradingErrorCode =
  | "no_open_day"
  | "no_open_shift"
  | "not_found"
  | "not_open"
  | "nothing_to_send"
  | "bad_gstin"
  | "payment_short"
  | "approval_needed"
  | "approval_expired"
  | "day_blocked"
  | "refused";

export class TradingError extends Error {
  constructor(
    readonly code: TradingErrorCode,
    detail?: string,
  ) {
    super(detail ? `${code}: ${detail}` : code);
    this.name = "TradingError";
  }
}

/** The signed-in member, or an error. Permission is checked on the last-synced grants (tenancy-auth-rbac). */
export function need(ctx: TradingCtx, permission: string, approvalId?: string): Session {
  const s = ctx.session();
  if (!s) throw new PermissionError("session");
  if (!can(s, permission, ctx.outletId, new Date(ctx.now())) && !approvalId) throw new PermissionError(permission);
  return s;
}

export const holds = (ctx: TradingCtx, permission: string): boolean => can(ctx.session(), permission, ctx.outletId, new Date(ctx.now()));

export type ListFn = (entity: string) => Row[];

/** Allocator over the transaction's number counter: the number is taken in the op's own transaction (ADR-0002 S7). */
export function depsFor(b: BuildCtx): DocumentDeps {
  return {
    allocator: allocatorFromFn((docType) => b.number(docType as SeriesDocType)),
    newId: b.newId,
    nowMs: b.now,
    businessDays: (b.list("business_day") as BusinessDay[]).map((d) => ({ business_date: d.business_date, status: d.status })),
  };
}

export function businessDateOf(list: ListFn): string | undefined {
  return stampingDate((list("business_day") as BusinessDay[]).map((d) => ({ business_date: d.business_date, status: d.status })));
}

export function requireDay(list: ListFn): string {
  const d = businessDateOf(list);
  if (!d) throw new TradingError("no_open_day");
  return d;
}

export function liveLines(list: ListFn, checkId: string): OrderLine[] {
  return linesOfCheck(checkId, list("order_line") as OrderLine[], list("order_line_cancel") as OrderLineCancel[]);
}

export function checkOf(list: ListFn, checkId: string): Check {
  const c = (list("check") as Check[]).find((x) => x.id === checkId);
  if (!c) throw new TradingError("not_found", `check ${checkId}`);
  return c;
}

export const isoNow = (ctx: TradingCtx): string => new Date(ctx.now()).toISOString();
export const todayIst = (ctx: TradingCtx): string => istDateOf(ctx.now());
