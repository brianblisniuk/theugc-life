/**
 * B07 slice 1 shared types and version constants.
 *
 * D072 / docs/B07_GMAIL_COMMERCIAL_MEANING_CONTRACT.md. This slice's engine
 * kind is rules only. Model identity columns exist so provenance can name
 * them later; this code never sets them and the migration rejects non-null
 * model fields.
 */
import { TEXT_TRANSFORM_VERSION as REPLY_TEXT_TRANSFORM_VERSION } from "@/lib/gmail/reply/text-transform";

/** Semantic schema of the rows this slice writes. */
export const COMMERCIAL_SCHEMA_VERSION = "gmail_commercial_schema_v1";

/**
 * Input-shaping version. Embeds B06's text-transform version so a quote-
 * stripper bump changes this string and therefore the input digest.
 */
export const COMMERCIAL_TRANSFORM_VERSION = `gmail_commercial_text_v1+${REPLY_TEXT_TRANSFORM_VERSION}`;

/**
 * Deterministic rule identity. Any change to classification behavior must
 * bump this constant. The same version plus the same source digest is a
 * no-op, so a silent behavior change under an unchanged version is forbidden.
 */
export const COMMERCIAL_RULE_VERSION = "gmail_commercial_rules_v1";

export const ENGINE_KIND = "rules" as const;

export const DISPOSITIONS = ["positive", "negative", "neutral", "mixed", "ambiguous"] as const;
export type Disposition = (typeof DISPOSITIONS)[number];

export const COMMERCIAL_SIGNALS = [
  "agreement",
  "interest",
  "offer",
  "other_commercial",
  "redirect",
  "rejection",
  "request_information",
  "terms_discussion",
  "timing_constraint",
] as const;
export type CommercialSignal = (typeof COMMERCIAL_SIGNALS)[number];

export const THREAD_STATES = [
  "unresolved",
  "engaged",
  "negotiating",
  "agreement_observed",
  "declined_observed",
  "ambiguous",
] as const;
export type ThreadState = (typeof THREAD_STATES)[number];

export const COMPENSATION_STRUCTURES = [
  "paid",
  "in_kind",
  "hybrid",
  "unpaid",
  "other",
  "unknown",
] as const;
export type CompensationStructure = (typeof COMPENSATION_STRUCTURES)[number];

export const EVIDENCE_STRENGTHS = ["strong", "moderate", "weak", "insufficient_evidence"] as const;
export type EvidenceStrength = (typeof EVIDENCE_STRENGTHS)[number];

export const REPLY_NATURES = [
  "human_reply",
  "automated",
  "delivery",
  "not_reply",
  "uncertain",
] as const;
export type ReplyNature = (typeof REPLY_NATURES)[number];

export const BUSINESS_OUTCOMES = ["open", "won", "lost", "ghosted", "uncertain"] as const;
export type BusinessOutcome = (typeof BUSINESS_OUTCOMES)[number];

export const LOST_REASONS = ["rejected", "not_a_fit", "timing", "other"] as const;
export type LostReason = (typeof LOST_REASONS)[number];

export const HUMAN_AXES = [
  "reply_nature",
  "disposition",
  "signals",
  "business_outcome",
  "compensation",
] as const;
export type HumanAxis = (typeof HUMAN_AXES)[number];

export interface CommercialMessageInput {
  providerMessageId: string;
  providerSent: boolean;
  internalDateMs: number;
  /** Quote-stripped authored body. Null when B04 had nothing confidently authored. */
  cleanText: string | null;
  /** SQL eligibility: effective human reply, never a creator-sent message. */
  eligible: boolean;
}

export interface MessageCommercialMeaning {
  providerMessageId: string;
  disposition: Disposition;
  signals: CommercialSignal[];
  evidenceStrength: EvidenceStrength;
  /** Booking-confirmation phrase. Not a stored signal. Drives thread state only. */
  explicitBookingConfirmation: boolean;
}

export interface ThreadCommercialMeaning {
  commercialState: ThreadState | null;
  compensationStructure: CompensationStructure;
  evidenceStrength: EvidenceStrength;
  messages: MessageCommercialMeaning[];
}
