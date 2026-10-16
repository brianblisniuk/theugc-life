/**
 * First-value cards (D095). A denied contact read is "Generic contact"
 * and carries no email. A failed intelligence read is not "insufficient".
 */
import { describe, expect, it } from "vitest";

import {
  ONBOARDING_CARD_KEYS,
  contactLabel,
  onboardingContact,
  onboardingContext,
  rankOnboardingHotels,
  type RankedHotel,
} from "@/lib/onboarding/hotel-cards";

const verified = {
  displayName: "Ana Ruiz",
  jobTitle: "PR",
  department: null,
  verificationStatus: "verified",
  email: "ana@hotel.example",
};

function card(partial: Partial<RankedHotel> & Pick<RankedHotel, "id" | "name">): RankedHotel {
  return {
    zone: null,
    contact: { kind: "generic" },
    context: null,
    verified: false,
    signalScore: 0,
    ...partial,
  };
}

describe("onboarding hotel cards", () => {
  it("shows a verified name and role only when the caller may read contacts", () => {
    const shown = onboardingContact("allowed", [verified]);
    expect(shown).toEqual({ kind: "verified", name: "Ana Ruiz", role: "PR" });
    expect(contactLabel(shown)).toBe("Ana Ruiz · PR");
    expect(JSON.stringify(shown)).not.toContain("ana@hotel.example");
    expect(JSON.stringify(shown)).not.toContain("email");
  });

  it("a denied read is generic even when the payload includes a verified email", () => {
    const shown = onboardingContact("denied", [verified]);
    expect(shown).toEqual({ kind: "generic" });
    expect(contactLabel(shown)).toBe("Generic contact");
    expect(JSON.stringify(shown)).not.toContain("Ana");
    expect(JSON.stringify(shown)).not.toContain("@");
  });

  it("a failed contact read is unknown, not generic", () => {
    expect(onboardingContact("error", [verified])).toEqual({ kind: "unknown" });
    expect(contactLabel({ kind: "unknown" })).toBeNull();
    expect(onboardingContact("allowed", null)).toEqual({ kind: "generic" });
    expect(
      onboardingContact("allowed", [
        { displayName: "  ", jobTitle: "PR", department: null, verificationStatus: "verified" },
      ]),
    ).toEqual({ kind: "generic" });
  });

  it("orders verified contacts first, then the public signal, then the name", () => {
    const ranked = rankOnboardingHotels([
      card({ id: "c", name: "Cebra", signalScore: 2 }),
      card({
        id: "a",
        name: "Álamo",
        verified: true,
        contact: { kind: "verified", name: "Ana", role: null },
        signalScore: 0,
      }),
      card({ id: "b", name: "Balsa", signalScore: 2 }),
    ]);
    expect(ranked.map((hotel) => hotel.id)).toEqual(["a", "b", "c"]);
  });

  it("does not call a failed intelligence read insufficient data", () => {
    expect(onboardingContext(null, true)).toEqual({ text: null, score: 0 });
    expect(onboardingContext(null, false).text).toBe("Insufficient data");
    expect(
      onboardingContext({ activity: null, recency: null, collaborationObserved: true }, false).text,
    ).toBe("Works with creators");
  });

  it("the card model has no email field", () => {
    expect(ONBOARDING_CARD_KEYS).not.toContain("email");
    const packed = JSON.stringify(
      card({
        id: "h",
        name: "Casa",
        contact: { kind: "verified", name: "Ana", role: "PR" },
      }),
    );
    expect(packed).not.toContain("email");
  });
});
