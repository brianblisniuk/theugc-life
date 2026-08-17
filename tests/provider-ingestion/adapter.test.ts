/**
 * Pure-unit tests for the provider ingestion adapter, manifest and CLI guards.
 *
 * No database and no network. Every fixture is SYNTHETIC — no real Hotelbeds
 * property appears in this repository, and the real cached artifacts are
 * gitignored evaluation evidence, not test data.
 */
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import {
  coordinatePlausibility,
  mapProperty,
  selectVoicePhone,
  buildRunNotes,
  loadReferenceData,
  buildBatch,
  type HotelbedsReferenceData,
} from "../../scripts/provider-ingestion/adapters/hotelbeds-cached";
import {
  canonicalJson,
  digestValue,
  deterministicUuid,
} from "../../scripts/provider-ingestion/digest";
import {
  resolveIngestionTarget,
  isLocalSocketUrl,
  UnsafeIngestionTargetError,
} from "../../scripts/provider-ingestion/db-target";
import {
  buildManifest,
  runFingerprint,
  verifyManifest,
  verifyManifestIntegrity,
  ArtifactDigestMismatchError,
  ManifestIntegrityError,
  MissingArtifactError,
  HOTELBEDS_EVALUATION_COVERAGE_RISKS,
  RUN_EVIDENCE_VERSION,
  type ArtifactSelection,
  type IngestionManifest,
} from "../../scripts/provider-ingestion/manifest";
import {
  assertArtifactsConsistent,
  assertGeographyConsistent,
  ArtifactConsistencyError,
  GeographyContradictionError,
} from "../../scripts/provider-ingestion/consistency";
import { parseArgs } from "../../scripts/provider-ingestion/ingest";
import {
  assertAttributesBounded,
  IngestionWriteError,
} from "../../scripts/provider-ingestion/writer";

const tempRoots: string[] = [];
afterAll(() => {
  for (const dir of tempRoots) rmSync(dir, { recursive: true, force: true });
});

/** A synthetic provider record in the shape the cached adapter reads. */
function syntheticProperty(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    code: 900001,
    name: { content: "Synthetic Beach Resort" },
    destinationCode: "SYN",
    zoneCode: 7,
    countryCode: "ZZ",
    coordinates: { latitude: -8.5, longitude: 115.2 },
    address: { content: "1 Synthetic Road" },
    postalCode: "00000",
    city: { content: "SYNTHETIC CITY" },
    email: "info@synthetic.example",
    web: "https://synthetic.example",
    phones: [
      { phoneNumber: "+100000001", phoneType: "PHONEFAX" },
      { phoneNumber: "+100000002", phoneType: "PHONEBOOKING" },
    ],
    categoryCode: "5EST",
    categoryGroupCode: "GRUPO5",
    chainCode: "SYNCHAIN",
    accommodationTypeCode: "H",
    images: [
      { imageTypeCode: "GEN", path: "a.jpg", order: 1, visualOrder: 0 },
      { imageTypeCode: "HAB", path: "b.jpg", order: 2, visualOrder: 5 },
    ],
    // Bulk sections the writer must never persist.
    rooms: [{ roomCode: "SYN.X" }],
    facilities: [{ facilityCode: 1 }],
    description: { content: "x".repeat(500) },
    ...over,
  };
}

const reference: HotelbedsReferenceData = {
  classifications: new Map([
    [
      "5EST",
      {
        code: "5EST",
        simpleCode: "5",
        accommodationType: null,
        group: "GRUPO5",
        description: "5 STARS",
      },
    ],
    [
      "5LL",
      {
        code: "5LL",
        simpleCode: "5",
        accommodationType: null,
        group: "GRUPO7",
        description: "5 KEYS",
      },
    ],
  ]),
  accommodationTypes: new Map([
    ["H", "Hotel"],
    ["A", "Apartment"],
  ]),
};

describe("hotelbeds cached adapter — field mapping", () => {
  it("maps a property to source evidence without upgrading its meaning", () => {
    const obs = mapProperty(syntheticProperty(), reference)!;

    expect(obs.sourcePropertyId).toBe("900001");
    expect(obs.name).toBe("Synthetic Beach Resort");
    expect(obs.destinationCode).toBe("SYN");
    // Numeric provider values become TEXT, because a provider id is text.
    expect(obs.zoneCode).toBe("7");
    expect(obs.city).toBe("SYNTHETIC CITY");
    expect(obs.propertyTypeCode).toBe("H");
    expect(obs.propertyTypeLabel).toBe("Hotel");
  });

  it("never selects a FAX as the contact phone", () => {
    // The fax is first in the array. Taking `phones[0]` would report it as a
    // contact number — the quiet meaning-upgrade this pipeline exists to stop.
    const obs = mapProperty(syntheticProperty(), reference)!;
    expect(obs.phone).toBe("+100000002");
    expect(obs.phoneType).toBe("PHONEBOOKING");

    // A fax-only property yields no phone at all rather than a fax.
    const faxOnly = selectVoicePhone({
      phones: [{ phoneNumber: "+199", phoneType: "PHONEFAX" }],
    });
    expect(faxOnly.phone).toBeNull();
  });

  it("keeps provider classification as EVIDENCE, with simpleCode as text", () => {
    const obs = mapProperty(syntheticProperty(), reference)!;
    expect(obs.classificationCode).toBe("5EST");
    expect(obs.classificationLabel).toBe("5 STARS");
    expect(obs.classificationSimpleCode).toBe("5");
    // A string, not a number: `5` covers 5 STARS and 5 KEYS alike.
    expect(typeof obs.classificationSimpleCode).toBe("string");

    // And the adapter produces no canonical star field of any kind.
    expect(Object.keys(obs)).not.toContain("starRating");
    expect(Object.keys(obs)).not.toContain("canonicalStars");
  });

  it("does not invent a lifecycle status the payload never carried", () => {
    // PR #21 established the hotels payload has no structured lifecycle field.
    const obs = mapProperty(syntheticProperty(), reference)!;
    expect(obs.lifecycleStatus).toBeNull();
  });

  it("records media as a SUMMARY, never as rows or URLs", () => {
    const obs = mapProperty(syntheticProperty(), reference)!;
    expect(obs.imageCount).toBe(2);
    // visualOrder = 0 is the documented provider designation.
    expect(obs.providerDesignatedPrincipalImage).toBe(true);

    const serialized = JSON.stringify(obs);
    expect(serialized).not.toContain("a.jpg");
    expect(serialized).not.toContain("photos.hotelbeds.com");
  });

  it("treats a missing principal designation as a valid documented state", () => {
    const obs = mapProperty(
      syntheticProperty({ images: [{ imageTypeCode: "GEN", path: "c.jpg", visualOrder: 42 }] }),
      reference,
    )!;
    expect(obs.imageCount).toBe(1);
    // Absence is not a defect and is not reinterpreted.
    expect(obs.providerDesignatedPrincipalImage).toBe(false);
  });

  it("carries no payload bulk into source_attributes", () => {
    const obs = mapProperty(syntheticProperty(), reference)!;
    expect(obs.attributes).toEqual({});
    const serialized = JSON.stringify(obs);
    expect(serialized).not.toContain("roomCode");
    expect(serialized).not.toContain("facilityCode");
    // The 500-char description does not travel either.
    expect(serialized.length).toBeLessThan(1000);
  });

  it("returns null for a record with no provider id, rather than inventing one", () => {
    expect(mapProperty(syntheticProperty({ code: null }), reference)).toBeNull();
    expect(mapProperty({}, reference)).toBeNull();
  });

  it("leaves an unresolvable category code as raw evidence", () => {
    const obs = mapProperty(syntheticProperty({ categoryCode: "NOTINMASTER" }), reference)!;
    // The code is retained — "the master does not explain this" is source-quality
    // evidence, not an excuse to drop the field.
    expect(obs.classificationCode).toBe("NOTINMASTER");
    expect(obs.classificationSimpleCode).toBeNull();
    expect(obs.classificationLabel).toBeNull();
  });
});

describe("coordinate plausibility", () => {
  it("keeps 'not supplied' distinct from 'supplied and implausible'", () => {
    expect(coordinatePlausibility(null, null)).toBeNull();
    expect(coordinatePlausibility(-8.5, null)).toBeNull();
    expect(coordinatePlausibility(-8.5, 115.2)).toBe(true);
    // The real Bali out-of-range longitude shape.
    expect(coordinatePlausibility(-8.69, -244.7)).toBe(false);
    // 0,0 is the Gulf of Guinea and almost always a missing-value sentinel.
    expect(coordinatePlausibility(0, 0)).toBe(false);
  });

  it("PRESERVES an implausible coordinate on the observation", () => {
    const obs = mapProperty(
      syntheticProperty({ coordinates: { latitude: -8.690705, longitude: -244.73644 } }),
      reference,
    )!;
    // Flagged, never dropped, nulled or coerced.
    expect(obs.latitude).toBe(-8.690705);
    expect(obs.longitude).toBe(-244.73644);
    expect(obs.coordinatesPlausible).toBe(false);
  });

  it("leaves missing coordinates missing rather than 0/0", () => {
    const obs = mapProperty(syntheticProperty({ coordinates: {} }), reference)!;
    expect(obs.latitude).toBeNull();
    expect(obs.longitude).toBeNull();
    expect(obs.coordinatesPlausible).toBeNull();
  });
});

describe("payload digest", () => {
  it("is deterministic and independent of key order", () => {
    const a = { code: 1, name: "x", nested: { b: 2, a: 1 } };
    const b = { nested: { a: 1, b: 2 }, name: "x", code: 1 };
    expect(canonicalJson(a)).toBe(canonicalJson(b));
    expect(digestValue(a)).toBe(digestValue(b));
  });

  it("preserves array order, because provider order is meaningful", () => {
    expect(digestValue([1, 2])).not.toBe(digestValue([2, 1]));
  });

  it("changes when any provider field changes, including unmodelled ones", () => {
    const base = syntheticProperty();
    const first = mapProperty(base, reference)!.payloadDigest;
    // `ranking` has no column anywhere in 0027.
    const changed = mapProperty(syntheticProperty({ ranking: 99 }), reference)!.payloadDigest;
    expect(changed).not.toBe(first);
    // Same input, same digest.
    expect(mapProperty(syntheticProperty(), reference)!.payloadDigest).toBe(first);
  });

  it("derives a stable, well-formed UUID from a fingerprint", () => {
    const id = deterministicUuid("synthetic-fingerprint");
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(deterministicUuid("synthetic-fingerprint")).toBe(id);
    expect(deterministicUuid("other")).not.toBe(id);
  });
});

// ---------------------------------------------------------------------------
// Manifest
// ---------------------------------------------------------------------------
function syntheticRepo(): { root: string; selection: ArtifactSelection } {
  const root = mkdtempSync(path.join(tmpdir(), "ingest-fixture-"));
  tempRoots.push(root);
  mkdirSync(path.join(root, "raw"), { recursive: true });

  writeFileSync(
    path.join(root, "raw", "properties.json"),
    JSON.stringify([syntheticProperty(), syntheticProperty({ code: 900002 })]),
  );
  writeFileSync(
    path.join(root, "metrics.json"),
    JSON.stringify({
      metrics: {
        accounting: {
          rawRecordsReturned: 2,
          uniqueSourcePropertyIds: 2,
          duplicateIdRecords: 0,
          recordsMissingSourcePropertyId: 0,
        },
        pagination: {
          reportedTotal: 2,
          walkCompleted: true,
          requests: 1,
          coverageRisks: ["[geography] synthetic coverage caveat"],
        },
      },
    }),
  );
  writeFileSync(
    path.join(root, "categories.json"),
    JSON.stringify({
      classifications: [
        {
          code: "5EST",
          simpleCode: "5",
          accommodationType: null,
          group: "GRUPO5",
          description: "5 STARS",
        },
      ],
    }),
  );
  writeFileSync(
    path.join(root, "accommodations.json"),
    JSON.stringify({ types: [{ code: "H", description: "Hotel" }] }),
  );

  return {
    root,
    selection: {
      provider: "synthetic_provider",
      destinationSlug: "synthetica",
      providerGeography: { destinationCode: "SYN" },
      rawProperties: "raw/properties.json",
      runMetrics: "metrics.json",
      classificationMaster: "categories.json",
      accommodationMaster: "accommodations.json",
    },
  };
}

describe("ingestion manifest", () => {
  it("freezes digests, counts and a labelled timestamp basis", async () => {
    const { root, selection } = syntheticRepo();
    const manifest = await buildManifest(selection, root);

    expect(manifest.artifacts).toHaveLength(4);
    for (const artifact of manifest.artifacts) {
      expect(artifact.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(artifact.bytes).toBeGreaterThan(0);
    }
    expect(manifest.evidence.rawRecordCount).toBe(2);
    expect(manifest.evidence.providerReportedTotal).toBe(2);
    // The timestamp is honest about what it is: local evidence, not provider truth.
    expect(manifest.observedAtBasis).toBe("artifact_capture_timestamp_local_evidence");
    expect(manifest.manifestDigest).toMatch(/^[0-9a-f]{64}$/);
  });

  it("re-derives ENUMERATION exhaustion without letting coverage risks block it", async () => {
    const { root, selection } = syntheticRepo();
    const manifest = await buildManifest(selection, root);

    // The walk completed and the provider total matched, so enumeration is
    // proven — and the open geography caveat is carried, not deleted. These are
    // different dimensions (0027 §7.1).
    expect(manifest.evidence.paginationWalkCompleted).toBe(true);
    expect(manifest.evidence.enumerationRisks).toEqual([]);
    expect(manifest.evidence.providerEnumerationExhaustionProven).toBe(true);
    // One synthetic geography caveat from the metrics, plus the one durable
    // evaluation-wide coverage-universe risk.
    expect(manifest.evidence.coverageRisks).toHaveLength(2);
  });

  it("refuses exhaustion when the provider total disagrees with the rows returned", async () => {
    const { root, selection } = syntheticRepo();
    writeFileSync(
      path.join(root, "metrics.json"),
      JSON.stringify({
        metrics: {
          accounting: { rawRecordsReturned: 2, uniqueSourcePropertyIds: 2 },
          pagination: { reportedTotal: 9, walkCompleted: true, coverageRisks: [] },
        },
      }),
    );
    const manifest = await buildManifest(selection, root);
    expect(manifest.evidence.providerEnumerationExhaustionProven).toBe(false);
    expect(manifest.evidence.enumerationRisks[0]).toMatch(/provider reported 9/);
  });

  it("STOPS when a required artifact is absent, instead of ingesting a partial set", async () => {
    const { root, selection } = syntheticRepo();
    rmSync(path.join(root, "accommodations.json"));
    await expect(buildManifest(selection, root)).rejects.toThrow(MissingArtifactError);
  });

  it("REFUSES to ingest changed artifacts under an older run identity", async () => {
    const { root, selection } = syntheticRepo();
    const manifest = await buildManifest(selection, root);
    await expect(verifyManifest(manifest, root)).resolves.toBeUndefined();

    // The provider file changes after the manifest was frozen.
    writeFileSync(
      path.join(root, "raw", "properties.json"),
      JSON.stringify([syntheticProperty({ code: 900003 })]),
    );
    await expect(verifyManifest(manifest, root)).rejects.toThrow(ArtifactDigestMismatchError);
  });

  it("keys the run on CONTENT, so a copied file is still the same run", async () => {
    const { root, selection } = syntheticRepo();
    const first = await buildManifest(selection, root);

    // Same bytes at a different path: the manifest differs (paths, mtimes) but
    // the run fingerprint must not, or a harmless copy would mint a second run.
    mkdirSync(path.join(root, "copy"), { recursive: true });
    writeFileSync(
      path.join(root, "copy", "properties.json"),
      JSON.stringify([syntheticProperty(), syntheticProperty({ code: 900002 })]),
    );
    const copied = await buildManifest(
      { ...selection, rawProperties: "copy/properties.json" },
      root,
    );

    expect(copied.manifestDigest).not.toBe(first.manifestDigest);
    expect(runFingerprint(copied)).toBe(runFingerprint(first));

    // A CHANGED artifact must produce a different logical run.
    writeFileSync(
      path.join(root, "copy", "properties.json"),
      JSON.stringify([syntheticProperty({ code: 900009 })]),
    );
    const mutated = await buildManifest(
      { ...selection, rawProperties: "copy/properties.json" },
      root,
    );
    expect(runFingerprint(mutated)).not.toBe(runFingerprint(first));
  });

  it("builds a batch whose run notes cannot be mistaken for a live extraction", async () => {
    const { root, selection } = syntheticRepo();
    const manifest = await buildManifest(selection, root);
    const batch = await buildBatch(manifest, "00000000-0000-0000-0000-0000000000ff", root);

    expect(batch.observations).toHaveLength(2);
    expect(batch.run.sourceEnvironment).toBe("evaluation");
    expect(batch.run.notes).toMatch(/OFFLINE REPLAY/);
    expect(batch.run.notes).toMatch(/ZERO provider requests/);
    expect(batch.run.notes).toMatch(/ARTIFACT CAPTURE timestamp/);
    // The observation time is the frozen artifact timestamp, not "now".
    expect(batch.run.observedAt.toISOString()).toBe(manifest.observedAt);
  });

  it("reports duplicate provider ids rather than double-inserting them", async () => {
    const { root, selection } = syntheticRepo();
    writeFileSync(
      path.join(root, "raw", "properties.json"),
      JSON.stringify([syntheticProperty(), syntheticProperty(), syntheticProperty({ code: null })]),
    );
    const manifest = await buildManifest(selection, root);
    const batch = await buildBatch(manifest, "00000000-0000-0000-0000-0000000000ff", root);

    expect(batch.observations).toHaveLength(1);
    expect(batch.duplicateSourcePropertyIds).toEqual(["900001"]);
    expect(batch.recordsMissingSourcePropertyId).toBe(1);
  });

  it("loads reference data from the ACCOMMODATIONS master, not the category master", async () => {
    const { root, selection } = syntheticRepo();
    const manifest = await buildManifest(selection, root);
    const ref = await loadReferenceData(manifest, root);
    // The category master's accommodationType is empty for every code — using it
    // as the property-type discriminator would resolve everything to unknown.
    expect(ref.classifications.get("5EST")?.accommodationType).toBeNull();
    expect(ref.accommodationTypes.get("H")).toBe("Hotel");
  });

  it("states the artifact timestamp basis in the run notes", async () => {
    const { root, selection } = syntheticRepo();
    const manifest = await buildManifest(selection, root);
    const notes = buildRunNotes(manifest);
    expect(notes).toContain(manifest.observedAt);
    expect(notes).toMatch(/NOT a provider-authoritative observation time/);
  });
});

// ---------------------------------------------------------------------------
// CLI + target guards
// ---------------------------------------------------------------------------
describe("CLI guards", () => {
  it("defaults to DRY-RUN and requires an explicit --apply", () => {
    expect(parseArgs(["--destination", "bali"]).apply).toBe(false);
    expect(parseArgs(["--destination", "bali", "--apply"]).apply).toBe(true);
  });

  it("REFUSES --environment production explicitly", () => {
    // Refused rather than silently ignored: a caller who asked for production
    // needs to be told there is no production path, not quietly given evaluation.
    expect(() => parseArgs(["--destination", "bali", "--environment", "production"])).toThrow(
      /locked to `evaluation`|no production ingestion path/,
    );
    // The only accepted value is the locked one.
    expect(() => parseArgs(["--destination", "bali", "--environment", "evaluation"])).not.toThrow();
  });

  it("requires a destination and validates the chunk size", () => {
    expect(() => parseArgs([])).toThrow(/--destination is required/);
    expect(() => parseArgs(["--destination", "bali", "--chunk-size", "0"])).toThrow(/chunk-size/);
    expect(() => parseArgs(["--destination", "bali", "--chunk-size", "99999"])).toThrow(
      /chunk-size/,
    );
    expect(parseArgs(["--destination", "bali", "--chunk-size", "250"]).chunkSize).toBe(250);
  });
});

describe("database target safety", () => {
  it("REFUSES a remote/hosted database", () => {
    expect(() =>
      resolveIngestionTarget({
        TEST_DATABASE_URL: "postgres://u:p@db.abcdefgh.supabase.co:5432/postgres?sslmode=require",
      }),
    ).toThrow(UnsafeIngestionTargetError);

    // …and via DATABASE_URL too, so pointing the command at production is an
    // explicit refusal rather than a confusing "not configured".
    expect(() =>
      resolveIngestionTarget({ DATABASE_URL: "postgres://u:p@prod.example.com:5432/app" }),
    ).toThrow(/Refusing to ingest into a remote target/);
  });

  it("has no environment escape hatch that makes a remote target acceptable", () => {
    // Behavioural, not source-text scanning: whatever a caller sets, a remote
    // target stays refused. There is no production ingestion mode to unlock.
    const remote = "postgres://u:p@db.abcdefgh.supabase.co:5432/postgres?sslmode=require";
    const escapes = [
      "ALLOW_REMOTE_INGESTION",
      "YES_REALLY_WRITE_PRODUCTION",
      "FORCE_INGESTION",
      "PROVIDER_INGESTION_ENVIRONMENT",
      "SOURCE_ENVIRONMENT",
      "NODE_ENV",
    ];
    for (const key of escapes) {
      expect(
        () => resolveIngestionTarget({ TEST_DATABASE_URL: remote, [key]: "production" }),
        `${key} unlocked a remote target`,
      ).toThrow(UnsafeIngestionTargetError);
      expect(() => resolveIngestionTarget({ TEST_DATABASE_URL: remote, [key]: "true" })).toThrow(
        UnsafeIngestionTargetError,
      );
    }
  });

  it("accepts loopback and local unix sockets", () => {
    expect(
      resolveIngestionTarget({
        TEST_DATABASE_URL: "postgres://postgres@127.0.0.1:5432/theugc_test",
      }).classification.isRemote,
    ).toBe(false);
    expect(isLocalSocketUrl("postgres://postgres@/theugc_test?host=/tmp&port=5433")).toBe(true);
    expect(
      resolveIngestionTarget({ TEST_DATABASE_URL: "postgres://postgres@/t?host=/tmp&port=5433" })
        .url,
    ).toContain("host=/tmp");
  });

  it("refuses an unclassifiable target rather than guessing", () => {
    expect(() => resolveIngestionTarget({ TEST_DATABASE_URL: "not-a-connection-string" })).toThrow(
      /unclassifiable/,
    );
    expect(() => resolveIngestionTarget({})).toThrow(/No database configured/);
  });
});

describe("manifest self-integrity", () => {
  /** Freeze a manifest, tamper with one field, and re-verify. */
  async function tampered(
    mutate: (m: IngestionManifest) => void,
  ): Promise<{ manifest: IngestionManifest; root: string }> {
    const { root, selection } = syntheticRepo();
    const manifest = await buildManifest(selection, root);
    mutate(manifest);
    return { manifest, root };
  }

  it("A. accepts an untouched frozen manifest", async () => {
    const { root, selection } = syntheticRepo();
    const manifest = await buildManifest(selection, root);
    expect(() => verifyManifestIntegrity(manifest)).not.toThrow();
    await expect(verifyManifest(manifest, root)).resolves.toBeUndefined();
  });

  it("B. REJECTS edited coverageRisks", async () => {
    // The scenario that matters: the source files are untouched and still hash
    // clean, but the risks written to source_runs have been quietly deleted.
    const { manifest, root } = await tampered((m) => {
      m.evidence.coverageRisks = [];
    });
    expect(() => verifyManifestIntegrity(manifest)).toThrow(ManifestIntegrityError);
    await expect(verifyManifest(manifest, root)).rejects.toThrow(ManifestIntegrityError);
  });

  it("C. REJECTS an edited observedAt", async () => {
    const { manifest } = await tampered((m) => {
      m.observedAt = "1999-01-01T00:00:00.000Z";
    });
    expect(() => verifyManifestIntegrity(manifest)).toThrow(ManifestIntegrityError);
  });

  it("D. REJECTS edited providerGeography", async () => {
    const { manifest } = await tampered((m) => {
      m.providerGeography = { destinationCode: "XXX" };
    });
    expect(() => verifyManifestIntegrity(manifest)).toThrow(ManifestIntegrityError);
  });

  it("E. REJECTS an edited evidence count", async () => {
    const { manifest } = await tampered((m) => {
      m.evidence.rawRecordCount = 99999;
    });
    expect(() => verifyManifestIntegrity(manifest)).toThrow(ManifestIntegrityError);
  });

  it("REJECTS edited artifact metadata, and still hashes the artifacts too", async () => {
    const { root, selection } = syntheticRepo();
    const manifest = await buildManifest(selection, root);
    manifest.artifacts[0]!.sha256 = "0".repeat(64);
    // Caught by self-integrity first — but the artifact hashing remains in place
    // for the case where the manifest is honest and the FILE changed.
    await expect(verifyManifest(manifest, root)).rejects.toThrow(ManifestIntegrityError);

    const honest = await buildManifest(selection, root);
    writeFileSync(path.join(root, "raw", "properties.json"), JSON.stringify([syntheticProperty()]));
    await expect(verifyManifest(honest, root)).rejects.toThrow(ArtifactDigestMismatchError);
  });
});

describe("raw ↔ metrics consistency gate", () => {
  /** Build a manifest, then overwrite the metrics so the two disagree. */
  async function withMetrics(
    metrics: Record<string, unknown>,
  ): Promise<{ manifest: IngestionManifest; outcome: Awaited<ReturnType<typeof buildBatch>> }> {
    const { root, selection } = syntheticRepo();
    writeFileSync(path.join(root, "metrics.json"), JSON.stringify(metrics));
    const manifest = await buildManifest(selection, root);
    const outcome = await buildBatch(manifest, "00000000-0000-0000-0000-0000000000ff", root);
    return { manifest, outcome };
  }

  const metricsWith = (over: Record<string, number>) => ({
    metrics: {
      accounting: {
        rawRecordsReturned: 2,
        uniqueSourcePropertyIds: 2,
        duplicateIdRecords: 0,
        recordsMissingSourcePropertyId: 0,
        ...over,
      },
      pagination: { reportedTotal: 2, walkCompleted: true, coverageRisks: [] },
    },
  });

  it("passes when both artifacts describe the same extraction", async () => {
    const { manifest, outcome } = await withMetrics(metricsWith({}));
    expect(() =>
      assertArtifactsConsistent(manifest, outcome, outcome.rawRecordCount),
    ).not.toThrow();
  });

  it("STOPS on a raw record count mismatch", async () => {
    // Metrics from a different run: 5 records claimed, 2 in the raw artifact.
    const { manifest, outcome } = await withMetrics(metricsWith({ rawRecordsReturned: 5 }));
    expect(() => assertArtifactsConsistent(manifest, outcome, outcome.rawRecordCount)).toThrow(
      ArtifactConsistencyError,
    );
    expect(() => assertArtifactsConsistent(manifest, outcome, outcome.rawRecordCount)).toThrow(
      /raw record count/,
    );
  });

  it("STOPS on a unique-id count mismatch", async () => {
    const { manifest, outcome } = await withMetrics(metricsWith({ uniqueSourcePropertyIds: 7 }));
    expect(() => assertArtifactsConsistent(manifest, outcome, outcome.rawRecordCount)).toThrow(
      /unique source property ids/,
    );
  });

  it("STOPS on a missing-id count mismatch", async () => {
    const { manifest, outcome } = await withMetrics(
      metricsWith({ recordsMissingSourcePropertyId: 3 }),
    );
    expect(() => assertArtifactsConsistent(manifest, outcome, outcome.rawRecordCount)).toThrow(
      /missing a source property id/,
    );
  });

  it("STOPS on a duplicate-id count mismatch", async () => {
    const { manifest, outcome } = await withMetrics(metricsWith({ duplicateIdRecords: 4 }));
    expect(() => assertArtifactsConsistent(manifest, outcome, outcome.rawRecordCount)).toThrow(
      /duplicate source property ids/,
    );
  });

  it("STOPS when observations do not account for every raw record", async () => {
    // Hand-built outcome: clean accounting, but one record vanished between the
    // artifact and the observation list.
    const { manifest, outcome } = await withMetrics(metricsWith({}));
    const short = { ...outcome, observations: outcome.observations.slice(0, 1) };
    expect(() => assertArtifactsConsistent(manifest, short, 2)).toThrow(
      /observations vs raw records/,
    );
  });
});

describe("geography consistency gate", () => {
  async function outcomeWithCodes(codes: (string | null)[]) {
    const { root, selection } = syntheticRepo();
    writeFileSync(
      path.join(root, "raw", "properties.json"),
      JSON.stringify(
        codes.map((code, i) =>
          syntheticProperty({ code: 900100 + i, destinationCode: code ?? undefined }),
        ),
      ),
    );
    const manifest = await buildManifest(selection, root);
    const outcome = await buildBatch(manifest, "00000000-0000-0000-0000-0000000000ff", root);
    return { manifest, outcome };
  }

  it("passes when every record carries the selected destination code", async () => {
    const { manifest, outcome } = await outcomeWithCodes(["SYN", "SYN"]);
    expect(() => assertGeographyConsistent(manifest, outcome)).not.toThrow();
  });

  it("STOPS on a geography contradiction rather than writing the wrong destination", async () => {
    const { manifest, outcome } = await outcomeWithCodes(["SYN", "OTHER"]);
    expect(() => assertGeographyConsistent(manifest, outcome)).toThrow(GeographyContradictionError);
    expect(() => assertGeographyConsistent(manifest, outcome)).toThrow(/OTHER × 1/);
  });

  it("treats a MISSING destination code as absence, not contradiction", async () => {
    // The provider omitting a field is not the provider making a conflicting
    // claim, and absence must not be reinterpreted as one.
    const { manifest, outcome } = await outcomeWithCodes(["SYN", null]);
    expect(() => assertGeographyConsistent(manifest, outcome)).not.toThrow();
  });
});

describe("durable evaluation coverage risks", () => {
  it("carries the coverage-universe risk alongside the geography caveats", async () => {
    const { root, selection } = syntheticRepo();
    const manifest = await buildManifest(selection, root);

    // 1 synthetic geography caveat + the 1 durable evaluation risk.
    expect(manifest.evidence.coverageRisks).toHaveLength(2);
    expect(manifest.evidence.coverageRisks[0]).toMatch(/geography/);
    expect(manifest.evidence.coverageRisks).toEqual(
      expect.arrayContaining([...HOTELBEDS_EVALUATION_COVERAGE_RISKS]),
    );
    expect(manifest.evidence.coverageRisks.join(" ")).toMatch(/coverage-universe.*PENDING/s);
  });

  it("no longer carries the SUPERSEDED secondary-verification risk", async () => {
    // D066: canonical classification is resolved product truth from a reviewed
    // provider policy. A run still claiming that stars need "secondary
    // authoritative verification" would mislabel a resolvable property as
    // blocked, so the risk is removed rather than reworded.
    const { root, selection } = syntheticRepo();
    const manifest = await buildManifest(selection, root);
    const joined = manifest.evidence.coverageRisks.join(" ");
    expect(joined).not.toMatch(/secondary authoritative verification/i);
    expect(joined).not.toMatch(/issuing authority/i);
    expect(joined).not.toMatch(/CANONICAL_D060_CLASSIFICATION_EVIDENCE/);
  });

  it("states the remaining risk is about the UNIVERSE, not star validation", async () => {
    const { root, selection } = syntheticRepo();
    const manifest = await buildManifest(selection, root);
    const joined = manifest.evidence.coverageRisks.join(" ");
    // Coverage and classification are separate dimensions, and the risk text
    // says so explicitly so a later reader cannot re-derive the old rule.
    expect(joined).toMatch(/NOT a second-source requirement/i);
    expect(joined).toMatch(/star classification/i);
  });

  it("does NOT let any of them falsify enumeration exhaustion", async () => {
    const { root, selection } = syntheticRepo();
    const manifest = await buildManifest(selection, root);
    // The walk completed and the total matched, so enumeration stands proven
    // with open coverage risks — different dimensions (0027 §7.1).
    expect(manifest.evidence.paginationWalkCompleted).toBe(true);
    expect(manifest.evidence.enumerationRisks).toEqual([]);
    expect(manifest.evidence.providerEnumerationExhaustionProven).toBe(true);
    expect(manifest.evidence.coverageRisks.length).toBeGreaterThan(0);
  });

  it("classifies it as coverage, not enumeration, and omits media rights entirely", () => {
    for (const risk of HOTELBEDS_EVALUATION_COVERAGE_RISKS) {
      expect(risk).not.toMatch(/^\[enumeration\]/);
    }
    expect(HOTELBEDS_EVALUATION_COVERAGE_RISKS.join(" ")).not.toMatch(/media|rights|image/i);
  });

  it("bumps the run evidence version, so the run fingerprint changes", async () => {
    expect(RUN_EVIDENCE_VERSION).toBe("hotelbeds-cached-evaluation/3");

    const { root, selection } = syntheticRepo();
    const manifest = await buildManifest(selection, root);
    // The fingerprint is version-sensitive by construction: changed evidence
    // semantics mean a different logical run.
    const asV1 = runFingerprint({
      ...manifest,
      runEvidenceVersion: "hotelbeds-cached-evaluation/1" as never,
    });
    expect(runFingerprint(manifest)).not.toBe(asV1);
  });
});

describe("no-network guarantee", () => {
  /** Walk the real relative-import graph from an entry file. */
  function importClosure(entry: string): string[] {
    const seen = new Set<string>();
    const queue = [path.resolve(entry)];
    while (queue.length > 0) {
      const file = queue.pop()!;
      if (seen.has(file)) continue;
      let source: string;
      try {
        source = readFileSync(file, "utf8");
      } catch {
        // A specifier that resolves to a directory index or a .d.ts we do not
        // ship; try the common suffixes before giving up.
        const candidates = [`${file}.ts`, `${file}/index.ts`];
        const found = candidates.find((c) => existsSync(c));
        if (!found || seen.has(found)) continue;
        queue.push(found);
        continue;
      }
      seen.add(file);
      for (const match of source.matchAll(/from\s+"(\.[^"]+)"/g)) {
        queue.push(path.resolve(path.dirname(file), match[1]!));
      }
    }
    return [...seen];
  }

  const ENTRIES = [
    "scripts/provider-ingestion/ingest.ts",
    "scripts/provider-ingestion/writer.ts",
    "scripts/provider-ingestion/adapters/hotelbeds-cached.ts",
  ];

  it("reaches no provider transport, client or credential module", () => {
    const forbidden =
      /provider-evaluation\/(hotelbeds\/(client|transport|signature|cache|budget|quota-ledger)|credentials|pilot-probe|run)\b/;
    for (const entry of ENTRIES) {
      for (const file of importClosure(entry)) {
        expect(file.replace(/\\/g, "/"), `${entry} reaches ${file}`).not.toMatch(forbidden);
      }
    }
  });

  it("issues no HTTP call anywhere in its import closure", () => {
    for (const entry of ENTRIES) {
      for (const file of importClosure(entry)) {
        const source = readFileSync(file, "utf8");
        // `fetch(`, `new Request(`, axios, http/https modules.
        expect(source, `${file} performs network I/O`).not.toMatch(
          /\bfetch\s*\(|new\s+Request\s*\(|require\(["']https?["']\)|from\s+["']node:https?["']/,
        );
      }
    }
  });

  it("reads no provider credential", () => {
    // Naming a credential is not reading one: the shared descriptor DECLARES
    // `requiredCredentialEnvVars` for the live harness, and that string being in
    // reach is fine. What must not appear is an actual read — of the
    // environment variable, or of the env file it lives in.
    const credentialRead =
      /process\.env\s*(\.\s*HOTELBEDS|\[\s*["'`]HOTELBEDS)|readFileSync\([^)]*\.env|dotenv/i;
    for (const entry of ENTRIES) {
      for (const file of importClosure(entry)) {
        const source = readFileSync(file, "utf8");
        expect(source, `${file} reads a provider credential`).not.toMatch(credentialRead);
      }
    }
  });

  it("keeps the evaluation harness's PURE modules in reach, so semantics are shared", () => {
    // The point is not isolation for its own sake: the adapter must still use
    // the field map and classification logic PR #21 verified, or the two would
    // drift.
    const closure = importClosure("scripts/provider-ingestion/adapters/hotelbeds-cached.ts").map(
      (f) => f.replace(/\\/g, "/"),
    );
    expect(closure.some((f) => f.endsWith("provider-evaluation/adapters/hotelbeds.ts"))).toBe(true);
    expect(closure.some((f) => f.endsWith("provider-evaluation/normalize.ts"))).toBe(true);
    expect(closure.some((f) => f.endsWith("provider-evaluation/classification.ts"))).toBe(true);
  });
});

describe("source_attributes bound", () => {
  it("rejects an oversized attributes blob before it reaches the database", () => {
    expect(() =>
      assertAttributesBounded([{ sourcePropertyId: "1", attributes: { blob: "x".repeat(9000) } }]),
    ).toThrow(IngestionWriteError);
  });

  it("accepts the empty attributes the adapter actually produces", () => {
    expect(() =>
      assertAttributesBounded([{ sourcePropertyId: "1", attributes: {} }]),
    ).not.toThrow();
  });
});
