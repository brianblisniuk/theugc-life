/**
 * Property-source evaluation harness — deterministic tests.
 *
 * Every fixture here is HAND-WRITTEN SYNTHETIC DATA. No provider response is
 * committed to this repository: rights to redistribute provider content have
 * not been evaluated, and the evaluation contract keeps real extracts out of
 * git entirely.
 *
 * The behaviours pinned below are the ones whose failure would be invisible in
 * the output — a premature pagination stop, a review score read as a star
 * classification, a leaked credential — rather than the ones that would crash.
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { ARTIFACT_ROOT } from "../../scripts/provider-evaluation/artifacts";

import { bookingDemandDescriptor } from "../../scripts/provider-evaluation/adapters/booking";
import { expediaRapidDescriptor } from "../../scripts/provider-evaluation/adapters/expedia";
import { getAdapter } from "../../scripts/provider-evaluation/adapters/registry";
import { hotelbedsContentDescriptor } from "../../scripts/provider-evaluation/adapters/hotelbeds";
import {
  assessAllCapabilities,
  assessCapability,
  assertRunnableForAnyCapability,
} from "../../scripts/provider-evaluation/capabilities";
import {
  buildClassificationMaster,
  interpretClassificationForD060,
  numericLevelFrom,
  observeClassification,
} from "../../scripts/provider-evaluation/classification";
import { checkCredentials } from "../../scripts/provider-evaluation/credentials";
import { LOCAL_ENV_FILE, loadLocalEnv } from "../../scripts/provider-evaluation/env";
import { executeEvaluation } from "../../scripts/provider-evaluation/execute";
import { computeMediaEvidence, computeMetrics } from "../../scripts/provider-evaluation/metrics";
import {
  buildStarObservation,
  classifyStarEligibility,
  hasValidCoordinates,
  isD060Evidence,
  normalizeAll,
  readPath,
} from "../../scripts/provider-evaluation/normalize";
import {
  analyseOverlap,
  buildClusters,
  hasAnyEvidence,
  NO_HEURISTIC,
  normalizeDomain,
  normalizeName,
  observePair,
} from "../../scripts/provider-evaluation/overlap";
import { paginateAll } from "../../scripts/provider-evaluation/paginate";
import { buildProbeEntries } from "../../scripts/provider-evaluation/pilot-probe";
import {
  collectSecretValues,
  isSecretName,
  redactObject,
  redactSecrets,
} from "../../scripts/provider-evaluation/redact";
import type {
  AdapterDescriptor,
  EvaluationRecord,
  PaginationEvidence,
} from "../../scripts/provider-evaluation/types";

/**
 * A fully-verified synthetic descriptor.
 *
 * It exists so the machinery can be tested end to end without pretending to
 * know any real provider's schema. `provider: "synthetic"` is deliberate — it
 * must never be mistaken for a real adapter.
 */
const SYNTHETIC: AdapterDescriptor = {
  provider: "synthetic",
  displayName: "Synthetic test provider",
  documentationStatus: "verified",
  accessStatus: "credentials_available",
  liveValidationStatus: "not_run",
  strategicRole: "active_evaluation",
  sources: [
    { url: "https://example.invalid/docs", accessedAt: "2026-08-15", verifiedBy: "claude_code" },
  ],
  requiredCredentialEnvVars: ["SYNTHETIC_API_KEY"],
  baseUrl: "https://example.invalid",
  staticContentEndpoint: "/static/properties",
  usesAvailabilityEndpointForCoverage: false,
  pagination: {
    method: "cursor",
    pageSizeParam: "limit",
    maxPageSize: 100,
    documentedHardCap: null,
  },
  fieldMap: {
    sourcePropertyId: "id",
    name: "name",
    propertyType: "type",
    address: "location.address",
    latitude: "location.lat",
    longitude: "location.lon",
    brand: "brand.name",
    chain: "chain.name",
    websiteUrl: "urls.website",
    phone: "contact.phone",
    providerContact: "contact.email",
    starValue: "rating.stars",
    starKind: "rating.stars_kind",
    reviewScore: "rating.guest_score",
    photos: "images",
    heroImage: "hero",
    activeStatus: "status",
  },
  starSemantics: [
    {
      provider: "synthetic",
      destination: "global",
      fieldName: "rating.stars",
      documentedSemantics: "Hospitality classification where kind=official.",
      isHospitalityClassification: true,
      issuer: "National tourism authority",
      origin: "official_authority",
      scale: "1-5 including halves",
      refreshBehaviour: "monthly",
      provenanceAvailableToUs: true,
      observedConflicts: [],
      verdict: "suitable",
      sources: [
        {
          url: "https://example.invalid/docs/stars",
          accessedAt: "2026-08-15",
          verifiedBy: "claude_code",
        },
      ],
    },
  ],
  imageFieldMap: { path: "url", type: "kind", visualOrder: "visualOrder" },
  classification: {
    mode: "inline_value_and_kind",
    hotelAccommodationTypes: [],
    issuerEstablished: true,
  },
  starKindsAcceptedAsD060Evidence: ["official"],
  starKindDocumentedAbsent: false,
  hospitalityPropertyTypes: ["hotel", "resort", "villa"],
  geographyEnumerationRisks: [],
  capabilityBlockers: {},
  geography: [
    {
      destination: "bali",
      providerEntityIds: ["r-bali"],
      providerEntityKind: "region",
      resolutionMethod: "synthetic fixture",
      requiresUnion: false,
      caveats: [],
    },
  ],
  operations: {
    paginationMethod: "cursor",
    stablePropertyIds: true,
    updateMechanism: "delta endpoint",
    closedOrInactiveSupport: "status field",
    documentedRefreshCadence: "daily",
    documentedRateLimits: "10 rps",
    credentialLevelRequired: "api key",
    sandboxVsProductionNotes: null,
  },
  media: { documentedUsageConstraints: ["synthetic: none"] },
  blockers: [],
};

function payload(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "p1",
    name: "Test Property",
    type: "hotel",
    location: { address: "1 Test Street", lat: -8.5, lon: 115.2 },
    brand: { name: "TestBrand" },
    chain: { name: "TestChain" },
    urls: { website: "https://test-property.example" },
    contact: { email: "reservations@test-property.example", phone: "+971 4 123 4567" },
    rating: { stars: 5, stars_kind: "official", guest_score: 9.1 },
    images: ["a.jpg", "b.jpg", "c.jpg"],
    hero: "a.jpg",
    status: "active",
    ...over,
  };
}

const EVIDENCE: PaginationEvidence = {
  requests: 1,
  pages: 1,
  totalRecords: 1,
  method: "cursor",
  documentedHardCap: null,
  reportedTotal: null,
  exhaustionProven: true,
  coverageRisks: [],
};

describe("pagination is exhaustive, and says so honestly", () => {
  it("follows cursors past any convenient stopping point", async () => {
    // 25 pages x 100 = 2500 records. A harness that stopped at 100/500/1000
    // would silently under-report a destination's universe.
    const pageCount = 25;
    const result = await paginateAll<number>(
      async (cursor) => {
        const index = cursor === null ? 0 : Number(cursor);
        return {
          records: Array.from({ length: 100 }, (_, i) => index * 100 + i),
          nextCursor: index + 1 < pageCount ? String(index + 1) : null,
        };
      },
      { method: "cursor" },
    );

    expect(result.records).toHaveLength(2500);
    expect(result.evidence.pages).toBe(25);
    expect(result.evidence.exhaustionProven).toBe(true);
    expect(result.evidence.coverageRisks).toEqual([]);
  });

  it("does not claim exhaustion when the runaway guard stops it", async () => {
    const result = await paginateAll<number>(
      async (cursor) => ({
        records: [Number(cursor ?? 0)],
        nextCursor: String(Number(cursor ?? 0) + 1), // never terminates
      }),
      { method: "cursor", maxRequests: 5 },
    );

    expect(result.evidence.exhaustionProven).toBe(false);
    expect(result.evidence.coverageRisks.join(" ")).toContain("safety limit, NOT a coverage cap");
  });

  it("flags a looping cursor instead of spinning or inflating counts", async () => {
    const result = await paginateAll<number>(async () => ({ records: [1], nextCursor: "same" }), {
      method: "cursor",
    });

    expect(result.evidence.exhaustionProven).toBe(false);
    expect(result.evidence.coverageRisks.join(" ")).toContain("repeated");
  });

  it("refuses to prove exhaustion when the provider's own total disagrees", async () => {
    const result = await paginateAll<number>(
      async () => ({ records: [1, 2], nextCursor: null, reportedTotal: 500 }),
      { method: "cursor" },
    );

    expect(result.evidence.exhaustionProven).toBe(false);
    expect(result.evidence.coverageRisks.join(" ")).toContain("reported a total of 500");
  });

  it("treats reaching a documented hard cap as a coverage risk", async () => {
    const result = await paginateAll<number>(
      async () => ({ records: [1, 2, 3], nextCursor: null }),
      { method: "cursor", documentedHardCap: 3 },
    );

    expect(result.evidence.exhaustionProven).toBe(false);
    expect(result.evidence.coverageRisks.join(" ")).toContain("documented hard cap");
  });
});

describe("normalization keeps stars and review scores apart", () => {
  it("reads a star classification and its explicitly mapped kind", () => {
    const star = buildStarObservation(payload(), SYNTHETIC);
    expect(star.value).toBe(5);
    expect(star.kind).toBe("official");
    expect(star.reviewScore).toBe(9.1);
  });

  it("never lets a guest-review score become a star value", () => {
    // No classification at all, only a 4.7 guest average — the exact shape D060
    // warns about, because both are "out of five".
    const star = buildStarObservation(payload({ rating: { guest_score: 4.7 } }), SYNTHETIC);
    expect(star.value).toBeNull();
    expect(star.reviewScore).toBe(4.7);
    expect(isD060Evidence(star, SYNTHETIC)).toBe(false);
  });

  it("NEVER invents a star-kind path from a naming convention", () => {
    // The descriptor is otherwise verified but maps no starKind. An earlier
    // version derived `${fieldName}_type`; that guessed path is gone, so the
    // qualifier must read as null even though `rating.stars_kind` exists in the
    // payload and would have been found by the old convention.
    const noKindPath: AdapterDescriptor = {
      ...SYNTHETIC,
      fieldMap: { ...SYNTHETIC.fieldMap, starKind: undefined },
    };
    const star = buildStarObservation(payload(), noKindPath);
    expect(star.kind).toBeNull();
    expect(isD060Evidence(star, noKindPath)).toBe(false);
  });

  it("accepts a value without a kind ONLY when absence is documented", () => {
    const documentedAbsent: AdapterDescriptor = {
      ...SYNTHETIC,
      fieldMap: { ...SYNTHETIC.fieldMap, starKind: null },
      starKindDocumentedAbsent: true,
      starKindsAcceptedAsD060Evidence: [],
    };
    const star = buildStarObservation(payload(), documentedAbsent);
    expect(star.kind).toBeNull();
    expect(isD060Evidence(star, documentedAbsent)).toBe(true);
  });

  it("rejects a star value whose kind is not accepted evidence", () => {
    const star = buildStarObservation(
      payload({ rating: { stars: 5, stars_kind: "provider_estimate" } }),
      SYNTHETIC,
    );
    expect(star.value).toBe(5);
    expect(isD060Evidence(star, SYNTHETIC)).toBe(false);
  });

  it("rejects every star value when no kind has been accepted yet", () => {
    const noKinds = { ...SYNTHETIC, starKindsAcceptedAsD060Evidence: [] };
    const star = buildStarObservation(payload(), noKinds);
    expect(isD060Evidence(star, noKinds)).toBe(false);
  });

  it("reads missing paths as null rather than throwing", () => {
    expect(readPath(payload(), "nope.not.here")).toBeNull();
    expect(readPath(null, "a.b")).toBeNull();
  });

  it("treats 0,0 and out-of-range coordinates as invalid", () => {
    const ok = normalizeAll([payload()], SYNTHETIC, "bali").records[0];
    const nullIsland = normalizeAll(
      [payload({ id: "p2", location: { lat: 0, lon: 0 } })],
      SYNTHETIC,
      "bali",
    ).records[0];
    const outOfRange = normalizeAll(
      [payload({ id: "p3", location: { lat: 99, lon: 200 } })],
      SYNTHETIC,
      "bali",
    ).records[0];

    expect(ok && hasValidCoordinates(ok)).toBe(true);
    expect(nullIsland && hasValidCoordinates(nullIsland)).toBe(false);
    expect(outOfRange && hasValidCoordinates(outOfRange)).toBe(false);
  });
});

describe("D060 requires EXACTLY 4 or 5", () => {
  function eligibilityOf(stars: number | null): string {
    const rating = stars === null ? { stars_kind: "official" } : { stars, stars_kind: "official" };
    return classifyStarEligibility(buildStarObservation(payload({ rating }), SYNTHETIC), SYNTHETIC);
  }

  it("resolves exact 4 and exact 5", () => {
    expect(eligibilityOf(4)).toBe("exact_four");
    expect(eligibilityOf(5)).toBe("exact_five");
  });

  it("does NOT round a half-star into an eligible band", () => {
    // Expedia's content documentation supports 3.5 and 4.5. A 4.5-star property
    // has a real classification that is neither exactly 4 nor exactly 5.
    expect(eligibilityOf(4.5)).toBe("classified_not_v1_scope");
    expect(eligibilityOf(3.5)).toBe("classified_not_v1_scope");
  });

  it("treats a genuine 3-star as classified-but-out-of-scope, not unresolved", () => {
    expect(eligibilityOf(3)).toBe("classified_not_v1_scope");
  });

  it("treats a missing value as unresolved, never as out of scope", () => {
    // D061: "classification unknown" and "confirmed 3-star" are different facts.
    expect(eligibilityOf(null)).toBe("unresolved");
  });

  it("does not coerce an unexpected scale", () => {
    // A 10-point scale means we are misreading the field. Say so; do not clamp.
    expect(eligibilityOf(9)).toBe("unresolved");
    expect(eligibilityOf(0)).toBe("unresolved");
    expect(eligibilityOf(-1)).toBe("unresolved");
  });

  it("counts half-stars separately from both eligible and unresolved buckets", () => {
    const { records, accounting } = normalizeAll(
      [
        payload({ id: "a", rating: { stars: 5, stars_kind: "official" } }),
        payload({ id: "b", rating: { stars: 4, stars_kind: "official" } }),
        payload({ id: "c", rating: { stars: 4.5, stars_kind: "official" } }),
        payload({ id: "d", rating: { stars: 3.5, stars_kind: "official" } }),
        payload({ id: "e", rating: { stars: 5, stars_kind: "guessed" } }),
        payload({ id: "f", rating: { guest_score: 9.9 } }),
      ],
      SYNTHETIC,
      "bali",
    );

    const metrics = computeMetrics(records, accounting, SYNTHETIC, "bali", EVIDENCE);

    expect(metrics.inventory.apparentExactFiveStar).toBe(1);
    expect(metrics.inventory.apparentExactFourStar).toBe(1);
    expect(metrics.inventory.classifiedNotV1Scope).toBe(2); // 4.5 and 3.5
    expect(metrics.inventory.unresolvedStar).toBe(2); // unusable kind, no value
    // The raw value distribution keeps an unexpected scale visible.
    expect(metrics.inventory.starValueDistribution["4.5"]).toBe(1);
  });
});

describe("metrics preserve the raw-vs-normalized accounting", () => {
  it("never reports the surviving count as the raw count", () => {
    // Two of five provider records have no id. That is source-quality evidence
    // and must not vanish before the denominator is explained.
    const payloads = [
      payload({ id: "a" }),
      payload({ id: null }),
      payload({ id: "b" }),
      payload({ id: undefined }),
      payload({ id: "c" }),
    ];
    const { records, accounting } = normalizeAll(payloads, SYNTHETIC, "bali");

    expect(accounting.rawRecordsReturned).toBe(5);
    expect(accounting.normalizedRecords).toBe(3);
    expect(accounting.recordsMissingSourcePropertyId).toBe(2);
    expect(accounting.otherNormalizationRejects).toBe(0);

    const metrics = computeMetrics(records, accounting, SYNTHETIC, "bali", EVIDENCE);
    expect(metrics.accounting.rawRecordsReturned).toBe(5);
    expect(metrics.accounting.normalizedRecords).toBe(3);
  });

  it("reports duplicate provider ids rather than hiding them", () => {
    const { records, accounting } = normalizeAll([payload(), payload()], SYNTHETIC, "bali");
    expect(accounting.rawRecordsReturned).toBe(2);
    expect(accounting.uniqueSourcePropertyIds).toBe(1);
    expect(accounting.duplicateIdRecords).toBe(1);
    expect(records).toHaveLength(2);
  });

  it("computes field coverage and photo statistics", () => {
    const { records, accounting } = normalizeAll(
      [
        payload({ id: "a", images: ["1.jpg"] }),
        payload({ id: "b", images: ["1.jpg", "2.jpg", "3.jpg"] }),
        payload({ id: "c", images: [], hero: null, urls: {} }),
      ],
      SYNTHETIC,
      "bali",
    );

    const metrics = computeMetrics(records, accounting, SYNTHETIC, "bali", EVIDENCE);

    expect(metrics.fieldCoverage.photoPct).toBeCloseTo(66.67, 1);
    expect(metrics.fieldCoverage.medianPhotosPerProperty).toBe(1);
    expect(metrics.fieldCoverage.averagePhotosPerProperty).toBeCloseTo(1.33, 1);
    expect(metrics.fieldCoverage.websitePct).toBeCloseTo(66.67, 1);
    expect(metrics.fieldCoverage.validCoordinatesPct).toBe(100);
    expect(metrics.fieldCoverage.phonePct).toBe(100);
  });

  it("returns null hospitality count when the type mapping is unestablished", () => {
    const noTypes = { ...SYNTHETIC, hospitalityPropertyTypes: [] };
    const { records, accounting } = normalizeAll([payload()], noTypes, "bali");
    const metrics = computeMetrics(records, accounting, noTypes, "bali", EVIDENCE);
    // Guessing which provider categories are "hospitality" would prejudge D060.
    expect(metrics.inventory.apparentPhysicalHospitalityProperties).toBeNull();
  });

  it("counts hospitality properties once the type mapping is documented", () => {
    const { records, accounting } = normalizeAll(
      [payload({ id: "a", type: "hotel" }), payload({ id: "b", type: "office" })],
      SYNTHETIC,
      "bali",
    );
    const metrics = computeMetrics(records, accounting, SYNTHETIC, "bali", EVIDENCE);
    expect(metrics.inventory.apparentPhysicalHospitalityProperties).toBe(1);
  });
});

describe("overlap analysis records evidence and invents no thresholds", () => {
  function record(over: Partial<EvaluationRecord>): EvaluationRecord {
    return {
      provider: "a",
      destination: "dubai",
      sourcePropertyId: "x",
      name: "Hotel One",
      propertyType: "hotel",
      address: null,
      latitude: 25.2,
      longitude: 55.27,
      brand: null,
      chain: null,
      websiteUrl: null,
      phone: null,
      providerContact: null,
      star: { value: 5, kind: "official", reviewScore: null },
      classification: null,
      photoCount: 0,
      hasPrincipalImageCandidate: false,
      imageTypes: [],
      imagesWithPath: 0,
      activeStatus: null,
      ...over,
    };
  }

  it("records raw coordinate distance instead of bucketing it", () => {
    const evidence = observePair(
      record({}),
      record({ provider: "b", latitude: 25.201, longitude: 55.27 }),
    );
    expect(evidence.bothCoordinatesPresent).toBe(true);
    expect(evidence.coordinateDistanceMetres).toBeGreaterThan(0);
    expect(evidence.coordinateDistanceMetres).toBeLessThan(200);
    // No verdict field exists on the evidence at all.
    expect(Object.keys(evidence)).not.toContain("verdict");
  });

  it("reports null distance when coordinates are missing", () => {
    const evidence = observePair(
      record({ latitude: null, longitude: null }),
      record({ provider: "b" }),
    );
    expect(evidence.bothCoordinatesPresent).toBe(false);
    expect(evidence.coordinateDistanceMetres).toBeNull();
    // Name still agrees, so the pair is still worth a human's attention.
    expect(hasAnyEvidence(evidence)).toBe(true);
  });

  it("declines to estimate a union without a configured heuristic", () => {
    const analysis = analyseOverlap(
      "dubai",
      [record({ sourcePropertyId: "a1" })],
      [record({ provider: "b", sourcePropertyId: "b1" })],
    );
    expect(analysis.estimatedUnionBeforeResolution).toBeNull();
    expect(analysis.notes.join(" ")).toContain("falsely precise");
  });

  it("estimates a union only when a PROVISIONAL heuristic is supplied, and labels it", () => {
    const analysis = analyseOverlap(
      "dubai",
      [record({ sourcePropertyId: "a1" })],
      [record({ provider: "b", sourcePropertyId: "b1" })],
      {
        coordinatesAgreeWithinMetres: 150,
        coordinatesContradictBeyondMetres: 2000,
        minimumAgreeingSignals: 2,
      },
    );
    expect(analysis.estimatedUnionBeforeResolution).toBe(1);
    expect(analysis.notes.join(" ")).toContain("PROVISIONAL EVALUATION HEURISTIC");
    expect(analysis.notes.join(" ")).toContain("NOT canonical matching policy");
  });

  it("treats one A matching two B records as an ambiguity cluster, not one overlap", () => {
    const a = [record({ sourcePropertyId: "a1", name: "Grand Hotel" })];
    const b = [
      record({ provider: "b", sourcePropertyId: "b1", name: "Grand Hotel" }),
      record({ provider: "b", sourcePropertyId: "b2", name: "Grand Hotel" }),
    ];

    const analysis = analyseOverlap("dubai", a, b, NO_HEURISTIC);

    expect(analysis.oneToOneCandidatePairs).toBe(0);
    expect(analysis.ambiguityClusters).toHaveLength(1);
    expect(analysis.ambiguityClusters[0]?.aIds).toEqual(["a1"]);
    expect(analysis.ambiguityClusters[0]?.bIds.sort()).toEqual(["b1", "b2"]);
  });

  it("treats two A records matching one B as an ambiguity cluster", () => {
    const a = [
      record({ sourcePropertyId: "a1", name: "Grand Hotel" }),
      record({ sourcePropertyId: "a2", name: "Grand Hotel" }),
    ];
    const b = [record({ provider: "b", sourcePropertyId: "b1", name: "Grand Hotel" })];

    const analysis = analyseOverlap("dubai", a, b, NO_HEURISTIC);

    expect(analysis.oneToOneCandidatePairs).toBe(0);
    expect(analysis.ambiguityClusters).toHaveLength(1);
    expect(analysis.ambiguityClusters[0]?.aIds.sort()).toEqual(["a1", "a2"]);
  });

  it("does not collapse a shared chain domain across distinct physical properties", () => {
    // Three properties of one chain share a domain. That is one weak signal
    // linking six records, not three clean overlaps.
    const a = [
      record({ sourcePropertyId: "a1", name: "Chain Marina", websiteUrl: "https://chain.example" }),
      record({
        sourcePropertyId: "a2",
        name: "Chain Downtown",
        websiteUrl: "https://chain.example",
      }),
    ];
    const b = [
      record({
        provider: "b",
        sourcePropertyId: "b1",
        name: "Chain Marina Hotel",
        websiteUrl: "https://chain.example",
      }),
      record({
        provider: "b",
        sourcePropertyId: "b2",
        name: "Chain Downtown Hotel",
        websiteUrl: "https://chain.example",
      }),
    ];

    const analysis = analyseOverlap("dubai", a, b, NO_HEURISTIC);

    expect(analysis.oneToOneCandidatePairs).toBe(0);
    expect(analysis.ambiguityClusters).toHaveLength(1);
    expect(analysis.ambiguityClusters[0]?.aIds).toHaveLength(2);
    expect(analysis.ambiguityClusters[0]?.bIds).toHaveLength(2);
  });

  it("keeps identical names at different coordinates as evidence with the distance recorded", () => {
    // Two genuinely different "Beach Resort" properties 100km apart. With no
    // heuristic configured nothing is vetoed — the distance is the evidence, and
    // a human decides.
    const a = [record({ sourcePropertyId: "a1", name: "Beach Resort" })];
    const b = [
      record({
        provider: "b",
        sourcePropertyId: "b1",
        name: "Beach Resort",
        latitude: 26.1,
        longitude: 56.2,
      }),
    ];

    const analysis = analyseOverlap("dubai", a, b, NO_HEURISTIC);
    expect(analysis.evidencePairs).toHaveLength(1);
    expect(analysis.evidencePairs[0]?.coordinateDistanceMetres).toBeGreaterThan(100_000);

    // With a provisional heuristic that defines a contradiction, it is vetoed.
    const withHeuristic = analyseOverlap("dubai", a, b, {
      coordinatesAgreeWithinMetres: 150,
      coordinatesContradictBeyondMetres: 2000,
      minimumAgreeingSignals: 2,
    });
    expect(withHeuristic.evidencePairs).toHaveLength(0);
  });

  it("counts NO_TEXTUAL_EVIDENCE without calling it provider-only", () => {
    // Two records that share nothing textual but sit 100m apart. They may well
    // be the same hotel under a transliterated name — "no textual evidence" is
    // not "no possible match".
    const a = [record({ sourcePropertyId: "a1", name: "Alpha Hotel" })];
    const b = [
      record({ provider: "b", sourcePropertyId: "b1", name: "Fundouq Alfa", latitude: 25.2009 }),
    ];
    const analysis = analyseOverlap("dubai", a, b, NO_HEURISTIC);

    expect(analysis.evidencePairs).toHaveLength(0);
    expect(analysis.aWithNoTextualEvidence).toBe(1);
    expect(analysis.bWithNoTextualEvidence).toBe(1);
    // The claim is explicitly bounded.
    expect(analysis.spatialCandidateGeneration).toBe("not_yet_assessed");
    expect(analysis.notes.join(" ")).toContain("NOT the same as NO_POSSIBLE_MATCH");
    expect(analysis.notes.join(" ")).toContain("never be reported as provider-unique inventory");
  });

  it("builds clean 1:1 pairs only when neither side is entangled", () => {
    const pairs = [
      { aId: "a1", bId: "b1" },
      { aId: "a2", bId: "b2" },
    ].map((p) => ({
      ...p,
      exactNormalizedNameAgrees: true,
      websiteDomainAgrees: false,
      brandAgrees: false,
      phoneAgrees: false,
      addressEvidenceAvailable: false,
      bothCoordinatesPresent: false,
      coordinateDistanceMetres: null,
    }));
    const { oneToOne, clusters } = buildClusters(pairs);
    expect(oneToOne).toHaveLength(2);
    expect(clusters).toHaveLength(0);
  });

  it("normalizes names and domains for comparison only", () => {
    expect(normalizeName("  Café  Royal-Hôtel ")).toBe("cafe royal hotel");
    expect(normalizeDomain("https://www.Example.com/path?a=1")).toBe("example.com");
    expect(normalizeDomain("not a url")).toBe("");
  });
});

describe("the execution pipeline runs end to end", () => {
  it("paginates, accounts, normalizes and computes metrics", async () => {
    // Three pages of synthetic provider payloads, including one identity-less
    // record, exercised through the real pipeline.
    const pages: unknown[][] = [
      [payload({ id: "p1", rating: { stars: 5, stars_kind: "official" } })],
      [payload({ id: "p2", rating: { stars: 4, stars_kind: "official" } }), payload({ id: null })],
      [payload({ id: "p3", rating: { stars: 4.5, stars_kind: "official" } })],
    ];

    const result = await executeEvaluation({
      descriptor: SYNTHETIC,
      destination: "bali",
      runLabel: "test",
      transport: {
        fetchPage: async (_entityId, cursor) => {
          const index = cursor === null ? 0 : Number(cursor);
          return {
            records: pages[index] ?? [],
            nextCursor: index + 1 < pages.length ? String(index + 1) : null,
          };
        },
      },
    });

    expect(result.metrics.pagination.pages).toBe(3);
    expect(result.metrics.pagination.exhaustionProven).toBe(true);
    expect(result.metrics.accounting.rawRecordsReturned).toBe(4);
    expect(result.metrics.accounting.normalizedRecords).toBe(3);
    expect(result.metrics.accounting.recordsMissingSourcePropertyId).toBe(1);
    expect(result.metrics.inventory.apparentExactFiveStar).toBe(1);
    expect(result.metrics.inventory.apparentExactFourStar).toBe(1);
    expect(result.metrics.inventory.classifiedNotV1Scope).toBe(1);
    expect(result.media.propertiesWithAnyImage).toBe(3);
    expect(result.operations.paginationMethod).toBe("cursor");
    expect(result.coverageDisclaimer).toContain("NOT a coverage claim");
    // Artifacts are written under the gitignored root.
    expect(result.artifacts.every((p) => p.includes("provider-evaluation"))).toBe(true);
  });

  it("unions several provider entities for one destination and flags the union", async () => {
    const multi: AdapterDescriptor = {
      ...SYNTHETIC,
      geography: [
        {
          destination: "bali",
          providerEntityIds: ["r-ubud", "r-canggu"],
          providerEntityKind: "region",
          resolutionMethod: "synthetic fixture",
          requiresUnion: true,
          caveats: ["synthetic caveat"],
        },
      ],
    };

    const result = await executeEvaluation({
      descriptor: multi,
      destination: "bali",
      runLabel: "test",
      transport: {
        fetchPage: async (entityId) => ({
          records: [payload({ id: `${entityId}-1` })],
          nextCursor: null,
        }),
      },
    });

    expect(result.metrics.accounting.rawRecordsReturned).toBe(2);
    // A destination assembled from several entities cannot claim exhaustion
    // silently; the union and its caveats are recorded as coverage risks.
    expect(result.metrics.pagination.exhaustionProven).toBe(false);
    expect(result.metrics.pagination.coverageRisks.join(" ")).toContain("required a union");
    expect(result.metrics.pagination.coverageRisks.join(" ")).toContain("synthetic caveat");
  });

  it("refuses to run a destination whose geography is unresolved", async () => {
    await expect(
      executeEvaluation({
        descriptor: SYNTHETIC,
        destination: "dubai", // synthetic descriptor resolves bali only
        runLabel: "test",
        transport: { fetchPage: async () => ({ records: [], nextCursor: null }) },
      }),
    ).rejects.toThrow(/no resolved geography/);
  });
});

describe("capability-specific gates", () => {
  it("lets a source measure inventory, location and media with classification unresolved", () => {
    // The layered-source principle. Hotelbeds has no accepted classification and
    // no established issuer, and that must NOT veto measuring coordinates.
    const ready: AdapterDescriptor = {
      ...hotelbedsContentDescriptor,
      // Pretend egress and geography are solved; everything else stays as-is.
      blockers: [],
      geography: [
        {
          destination: "bali",
          providerEntityIds: ["D1", "D2"],
          providerEntityKind: "destination",
          resolutionMethod: "test fixture",
          requiresUnion: true,
          caveats: [],
        },
      ],
    };

    const byName = Object.fromEntries(
      assessAllCapabilities(ready, "bali").map((c) => [c.capability, c]),
    );

    expect(byName["enumerate_inventory"]?.runnable).toBe(true);
    expect(byName["measure_location"]?.runnable).toBe(true);
    expect(byName["measure_media"]?.runnable).toBe(true);
    // And the strict one is still strict.
    expect(byName["resolve_d060_classification"]?.runnable).toBe(false);
    expect(byName["resolve_d060_classification"]?.reasons.join(" ")).toContain("issuing authority");
  });

  it("does not weaken D060: no issuer means no resolution, ever", () => {
    const noIssuer: AdapterDescriptor = {
      ...SYNTHETIC,
      classification: { ...SYNTHETIC.classification, issuerEstablished: false },
    };
    const assessment = assessCapability(noIssuer, "resolve_d060_classification");
    expect(assessment.runnable).toBe(false);
    expect(assessment.reasons.join(" ")).toContain("condition 7");
  });

  it("blocks every capability when a GLOBAL blocker applies", () => {
    const blocked: AdapterDescriptor = { ...SYNTHETIC, blockers: ["EGRESS BLOCKED"] };
    for (const c of assessAllCapabilities(blocked, "bali")) {
      expect(c.runnable).toBe(false);
      expect(c.reasons).toContain("EGRESS BLOCKED");
    }
    expect(() => assertRunnableForAnyCapability(blocked, "bali")).toThrow(/cannot evaluate ANY/);
  });

  it("requires geography, but points at the discovery phase rather than stars", () => {
    const noGeography: AdapterDescriptor = { ...SYNTHETIC, geography: [] };
    const reasons = assessCapability(noGeography, "enumerate_inventory").reasons.join(" ");
    expect(reasons).toContain("geography-discovery phase");
    expect(reasons).toContain("NOT gated on classification");
  });

  it("allows a run when ANY capability is measurable", () => {
    expect(() => assertRunnableForAnyCapability(SYNTHETIC, "bali")).not.toThrow();
  });

  it("keeps Booking and Expedia as documented future strategic sources", () => {
    expect(bookingDemandDescriptor.accessStatus).toBe("direct_access_unavailable");
    expect(bookingDemandDescriptor.strategicRole).toBe("future_strategic_source");
    expect(expediaRapidDescriptor.accessStatus).toBe("direct_access_unavailable");
    expect(expediaRapidDescriptor.liveValidationStatus).toBe("not_run");
  });

  it("keeps the top-500 mapping cap as a GEOGRAPHY risk, not a content pagination cap", () => {
    expect(expediaRapidDescriptor.pagination?.documentedHardCap).toBeNull();
    expect(expediaRapidDescriptor.geographyEnumerationRisks.join(" ")).toContain("TOP 500");
  });

  it("does not raise a geography coverage risk from a >500-record content extraction", async () => {
    const pages = [
      Array.from({ length: 500 }, (_, i) => payload({ id: `a${i}` })),
      Array.from({ length: 400 }, (_, i) => payload({ id: `b${i}` })),
    ];

    const result = await executeEvaluation({
      descriptor: SYNTHETIC,
      destination: "bali",
      runLabel: "test",
      transport: {
        fetchPage: async (_entityId, cursor) => {
          const index = cursor === null ? 0 : Number(cursor);
          return {
            records: pages[index] ?? [],
            nextCursor: index + 1 < pages.length ? String(index + 1) : null,
          };
        },
      },
    });

    expect(result.metrics.accounting.rawRecordsReturned).toBe(900);
    expect(result.metrics.pagination.exhaustionProven).toBe(true);
    expect(result.metrics.pagination.coverageRisks).toEqual([]);
  });

  it("resolves adapters by name and rejects unknown ones", () => {
    expect(getAdapter("hotelbeds").provider).toBe("hotelbeds");
    expect(() => getAdapter("nope")).toThrow(/Unknown provider/);
  });

  it("never records an availability endpoint as the coverage source", () => {
    for (const d of [bookingDemandDescriptor, expediaRapidDescriptor, hotelbedsContentDescriptor]) {
      expect(d.usesAvailabilityEndpointForCoverage).toBe(false);
    }
  });

  it("attributes external-review evidence honestly", () => {
    for (const source of [
      ...bookingDemandDescriptor.sources,
      ...expediaRapidDescriptor.sources,
      ...hotelbedsContentDescriptor.sources,
    ]) {
      expect(source.verifiedBy).toBe("external_review");
    }
  });
});

describe("classification: master-data join, then D060 interpretation", () => {
  const HOTELBEDS: AdapterDescriptor = {
    ...SYNTHETIC,
    provider: "hb",
    classification: {
      mode: "code_with_master_lookup",
      codePath: "categoryCode",
      hotelAccommodationTypes: ["HOTEL"],
      issuerEstablished: true,
    },
  };

  const master = buildClassificationMaster(
    [
      { code: "5EST", simpleCode: "5", accommodationType: "HOTEL", description: "5 STAR" },
      { code: "4EST", simpleCode: "4", accommodationType: "HOTEL", description: "4 STAR" },
      { code: "3EST", simpleCode: "3", accommodationType: "HOTEL", description: "3 STAR" },
      { code: "5LL", simpleCode: "5", accommodationType: "APARTMENT", description: "5 KEY" },
      { code: "BOUT", simpleCode: "BO", accommodationType: "HOTEL", description: "BOUTIQUE" },
    ],
    {
      code: "code",
      simpleCode: "simpleCode",
      accommodationType: "accommodationType",
      description: "description",
    },
  );
  const reference = { classifications: master };

  function interpret(categoryCode: unknown, descriptor = HOTELBEDS) {
    const observation = observeClassification({ categoryCode }, descriptor, reference);
    return { observation, eligibility: interpretClassificationForD060(observation, descriptor) };
  }

  it("resolves a hotel category code through master data", () => {
    const { observation, eligibility } = interpret("5EST");
    expect(observation.resolution).toBe("resolved");
    expect(observation.master?.accommodationType).toBe("HOTEL");
    expect(eligibility).toBe("exact_five");
    expect(interpret("4EST").eligibility).toBe("exact_four");
  });

  it("keeps HOTEL + 5 STAR distinct from APARTMENT + 5 KEY", () => {
    // Both have simpleCode 5. Only one is five hotel stars.
    expect(interpret("5EST").eligibility).toBe("exact_five");
    expect(interpret("5LL").eligibility).toBe("unresolved");
    expect(interpret("5LL").observation.master?.description).toBe("5 KEY");
  });

  it("treats a genuine 3-star hotel as classified-but-out-of-scope", () => {
    expect(interpret("3EST").eligibility).toBe("classified_not_v1_scope");
  });

  it("marks a missing master entry as unresolved, not as absent classification", () => {
    const { observation, eligibility } = interpret("NOPE");
    expect(observation.resolution).toBe("unresolved_no_master_entry");
    expect(observation.sourceCode).toBe("NOPE");
    expect(eligibility).toBe("unresolved");
  });

  it("marks a missing code on the property as unresolved", () => {
    expect(interpret(null).observation.resolution).toBe("unresolved_no_code");
  });

  it("NEVER manufactures a number from the category code string", () => {
    // "5EST" contains a 5. Only an explicit numeric simpleCode counts.
    expect(
      numericLevelFrom({
        code: "5EST",
        simpleCode: "5EST",
        accommodationType: "HOTEL",
        group: null,
        description: "5 STAR",
      }),
    ).toBeNull();
    expect(
      numericLevelFrom({
        code: "BOUT",
        simpleCode: "BO",
        accommodationType: "HOTEL",
        group: null,
        description: "BOUTIQUE",
      }),
    ).toBeNull();
    expect(interpret("BOUT").eligibility).toBe("unresolved");
  });

  it("resolves nothing while no accommodation type is accepted as a hotel classification", () => {
    const undeclared: AdapterDescriptor = {
      ...HOTELBEDS,
      classification: { ...HOTELBEDS.classification, hotelAccommodationTypes: [] },
    };
    expect(interpret("5EST", undeclared).eligibility).toBe("unresolved");
  });

  it("resolves nothing while the issuing authority is unestablished", () => {
    const noIssuer: AdapterDescriptor = {
      ...HOTELBEDS,
      classification: { ...HOTELBEDS.classification, issuerEstablished: false },
    };
    expect(interpret("5EST", noIssuer).eligibility).toBe("unresolved");
  });

  it("reports the join outcome distribution in the metrics", () => {
    const payloads = [
      { id: "a", categoryCode: "5EST" },
      { id: "b", categoryCode: "5LL" },
      { id: "c", categoryCode: "NOPE" },
      { id: "d" },
    ];
    const { records, accounting } = normalizeAll(payloads, HOTELBEDS, "bali", reference);
    const metrics = computeMetrics(records, accounting, HOTELBEDS, "bali", EVIDENCE);

    expect(metrics.inventory.apparentExactFiveStar).toBe(1);
    expect(metrics.inventory.classificationResolutionDistribution["resolved"]).toBe(2);
    expect(
      metrics.inventory.classificationResolutionDistribution["unresolved_no_master_entry"],
    ).toBe(1);
    expect(metrics.inventory.classificationAccommodationTypeDistribution["APARTMENT"]).toBe(1);
  });
});

describe("media evidence is derived from the images collection", () => {
  it("finds a principal-image candidate via visualOrder = 0", () => {
    const withPrincipal = payload({
      id: "a",
      images: [
        { url: "x.jpg", kind: "GEN", visualOrder: 1 },
        { url: "y.jpg", kind: "ROO", visualOrder: 0 },
      ],
    });
    const { records, accounting } = normalizeAll([withPrincipal], SYNTHETIC, "bali");
    expect(records[0]?.hasPrincipalImageCandidate).toBe(true);
    expect(records[0]?.imageTypes.sort()).toEqual(["GEN", "ROO"]);
    expect(records[0]?.imagesWithPath).toBe(2);

    const metrics = computeMetrics(records, accounting, SYNTHETIC, "bali", EVIDENCE);
    expect(metrics.fieldCoverage.heroImagePct).toBe(100);
  });

  it("reports no principal candidate when no image carries visualOrder 0", () => {
    const noPrincipal = payload({
      id: "b",
      // hero cleared: this test exercises pure derivation from the collection.
      hero: null,
      images: [{ url: "x.jpg", kind: "GEN", visualOrder: 3 }],
    });
    const { records } = normalizeAll([noPrincipal], SYNTHETIC, "bali");
    expect(records[0]?.hasPrincipalImageCandidate).toBe(false);
  });

  it("aggregates image types and path availability into media evidence", () => {
    const { records } = normalizeAll(
      [
        payload({ id: "a", hero: null, images: [{ url: "1.jpg", kind: "GEN", visualOrder: 0 }] }),
        payload({ id: "b", hero: null, images: [{ kind: "ROO", visualOrder: 2 }] }),
      ],
      SYNTHETIC,
      "bali",
    );
    const media = computeMediaEvidence(records, SYNTHETIC);

    expect(media.propertiesWithAnyImage).toBe(2);
    expect(media.propertiesWithPrincipalImageCandidate).toBe(1);
    expect(media.totalImages).toBe(2);
    // One image has no path — that is a real content-quality signal.
    expect(media.imagesWithPath).toBe(1);
    expect(media.categoryDistribution["GEN"]).toBe(1);
  });

  it("still honours an explicit hero field when the provider has one", () => {
    // SYNTHETIC maps `heroImage: "hero"`, and the default payload supplies it.
    const { records } = normalizeAll([payload({ id: "c", images: [] })], SYNTHETIC, "bali");
    expect(records[0]?.hasPrincipalImageCandidate).toBe(true);
  });

  it("keeps Hotelbeds media as technically available, rights unresolved", () => {
    const constraints = hotelbedsContentDescriptor.media.documentedUsageConstraints.join(" ");
    expect(constraints).toContain("TECHNICALLY_AVAILABLE");
    expect(constraints).toContain("PRODUCTION_RIGHTS_REVIEW_REQUIRED");
  });
});

describe("credentials are reported without ever exposing a value", () => {
  it("reports AVAILABLE / NOT AVAILABLE only", () => {
    const report = checkCredentials("x", ["PRESENT_KEY", "MISSING_KEY"], {
      PRESENT_KEY: "super-secret-value",
      MISSING_KEY: "",
    } as unknown as NodeJS.ProcessEnv);

    expect(report.variables).toEqual({
      PRESENT_KEY: "AVAILABLE",
      MISSING_KEY: "NOT AVAILABLE",
    });
    expect(report.allPresent).toBe(false);
    expect(JSON.stringify(report)).not.toContain("super-secret-value");
  });
});

describe("secret redaction", () => {
  it("recognises secret-shaped variable names", () => {
    expect(isSecretName("EXPEDIA_RAPID_SHARED_SECRET")).toBe(true);
    expect(isSecretName("BOOKING_DEMAND_API_TOKEN")).toBe(true);
    expect(isSecretName("Authorization")).toBe(true);
    expect(isSecretName("DESTINATION")).toBe(false);
  });

  it("redacts a secret value out of free text, wherever it appears", () => {
    const text = "GET /x?token=abcdefgh12345 failed with header abcdefgh12345";
    expect(redactSecrets(text, ["abcdefgh12345"])).toBe(
      "GET /x?token=[REDACTED] failed with header [REDACTED]",
    );
  });

  it("redacts by key name as well as by value, keeping the shape", () => {
    const out = redactObject(
      { headers: { Authorization: "Bearer abcdefgh12345" }, url: "https://x/?k=abcdefgh12345" },
      ["abcdefgh12345"],
    ) as { headers: { Authorization: string }; url: string };

    expect(out.headers.Authorization).toBe("[REDACTED]");
    expect(out.url).not.toContain("abcdefgh12345");
  });

  it("ignores values too short to be credentials", () => {
    expect(redactSecrets("a short abc value", ["abc"])).toBe("a short abc value");
  });

  it("collects secret values from an env by name shape", () => {
    const values = collectSecretValues({
      SOME_API_TOKEN: "tokenvalue123",
      PLAIN: "not-a-secret",
    } as unknown as NodeJS.ProcessEnv);
    expect(values).toEqual(["tokenvalue123"]);
  });
});

describe("Dubai pilot probe input", () => {
  it("builds entries from raw rows and skips unnamed ones", () => {
    const entries = buildProbeEntries([
      {
        sheetName: "properties",
        sourceRowNumber: 2,
        data: {
          property_name: "Synthetic Hotel",
          address: "1 Fake Road",
          website_url: "https://synthetic.example",
          star_rating: "5",
          latitude: null,
          longitude: null,
          source_property_id: "SYN-1",
        },
      },
      {
        sheetName: "properties",
        sourceRowNumber: 3,
        data: { property_name: null, address: "2 Fake Road" },
      },
    ]);

    expect(entries).toHaveLength(1);
    expect(entries[0]?.name).toBe("Synthetic Hotel");
    expect(entries[0]?.starRating).toBe(5);
    expect(entries[0]?.latitude).toBeNull();
  });
});

describe("raw provider data cannot reach the repository", () => {
  it("keeps the artifact root gitignored", () => {
    // Brief §8: raw provider responses and derived property-level extracts must
    // stay out of git. A rule nobody checks is a rule that lapses, so check it.
    const probe = join(ARTIFACT_ROOT, "booking-bali-raw.json");
    const result = spawnSync("git", ["check-ignore", probe], { encoding: "utf8" });
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe(probe);
  });

  it("keeps the real pilot workbook gitignored", () => {
    const workbook = "data/imports/raw/theugc-life_Sprint1C_Dubai_Pilot_30.xlsx";
    const result = spawnSync("git", ["check-ignore", workbook], { encoding: "utf8" });
    expect(result.status).toBe(0);
  });
});

describe("local env loading", () => {
  it("reports when no local env file exists rather than silently doing nothing", () => {
    const result = loadLocalEnv(mkdtempSync(join(tmpdir(), "eval-env-")));
    expect(result.loaded).toBe(false);
    expect(result.path).toContain(LOCAL_ENV_FILE);
  });

  it("loads variables from .env.local without overriding an exported value", () => {
    const dir = mkdtempSync(join(tmpdir(), "eval-env-"));
    writeFileSync(
      join(dir, LOCAL_ENV_FILE),
      "EVAL_TEST_FROM_FILE=file-value\nEVAL_TEST_ALREADY_SET=file-value\n",
    );
    process.env.EVAL_TEST_ALREADY_SET = "exported-value";

    const result = loadLocalEnv(dir);

    expect(result.loaded).toBe(true);
    expect(process.env.EVAL_TEST_FROM_FILE).toBe("file-value");
    // An explicitly exported value must win over a stale file.
    expect(process.env.EVAL_TEST_ALREADY_SET).toBe("exported-value");

    delete process.env.EVAL_TEST_FROM_FILE;
    delete process.env.EVAL_TEST_ALREADY_SET;
  });
});
