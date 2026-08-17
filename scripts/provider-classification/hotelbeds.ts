/**
 * Hotelbeds classification policy v1 (D066).
 *
 * Approved for D060 resolution ONLY through this explicit code mapping. The full
 * reasoning, code by code, is `docs/PROPERTY_SOURCE_CLASSIFICATION_POLICY.md` §5;
 * this file is that document made executable.
 *
 * Read on `categoryCode`, resolved through the categories master. Deliberately
 * NOT `simpleCode`: PR #21 proved `simpleCode 5` covers 5 STARS, 5 KEYS, APTH5,
 * BB5, HS5 and HIST, and `simpleCode 3` covers "WITHOUT OFFICIAL CATEGORY". That
 * finding is preserved, not contradicted — mapping the category code is what
 * makes it possible to keep it.
 */
import type { ClassificationPolicy } from "./policy";

export const HOTELBEDS_CLASSIFICATION_POLICY: ClassificationPolicy = {
  provider: "hotelbeds",
  version: "hotelbeds-classification/1",
  field: "categoryCode",
  notes:
    "Reviewed against the 65-code categories master retrieved in PR #21 and the live " +
    "Bali/Dubai category distributions. Only plain hotel-star codes in the star groups " +
    "are approved. Half-star levels are classified-but-out-of-scope; every other " +
    "register (keys, aparthotel, apartment, B&B, hostel, camping, rural hotel) and every " +
    "property-type label is unresolved. See docs/PROPERTY_SOURCE_CLASSIFICATION_POLICY.md.",
  mappings: {
    // ---- APPROVED: plain hotel star classifications, exactly 4 or exactly 5 --
    // Each of these names an exact star count in the provider's own master. The
    // `*LUX` pair states the count AND a LUXURY qualifier; the count is what the
    // mapping reads, and no inference is needed beyond the master's own wording.
    "4EST": "exact_four", // 4 STARS
    "4LUX": "exact_four", // 4 STARS LUXURY
    "5EST": "exact_five", // 5 STARS
    "5LUX": "exact_five", // 5 STARS LUXURY

    // ---- CLASSIFIED, but not V1 scope --------------------------------------
    // Real classifications that are not exactly 4 or 5. These carry a durable
    // reason rather than sitting unresolved, because we know what they are.
    "1EST": "classified_not_v1_scope", // 1 STAR
    "2EST": "classified_not_v1_scope", // 2 STARS
    "3EST": "classified_not_v1_scope", // 3 STARS
    H1_5: "classified_not_v1_scope", // 1 STAR AND A HALF
    H2_5: "classified_not_v1_scope", // 2 STARS AND A HALF
    H3_5: "classified_not_v1_scope", // 3 STARS AND A HALF
    // The two most likely to be wrongly coerced into scope. 4.5 stars is a real
    // classification that D060 excludes; rounding it is the failure the
    // "never average" rule exists to prevent.
    H4_5: "classified_not_v1_scope", // 4 STARS AND A HALF
    H5_5: "classified_not_v1_scope", // 5 STARS AND A HALF
    H2S: "classified_not_v1_scope", // SUPERIOR 2*
    H3S: "classified_not_v1_scope", // SUPERIOR 3*

    // ---- Everything else is ABSENT, and therefore `unresolved` -------------
    // Listed here as documentation of what was considered and refused; the
    // lookup treats an absent code as unresolved, so these entries are the
    // reasoning, not the mechanism:
    //
    //   KEYS               1LL 2LL 3LL 4LL 5LL              — different register
    //   aparthotel         APTH APTH2 APTH3 APTH4 APTH5     — different register
    //   apartment          AT1 AT2 AT3                      — different register
    //   B&B                BB BB3 BB4 BB5                   — different register
    //   hostel/boarding    HS HS2 HS3 HS4 HS5 HSR1 HSR2
    //                      ALBER PENSI CHUES                — different register
    //   camping            CAMP1 CAMP2                      — different register
    //   rural hotel        HR HR2 HR3 HR4 HR5 HRS           — scale not established
    //   property types     VILLA RSORT BOU POUSA AG LODGE
    //                      RESID VTV HIST                   — no star count
    //   absent/unknown     SPC PENDI STD 0 2 3              — no category
    //
    // SUP ("SUPERIOR 4*") is the closest call and stays unresolved: its
    // description names 4*, but no reviewed evidence here establishes that
    // "superior" is a sub-grade rather than a step. First candidate for v2.
  },
};
