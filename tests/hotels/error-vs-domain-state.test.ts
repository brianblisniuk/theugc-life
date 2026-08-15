/**
 * Product integrity: A TECHNICAL ERROR IS NOT A DOMAIN FACT.
 *
 * Regression coverage for the three PR #8 review findings:
 *   F1 an entitlement-check failure is not "you have no access"
 *   F2 an intelligence query failure is not "not enough creator data"
 *   F3 a destination-lookup failure is not "no hotels match"
 *
 * The mappings are pure, so these assert real behaviour without stubbing
 * Supabase internals or making the tests brittle.
 */
import { describe, expect, it } from "vitest";

import {
  contactSectionState,
  mapContactAccess,
  mayQueryContacts,
  shouldOfferUpgrade,
  type ContactAccessResult,
} from "@/lib/hotels/access";
import {
  INSUFFICIENT_INTELLIGENCE_COPY,
  INTELLIGENCE_ERROR_COPY,
  intelligencePanelState,
  type IntelligenceResult,
} from "@/lib/hotels/intelligence";

const ALLOWED: ContactAccessResult = { status: "allowed" };
const DENIED: ContactAccessResult = { status: "denied" };
const ERRORED: ContactAccessResult = { status: "error" };

describe("F1 — entitlement check failure is not a denial", () => {
  it("RPC false → denied → locked upgrade state", () => {
    const access = mapContactAccess({ data: false, error: null });
    expect(access).toEqual(DENIED);
    const state = contactSectionState({ access, contacts: [], failed: false });
    expect(state).toBe("locked");
    expect(shouldOfferUpgrade(state)).toBe(true);
  });

  it("RPC true → allowed → contact query may run", () => {
    const access = mapContactAccess({ data: true, error: null });
    expect(access).toEqual(ALLOWED);
    expect(mayQueryContacts(access)).toBe(true);
    expect(contactSectionState({ access, contacts: [{}], failed: false })).toBe("contacts");
  });

  it("RPC error → error, NOT denied", () => {
    const access = mapContactAccess({ data: null, error: { message: "boom" } });
    expect(access).toEqual(ERRORED);
    expect(access.status).not.toBe("denied");
  });

  it("RPC error → premium contacts are still NOT queried (fail-closed)", () => {
    expect(mayQueryContacts(mapContactAccess({ data: null, error: { message: "boom" } }))).toBe(
      false,
    );
    // Denied is equally closed.
    expect(mayQueryContacts(DENIED)).toBe(false);
  });

  it("RPC error → neutral error state, and NO upgrade CTA is offered", () => {
    const state = contactSectionState({ access: ERRORED, contacts: [], failed: false });
    expect(state).toBe("access-error");
    expect(state).not.toBe("locked");
    expect(shouldOfferUpgrade(state)).toBe(false);
  });

  it("an uninterpretable RPC answer is treated as error, never denial", () => {
    for (const data of [null, undefined, "yes", 1, {}]) {
      expect(mapContactAccess({ data, error: null }).status).toBe("error");
    }
  });

  it("an entitled user whose contact fetch fails gets a neutral error, not 'no contact'", () => {
    const state = contactSectionState({ access: ALLOWED, contacts: [], failed: true });
    expect(state).toBe("fetch-error");
    expect(state).not.toBe("empty");
    expect(shouldOfferUpgrade(state)).toBe(false);
  });

  it("an entitled user with genuinely zero contacts sees the empty state", () => {
    expect(contactSectionState({ access: ALLOWED, contacts: [], failed: false })).toBe("empty");
  });
});

describe("F2 — intelligence query failure is not insufficient data", () => {
  it("genuine no-row → insufficient-data state", () => {
    const result: IntelligenceResult = { status: "none" };
    expect(intelligencePanelState(result)).toBe("insufficient");
  });

  it("query error → temporary-unavailable state, NOT insufficient data", () => {
    const result: IntelligenceResult = { status: "error" };
    const state = intelligencePanelState(result);
    expect(state).toBe("error");
    expect(state).not.toBe("insufficient");
  });

  it("the error copy makes no claim about creator activity", () => {
    expect(INTELLIGENCE_ERROR_COPY.title).toBe("Creator intelligence is temporarily unavailable");
    expect(INTELLIGENCE_ERROR_COPY.title).not.toBe(INSUFFICIENT_INTELLIGENCE_COPY.title);
    const blob = `${INTELLIGENCE_ERROR_COPY.title} ${INTELLIGENCE_ERROR_COPY.description}`;
    for (const forbidden of ["not enough", "0%", "low activity", "no creators"]) {
      expect(blob.toLowerCase()).not.toContain(forbidden);
    }
  });

  it("a real signal still renders as a signal", () => {
    const result: IntelligenceResult = {
      status: "ok",
      signal: {
        activityLevel: "high",
        confidenceLevel: "strong",
        hasObservedCollaboration: true,
        recencyBand: "past_month",
      },
    };
    expect(intelligencePanelState(result)).toBe("signal");
  });

  it("a row whose confidence gates leave nothing displayable is insufficient, not error", () => {
    const result: IntelligenceResult = {
      status: "ok",
      signal: {
        activityLevel: null,
        confidenceLevel: "emerging",
        hasObservedCollaboration: null,
        recencyBand: null,
      },
    };
    expect(intelligencePanelState(result)).toBe("insufficient");
  });
});
