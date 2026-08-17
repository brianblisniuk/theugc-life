/**
 * The reviewed provider classification policy (D066).
 *
 * These pin the product contract in
 * `docs/PROPERTY_SOURCE_CLASSIFICATION_POLICY.md`: what one approved provider may
 * resolve, what it may not, and what happens when a second source shows up.
 *
 * Pure and offline. No database, no network, no provider call.
 */
import { describe, expect, it } from "vitest";

import {
  classifyProviderCode,
  isV1Eligible,
  reconcile,
  type ClassificationPolicy,
} from "../../scripts/provider-classification/policy";
import { HOTELBEDS_CLASSIFICATION_POLICY as POLICY } from "../../scripts/provider-classification/hotelbeds";

const classify = (code: string | null | undefined) => classifyProviderCode(POLICY, code);

describe("A. simpleCode alone cannot resolve stars", () => {
  it("reads the CATEGORY code, never simpleCode", () => {
    expect(POLICY.field).toBe("categoryCode");
    expect(POLICY.field).not.toMatch(/simple/i);
  });

  it("refuses the simpleCode values that PR #21 proved are conflated", () => {
    // simpleCode 5 covers 5 STARS, 5 KEYS, aparthotel, B&B, hostel and HIST;
    // simpleCode 4 covers VILLA, BOU, RSORT and APARTMENT 1ST CATEGORY. Passing
    // the aggregate value resolves nothing, which is the whole point.
    for (const simple of ["1", "2", "3", "4", "5", "0"]) {
      expect(classify(simple), `simpleCode ${simple} resolved a classification`).toBe("unresolved");
    }
  });

  it("keeps every simpleCode-5 sibling of 5EST unresolved", () => {
    // These all share simpleCode 5 with 5EST. Only 5EST is a hotel star code.
    for (const code of ["5LL", "APTH5", "BB5", "HS5", "HR5", "HIST"]) {
      expect(classify(code), `${code} resolved`).toBe("unresolved");
    }
    expect(classify("5EST")).toBe("exact_five");
  });

  it("keeps every simpleCode-4 sibling of 4EST unresolved", () => {
    for (const code of ["VILLA", "BOU", "RSORT", "AT1", "SUP", "4LL", "APTH4", "BB4", "HS4"]) {
      expect(classify(code), `${code} resolved`).toBe("unresolved");
    }
    expect(classify("4EST")).toBe("exact_four");
  });
});

describe("B. an approved code resolves its intended exact class", () => {
  it("maps the four approved Hotelbeds codes", () => {
    expect(classify("4EST")).toBe("exact_four"); // 4 STARS
    expect(classify("4LUX")).toBe("exact_four"); // 4 STARS LUXURY
    expect(classify("5EST")).toBe("exact_five"); // 5 STARS
    expect(classify("5LUX")).toBe("exact_five"); // 5 STARS LUXURY
  });

  it("puts exactly those four inside V1 scope, and nothing else", () => {
    const eligible = Object.entries(POLICY.mappings)
      .filter(([, outcome]) => isV1Eligible(outcome))
      .map(([code]) => code)
      .sort();
    expect(eligible).toEqual(["4EST", "4LUX", "5EST", "5LUX"]);
  });

  it("is versioned, so a resolution can name the policy that produced it", () => {
    expect(POLICY.version).toBe("hotelbeds-classification/1");
    expect(POLICY.provider).toBe("hotelbeds");
  });
});

describe("C. ambiguous or unreviewed codes stay unresolved", () => {
  it("treats an unknown code as unresolved rather than guessing", () => {
    // The mapping is an allow-list: a provider adding a code we have never
    // reviewed cannot acquire a meaning by accident.
    expect(classify("BRAND_NEW_CODE")).toBe("unresolved");
    expect(classify("")).toBe("unresolved");
    expect(classify(null)).toBe("unresolved");
    expect(classify(undefined)).toBe("unresolved");
  });

  it("leaves 'no category' and 'pending category' unresolved", () => {
    // SPC carries simpleCode 3 while meaning WITHOUT OFFICIAL CATEGORY.
    expect(classify("SPC")).toBe("unresolved");
    expect(classify("PENDI")).toBe("unresolved");
    expect(classify("STD")).toBe("unresolved");
  });

  it("leaves the rural-hotel register unresolved — a different scale", () => {
    for (const code of ["HR", "HR2", "HR3", "HR4", "HR5", "HRS"]) {
      expect(classify(code), `${code} resolved`).toBe("unresolved");
    }
  });

  it("leaves property-type labels unresolved — they carry no star count", () => {
    for (const code of ["VILLA", "RSORT", "BOU", "POUSA", "AG", "LODGE", "RESID", "VTV"]) {
      expect(classify(code), `${code} resolved`).toBe("unresolved");
    }
  });

  it("leaves HIST unresolved despite its simpleCode of 5", () => {
    // HISTORICAL HOTEL LUXURIOUS: simpleCode 5 but group GRUPO4, and no star
    // count in the description. Contradictory signals, none of them a star.
    expect(classify("HIST")).toBe("unresolved");
  });

  it("does not coerce half-star levels into scope", () => {
    // A real classification that is not exactly 4 or 5 — recorded as such, so it
    // is out of scope with a reason rather than pending review forever.
    expect(classify("H4_5")).toBe("classified_not_v1_scope");
    expect(classify("H5_5")).toBe("classified_not_v1_scope");
    expect(isV1Eligible(classify("H4_5"))).toBe(false);
    expect(isV1Eligible(classify("H5_5"))).toBe(false);
  });

  it("records 1/2/3 stars as classified-but-out-of-scope, not unresolved", () => {
    // "Confirmed 3-star" and "star unknown" are different facts (D061 §9).
    for (const code of ["1EST", "2EST", "3EST"]) {
      expect(classify(code)).toBe("classified_not_v1_scope");
    }
  });
});

describe("D. a KEY classification never becomes a STAR classification", () => {
  it("resolves no KEY code", () => {
    for (const code of ["1LL", "2LL", "3LL", "4LL", "5LL"]) {
      expect(classify(code), `${code} resolved`).toBe("unresolved");
    }
  });

  it("resolves no aparthotel or apartment category", () => {
    for (const code of ["APTH", "APTH2", "APTH3", "APTH4", "APTH5", "AT1", "AT2", "AT3"]) {
      expect(classify(code), `${code} resolved`).toBe("unresolved");
    }
  });

  it("resolves no hostel, B&B or camping category", () => {
    for (const code of ["HS", "HS4", "HS5", "BB", "BB4", "BB5", "ALBER", "CAMP1", "CAMP2"]) {
      expect(classify(code), `${code} resolved`).toBe("unresolved");
    }
  });

  it("maps every approved code into a STAR group only", () => {
    // Every eligible code names a plain star count in the provider master.
    for (const [code, outcome] of Object.entries(POLICY.mappings)) {
      if (!isV1Eligible(outcome)) continue;
      expect(code, `${code} is not a plain star code`).toMatch(/^[45](EST|LUX)$/);
    }
  });
});

describe("E. no two-source requirement exists", () => {
  it("resolves from a SINGLE approved observation", () => {
    // One provider, one code, one call — no second lookup anywhere in the path.
    expect(classifyProviderCode(POLICY, "5EST")).toBe("exact_five");
    expect(classifyProviderCode.length).toBe(2);
  });

  it("treats a first approved observation as RESOLVING, not merely corroborating", () => {
    // The distinction matters: one approved provider is sufficient, so this
    // observation classified the property. There was no prior value for it to
    // agree with, and calling it "corroborated" would describe the single-source
    // case as though a second source had confirmed it.
    const first = reconcile("unresolved", "exact_five");
    expect(first).toEqual({ state: "resolved", value: "exact_five" });
    expect(isV1Eligible((first as { value: "exact_five" }).value)).toBe(true);
  });

  it("keeps FIRST RESOLUTION and CORROBORATION as different states", () => {
    expect(reconcile("unresolved", "exact_four").state).toBe("resolved");
    expect(reconcile("exact_four", "exact_four").state).toBe("corroborated");
    // A first out-of-scope classification is also a resolution — "confirmed
    // 3-star" is a decided fact, not a pending one.
    expect(reconcile("unresolved", "classified_not_v1_scope")).toEqual({
      state: "resolved",
      value: "classified_not_v1_scope",
    });
  });

  it("requires no registry or authority input to reach a decision", () => {
    // The policy's inputs are provider, field, code, version. There is nowhere
    // to pass a government registry, because none is required.
    expect(Object.keys(POLICY).sort()).toEqual([
      "field",
      "mappings",
      "notes",
      "provider",
      "version",
    ]);
  });
});

describe("F. conflicting observations are never averaged", () => {
  it("sends a genuine disagreement to REVIEW", () => {
    expect(reconcile("exact_four", "exact_five")).toEqual({
      state: "conflict",
      existing: "exact_four",
      incoming: "exact_five",
    });
    // And emphatically NOT 4.5 — there is no arithmetic in the path at all.
    const outcome = reconcile("exact_four", "exact_five");
    expect(JSON.stringify(outcome)).not.toMatch(/4\.5|four_and|half/i);
  });

  it("does not silently flip the canonical value", () => {
    const outcome = reconcile("exact_five", "exact_four");
    expect(outcome.state).toBe("conflict");
    // The existing value is reported, not replaced.
    expect(outcome).toHaveProperty("existing", "exact_five");
  });

  it("corroborates agreement with an EXISTING value, without changing it", () => {
    expect(reconcile("exact_five", "exact_five")).toEqual({
      state: "corroborated",
      value: "exact_five",
    });
    // Corroboration requires something to corroborate.
    expect(reconcile("unresolved", "exact_five").state).not.toBe("corroborated");
  });

  it("lets an unresolved second source change nothing", () => {
    // A provider with no reviewed mapping for its code cannot unset a resolved
    // classification, and cannot manufacture a conflict either.
    expect(reconcile("exact_four", "unresolved")).toEqual({
      state: "no_change",
      value: "exact_four",
    });
  });

  it("also refuses to average a scope conflict", () => {
    const outcome = reconcile("exact_four", "classified_not_v1_scope");
    expect(outcome.state).toBe("conflict");
  });
});

describe("policy shape", () => {
  it("defaults an empty policy to unresolved for everything", () => {
    const empty: ClassificationPolicy = {
      provider: "synthetic",
      version: "synthetic/1",
      field: "categoryCode",
      mappings: {},
      notes: "no code reviewed yet",
    };
    expect(classifyProviderCode(empty, "5EST")).toBe("unresolved");
  });

  it("carries no confidence score or threshold of any kind", () => {
    const serialized = JSON.stringify(POLICY);
    expect(serialized).not.toMatch(/confidence|threshold|score|weight/i);
  });
});
