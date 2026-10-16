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

const REVOKE_PLAN = "rebill_revoke_plan:";
const REVOKE_PAYMENT = "rebill_revoke:";
const MONTHLY_PLANS = new Set(["pro_monthly", "max_monthly"]);
const ANNUAL_PLANS = new Set(["pro_annual", "max_annual"]);

/** Payment facts for one ledger reversal. A missing fact is not a guess. */
export interface ReversalEvidence {
  packGrant: number | null;
  purchase: {
    status: string;
    productType: string;
    productReference: string;
  } | null;
}

export function ledgerLabel(
  reason: CreditReason,
  idempotencyKey: string,
  delta = 0,
  evidence: ReversalEvidence = { packGrant: null, purchase: null },
): string {
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
  if (reason === "reversal" && idempotencyKey.startsWith("plan_expire:")) {
    return "Plan credits expired";
  }
  if (reason === "reversal" && idempotencyKey.startsWith("free_weekly_expire:")) {
    return "Weekly credits expired";
  }
  if (reason === "reversal") return reversalLabel(idempotencyKey, delta, evidence);
  return "Credit movement";
}

/**
 * `rebill_revoke:` is a monthly plan refund or a pack chargeback (or a pack
 * refund of unused credits). `rebill_revoke_plan:` is a plan chargeback or an
 * annual refund. The prefix alone does not choose the label (0081, D140).
 */
function reversalLabel(key: string, delta: number, evidence: ReversalEvidence): string {
  const parsed = revokePayment(key);
  if (!parsed) return "Credit reversal";
  const purchase = evidence.purchase;
  const reference = purchase?.productReference ?? "";
  const productType = purchase?.productType ?? "";
  const status = purchase?.status ?? "";
  const pack = productType === "credit_pack" || reference.startsWith("pack_");
  const monthly = MONTHLY_PLANS.has(reference);
  const annual = ANNUAL_PLANS.has(reference);
  const plan = productType === "plan" || monthly || annual;
  const refund = status === "refunded" || status === "partially_refunded";

  if (parsed.kind === "payment") {
    if (pack && status === "chargeback") {
      if (
        evidence.packGrant !== null &&
        evidence.packGrant > 0 &&
        Math.abs(delta) < evidence.packGrant
      ) {
        return "Unused pack credits reversed";
      }
      return "Pack credits reversed for a chargeback";
    }
    if (pack && refund) return "Unused pack credits reversed";
    if (monthly && refund) return "Unused plan credits reversed for that payment";
    if (
      !plan &&
      evidence.packGrant !== null &&
      evidence.packGrant > 0 &&
      Math.abs(delta) < evidence.packGrant
    ) {
      return "Unused pack credits reversed";
    }
    return "Credit reversal";
  }

  if (plan && status === "chargeback") return "Plan credits reversed for a chargeback";
  if (annual && refund) return "Unused plan credits reversed for a refunded annual payment";
  if (monthly && refund) return "Unused plan credits reversed for a refunded payment";
  return "Credit reversal";
}

function revokePayment(key: string): { kind: "plan" | "payment"; paymentId: string } | null {
  if (key.startsWith(REVOKE_PLAN)) {
    const paymentId = key.slice(REVOKE_PLAN.length);
    return paymentId.length > 0 ? { kind: "plan", paymentId } : null;
  }
  if (key.startsWith(REVOKE_PAYMENT)) {
    const paymentId = key.slice(REVOKE_PAYMENT.length);
    return paymentId.length > 0 ? { kind: "payment", paymentId } : null;
  }
  return null;
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

interface ParsedLedgerRow {
  id: string;
  reason: CreditReason;
  idempotencyKey: string;
  when: string;
  delta: number;
}

interface PaymentFact {
  status: string;
  productType: string;
  productReference: string;
}

function packGrant(rows: readonly ParsedLedgerRow[], paymentId: string): number | null {
  let grant = 0;
  let found = false;
  for (const row of rows) {
    if (row.idempotencyKey === `pack:${paymentId}` && row.delta > 0) {
      grant += row.delta;
      found = true;
    }
  }
  return found ? grant : null;
}

function paymentFacts(
  purchases: readonly unknown[],
  viewerId: string,
): Map<string, PaymentFact> | null {
  const facts = new Map<string, PaymentFact>();
  for (const raw of purchases) {
    const row = asRecord(raw);
    if (!row || row.user_id !== viewerId) return null;
    if (
      typeof row.provider_transaction_id !== "string" ||
      row.provider_transaction_id.length === 0
    ) {
      return null;
    }
    if (typeof row.status !== "string" || row.status.trim() === "") return null;
    const next: PaymentFact = {
      status: row.status.trim(),
      productType: typeof row.product_type === "string" ? row.product_type : "",
      productReference: typeof row.product_reference === "string" ? row.product_reference : "",
    };
    const existing = facts.get(row.provider_transaction_id);
    if (
      existing &&
      (existing.status !== next.status ||
        existing.productType !== next.productType ||
        existing.productReference !== next.productReference)
    ) {
      return null;
    }
    facts.set(row.provider_transaction_id, next);
  }
  return facts;
}

export function ledgerActivity(
  rows: readonly unknown[],
  viewerId: string,
  total: number | null,
  limit: number,
  purchases: readonly unknown[] = [],
): LedgerActivity {
  if (!viewerId || total === null || !Number.isInteger(total) || total < 0)
    return { kind: "error" };
  if (rows.length > limit) return { kind: "error" };
  const facts = paymentFacts(purchases, viewerId);
  if (!facts) return { kind: "error" };
  const parsed: ParsedLedgerRow[] = [];
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
    parsed.push({
      id: row.id,
      reason: row.reason,
      idempotencyKey: row.idempotency_key,
      when,
      delta,
    });
  }
  const movements: LedgerMovement[] = [];
  for (const row of parsed) {
    const payment = revokePayment(row.idempotencyKey);
    const purchase = payment ? (facts.get(payment.paymentId) ?? null) : null;
    movements.push({
      id: row.id,
      when: row.when,
      label: ledgerLabel(row.reason, row.idempotencyKey, row.delta, {
        packGrant: payment ? packGrant(parsed, payment.paymentId) : null,
        purchase,
      }),
      reason: row.reason,
      delta: row.delta,
      outcome: ledgerOutcome(row.reason, row.delta),
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
