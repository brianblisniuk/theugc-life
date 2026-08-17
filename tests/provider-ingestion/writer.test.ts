/**
 * Database-backed tests for the generic provider ingestion writer.
 *
 * These run against migration 0027 as merged, and their job is to prove the
 * writer cannot violate it: no canonical write, no production row, no duplicate
 * on replay, no half-written destination, no mutated observation.
 *
 * All fixtures are SYNTHETIC. No Hotelbeds property data appears here.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { adminQuery, hasTestDb, setupDatabase, teardownDatabase } from "../db/harness";
import { seed, DEST } from "../rls/seed";
import { connectClient, endClient, getRawClient } from "./client-shim";
import { resolveDestinationId } from "../../scripts/provider-ingestion/ingest";
import {
  applyIngestion,
  previewIngestion,
  IngestionWriteError,
} from "../../scripts/provider-ingestion/writer";
import type {
  ProviderIngestionBatch,
  SourcePropertyObservationInput,
} from "../../scripts/provider-ingestion/types";
import { deterministicUuid } from "../../scripts/provider-ingestion/digest";

const d = describe.skipIf(!hasTestDb);

const SOURCE = "synthetic_provider";

let counter = 0;
const uniqueRun = () => deterministicUuid(`synthetic-run-${Date.now()}-${(counter += 1)}`);

function observation(
  id: string,
  over: Partial<SourcePropertyObservationInput> = {},
): SourcePropertyObservationInput {
  return {
    sourcePropertyId: id,
    name: `Synthetic Property ${id}`,
    destinationCode: "SYN",
    latitude: -8.5,
    longitude: 115.2,
    coordinatesPlausible: true,
    classificationCode: "5EST",
    classificationLabel: "5 STARS",
    classificationSimpleCode: "5",
    classificationGroup: "GRUPO5",
    propertyTypeCode: "H",
    propertyTypeLabel: "Hotel",
    imageCount: 3,
    providerDesignatedPrincipalImage: true,
    attributes: {},
    payloadDigest: `digest-${id}`,
    ...over,
  };
}

function batch(
  runId: string,
  observations: SourcePropertyObservationInput[],
  over: { observedAt?: Date } = {},
): ProviderIngestionBatch {
  return {
    run: {
      id: runId,
      source: SOURCE,
      sourceEnvironment: "evaluation",
      destinationId: DEST.bali,
      providerGeography: { destinationCode: "SYN" },
      runMode: "evaluation",
      evidence: {
        rawRecordsSeen: observations.length,
        uniqueSourcePropertyIds: observations.length,
        providerReportedTotal: observations.length,
        paginationWalkCompleted: true,
        enumerationRisks: [],
        coverageRisks: ["[geography] synthetic caveat"],
        originalRequestCount: 1,
      },
      observedAt: over.observedAt ?? new Date("2026-08-01T00:00:00.000Z"),
      notes: "OFFLINE REPLAY of a synthetic cached extraction.",
      harnessVersion: "test",
    },
    observations,
  };
}

/** Counts of every table this block must not touch. */
async function canonicalSnapshot(): Promise<Record<string, number>> {
  const res = await adminQuery<Record<string, string>>(
    `select (select count(*) from public.hotels)::text as hotels,
            (select count(*) from public.hotel_source_identities)::text as links,
            (select count(*) from public.source_match_candidates)::text as candidates,
            (select count(*) from public.source_property_reviews)::text as reviews,
            (select count(*) from public.hotel_contacts)::text as contacts,
            (select count(*) from public.editorial_evidence)::text as evidence`,
  );
  return Object.fromEntries(Object.entries(res[0]!).map(([k, v]) => [k, Number(v)]));
}

async function sourceCounts(): Promise<Record<string, number>> {
  const res = await adminQuery<Record<string, string>>(
    `select (select count(*) from public.source_runs)::text as runs,
            (select count(*) from public.source_property_identities)::text as identities,
            (select count(*) from public.source_property_observations)::text as observations,
            (select coalesce(sum(observation_count),0) from public.source_property_identities)::text as obs_count,
            (select count(*) from public.source_property_identities
               where source_environment = 'production')::text as production,
            (select count(*) from public.source_property_identities
               where resolution_state <> 'unresolved')::text as resolved`,
  );
  return Object.fromEntries(Object.entries(res[0]!).map(([k, v]) => [k, Number(v)]));
}

d("provider ingestion writer (against migration 0027)", () => {
  beforeAll(async () => {
    await setupDatabase();
    await seed();
    await connectClient();
  });
  afterAll(async () => {
    await endClient();
    await teardownDatabase();
  });

  // Observations are append-only by design, so they cannot be deleted between
  // tests. Each test uses its own run id and its own provider ids instead, and
  // every assertion is a delta rather than an absolute.
  const client = () => getRawClient();

  // -----------------------------------------------------------------------
  describe("dry-run", () => {
    it("makes ZERO writes", async () => {
      const before = await sourceCounts();
      const runId = uniqueRun();
      const planned = await previewIngestion(
        client(),
        batch(runId, [observation("p1"), observation("p2")]),
      );

      expect(planned.runsCreated).toBe(1);
      expect(planned.identitiesCreated).toBe(2);
      expect(planned.observationsCreated).toBe(2);

      const after = await sourceCounts();
      expect(after).toEqual(before);
    });
  });

  // -----------------------------------------------------------------------
  describe("apply", () => {
    it("writes a run, its identities and its observations in one transaction", async () => {
      const runId = uniqueRun();
      const counts = await applyIngestion(
        client(),
        batch(runId, [observation("a1"), observation("a2"), observation("a3")]),
      );

      expect(counts.runsCreated).toBe(1);
      expect(counts.identitiesCreated).toBe(3);
      expect(counts.observationsCreated).toBe(3);
      expect(counts.observationCountIncrements).toBe(3);

      const rows = await adminQuery<{ n: string }>(
        `select count(*)::text as n from public.source_property_observations where source_run_id = $1`,
        [runId],
      );
      expect(rows[0]!.n).toBe("3");
    });

    it("locks the environment to `evaluation` regardless of the caller", async () => {
      const runId = uniqueRun();
      const input = batch(runId, [observation("env1")]);
      // Even if a caller mutates the input, the writer substitutes the constant.
      (input.run as { sourceEnvironment: string }).sourceEnvironment = "production";
      await applyIngestion(client(), input);

      const rows = await adminQuery<{ env: string }>(
        `select source_environment as env from public.source_runs where id = $1`,
        [runId],
      );
      expect(rows[0]!.env).toBe("evaluation");
      const counts = await sourceCounts();
      expect(counts.production).toBe(0);
    });

    it("records request_count = 0, because this replay called nothing", async () => {
      const runId = uniqueRun();
      await applyIngestion(client(), batch(runId, [observation("r1")]));
      const rows = await adminQuery<{ req: number; cache: number; notes: string }>(
        `select request_count as req, cache_hit_count as cache, notes from public.source_runs where id = $1`,
        [runId],
      );
      // Semantically honest: the ORIGINAL extraction's request count belongs in
      // the notes, not in this row's own activity counters.
      expect(rows[0]!.req).toBe(0);
      expect(rows[0]!.cache).toBe(0);
      expect(rows[0]!.notes).toMatch(/OFFLINE REPLAY/);
    });

    it("carries enumeration exhaustion while KEEPING open coverage risks", async () => {
      const runId = uniqueRun();
      await applyIngestion(client(), batch(runId, [observation("x1")]));
      const rows = await adminQuery<{
        proven: boolean;
        enumeration: string[];
        coverage: string[];
      }>(
        `select provider_enumeration_exhaustion_proven as proven,
                enumeration_risks as enumeration, coverage_risks as coverage
           from public.source_runs where id = $1`,
        [runId],
      );
      expect(rows[0]!.proven).toBe(true);
      expect(rows[0]!.enumeration).toEqual([]);
      // Never emptied to make the run look clean.
      expect(rows[0]!.coverage).toHaveLength(1);
    });
  });

  // -----------------------------------------------------------------------
  describe("idempotency", () => {
    it("replaying the SAME run creates nothing and inflates nothing", async () => {
      const runId = uniqueRun();
      const input = batch(runId, [observation("i1"), observation("i2")]);
      await applyIngestion(client(), input);
      const after1 = await sourceCounts();

      const replay = await applyIngestion(client(), input);
      const after2 = await sourceCounts();

      expect(replay.runsCreated).toBe(0);
      expect(replay.runsExisting).toBe(1);
      expect(replay.identitiesCreated).toBe(0);
      expect(replay.observationsCreated).toBe(0);
      expect(replay.observationCountIncrements).toBe(0);
      expect(after2).toEqual(after1);
    });

    it("keeps ONE durable identity per (source, environment, provider id)", async () => {
      const providerId = "dur1";
      await applyIngestion(client(), batch(uniqueRun(), [observation(providerId)]));
      await applyIngestion(
        client(),
        batch(uniqueRun(), [observation(providerId)], {
          observedAt: new Date("2026-09-01T00:00:00.000Z"),
        }),
      );

      const rows = await adminQuery<{ n: string }>(
        `select count(*)::text as n from public.source_property_identities
          where source = $1 and source_environment = 'evaluation' and source_property_id = $2`,
        [SOURCE, providerId],
      );
      expect(rows[0]!.n).toBe("1");
    });
  });

  // -----------------------------------------------------------------------
  describe("a genuinely new run appends", () => {
    it("keeps one identity, two runs, two immutable observations", async () => {
      const providerId = "hist1";
      const run1 = uniqueRun();
      const run2 = uniqueRun();

      await applyIngestion(
        client(),
        batch(
          run1,
          [observation(providerId, { classificationCode: "4EST", classificationLabel: "4 STARS" })],
          {
            observedAt: new Date("2026-08-01T00:00:00.000Z"),
          },
        ),
      );
      const second = await applyIngestion(
        client(),
        batch(
          run2,
          [observation(providerId, { classificationCode: "5EST", classificationLabel: "5 STARS" })],
          {
            observedAt: new Date("2026-09-01T00:00:00.000Z"),
          },
        ),
      );

      expect(second.identitiesCreated).toBe(0);
      expect(second.observationsCreated).toBe(1);
      expect(second.observationCountIncrements).toBe(1);
      expect(second.lastSeenAdvanced).toBe(1);

      const identity = await adminQuery<{
        id: string;
        first_seen_run_id: string;
        last_seen_run_id: string;
        observation_count: number;
        resolution_state: string;
      }>(
        `select id, first_seen_run_id, last_seen_run_id, observation_count, resolution_state
           from public.source_property_identities
          where source = $1 and source_property_id = $2`,
        [SOURCE, providerId],
      );
      expect(identity).toHaveLength(1);
      // first_seen is never rewritten; last_seen advances.
      expect(identity[0]!.first_seen_run_id).toBe(run1);
      expect(identity[0]!.last_seen_run_id).toBe(run2);
      expect(identity[0]!.observation_count).toBe(2);
      // Ingestion resolves nothing.
      expect(identity[0]!.resolution_state).toBe("unresolved");

      const observations = await adminQuery<{ code: string }>(
        `select source_classification_code as code from public.source_property_observations
          where source_property_identity_id = $1 order by observed_at`,
        [identity[0]!.id],
      );
      // The 4EST -> 5EST change is HISTORY, not an overwrite.
      expect(observations.map((o) => o.code)).toEqual(["4EST", "5EST"]);
    });

    it("does not drag last_seen backwards for an OLDER run", async () => {
      const providerId = "older1";
      const newer = uniqueRun();
      const older = uniqueRun();

      await applyIngestion(
        client(),
        batch(newer, [observation(providerId)], {
          observedAt: new Date("2026-09-01T00:00:00.000Z"),
        }),
      );
      const back = await applyIngestion(
        client(),
        batch(older, [observation(providerId)], {
          observedAt: new Date("2026-07-01T00:00:00.000Z"),
        }),
      );

      // The older run's observation is still recorded…
      expect(back.observationsCreated).toBe(1);
      expect(back.observationCountIncrements).toBe(1);
      // …but it does not become the identity's last sighting.
      expect(back.lastSeenAdvanced).toBe(0);
      const rows = await adminQuery<{ last: string }>(
        `select last_seen_run_id as last from public.source_property_identities
          where source = $1 and source_property_id = $2`,
        [SOURCE, providerId],
      );
      expect(rows[0]!.last).toBe(newer);
    });

    it("still cannot UPDATE an observation after the fact", async () => {
      const runId = uniqueRun();
      await applyIngestion(client(), batch(runId, [observation("imm1")]));
      await expect(
        adminQuery(
          `update public.source_property_observations set source_name = 'Rewritten' where source_run_id = $1`,
          [runId],
        ),
      ).rejects.toThrow(/APPEND-ONLY/i);
      await expect(
        adminQuery(`delete from public.source_property_observations where source_run_id = $1`, [
          runId,
        ]),
      ).rejects.toThrow(/APPEND-ONLY/i);
    });
  });

  // -----------------------------------------------------------------------
  describe("source facts are preserved, not cleaned", () => {
    it("stores an implausible coordinate rather than dropping the row", async () => {
      const runId = uniqueRun();
      await applyIngestion(
        client(),
        batch(runId, [
          observation("bad1", {
            latitude: -8.690705,
            longitude: -244.73644,
            coordinatesPlausible: false,
          }),
        ]),
      );
      const rows = await adminQuery<{ lat: string; lon: string; plausible: boolean }>(
        `select source_latitude::text as lat, source_longitude::text as lon,
                source_coordinates_plausible as plausible
           from public.source_property_observations where source_run_id = $1`,
        [runId],
      );
      expect(rows[0]!.lat).toBe("-8.690705");
      expect(rows[0]!.lon).toBe("-244.73644");
      expect(rows[0]!.plausible).toBe(false);
    });

    it("leaves missing coordinates NULL rather than 0/0", async () => {
      const runId = uniqueRun();
      await applyIngestion(
        client(),
        batch(runId, [
          observation("none1", { latitude: null, longitude: null, coordinatesPlausible: null }),
        ]),
      );
      const rows = await adminQuery<{ lat: string | null; lon: string | null; p: boolean | null }>(
        `select source_latitude::text as lat, source_longitude::text as lon,
                source_coordinates_plausible as p
           from public.source_property_observations where source_run_id = $1`,
        [runId],
      );
      expect(rows[0]!.lat).toBeNull();
      expect(rows[0]!.lon).toBeNull();
      expect(rows[0]!.p).toBeNull();
    });

    it("keeps classification as PROVIDER evidence and simpleCode as text", async () => {
      const runId = uniqueRun();
      await applyIngestion(client(), batch(runId, [observation("cls1")]));
      const rows = await adminQuery<{ kind: string; simple: string; label: string }>(
        `select source_classification_evidence_kind as kind,
                source_classification_simple_code as simple,
                source_classification_label as label
           from public.source_property_observations where source_run_id = $1`,
        [runId],
      );
      // The writer never writes this column, so 0027's single permitted value
      // stands — a provider cannot promote itself to canonical star authority.
      expect(rows[0]!.kind).toBe("provider_classification_evidence");
      expect(rows[0]!.simple).toBe("5");
      expect(typeof rows[0]!.simple).toBe("string");
    });

    it("stores property type as source evidence, gating nothing", async () => {
      const runId = uniqueRun();
      await applyIngestion(
        client(),
        batch(runId, [
          observation("pt1", { propertyTypeCode: "A", propertyTypeLabel: "Apartment" }),
        ]),
      );
      const rows = await adminQuery<{ code: string; label: string; state: string }>(
        `select o.source_property_type_code as code, o.source_property_type_label as label,
                i.resolution_state as state
           from public.source_property_observations o
           join public.source_property_identities i on i.id = o.source_property_identity_id
          where o.source_run_id = $1`,
        [runId],
      );
      expect(rows[0]!.code).toBe("A");
      expect(rows[0]!.label).toBe("Apartment");
      // A non-hotel type is stored and excludes nothing at this layer.
      expect(rows[0]!.state).toBe("unresolved");
    });

    it("stores media as a summary only", async () => {
      const runId = uniqueRun();
      await applyIngestion(
        client(),
        batch(runId, [
          observation("m1", { imageCount: 118, providerDesignatedPrincipalImage: false }),
        ]),
      );
      const rows = await adminQuery<{ n: number; principal: boolean }>(
        `select source_image_count as n, source_provider_designated_principal_image as principal
           from public.source_property_observations where source_run_id = $1`,
        [runId],
      );
      expect(rows[0]!.n).toBe(118);
      expect(rows[0]!.principal).toBe(false);
    });

    it("stores a payload digest and no payload URI", async () => {
      const runId = uniqueRun();
      await applyIngestion(client(), batch(runId, [observation("dg1")]));
      const rows = await adminQuery<{ digest: string; uri: string | null; attrs: string }>(
        `select source_payload_digest as digest, source_payload_uri as uri,
                source_attributes::text as attrs
           from public.source_property_observations where source_run_id = $1`,
        [runId],
      );
      expect(rows[0]!.digest).toBe("digest-dg1");
      // A local filesystem path is not a durable URI, so nothing is written.
      expect(rows[0]!.uri).toBeNull();
      expect(rows[0]!.attrs).toBe("{}");
    });

    it("refuses an oversized attributes blob before the transaction opens", async () => {
      const runId = uniqueRun();
      const before = await sourceCounts();
      await expect(
        applyIngestion(
          client(),
          batch(runId, [observation("big1", { attributes: { blob: "x".repeat(9000) } })]),
        ),
      ).rejects.toThrow(IngestionWriteError);
      expect(await sourceCounts()).toEqual(before);
    });
  });

  // -----------------------------------------------------------------------
  describe("failure safety", () => {
    it("rolls the WHOLE destination back when one row fails", async () => {
      const runId = uniqueRun();
      const before = await sourceCounts();

      // A negative image count violates 0027's CHECK. With a chunk size of 2 the
      // failure lands after earlier rows have already been written inside the
      // transaction — exactly the half-written state that must not survive.
      const observations = [
        observation("rb1"),
        observation("rb2"),
        observation("rb3", { imageCount: -5 }),
        observation("rb4"),
      ];

      await expect(
        applyIngestion(client(), batch(runId, observations), { chunkSize: 2 }),
      ).rejects.toThrow(IngestionWriteError);

      // No run, no identities, no observations: nothing half-written survives.
      expect(await sourceCounts()).toEqual(before);
      const run = await adminQuery<{ n: string }>(
        `select count(*)::text as n from public.source_runs where id = $1`,
        [runId],
      );
      expect(run[0]!.n).toBe("0");
    });

    it("STOPS when the canonical destination does not exist", async () => {
      await expect(resolveDestinationId(client(), "no-such-destination")).rejects.toThrow(
        /does not exist in public.destinations/,
      );
      // …and says explicitly that this block will not create one.
      await expect(resolveDestinationId(client(), "no-such-destination")).rejects.toThrow(
        /does not create destinations/,
      );
      // A seeded destination resolves normally.
      await expect(resolveDestinationId(client(), "bali")).resolves.toBe(DEST.bali);
    });
  });

  // -----------------------------------------------------------------------
  describe("canonical safety", () => {
    it("touches NO canonical or resolution table", async () => {
      const before = await canonicalSnapshot();
      await applyIngestion(
        client(),
        batch(uniqueRun(), [observation("c1"), observation("c2"), observation("c3")]),
      );
      expect(await canonicalSnapshot()).toEqual(before);
    });

    it("leaves every identity unresolved and in the evaluation environment", async () => {
      await applyIngestion(client(), batch(uniqueRun(), [observation("u1")]));
      const counts = await sourceCounts();
      expect(counts.production).toBe(0);
      expect(counts.resolved).toBe(0);
    });

    it("cannot have its evaluation identities linked to a canonical hotel", async () => {
      const runId = uniqueRun();
      await applyIngestion(client(), batch(runId, [observation("link1")]));
      const identity = await adminQuery<{ id: string; pid: string }>(
        `select id, source_property_id as pid from public.source_property_identities
          where source = $1 and source_property_id = 'link1'`,
        [SOURCE],
      );
      // 0027's production-only rule, reached through real ingested data.
      await expect(
        adminQuery(
          `insert into public.hotel_source_identities
             (hotel_id, source_property_identity_id, source, source_environment,
              source_property_id, match_method)
           values ((select id from public.hotels limit 1), $1, $2, 'evaluation', $3, 'test')`,
          [identity[0]!.id, SOURCE, identity[0]!.pid],
        ),
      ).rejects.toThrow(/production_only/i);
    });
  });
});
