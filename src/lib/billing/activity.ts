/**
 * Billing activity labels (D007, D140).
 *
 * A ledger row is a movement that already happened. A missing read is not a
 * zero balance and not an empty ledger. A purchase or a subscription is not
 * access. Refund copy describes the rule. It does not invent a refund row.
 */
import { CREDITS_CONFIG } from "@/lib/credits/config";
import type { PlanChip } from "@/lib/screens/plan-chip";

export const CREDIT_REASONS = [
  "free_grant",
  "plan_grant",
  "pack_purchase",
  "admin_grant",
  "courtesy",
  "unlock",
  "reversal",
  "ai_draft",
] as const;

export type CreditReason = (typeof CREDIT_REASONS)[number];

export const REFUND_RULES = [
  "A refund of a monthly Pro or Max payment shortens only the period that payment bought. Unused plan credits from that period are reversed. Other paid periods stay.",
  "A pack refund reverses only the unused credits of that pack. The balance does not go below zero.",
  "A chargeback of a plan payment revokes the subscription and the unused plan credits.",
  "A payment, a subscription, or a checkout is not access. Access is an entitlement row.",
] as const;

export const LEDGER_EMPTY = "No credit movements yet.";
export const LEDGER_ERROR =
  "We couldn’t read your credit activity. This is not a zero balance and not an empty ledger.";
export const COMMERCE_EMPTY = "No payment records.";
export const COMMERCE_ERROR =
  "We couldn’t read your payment records. This is not “no payments” and it is not access.";
export const BALANCE_ERROR = "Credit balance unavailable.";
export const NOT_A_CHARGE = "This server does not charge a card. Checkout opens on Rebill.";

export interface LedgerMovement {
  id: string;
  when: string;
  label: string;
  reason: CreditReason;
  delta: number;
  outcome: string;
}

export type LedgerActivity =
  { kind: "error" } | { kind: "ok"; movements: LedgerMovement[]; used: number; capped: boolean };

export interface CommerceRecord {
  id: string;
  kind: "subscription" | "purchase";
  title: string;
  status: string;
  amount: string | null;
  when: string | null;
  refundedAt: string | null;
}

export type CommerceActivity =
  { kind: "error" } | { kind: "empty" } | { kind: "ok"; records: CommerceRecord[] };

export interface PlanAllowance {
  credits: number;
  note: string;
}

const DAY = new Intl.DateTimeFormat("en-GB", {
  timeZone: "UTC",
  day: "numeric",
  month: "short",
  year: "numeric",
});

function isReason(value: string): value is CreditReason {
  return (CREDIT_REASONS as readonly string[]).includes(value);
}

export function formatActivityWhen(value: string): string | null {
  if (typeof value !== "string" || value.trim() === "") return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return DAY.format(date);
}

export function ledgerLabel(reason: CreditReason, idempotencyKey: string): string {
  if (reason === "unlock") return "Hotel contact unlock";
  if (reason === "ai_draft") return "AI pitch draft";
  if (reason === "plan_grant") return "Plan credits";
  if (reason === "pack_purchase") return "Credit pack";
  if (reason === "admin_grant") return "Admin grant";
  if (reason === "courtesy") return "Courtesy credit";
  if (reason === "free_grant" && idempotencyKey.startsWith("free_weekly:")) {
    return "Weekly Free credits";
  }
  if (reason === "free_grant") return "Free credits";
  if (reason === "reversal" && idempotencyKey.startsWith("rebill_revoke_plan:")) {
    return "Plan credits reversed for a refunded payment";
  }
  if (reason === "reversal" && idempotencyKey.startsWith("rebill_revoke:")) {
    return "Unused pack credits reversed";
  }
  if (reason === "reversal" && idempotencyKey.startsWith("plan_expire:")) {
    return "Plan credits expired";
  }
  if (reason === "reversal" && idempotencyKey.startsWith("free_weekly_expire:")) {
    return "Weekly credits expired";
  }
  if (reason === "reversal") return "Credit reversal";
  return "Credit movement";
}

export function ledgerOutcome(reason: CreditReason, delta: number): string {
  if (reason === "unlock" && delta < 0) return "Charged";
  if (reason === "ai_draft" && delta < 0) return "Generated";
  if (reason === "reversal") return "Reversed";
  if (delta > 0) return "Added";
  return "Recorded";
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function integerDelta(value: unknown): number | null {
  if (typeof value === "number" && Number.isInteger(value) && value !== 0) return value;
  if (typeof value === "string" && /^-?\d+$/.test(value)) {
    const parsed = Number(value);
    if (Number.isSafeInteger(parsed) && parsed !== 0) return parsed;
  }
  return null;
}

/** Successful unlocks and AI drafts. Reversals are not spends. */
export function creditsUsed(movements: readonly LedgerMovement[]): number {
  return movements.reduce((sum, movement) => {
    if (movement.delta >= 0) return sum;
    if (movement.reason === "unlock" || movement.reason === "ai_draft") {
      return sum + Math.abs(movement.delta);
    }
    return sum;
  }, 0);
}

export function ledgerActivity(
  rows: readonly unknown[],
  viewerId: string,
  total: number | null,
  limit: number,
): LedgerActivity {
  if (!viewerId || total === null || !Number.isInteger(total) || total < 0)
    return { kind: "error" };
  if (rows.length > limit) return { kind: "error" };
  const movements: LedgerMovement[] = [];
  for (const raw of rows) {
    const row = asRecord(raw);
    if (!row) return { kind: "error" };
    if (row.user_id !== viewerId) return { kind: "error" };
    if (typeof row.id !== "string" || row.id.length === 0) return { kind: "error" };
    if (typeof row.reason !== "string" || !isReason(row.reason)) return { kind: "error" };
    if (typeof row.idempotency_key !== "string" || row.idempotency_key.length === 0) {
      return { kind: "error" };
    }
    if (typeof row.created_at !== "string") return { kind: "error" };
    const when = formatActivityWhen(row.created_at);
    const delta = integerDelta(row.delta);
    if (!when || delta === null) return { kind: "error" };
    movements.push({
      id: row.id,
      when,
      label: ledgerLabel(row.reason, row.idempotency_key),
      reason: row.reason,
      delta,
      outcome: ledgerOutcome(row.reason, delta),
    });
  }
  if (total > 0 && movements.length === 0) return { kind: "error" };
  if (movements.length > total) return { kind: "error" };
  return {
    kind: "ok",
    movements,
    used: creditsUsed(movements),
    capped: total > movements.length,
  };
}

function money(amount: unknown, currency: unknown): string | null | undefined {
  if (amount === null || amount === undefined) return null;
  const text =
    typeof amount === "number" && Number.isFinite(amount)
      ? String(amount)
      : typeof amount === "string" && amount.trim() !== "" && Number.isFinite(Number(amount))
        ? amount.trim()
        : null;
  if (text === null) return undefined;
  if (typeof currency !== "string" || currency.trim() === "") return text;
  return `${text} ${currency.trim()}`;
}

function optionalWhen(value: unknown): string | null | undefined {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string") return undefined;
  return formatActivityWhen(value);
}

export function commerceActivity(
  subscriptions: readonly unknown[],
  purchases: readonly unknown[],
  viewerId: string,
): CommerceActivity {
  if (!viewerId) return { kind: "error" };
  const records: CommerceRecord[] = [];
  for (const raw of subscriptions) {
    const row = asRecord(raw);
    if (!row || row.user_id !== viewerId) return { kind: "error" };
    if (typeof row.id !== "string" || typeof row.status !== "string" || row.status.trim() === "") {
      return { kind: "error" };
    }
    const amount = money(row.price_paid, row.currency);
    const when = optionalWhen(row.started_at);
    if (amount === undefined || when === undefined) return { kind: "error" };
    const title =
      typeof row.plan_code === "string" && row.plan_code.trim()
        ? row.plan_code.trim()
        : "Subscription";
    records.push({
      id: row.id,
      kind: "subscription",
      title,
      status: row.status.trim(),
      amount,
      when,
      refundedAt: null,
    });
  }
  for (const raw of purchases) {
    const row = asRecord(raw);
    if (!row || row.user_id !== viewerId) return { kind: "error" };
    if (typeof row.id !== "string" || typeof row.status !== "string" || row.status.trim() === "") {
      return { kind: "error" };
    }
    const amount = money(row.amount, row.currency);
    const when = optionalWhen(row.purchased_at ?? row.created_at);
    const refundedAt = optionalWhen(row.refunded_at);
    if (amount === undefined || when === undefined || refundedAt === undefined) {
      return { kind: "error" };
    }
    const parts = [row.product_type, row.product_reference].filter(
      (part): part is string => typeof part === "string" && part.trim() !== "",
    );
    records.push({
      id: row.id,
      kind: "purchase",
      title: parts.length > 0 ? parts.map((part) => part.trim()).join(" · ") : "Payment",
      status: row.status.trim(),
      amount,
      when,
      refundedAt,
    });
  }
  if (records.length === 0) return { kind: "empty" };
  return { kind: "ok", records };
}

/** Allowance printed from config. A failed plan read returns null, not Free. */
export function planAllowance(chip: PlanChip | null): PlanAllowance | null {
  if (chip === null) return null;
  if (chip === "Max") {
    return {
      credits: CREDITS_CONFIG.planMonthlyCredits.max,
      note: "Max credits each paid month",
    };
  }
  if (chip === "Pro") {
    return {
      credits: CREDITS_CONFIG.planMonthlyCredits.pro,
      note: "Pro credits each paid month",
    };
  }
  return {
    credits: CREDITS_CONFIG.freeWeeklyCredits,
    note: `Free credits every ${CREDITS_CONFIG.freeWeeklyPeriodDays} days`,
  };
}
