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
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { ARTIFACT_ROOT } from "../../scripts/provider-evaluation/artifacts";

import { bookingDemandDescriptor } from "../../scripts/provider-evaluation/adapters/booking";
import { expediaRapidDescriptor } from "../../scripts/provider-evaluation/adapters/expedia";
import {
  assertRunnable,
  checkRunnable,
  getAdapter,
} from "../../scripts/provider-evaluation/adapters/registry";
import { checkCredentials } from "../../scripts/provider-evaluation/credentials";
import { computeMetrics } from "../../scripts/provider-evaluation/metrics";
import {
  buildStarObservation,
  hasValidCoordinates,
  isD060Evidence,
  normalizeAll,
  readPath,
} from "../../scripts/provider-evaluation/normalize";
import {
  analyseOverlap,
  classifyPair,
  normalizeDomain,
  normalizeName,
  scorePair,
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
  sources: [{ url: "https://example.invalid/docs", accessedAt: "2026-08-15" }],
  requiredCredentialEnvVars: ["SYNTHETIC_API_KEY"],
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
    providerContact: "contact.email",
    star: "rating.stars",
    starKind: "rating.stars_kind",
    reviewScore: "rating.guest_score",
    photos: "images",
    heroImage: "hero",
    activeStatus: "status",
  } as AdapterDescriptor["fieldMap"],
  starSemantics: {
    provider: "synthetic",
    destination: "global",
    fieldName: "rating.stars",
    documentedSemantics: "Hospitality classification where kind=official.",
    isHospitalityClassification: true,
    issuer: "National tourism authority",
    origin: "official_authority",
    scale: "1-5 integers",
    refreshBehaviour: "monthly",
    provenanceAvailableToUs: true,
    observedConflicts: [],
    verdict: "suitable",
    sources: [{ url: "https://example.invalid/docs/stars", accessedAt: "2026-08-15" }],
  },
  starKindsAcceptedAsD060Evidence: ["official"],
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
    contact: { email: "reservations@test-property.example" },
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
  it("reads a star classification and its kind", () => {
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

  it("drops records with no provider id, since they cannot be counted or matched", () => {
    const records = normalizeAll([payload(), payload({ id: null })], SYNTHETIC, "bali");
    expect(records).toHaveLength(1);
  });

  it("reads missing paths as null rather than throwing", () => {
    expect(readPath(payload(), "nope.not.here")).toBeNull();
    expect(readPath(null, "a.b")).toBeNull();
  });

  it("treats 0,0 and out-of-range coordinates as invalid", () => {
    const [ok] = normalizeAll([payload()], SYNTHETIC, "bali");
    const [nullIsland] = normalizeAll(
      [payload({ id: "p2", location: { lat: 0, lon: 0 } })],
      SYNTHETIC,
      "bali",
    );
    const [outOfRange] = normalizeAll(
      [payload({ id: "p3", location: { lat: 99, lon: 200 } })],
      SYNTHETIC,
      "bali",
    );

    expect(ok && hasValidCoordinates(ok)).toBe(true);
    expect(nullIsland && hasValidCoordinates(nullIsland)).toBe(false);
    expect(outOfRange && hasValidCoordinates(outOfRange)).toBe(false);
  });
});

describe("metrics", () => {
  it("counts an unusable star kind as unknown, never as a lower band", () => {
    // The distinction D061 insists on: "classification unknown" is a review
    // state; "confirmed 3-star" is out of scope. Collapsing them deletes hotels.
    const records = normalizeAll(
      [
        payload({ id: "a", rating: { stars: 5, stars_kind: "official" } }),
        payload({ id: "b", rating: { stars: 4, stars_kind: "official" } }),
        payload({ id: "c", rating: { stars: 3, stars_kind: "official" } }),
        payload({ id: "d", rating: { stars: 5, stars_kind: "guessed" } }),
        payload({ id: "e", rating: { guest_score: 9.9 } }),
      ],
      SYNTHETIC,
      "bali",
    );

    const metrics = computeMetrics(records, SYNTHETIC, "bali", EVIDENCE);

    expect(metrics.inventory.apparentFiveStar).toBe(1);
    expect(metrics.inventory.apparentFourStar).toBe(1);
    expect(metrics.inventory.apparentLowerStar).toBe(1);
    expect(metrics.inventory.unknownStar).toBe(2);
    expect(metrics.fieldCoverage.starFieldPct).toBe(80);
    expect(metrics.fieldCoverage.starSuitableForD060Pct).toBe(60);
  });

  it("computes field coverage and photo statistics", () => {
    const records = normalizeAll(
      [
        payload({ id: "a", images: ["1.jpg"] }),
        payload({ id: "b", images: ["1.jpg", "2.jpg", "3.jpg"] }),
        payload({ id: "c", images: [], hero: null, urls: {} }),
      ],
      SYNTHETIC,
      "bali",
    );

    const metrics = computeMetrics(records, SYNTHETIC, "bali", EVIDENCE);

    expect(metrics.inventory.totalRawRecords).toBe(3);
    expect(metrics.fieldCoverage.photoPct).toBeCloseTo(66.67, 1);
    expect(metrics.fieldCoverage.medianPhotosPerProperty).toBe(1);
    expect(metrics.fieldCoverage.averagePhotosPerProperty).toBeCloseTo(1.33, 1);
    expect(metrics.fieldCoverage.websitePct).toBeCloseTo(66.67, 1);
    expect(metrics.fieldCoverage.validCoordinatesPct).toBe(100);
  });

  it("reports duplicate provider ids rather than hiding them", () => {
    const records = normalizeAll([payload(), payload()], SYNTHETIC, "bali");
    const metrics = computeMetrics(records, SYNTHETIC, "bali", EVIDENCE);
    expect(metrics.inventory.totalRawRecords).toBe(2);
    expect(metrics.inventory.uniqueSourcePropertyIds).toBe(1);
    expect(metrics.inventory.duplicateIdRecords).toBe(1);
  });
});

describe("overlap analysis is conservative", () => {
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
      providerContact: null,
      star: { value: 5, kind: "official", reviewScore: null },
      photoCount: 0,
      hasHeroImage: false,
      activeStatus: null,
      ...over,
    };
  }

  it("does not merge on name similarity alone", () => {
    const verdict = classifyPair(
      scorePair(
        record({ latitude: null, longitude: null }),
        record({ provider: "b", latitude: null, longitude: null }),
      ),
    );
    expect(verdict).toBe("ambiguous");
  });

  it("accepts a pair only when two independent signals agree", () => {
    const a = record({ websiteUrl: "https://www.hotel-one.example/rooms" });
    const b = record({ provider: "b", websiteUrl: "https://hotel-one.example" });
    expect(classifyPair(scorePair(a, b))).toBe("high_confidence");
  });

  it("lets a coordinate contradiction veto a name+domain match", () => {
    // Same brand name and domain, 100km apart: two different properties, and a
    // merge here would weld one hotel's history onto another.
    const a = record({ websiteUrl: "https://chain.example" });
    const b = record({
      provider: "b",
      websiteUrl: "https://chain.example",
      latitude: 26.1,
      longitude: 56.2,
    });
    expect(classifyPair(scorePair(a, b))).toBe("no_match");
  });

  it("counts provider-only records and a union that assumes nothing", () => {
    const a = [
      record({ sourcePropertyId: "a1", websiteUrl: "https://one.example" }),
      record({ sourcePropertyId: "a2", name: "Solo A", latitude: 25.4, longitude: 55.5 }),
    ];
    const b = [
      record({
        provider: "b",
        sourcePropertyId: "b1",
        websiteUrl: "https://one.example",
      }),
      record({
        provider: "b",
        sourcePropertyId: "b2",
        name: "Solo B",
        latitude: 25.9,
        longitude: 55.9,
      }),
    ];

    const analysis = analyseOverlap("dubai", a, b);

    expect(analysis.highConfidenceOverlap).toBe(1);
    expect(analysis.aOnly).toBe(1);
    expect(analysis.bOnly).toBe(1);
    // 2 + 2 - 1 matched = 3 distinct candidates before human resolution.
    expect(analysis.estimatedUnionBeforeResolution).toBe(3);
  });

  it("normalizes names and domains for comparison only", () => {
    expect(normalizeName("  Café  Royal-Hôtel ")).toBe("cafe royal hotel");
    expect(normalizeDomain("https://www.Example.com/path?a=1")).toBe("example.com");
    expect(normalizeDomain("not a url")).toBe("");
  });
});

describe("the runnability gate blocks unverified descriptors", () => {
  it("refuses Booking until its documentation is verified", () => {
    const problem = checkRunnable(bookingDemandDescriptor);
    expect(problem).not.toBeNull();
    expect(problem?.reasons.join(" ")).toContain("UNVERIFIED");
    expect(() => assertRunnable(bookingDemandDescriptor)).toThrow(/cannot be evaluated yet/);
  });

  it("refuses Expedia until its documentation is verified", () => {
    expect(() => assertRunnable(expediaRapidDescriptor)).toThrow(/cannot be evaluated yet/);
  });

  it("names the missing star semantics explicitly, not just 'incomplete'", () => {
    const reasons = checkRunnable(expediaRapidDescriptor)?.reasons.join(" ") ?? "";
    expect(reasons).toContain("Star semantics have not been established");
    expect(reasons).toContain("not automatically a hospitality classification");
  });

  it("allows a fully verified descriptor through", () => {
    expect(checkRunnable(SYNTHETIC)).toBeNull();
    expect(() => assertRunnable(SYNTHETIC)).not.toThrow();
  });

  it("never records an availability endpoint as the coverage source", () => {
    for (const descriptor of [bookingDemandDescriptor, expediaRapidDescriptor, SYNTHETIC]) {
      expect(descriptor.usesAvailabilityEndpointForCoverage).toBe(false);
    }
  });

  it("resolves adapters by name and rejects unknown ones", () => {
    expect(getAdapter("booking").provider).toBe("booking");
    expect(() => getAdapter("nope")).toThrow(/Unknown provider/);
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
