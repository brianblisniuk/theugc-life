/**
 * D078 vocabulary and validation for agreed compensation and deliverables.
 *
 * Creator-entered compensation is human truth. A B07 machine structure may be
 * shown as a suggestion. This module does not call a model and does not charge.
 */
import { z } from "zod";

import { isUuid } from "@/lib/hotels/ids";

import { ISO_CURRENCIES, MAX_MINOR_AMOUNT, isIsoCurrency, majorToMinor } from "./currencies";

function hybridSumFits(
  cash: number | null,
  estimate: number | null,
  sameCurrency: boolean,
): boolean {
  if (!sameCurrency || cash === null || estimate === null) return true;
  return cash <= MAX_MINOR_AMOUNT - estimate;
}

export const COMPENSATION_STRUCTURES = [
  "paid",
  "in_kind",
  "hybrid",
  "unpaid",
  "other",
  "unknown",
] as const;
export type CompensationStructure = (typeof COMPENSATION_STRUCTURES)[number];

export const PAYMENT_STATUSES = ["pending", "partially_paid", "paid", "not_applicable"] as const;
export type PaymentStatus = (typeof PAYMENT_STATUSES)[number];

export const DELIVERABLE_TYPES = [
  "reel",
  "story",
  "post",
  "tiktok",
  "youtube",
  "photo_set",
  "ugc_video",
  "other",
] as const;
export type DeliverableType = (typeof DELIVERABLE_TYPES)[number];

export const DELIVERABLE_STATUSES = ["pending", "submitted", "approved", "rejected"] as const;
export type DeliverableStatus = (typeof DELIVERABLE_STATUSES)[number];

export const PROOF_URL = /^https:\/\/[A-Za-z0-9.-]+(?::[0-9]{1,5})?(?:\/[^\s]*)?$/;

const CASH_PAYMENTS = ["pending", "partially_paid", "paid"] as const;

export function paymentStatusesFor(structure: CompensationStructure): readonly PaymentStatus[] {
  if (structure === "paid" || structure === "hybrid") return CASH_PAYMENTS;
  return ["not_applicable"];
}

const currencyCode = z
  .string()
  .trim()
  .toUpperCase()
  .refine(isIsoCurrency, "Choose a valid currency.");

const minorAmount = z.number().int().nonnegative().max(MAX_MINOR_AMOUNT);

export interface CompensationInput {
  structure: CompensationStructure;
  cashAmountMinor: number | null;
  cashCurrency: string | null;
  inKindDescription: string | null;
  inKindEstimateMinor: number | null;
  inKindEstimateCurrency: string | null;
  paymentStatus: PaymentStatus;
}

export interface DeliverableInput {
  deliverableId: string | null;
  deliverableType: DeliverableType;
  quantity: number;
  platform: string | null;
  dueOn: string | null;
  status: DeliverableStatus;
  proofUrl: string | null;
  notes: string | null;
}

function cleanText(value: unknown, max: number): string | null | undefined {
  if (value == null || value === "") return null;
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  if (trimmed.length > max) return undefined;
  return trimmed;
}

const DAY = /^\d{4}-\d{2}-\d{2}$/;

function isRealDay(value: string): boolean {
  if (!DAY.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number);
  if (!year || !month || !day) return false;
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
  );
}

export type FieldParse<T> = { ok: true; value: T } | { ok: false; message: string };

export function parseCompensationForm(fields: {
  structure?: unknown;
  cashAmount?: unknown;
  cashCurrency?: unknown;
  inKindDescription?: unknown;
  inKindEstimate?: unknown;
  inKindEstimateCurrency?: unknown;
  paymentStatus?: unknown;
}): FieldParse<CompensationInput> {
  const structureParsed = z.enum(COMPENSATION_STRUCTURES).safeParse(fields.structure);
  if (!structureParsed.success) return { ok: false, message: "Choose a compensation type." };
  const structure = structureParsed.data;
  const paymentParsed = z.enum(PAYMENT_STATUSES).safeParse(fields.paymentStatus);
  if (!paymentParsed.success) return { ok: false, message: "Choose a payment status." };
  const paymentStatus = paymentParsed.data;
  if (!paymentStatusesFor(structure).includes(paymentStatus)) {
    return { ok: false, message: "That payment status does not apply to this compensation type." };
  }

  const description = cleanText(fields.inKindDescription, 500);
  if (description === undefined) return { ok: false, message: "Shorten the in-kind description." };

  const needsCash = structure === "paid" || structure === "hybrid";
  const needsKind = structure === "in_kind" || structure === "hybrid";
  let cashAmountMinor: number | null = null;
  let cashCurrency: string | null = null;
  let inKindEstimateMinor: number | null = null;
  let inKindEstimateCurrency: string | null = null;

  if (needsCash) {
    if (typeof fields.cashAmount !== "string" || fields.cashAmount.trim() === "") {
      return { ok: false, message: "Enter the cash amount." };
    }
    const currency = currencyCode.safeParse(fields.cashCurrency);
    if (!currency.success) return { ok: false, message: "Choose a valid cash currency." };
    const minor = majorToMinor(fields.cashAmount, currency.data);
    if (!minor.ok) return { ok: false, message: "Enter a non-negative cash amount." };
    cashAmountMinor = minor.minor;
    cashCurrency = currency.data;
  } else if (present(fields.cashAmount) || present(fields.cashCurrency)) {
    return { ok: false, message: "Cash applies only to paid or hybrid compensation." };
  }

  if (needsKind) {
    if (!description) return { ok: false, message: "Describe the product or stay." };
    const estimateRaw =
      typeof fields.inKindEstimate === "string" ? fields.inKindEstimate.trim() : "";
    const estimateCurrencyRaw =
      typeof fields.inKindEstimateCurrency === "string" ? fields.inKindEstimateCurrency.trim() : "";
    if (estimateRaw !== "" || estimateCurrencyRaw !== "") {
      if (estimateRaw === "" || estimateCurrencyRaw === "") {
        return { ok: false, message: "An in-kind estimate needs both an amount and a currency." };
      }
      const currency = currencyCode.safeParse(estimateCurrencyRaw);
      if (!currency.success) return { ok: false, message: "Choose a valid estimate currency." };
      const minor = majorToMinor(estimateRaw, currency.data);
      if (!minor.ok) return { ok: false, message: "Enter a non-negative in-kind estimate." };
      inKindEstimateMinor = minor.minor;
      inKindEstimateCurrency = currency.data;
    }
  } else if (
    description ||
    present(fields.inKindEstimate) ||
    present(fields.inKindEstimateCurrency)
  ) {
    return {
      ok: false,
      message: "An in-kind description applies only to in-kind or hybrid compensation.",
    };
  }

  const parsed = compensationShape.safeParse({
    structure,
    cashAmountMinor,
    cashCurrency,
    inKindDescription: needsKind ? description : null,
    inKindEstimateMinor,
    inKindEstimateCurrency,
    paymentStatus,
  });
  if (!parsed.success) return { ok: false, message: "Check the compensation details." };
  return { ok: true, value: parsed.data };
}

function present(value: unknown): boolean {
  return typeof value === "string" ? value.trim() !== "" : value != null && value !== "";
}

const compensationShape = z
  .object({
    structure: z.enum(COMPENSATION_STRUCTURES),
    cashAmountMinor: minorAmount.nullable(),
    cashCurrency: z.enum(ISO_CURRENCIES).nullable(),
    inKindDescription: z.string().trim().min(1).max(500).nullable(),
    inKindEstimateMinor: minorAmount.nullable(),
    inKindEstimateCurrency: z.enum(ISO_CURRENCIES).nullable(),
    paymentStatus: z.enum(PAYMENT_STATUSES),
  })
  .superRefine((value, ctx) => {
    const cash = value.cashAmountMinor !== null || value.cashCurrency !== null;
    const estimate = value.inKindEstimateMinor !== null || value.inKindEstimateCurrency !== null;
    const estimatePair =
      (value.inKindEstimateMinor === null) === (value.inKindEstimateCurrency === null);
    const fail = (message: string) => ctx.addIssue({ code: z.ZodIssueCode.custom, message });
    if (!estimatePair) fail("An in-kind estimate needs both an amount and a currency.");
    if (value.structure === "paid") {
      if (value.cashAmountMinor === null || value.cashCurrency === null)
        fail("Paid compensation needs a cash amount.");
      if (value.inKindDescription || estimate) fail("Paid compensation is cash only.");
      if (!CASH_PAYMENTS.includes(value.paymentStatus as (typeof CASH_PAYMENTS)[number])) {
        fail("Paid compensation has a cash payment status.");
      }
    } else if (value.structure === "in_kind") {
      if (cash) fail("In-kind compensation has no cash amount.");
      if (!value.inKindDescription) fail("Describe the product or stay.");
      if (value.paymentStatus !== "not_applicable")
        fail("In-kind compensation is not a cash payment.");
    } else if (value.structure === "hybrid") {
      if (value.cashAmountMinor === null || value.cashCurrency === null)
        fail("Hybrid compensation needs a cash amount.");
      if (!value.inKindDescription) fail("Describe the product or stay.");
      if (!CASH_PAYMENTS.includes(value.paymentStatus as (typeof CASH_PAYMENTS)[number])) {
        fail("Hybrid compensation has a cash payment status.");
      }
      if (
        !hybridSumFits(
          value.cashAmountMinor,
          value.inKindEstimateMinor,
          value.cashCurrency !== null && value.cashCurrency === value.inKindEstimateCurrency,
        )
      ) {
        fail("The cash amount and in-kind estimate are too large to add together.");
      }
    } else if (
      cash ||
      value.inKindDescription ||
      estimate ||
      value.paymentStatus !== "not_applicable"
    ) {
      fail("This compensation type does not take an amount.");
    }
  });

export function parseDeliverableForm(fields: {
  deliverableId?: unknown;
  deliverableType?: unknown;
  quantity?: unknown;
  platform?: unknown;
  dueOn?: unknown;
  status?: unknown;
  proofUrl?: unknown;
  notes?: unknown;
}): FieldParse<DeliverableInput> {
  const deliverableId =
    fields.deliverableId == null || fields.deliverableId === ""
      ? null
      : typeof fields.deliverableId === "string" && isUuid(fields.deliverableId)
        ? fields.deliverableId
        : undefined;
  if (deliverableId === undefined)
    return { ok: false, message: "That deliverable could not be saved." };

  const deliverableType = z.enum(DELIVERABLE_TYPES).safeParse(fields.deliverableType);
  if (!deliverableType.success) return { ok: false, message: "Choose a deliverable type." };
  const status = z.enum(DELIVERABLE_STATUSES).safeParse(fields.status);
  if (!status.success) return { ok: false, message: "Choose a deliverable status." };

  const quantityRaw =
    typeof fields.quantity === "string" ? fields.quantity.trim() : fields.quantity;
  const quantity = z.coerce.number().int().min(1).max(10_000).safeParse(quantityRaw);
  if (!quantity.success)
    return { ok: false, message: "Quantity must be a whole number of at least 1." };

  const platform = cleanText(fields.platform, 80);
  if (platform === undefined) return { ok: false, message: "Shorten the platform." };
  const notes = cleanText(fields.notes, 2000);
  if (notes === undefined) return { ok: false, message: "Shorten the notes." };

  let dueOn: string | null = null;
  if (present(fields.dueOn)) {
    if (typeof fields.dueOn !== "string" || !isRealDay(fields.dueOn)) {
      return { ok: false, message: "Enter a real due date." };
    }
    dueOn = fields.dueOn;
  }

  let proofUrl: string | null = null;
  if (present(fields.proofUrl)) {
    if (typeof fields.proofUrl !== "string") return { ok: false, message: "Enter an https link." };
    const trimmed = fields.proofUrl.trim();
    if (trimmed.length > 2000 || !PROOF_URL.test(trimmed)) {
      return { ok: false, message: "Proof must be an https link." };
    }
    proofUrl = trimmed;
  }

  return {
    ok: true,
    value: {
      deliverableId,
      deliverableType: deliverableType.data,
      quantity: quantity.data,
      platform,
      dueOn,
      status: status.data,
      proofUrl,
      notes,
    },
  };
}

export function parsePrefillForm(fields: {
  mailAccountId?: unknown;
  providerThreadId?: unknown;
}): FieldParse<{ mailAccountId: string; providerThreadId: string }> {
  if (typeof fields.mailAccountId !== "string" || !isUuid(fields.mailAccountId)) {
    return { ok: false, message: "Choose your own mailbox." };
  }
  if (typeof fields.providerThreadId !== "string") {
    return { ok: false, message: "Enter the Gmail thread." };
  }
  const providerThreadId = fields.providerThreadId.trim();
  if (providerThreadId.length < 1 || providerThreadId.length > 256) {
    return { ok: false, message: "Enter the Gmail thread." };
  }
  return { ok: true, value: { mailAccountId: fields.mailAccountId, providerThreadId } };
}

const attributedValueSchema = z
  .object({
    kind: z.enum(["unknown", "derived"]),
    label: z.enum(["unknown", "derived"]),
    basis: z.enum(["unknown", "unpaid_explicit", "allocated"]),
    amount_minor: z.number().int().nonnegative().max(MAX_MINOR_AMOUNT).nullable(),
    currency: z.enum(ISO_CURRENCIES).nullable(),
  })
  .strict()
  .superRefine((value, ctx) => {
    const fail = (message: string) => ctx.addIssue({ code: z.ZodIssueCode.custom, message });
    if (value.kind !== value.label) fail("The value label must match its kind.");
    if (value.kind === "unknown") {
      if (value.amount_minor !== null || value.currency !== null || value.basis !== "unknown") {
        fail("Unknown value must not be stored as an amount.");
      }
    } else if (value.basis === "unpaid_explicit") {
      if (value.amount_minor !== 0 || value.currency !== null)
        fail("Unpaid must be an explicit zero.");
    } else if (value.basis === "allocated") {
      if (value.amount_minor === null || value.currency === null)
        fail("An allocated value needs an amount and a currency.");
    } else {
      fail("A derived value needs a basis.");
    }
  });

export const workspacePayloadSchema = z
  .object({
    result: z.literal("ok"),
    compensation: z
      .object({
        authority: z.literal("creator"),
        structure: z.enum(COMPENSATION_STRUCTURES),
        cash_amount_minor: z.number().int().nonnegative().max(MAX_MINOR_AMOUNT).nullable(),
        cash_currency: z.enum(ISO_CURRENCIES).nullable(),
        in_kind_description: z.string().nullable(),
        in_kind_estimate_minor: z.number().int().nonnegative().max(MAX_MINOR_AMOUNT).nullable(),
        in_kind_estimate_currency: z.enum(ISO_CURRENCIES).nullable(),
        in_kind_estimate_label: z.literal("creator_estimate").nullable(),
        payment_status: z.enum(PAYMENT_STATUSES),
      })
      .strict()
      .nullable(),
    suggestion: z
      .object({
        authority: z.literal("machine_suggestion"),
        structure: z.enum(COMPENSATION_STRUCTURES),
        source_mail_account_id: z.string().uuid(),
        source_provider_thread_id: z.string().min(1),
        source_attempt_id: z.string().uuid(),
        rule_version: z.string().min(1),
      })
      .strict()
      .nullable(),
    valuation: z
      .object({
        kind: z.enum(["unknown", "derived"]),
        label: z.enum(["unknown", "derived"]),
        reason: z.enum([
          "no_creator_compensation",
          "structure_unknown",
          "structure_other",
          "in_kind_estimate_missing",
          "hybrid_incomplete",
          "currency_mismatch",
          "unpaid",
          "allocated",
        ]),
        currency: z.enum(ISO_CURRENCIES).nullable(),
        total_minor: z.number().int().nonnegative().max(MAX_MINOR_AMOUNT).nullable(),
      })
      .strict(),
    deliverables: z.array(
      z
        .object({
          id: z.string().uuid(),
          deliverable_type: z.enum(DELIVERABLE_TYPES),
          quantity: z.number().int().min(1).max(10_000),
          platform: z.string().nullable(),
          due_on: z.string().nullable(),
          status: z.enum(DELIVERABLE_STATUSES),
          proof_url: z.string().nullable(),
          notes: z.string().nullable(),
          attributed_value: attributedValueSchema,
        })
        .strict(),
    ),
  })
  .strict()
  .superRefine((value, ctx) => {
    const fail = (message: string) => ctx.addIssue({ code: z.ZodIssueCode.custom, message });
    if (value.valuation.kind !== value.valuation.label)
      fail("Valuation label must match its kind.");
    if (value.valuation.kind === "unknown" && value.valuation.total_minor !== null) {
      fail("Unknown valuation must not be zero or any other amount.");
    }
    if (value.valuation.reason === "unpaid") {
      if (value.valuation.kind !== "derived" || value.valuation.total_minor !== 0) {
        fail("Unpaid valuation is an explicit zero.");
      }
    }
    if (value.valuation.reason === "allocated") {
      if (value.valuation.total_minor === null || value.valuation.currency === null) {
        fail("Allocated valuation needs a total.");
      }
    }
    if (value.compensation === null && value.valuation.reason !== "no_creator_compensation") {
      fail("Without creator compensation the value is unknown.");
    }
    const total = value.deliverables.reduce((sum, row) => {
      const amount = row.attributed_value.amount_minor;
      return sum + (amount ?? 0);
    }, 0);
    if (value.valuation.reason === "allocated" && value.deliverables.length > 0) {
      if (total !== value.valuation.total_minor)
        fail("Derived shares must add up to the agreed total.");
    }
    for (const row of value.deliverables) {
      if (value.valuation.kind === "unknown" && row.attributed_value.kind !== "unknown") {
        fail("A piece cannot have a number when the compensation value is unknown.");
      }
    }
  });

export type CollaborationWorkspace = z.infer<typeof workspacePayloadSchema>;

export function parseWorkspacePayload(data: unknown): CollaborationWorkspace | null {
  const parsed = workspacePayloadSchema.safeParse(data);
  return parsed.success ? parsed.data : null;
}
