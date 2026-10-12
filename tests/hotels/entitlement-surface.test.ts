/**
 * Free / Destination Pass / Pro on Hotel Detail use the existing entitlement
 * answer. This surface does not invent a tier, a price, or a limit.
 *
 * The database cases (free denied, pass only inside its destination, pro
 * worldwide) live in tests/hotels/contact-access.test.ts. Here the same
 * access result is what the panels render.
 */
import { describe, expect, it } from "vitest";

import {
  contactSectionState,
  shouldOfferUpgrade,
  type ContactAccessResult,
} from "@/lib/hotels/access";
import {
  LOCKED_INTELLIGENCE_COPY,
  premiumIntelligenceState,
  premiumReplyRateLabel,
  type PremiumIntelligenceSignal,
} from "@/lib/hotels/intelligence";

const suppressed: PremiumIntelligenceSignal = {
  confidenceLevel: "insufficient",
  replyRate: null,
  replyTimeBand: null,
  recentActivityBand: null,
  collaborationTypes: null,
  contributorCount: null,
};

function panels(access: ContactAccessResult, replyRate: number | null) {
  return {
    premium: premiumIntelligenceState({
      access,
      result:
        access.status === "allowed" ? { status: "ok", signal: { ...suppressed, replyRate } } : null,
    }),
    contacts: contactSectionState({ access, contacts: [], failed: false }),
  };
}

describe("entitlement surface", () => {
  it("a denied viewer (Free, or a Pass outside its destination) is locked", () => {
    const view = panels({ status: "denied" }, null);
    expect(view.premium).toBe("locked");
    expect(view.contacts).toBe("locked");
    expect(shouldOfferUpgrade(view.contacts)).toBe(true);
    expect(premiumReplyRateLabel(suppressed)).toBeNull();
  });

  it("an allowed viewer with a disclosed rate sees that rate", () => {
    const view = panels({ status: "allowed" }, 0.62);
    expect(view.premium).toBe("available");
    expect(view.contacts).toBe("empty");
    expect(premiumReplyRateLabel({ ...suppressed, replyRate: 0.62 })).toBe("62%");
  });

  it("an allowed viewer with a suppressed metric sees building, not zero", () => {
    const view = panels({ status: "allowed" }, null);
    expect(view.premium).toBe("building");
    expect(premiumReplyRateLabel(suppressed)).toBeNull();
    expect(JSON.stringify(suppressed)).not.toContain("0%");
  });

  it("a failed entitlement check is an error, not a lock and not an upgrade", () => {
    const view = panels({ status: "error" }, null);
    expect(view.premium).toBe("error");
    expect(view.contacts).toBe("access-error");
    expect(shouldOfferUpgrade(view.contacts)).toBe(false);
  });

  it("the locked copy names the existing plans and no new price", () => {
    expect(LOCKED_INTELLIGENCE_COPY.description).toMatch(/Destination Pass/);
    expect(LOCKED_INTELLIGENCE_COPY.description).toMatch(/Creator Pro/);
    expect(LOCKED_INTELLIGENCE_COPY.description).not.toMatch(/\$\d/);
  });
});
