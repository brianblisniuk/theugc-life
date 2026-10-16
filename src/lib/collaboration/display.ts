/**
 * Labels for D078 compensation and deliverables.
 * Unknown is the word "Unknown". It is never rendered as zero.
 */
import { currencyExponent } from "./currencies";
import type { CollaborationWorkspace } from "./contract";

const STRUCTURE_LABEL: Record<string, string> = {
  paid: "Paid (cash only)",
  in_kind: "In-kind (product or stay)",
  hybrid: "Hybrid (product and cash)",
  unpaid: "Unpaid",
  other: "Other",
  unknown: "Unknown",
};

const PAYMENT_LABEL: Record<string, string> = {
  pending: "Pending",
  partially_paid: "Partially paid",
  paid: "Paid",
  not_applicable: "Not a cash payment",
};

const DELIVERABLE_LABEL: Record<string, string> = {
  reel: "Reel",
  story: "Story",
  post: "Post",
  tiktok: "TikTok",
  youtube: "YouTube",
  photo_set: "Photo set",
  ugc_video: "UGC video",
  other: "Other",
};

const STATUS_LABEL: Record<string, string> = {
  pending: "Pending",
  submitted: "Submitted",
  revision_requested: "Revision requested",
  approved: "Approved",
  rejected: "Rejected",
};

export function compensationStructureLabel(value: string): string {
  return STRUCTURE_LABEL[value] ?? "Unknown";
}

export function paymentStatusLabel(value: string): string {
  return PAYMENT_LABEL[value] ?? "Unknown";
}

export function deliverableTypeLabel(value: string): string {
  return DELIVERABLE_LABEL[value] ?? "Other";
}

export function deliverableStatusLabel(value: string): string {
  return STATUS_LABEL[value] ?? "Pending";
}

/** Major-unit string for an input. Null stays blank, not zero. */
export function minorToMajorInput(amount: number | null, currency: string | null): string {
  if (amount === null || currency === null) return "";
  const exponent = currencyExponent(currency);
  if (exponent === 0) return String(amount);
  const scale = 10 ** exponent;
  const whole = Math.floor(amount / scale);
  const fraction = String(amount % scale).padStart(exponent, "0");
  return `${whole}.${fraction}`;
}

/** Format integer minor units for display. Null is Unknown, never 0. */
export function formatMinor(amount: number | null, currency: string | null): string {
  if (amount === null || currency === null) return "Unknown";
  const exponent = currencyExponent(currency);
  const negative = amount < 0;
  const absolute = Math.abs(amount);
  const scale = 10 ** exponent;
  const whole = Math.floor(absolute / scale);
  const fraction = String(absolute % scale).padStart(exponent, "0");
  const body = exponent === 0 ? String(whole) : `${whole}.${fraction}`;
  return `${negative ? "-" : ""}${body} ${currency}`;
}

export function valuationLabel(valuation: CollaborationWorkspace["valuation"]): string {
  if (valuation.kind === "unknown" || valuation.total_minor === null) return "Unknown";
  if (valuation.reason === "unpaid") return "No compensation (unpaid)";
  return `Derived ${formatMinor(valuation.total_minor, valuation.currency)}`;
}

export function attributedValueLabel(
  value: CollaborationWorkspace["deliverables"][number]["attributed_value"],
): string {
  if (value.kind === "unknown" || value.basis === "unknown") return "Unknown";
  if (value.basis === "unpaid_explicit") return "No compensation (unpaid)";
  return `Derived ${formatMinor(value.amount_minor, value.currency)}`;
}
