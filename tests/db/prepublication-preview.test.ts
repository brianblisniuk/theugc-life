import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { resolveDestination } from "../../scripts/provider-resolution/resolver";
import { loadPreviewResults } from "../../scripts/prepublication-preview/preview";
import { adminQuery, hasTestDb, setupDatabase, teardownDatabase } from "./harness";
import { DEST, seed } from "../rls/seed";

const d = describe.skipIf(!hasTestDb);
let n = 0;
const key = () => `preview-${Date.now()}-${++n}`;

async function run(
  source: string,
  environment: "evaluation" | "production",
  destination = DEST.bali,
) {
  return (
    await adminQuery<{ id: string }>(
      `insert into public.source_runs (source, source_environment, destination_id, run_mode, started_at)
     values ($1,$2,$3,'evaluation',clock_timestamp()) returning id`,
      [source, environment, destination],
    )
  )[0]!.id;
}

async function identity(source: string, environment: "evaluation" | "production", runId: string) {
  return (
    await adminQuery<{ id: string }>(
      `insert into public.source_property_identities
       (source,source_environment,source_property_id,first_seen_run_id,last_seen_run_id)
     values ($1,$2,$3,$4,$4) returning id`,
      [source, environment, key(), runId],
    )
  )[0]!.id;
}

async function observation(
  identityId: string,
  source: string,
  environment: "evaluation" | "production",
  runId: string,
  observedAt: string,
  website = `https://${identityId}.example`,
) {
  return (
    await adminQuery<{ id: string }>(
      `insert into public.source_property_observations
       (source_run_id,source_property_identity_id,source,source_environment,observed_at,
        source_name,source_website_url,source_property_type_code,source_classification_code,
        source_latitude,source_longitude,source_coordinates_plausible,source_payload_digest)
     values ($1,$2,$3,$4,$5,'Preview Hotel',$7,'H','4EST',-8.5,115.2,true,$6)
     returning id`,
      [runId, identityId, source, environment, observedAt, `${key()}-digest`, website],
    )
  )[0]!.id;
}

async function foreignMachinePair(
  source: string,
  environment: "evaluation" | "production",
  status = "pending",
  method = "blocking:exact_domain",
) {
  const r = await run(source, environment);
  const a = await identity(source, environment, r);
  const b = await identity(source, environment, r);
  const shared = `https://${key()}.example`;
  await observation(a, source, environment, r, "2026-08-17T00:00:00Z", shared);
  await observation(b, source, environment, r, "2026-08-17T00:00:00Z", shared);
  const [left, right] = a < b ? [a, b] : [b, a];
  await adminQuery(
    `insert into public.source_match_candidates
       (source_property_identity_id,candidate_source_property_identity_id,source,source_environment,
        candidate_kind,match_method,status,review_note)
     values ($1,$2,$3,$4,'source_identity',$5,'pending','foreign isolation control')`,
    [left, right, source, environment, method],
  );
  if (status !== "pending") {
    await adminQuery(
      `update public.source_match_candidates set status=$1, resolved_at=now()
        where source_property_identity_id=$2 and candidate_source_property_identity_id=$3`,
      [status, left, right],
    );
  }
}

d("D062 preview real DB composition", () => {
  beforeAll(async () => {
    await setupDatabase();
    await seed();
  });
  afterAll(teardownDatabase);

  it("loads only pointer-current evidence, isolates entity sync, and writes zero publication state", async () => {
    const currentRun = await run("hotelbeds", "evaluation");
    const id = await identity("hotelbeds", "evaluation", currentRun);
    const currentObservation = await observation(
      id,
      "hotelbeds",
      "evaluation",
      currentRun,
      "2026-08-17T00:00:00Z",
    );
    const client = new Client({ connectionString: process.env.TEST_DATABASE_URL });
    await client.connect();
    try {
      await resolveDestination(client, {
        source: "hotelbeds",
        environment: "evaluation",
        destinationId: null,
        apply: true,
      });
      // A later timestamp exists, but ingestion has not advanced last_seen_run_id.
      // Every preview dimension must continue to cite the pointed observation.
      const laterRun = await run("hotelbeds", "evaluation");
      await observation(id, "hotelbeds", "evaluation", laterRun, "2026-08-18T00:00:00Z");
      const digest = (
        await adminQuery<{ d: string }>(
          `select source_payload_digest d from public.source_property_observations where id=$1`,
          [currentObservation],
        )
      )[0]!.d;
      await adminQuery(
        `insert into public.source_property_issue_snapshots
           (source_property_identity_id,source,source_environment,evidence_observation_id,
            provider_issue_count,source_payload_digest,evidence_source_run_id,extraction_method)
         values ($1,'hotelbeds','evaluation',$2,0,$3,$4,'test/1')`,
        [id, currentObservation, digest, currentRun],
      );

      await foreignMachinePair("hotelbeds", "evaluation");
      await foreignMachinePair("booking", "evaluation");
      await foreignMachinePair("hotelbeds", "production");
      await foreignMachinePair("booking", "evaluation", "accepted", "manual_search");
      await foreignMachinePair("booking", "evaluation", "superseded", "manual_search");

      const before = (
        await adminQuery<{ hotels: string; links: string; contacts: string; reviews: string }>(
          `select (select count(*) from public.hotels)::text hotels,
                (select count(*) from public.hotel_source_identities)::text links,
                (select count(*) from public.hotel_contacts)::text contacts,
                (select count(*) from public.source_property_reviews)::text reviews`,
        )
      )[0]!;
      const [preview] = await loadPreviewResults(client, {
        source: "hotelbeds",
        environment: "evaluation",
        asOf: "2026-08-17",
        identityId: id,
        sourcePropertyId: null,
        limit: 1,
      });
      const after = (
        await adminQuery<typeof before>(
          `select (select count(*) from public.hotels)::text hotels,
                (select count(*) from public.hotel_source_identities)::text links,
                (select count(*) from public.hotel_contacts)::text contacts,
                (select count(*) from public.source_property_reviews)::text reviews`,
        )
      )[0]!;

      expect(preview!.conditions[0]!.reason).toBe("identity_review_missing_or_deferred");
      expect(preview!.conditions[10]!.reason).toBe("no_current_entity_conflict");
      expect(preview!.conditions[2]!.evidence.observationId).toBe(currentObservation);
      expect(preview!.conditions[5]!.evidence.observationId).toBe(currentObservation);
      expect(preview!.conditions[9]!.evidence.observationId).toBe(currentObservation);
      expect(preview!.conditions[3]!.status).toBe("PASS");
      expect(before).toEqual(after);
    } finally {
      await client.end();
    }
  });

  it("keeps an identity with an unresolvable pointer and holds instead of inferring no conflict", async () => {
    const oldRun = await run("hotelbeds", "evaluation");
    const id = await identity("hotelbeds", "evaluation", oldRun);
    await observation(id, "hotelbeds", "evaluation", oldRun, "2026-08-17T00:00:00Z");
    const emptyRun = await run("hotelbeds", "evaluation");
    await adminQuery(
      `update public.source_property_identities set last_seen_run_id=$1 where id=$2`,
      [emptyRun, id],
    );
    const client = new Client({ connectionString: process.env.TEST_DATABASE_URL });
    await client.connect();
    try {
      const [preview] = await loadPreviewResults(client, {
        source: "hotelbeds",
        environment: "evaluation",
        asOf: "2026-08-17",
        identityId: id,
        sourcePropertyId: null,
        limit: 1,
      });
      expect(preview!.conditions[0]!.status).toBe("UNRESOLVED");
      expect(preview!.conditions[10]!.status).toBe("UNRESOLVED");
      expect(preview!.conditions[10]!.reason).toBe("current_entity_conflict");
    } finally {
      await client.end();
    }
  });
});
