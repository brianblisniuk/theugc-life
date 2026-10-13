/**
 * First-value hotel cards (D095).
 *
 * A verified name and role are shown only when this user already unlocked the
 * hotel. Otherwise the card says "Contacto genérico" and does not carry an
 * email. The card never spends a credit by being rendered.
 */
import type { PublicCardSignal } from "@/lib/hotels/card-signal";

import { FIRST_RUN_COPY } from "./first-run";

export interface OnboardingContactSource {
  displayName: string | null;
  jobTitle: string | null;
  department: string | null;
  verificationStatus: string | null;
}

export type OnboardingContact =
  | { kind: "verified"; name: string; role: string | null }
  | { kind: "generic" }
  | { kind: "unknown" };

export interface RankedHotel {
  id: string;
  name: string;
  zone: string | null;
  contact: OnboardingContact;
  context: string | null;
  verified: boolean;
  signalScore: number;
}

export function onboardingContact(
  access: "allowed" | "denied" | "error",
  contacts: readonly OnboardingContactSource[] | null,
): OnboardingContact {
  if (access !== "allowed" || !contacts) {
    return access === "error" ? { kind: "unknown" } : { kind: "generic" };
  }
  const verified = contacts.find(
    (contact) =>
      contact.verificationStatus === "verified" &&
      typeof contact.displayName === "string" &&
      contact.displayName.trim().length > 0,
  );
  if (!verified?.displayName) return { kind: "generic" };
  const role = verified.jobTitle?.trim() || verified.department?.trim() || null;
  return { kind: "verified", name: verified.displayName.trim(), role };
}

export function contactLabel(contact: OnboardingContact): string | null {
  if (contact.kind === "unknown") return null;
  if (contact.kind === "generic") return FIRST_RUN_COPY.genericContact;
  return contact.role ? `${contact.name} · ${contact.role}` : contact.name;
}

/** Public signal only. A failed intelligence read is not "insufficient data". */
export function onboardingContext(
  signal: PublicCardSignal | null,
  intelligenceFailed: boolean,
): { text: string | null; score: number } {
  if (intelligenceFailed) return { text: null, score: 0 };
  if (!signal) return { text: "Datos insuficientes todavía", score: 0 };
  if (signal.collaborationObserved) {
    return { text: "Trabaja con creadores", score: 2 };
  }
  const parts = [signal.activity, signal.recency].filter((part): part is string => Boolean(part));
  if (parts.length > 0) return { text: parts.join(" · "), score: 1 };
  return { text: "Datos insuficientes todavía", score: 0 };
}

export function rankOnboardingHotels<T extends RankedHotel>(hotels: readonly T[]): T[] {
  return [...hotels].sort((a, b) => {
    if (a.verified !== b.verified) return a.verified ? -1 : 1;
    if (a.signalScore !== b.signalScore) return b.signalScore - a.signalScore;
    return a.name.localeCompare(b.name, "es");
  });
}

/** The card model has no email field. A test fails if one is added. */
export const ONBOARDING_CARD_KEYS = [
  "id",
  "name",
  "zone",
  "contact",
  "context",
  "verified",
  "signalScore",
] as const;
