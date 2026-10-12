/**
 * Deterministic commercial-meaning rules (D072 §3–§8, §17, §27).
 *
 * Conservative on purpose:
 * - redirect is never rejection
 * - timing_constraint is never a permanent decline
 * - uncertainty is ambiguous
 * - politeness alone is not positive
 * - an offer is not agreement_observed
 * - unknown compensation is not unpaid
 * - no numeric confidence and no model call
 *
 * Subject lines are ignored. A subject can quote the other party's words
 * ("Re: We agree") and is not the authored body §16 classifies.
 */
import {
  COMMERCIAL_SIGNALS,
  type CommercialMessageInput,
  type CommercialSignal,
  type CompensationStructure,
  type Disposition,
  type EvidenceStrength,
  type MessageCommercialMeaning,
  type ThreadCommercialMeaning,
  type ThreadState,
} from "@/lib/gmail/commercial/contract";

const SIGNAL_RANK = new Map<CommercialSignal, number>(
  COMMERCIAL_SIGNALS.map((signal, index) => [signal, index]),
);

function normalize(text: string): string {
  return text.replace(/\s+/g, " ").trim().toLowerCase();
}

function has(text: string, pattern: RegExp): boolean {
  pattern.lastIndex = 0;
  return pattern.test(text);
}

const REDIRECT = [
  /\bcan'?t sign (this |it )?off\b/,
  /\bcannot sign (this |it )?off\b/,
  /\bno puedo aprobar/,
  /\bno puedo firmar/,
  /\bvisto bueno\b/,
  /\bde la central\b/,
  /\bregional approval\b/,
  /\bplease (contact|speak with|talk to|reach out to)\b/,
  /\bcontact our\b/,
  /\bspeak with\b/,
];

/** First-person / this-party decline of THIS opportunity. Not "rejecting" about someone else. */
const REJECTION = [
  /\baren'?t accepting\b/,
  /\bare not accepting\b/,
  /\bnot accepting collaborations\b/,
  /\bwe (must|have to) decline\b/,
  /\bwe cannot (accept|proceed|move forward)\b/,
  /\bwe can'?t (accept|proceed|move forward)\b/,
  /\bunfortunately we (aren'?t|are not|cannot|can'?t|decline|must decline)\b/,
  /\bwe('ll| will) pass\b/,
  /\bno nos interesa\b/,
  /\bno estamos aceptando\b/,
  /\bwe have to cancel\b/,
  /\bwe must cancel\b/,
];

const TIMING = [
  /\bmid-reorgani[sz]ation\b/,
  /\bno availability\b/,
  /\bbusiest month\b/,
  /\bplease reach out\b/,
  /\breach out (again|for)\b/,
  /\bcan'?t tell you yet\b/,
  /\bcannot tell you yet\b/,
];

const UNCERTAINTY = [
  /\bcan'?t tell you yet\b/,
  /\bcannot tell you yet\b/,
  /\bdon'?t know yet\b/,
  /\bwhether this is something we can do\b/,
  /\bstring you along\b/,
];

const INTEREST = [
  /\bsounds interesting\b/,
  /\bsounds great\b/,
  /\blove to (explore|collaborate|work)\b/,
  /\bwe'?d love\b/,
  /\bhappy to\b/,
  /\bglad to\b/,
  /\binterested in\b/,
  /\bstill interested\b/,
];

const REQUEST_INFORMATION = [
  /\bmedia kit\b/,
  /\bsend (me |us )?your\b/,
  /\bcan you send\b/,
  /\bcould you send\b/,
  /\bplease send\b/,
  /\bwhat are your rates\b/,
  /\bare your .+ dates still\b/,
];

const TERMS = [/\brates\b/, /\bcompensation\b/, /\bbreakfast included\b/, /\bpayment\b/];

const OFFER = [
  /\bwe can offer\b/,
  /\bcan offer\b/,
  /\bwe can host\b/,
  /\bhost you\b/,
  /\btwo nights\b/,
  /\bbreakfast included\b/,
];

/** Explicit booked-stay confirmation. "Confirmed" alone does not match. */
const BOOKING_CONFIRMATION = [
  /\byour stay is confirmed\b/,
  /\bstay is confirmed for\b/,
  /\breservation is confirmed\b/,
  /\byou'?re booked\b/,
];

const ACCEPTANCE_LANGUAGE = [/\b(we|i) accept\b/];

const AVAILABILITY_NO = /\bno availability\b/;
const RETRY_INVITATION = /\bplease reach out\b|\breach out (again|for)\b|\btry again\b/;

const POLITENESS_ONLY =
  /^(thanks|thank you)( for (reaching out|your (email|message)|getting in touch))?[.!\s]*$/;

const PAID = /\b(we will pay|we'll pay|paid collaboration|cash compensation|we can pay|our fee)\b/;
const IN_KIND = /\b(host you|hosted stay|in-kind|in kind|two nights|breakfast included)\b/;
const NO_PAYMENT = /\b(cannot offer payment|can't offer payment|no payment|without payment)\b/;
const UNPAID = /\b(unpaid|no compensation|without compensation)\b/;

function any(text: string, patterns: readonly RegExp[]): boolean {
  return patterns.some((pattern) => has(text, pattern));
}

function sortSignals(signals: ReadonlySet<CommercialSignal>): CommercialSignal[] {
  return [...signals].sort((a, b) => SIGNAL_RANK.get(a)! - SIGNAL_RANK.get(b)!);
}

export interface MessageRuleResult {
  disposition: Disposition;
  signals: CommercialSignal[];
  evidenceStrength: EvidenceStrength;
  explicitBookingConfirmation: boolean;
}

/**
 * Classify one authored body. Empty / non-authored text abstains.
 * Quoted history must already have been removed by the caller.
 */
export function interpretCommercialMessage(cleanText: string | null): MessageRuleResult {
  if (cleanText === null || normalize(cleanText).length === 0) {
    return {
      disposition: "ambiguous",
      signals: [],
      evidenceStrength: "insufficient_evidence",
      explicitBookingConfirmation: false,
    };
  }

  const text = normalize(cleanText);
  const signals = new Set<CommercialSignal>();

  const redirect = any(text, REDIRECT);
  if (redirect) signals.add("redirect");

  // Redirect wins over a forecast that some other party has been "rejecting".
  if (!redirect && any(text, REJECTION)) signals.add("rejection");

  if (any(text, TIMING)) signals.add("timing_constraint");
  if (any(text, INTEREST)) signals.add("interest");
  if (any(text, REQUEST_INFORMATION)) signals.add("request_information");
  if (any(text, TERMS)) signals.add("terms_discussion");
  if (any(text, OFFER)) signals.add("offer");

  const explicitBookingConfirmation = any(text, BOOKING_CONFIRMATION);
  if (explicitBookingConfirmation || any(text, ACCEPTANCE_LANGUAGE)) signals.add("agreement");

  // A redirect is never also a rejection, even if a future pattern gets wider.
  if (signals.has("redirect")) signals.delete("rejection");

  const uncertainty = any(text, UNCERTAINTY);
  const politenessOnly = signals.size === 0 && has(text, POLITENESS_ONLY);
  const advancing =
    signals.has("interest") ||
    signals.has("offer") ||
    signals.has("agreement") ||
    signals.has("request_information") ||
    signals.has("terms_discussion");
  const retry = has(text, RETRY_INVITATION) && has(text, AVAILABILITY_NO);

  let disposition: Disposition;
  if (uncertainty) {
    disposition = "ambiguous";
  } else if (signals.has("rejection") && (advancing || signals.has("timing_constraint"))) {
    disposition = "mixed";
  } else if (signals.has("rejection")) {
    disposition = "negative";
  } else if (retry) {
    disposition = "mixed";
  } else if (signals.has("timing_constraint") && advancing) {
    disposition = "mixed";
  } else if (signals.has("redirect") && !advancing) {
    disposition = "neutral";
  } else if (signals.has("timing_constraint")) {
    disposition = "neutral";
  } else if (advancing) {
    disposition = "positive";
  } else if (politenessOnly) {
    disposition = "neutral";
  } else {
    disposition = "ambiguous";
  }

  let evidenceStrength: EvidenceStrength;
  if (signals.has("agreement") || signals.has("rejection")) evidenceStrength = "strong";
  else if (signals.size === 0 && disposition === "ambiguous")
    evidenceStrength = "insufficient_evidence";
  else if (signals.size === 0 && disposition === "neutral") evidenceStrength = "weak";
  else evidenceStrength = "moderate";

  return {
    disposition,
    signals: sortSignals(signals),
    evidenceStrength,
    explicitBookingConfirmation,
  };
}

function compensationOf(text: string): CompensationStructure | null {
  const paid = has(text, PAID);
  const inKind = has(text, IN_KIND);
  const noPayment = has(text, NO_PAYMENT);
  const unpaid = has(text, UNPAID);
  // "host you but cannot offer payment" is in-kind, never unpaid and never hybrid.
  if (inKind && noPayment && !paid) return "in_kind";
  if (paid && inKind) return "hybrid";
  if (paid) return "paid";
  if (inKind) return "in_kind";
  if (unpaid) return "unpaid";
  return null;
}

function laterCancellation(
  messages: readonly MessageCommercialMeaning[],
  fromIndex: number,
): boolean {
  return messages.slice(fromIndex + 1).some((message) => message.signals.includes("rejection"));
}

/**
 * Thread advisory state over eligible human replies only.
 * Creator-sent rows are context for "was there an earlier message?" and are
 * never given a disposition. No eligible reply → no thread state and
 * compensation `unknown` (not unpaid, not ghosted).
 */
export function interpretCommercialThread(
  messages: readonly CommercialMessageInput[],
): ThreadCommercialMeaning {
  const ordered = [...messages].sort((a, b) => {
    if (a.internalDateMs !== b.internalDateMs) return a.internalDateMs - b.internalDateMs;
    return a.providerMessageId < b.providerMessageId ? -1 : 1;
  });

  const interpreted: MessageCommercialMeaning[] = [];
  for (const message of ordered) {
    if (!message.eligible || message.providerSent) continue;
    const meaning = interpretCommercialMessage(message.cleanText);
    interpreted.push({
      providerMessageId: message.providerMessageId,
      disposition: meaning.disposition,
      signals: meaning.signals,
      evidenceStrength: meaning.evidenceStrength,
      explicitBookingConfirmation: meaning.explicitBookingConfirmation,
    });
  }

  if (interpreted.length === 0) {
    return {
      commercialState: null,
      compensationStructure: "unknown",
      evidenceStrength: "insufficient_evidence",
      messages: [],
    };
  }

  let compensation: CompensationStructure = "unknown";
  for (const message of ordered) {
    if (!message.eligible || message.providerSent || message.cleanText === null) continue;
    const found = compensationOf(normalize(message.cleanText));
    if (found) compensation = found;
  }

  const latest = interpreted[interpreted.length - 1]!;
  const bookingIndex = interpreted.findIndex((message) => message.explicitBookingConfirmation);
  const bookingMessage =
    bookingIndex >= 0
      ? ordered.find(
          (message) => message.providerMessageId === interpreted[bookingIndex]!.providerMessageId,
        )
      : undefined;
  const priorSentBeforeBooking = bookingMessage
    ? ordered.some(
        (message) => message.providerSent && message.internalDateMs < bookingMessage.internalDateMs,
      )
    : false;

  let commercialState: ThreadState;

  if (bookingIndex >= 0 && priorSentBeforeBooking && laterCancellation(interpreted, bookingIndex)) {
    // Agreement followed by cancellation is conflicting evidence. B07 does not
    // own a collaboration-cancellation lifecycle, so the summary is ambiguous
    // rather than a frozen agreement or a fresh decline.
    commercialState = "ambiguous";
  } else if (bookingIndex >= 0 && priorSentBeforeBooking) {
    commercialState = "agreement_observed";
  } else if (
    latest.signals.includes("rejection") &&
    !latest.signals.includes("redirect") &&
    !latest.signals.includes("timing_constraint")
  ) {
    commercialState = "declined_observed";
  } else if (
    interpreted.some(
      (message) =>
        message.signals.includes("offer") ||
        message.signals.includes("terms_discussion") ||
        message.signals.includes("agreement"),
    )
  ) {
    commercialState = "negotiating";
  } else if (
    interpreted.some(
      (message) =>
        message.signals.includes("interest") || message.signals.includes("request_information"),
    )
  ) {
    commercialState = "engaged";
  } else if (latest.disposition === "ambiguous" || latest.disposition === "mixed") {
    commercialState = "ambiguous";
  } else {
    commercialState = "unresolved";
  }

  const evidenceStrength: EvidenceStrength =
    latest.evidenceStrength === "insufficient_evidence" ? "weak" : latest.evidenceStrength;

  return {
    commercialState,
    compensationStructure: compensation,
    evidenceStrength,
    messages: interpreted,
  };
}
