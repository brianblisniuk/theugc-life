import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { resolveDestination } from "../../scripts/provider-resolution/resolver";
import {
  inPreviewSnapshot,
  loadPreviewResults,
} from "../../scripts/prepublication-preview/preview";
import { adminQuery, hasTestDb, setupDatabase, teardownDatabase } from "./harness";
import { DEST, HOTEL, seed } from "../rls/seed";

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
  name = `Preview Property ${identityId}`,
) {
  return (
    await adminQuery<{ id: string }>(
      `insert into public.source_property_observations
       (source_run_id,source_property_identity_id,source,source_environment,observed_at,
        source_name,source_website_url,source_property_type_code,source_classification_code,
        source_latitude,source_longitude,source_coordinates_plausible,source_payload_digest)
     values ($1,$2,$3,$4,$5,$8,$7,'H','4EST',-8.5,115.2,true,$6)
     returning id`,
      [runId, identityId, source, environment, observedAt, `${key()}-digest`, website, name],
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
  const pairName = `Foreign Pair ${key()}`;
  await observation(a, source, environment, r, "2026-08-17T00:00:00Z", shared, pairName);
  await observation(b, source, environment, r, "2026-08-17T00:00:00Z", shared, pairName);
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

  it("enforces READ ONLY and rolls back the transaction after a rejected write", async () => {
    const client = new Client({ connectionString: process.env.TEST_DATABASE_URL });
    await client.connect();
    try {
      await expect(
        inPreviewSnapshot(client, () =>
          client.query(
            `insert into public.destinations (name,slug,type) values ('No','no-preview-write','city')`,
          ),
        ),
      ).rejects.toThrow(/read-only transaction/i);
      expect(
        (
          await client.query(
            `select count(*)::int n from public.destinations where slug='no-preview-write'`,
          )
        ).rows[0]!.n,
      ).toBe(0);
    } finally {
      await client.end();
    }
  });

  it("holds one REPEATABLE READ snapshot while a second connection mutates current state", async () => {
    const r = await run("hotelbeds", "evaluation");
    const a = await identity("hotelbeds", "evaluation", r),
      b = await identity("hotelbeds", "evaluation", r);
    const [left, right] = a < b ? [a, b] : [b, a];
    const inserted = (
      await adminQuery<{ id: string }>(
        `insert into public.source_match_candidates
         (source,source_environment,source_property_identity_id,candidate_source_property_identity_id,candidate_kind,match_method,status)
       values ('hotelbeds','evaluation',$1,$2,'source_identity','manual_snapshot','pending') returning id`,
        [left, right],
      )
    )[0]!.id;
    const reader = new Client({ connectionString: process.env.TEST_DATABASE_URL });
    const writer = new Client({ connectionString: process.env.TEST_DATABASE_URL });
    await reader.connect();
    await writer.connect();
    try {
      await inPreviewSnapshot(reader, async () => {
        expect(
          (
            await reader.query(`select status from public.source_match_candidates where id=$1`, [
              inserted,
            ])
          ).rows[0]!.status,
        ).toBe("pending");
        await writer.query(
          `update public.source_match_candidates set status='rejected',resolved_at=now() where id=$1`,
          [inserted],
        );
        expect(
          (
            await reader.query(`select status from public.source_match_candidates where id=$1`, [
              inserted,
            ])
          ).rows[0]!.status,
        ).toBe("pending");
      });
      await inPreviewSnapshot(reader, async () => {
        expect(
          (
            await reader.query(`select status from public.source_match_candidates where id=$1`, [
              inserted,
            ])
          ).rows[0]!.status,
        ).toBe("rejected");
      });
    } finally {
      await reader.end();
      await writer.end();
    }
  });

  it("supports one exact canonical target and holds mismatches or contradictory accepted evidence", async () => {
    const r = await run("hotelbeds", "evaluation");
    const id = await identity("hotelbeds", "evaluation", r);
    await observation(id, "hotelbeds", "evaluation", r, "2026-08-17T00:00:00Z");
    await adminQuery(
      `insert into public.source_property_reviews
         (source_property_identity_id,source,source_environment,decision,target_hotel_id,
          reviewer_label,review_note,decided_in_run_id,reviewed_at)
       values ($1,'hotelbeds','evaluation','approve_match',$2,'Auditor','exact target',$3,'2026-08-17T00:00:00Z')`,
      [id, HOTEL.bali, r],
    );
    const addCanonical = (hotel: string) =>
      adminQuery(
        `insert into public.source_match_candidates
         (source_property_identity_id,source,source_environment,candidate_kind,candidate_hotel_id,
          match_method,status,review_note,resolved_at)
       values ($1,'hotelbeds','evaluation','canonical_hotel',$2,'manual_search','accepted','reviewed target',now())`,
        [id, hotel],
      );
    const client = new Client({ connectionString: process.env.TEST_DATABASE_URL });
    await client.connect();
    try {
      await addCanonical(HOTEL.bali);
      let [preview] = await loadPreviewResults(client, {
        source: "hotelbeds",
        environment: "evaluation",
        asOf: "2026-08-17",
        identityId: id,
        sourcePropertyId: null,
        limit: 1,
      });
      expect(preview!.conditions[0]!.reason).toBe("reviewed_explicit_canonical_match");
      expect(preview!.conditions[1]!.reason).toBe("canonical_match_target_destination_supported");
      const oneFingerprint = preview!.fingerprint;
      await client.query(`set time zone 'Pacific/Honolulu'`);
      const [zoned] = await loadPreviewResults(client, {
        source: "hotelbeds",
        environment: "evaluation",
        asOf: "2026-08-17",
        identityId: id,
        sourcePropertyId: null,
        limit: 1,
      });
      expect(zoned!.fingerprint).toBe(oneFingerprint);
      expect(zoned!.conditions[0]!.evidence.reviewedAt).toBe("2026-08-17T00:00:00.000000Z");
      await adminQuery(
        `update public.source_property_reviews set reviewed_at='2026-08-17T00:00:01Z' where source_property_identity_id=$1`,
        [id],
      );
      const [instantChanged] = await loadPreviewResults(client, {
        source: "hotelbeds",
        environment: "evaluation",
        asOf: "2026-08-17",
        identityId: id,
        sourcePropertyId: null,
        limit: 1,
      });
      expect(instantChanged!.fingerprint).not.toBe(oneFingerprint);
      await adminQuery(
        `update public.source_property_reviews set destination_id=$1 where source_property_identity_id=$2`,
        [DEST.ubud, id],
      );
      [preview] = await loadPreviewResults(client, {
        source: "hotelbeds",
        environment: "evaluation",
        asOf: "2026-08-17",
        identityId: id,
        sourcePropertyId: null,
        limit: 1,
      });
      expect(preview!.conditions[1]!.reason).toBe("reviewed_destination_target_mismatch");
      expect(preview!.fingerprint).not.toBe(oneFingerprint);
      await adminQuery(
        `update public.source_property_reviews set destination_id=null where source_property_identity_id=$1`,
        [id],
      );
      await addCanonical(HOTEL.ubud);
      [preview] = await loadPreviewResults(client, {
        source: "hotelbeds",
        environment: "evaluation",
        asOf: "2026-08-17",
        identityId: id,
        sourcePropertyId: null,
        limit: 1,
      });
      expect(preview!.conditions[0]!.reason).toBe("accepted_entity_evidence_inconsistent");
      expect(preview!.conditions[10]!.reason).toBe("accepted_entity_evidence_inconsistent");
      expect(preview!.fingerprint).not.toBe(oneFingerprint);
      await adminQuery(
        `insert into public.source_match_candidates
           (source_property_identity_id,source,source_environment,candidate_kind,match_method,status,review_note,resolved_at)
         values ($1,'hotelbeds','evaluation','new_property','manual_search','accepted','distinct finding',now())`,
        [id],
      );
      [preview] = await loadPreviewResults(client, {
        source: "hotelbeds",
        environment: "evaluation",
        asOf: "2026-08-17",
        identityId: id,
        sourcePropertyId: null,
        limit: 1,
      });
      expect(preview!.conditions[0]!.reason).toBe("accepted_entity_evidence_inconsistent");
    } finally {
      await client.end();
    }
  });

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

  it("keeps a genuine selected-target entity conflict unresolved", async () => {
    const r = await run("hotelbeds", "evaluation");
    const target = await identity("hotelbeds", "evaluation", r);
    const other = await identity("hotelbeds", "evaluation", r);
    const sharedDomain = `https://${key()}.example`;
    const sharedName = `Real Conflict ${key()}`;
    await observation(
      target,
      "hotelbeds",
      "evaluation",
      r,
      "2026-08-17T00:00:00Z",
      sharedDomain,
      sharedName,
    );
    await observation(
      other,
      "hotelbeds",
      "evaluation",
      r,
      "2026-08-17T00:00:00Z",
      sharedDomain,
      sharedName,
    );
    const [left, right] = target < other ? [target, other] : [other, target];
    await adminQuery(
      `insert into public.source_match_candidates
         (source_property_identity_id,candidate_source_property_identity_id,source,
          source_environment,candidate_kind,match_method,status)
       values ($1,$2,'hotelbeds','evaluation','source_identity',
               'blocking:exact_domain+name_exact','pending')`,
      [left, right],
    );

    const client = new Client({ connectionString: process.env.TEST_DATABASE_URL });
    await client.connect();
    try {
      const [preview] = await loadPreviewResults(client, {
        source: "hotelbeds",
        environment: "evaluation",
        asOf: "2026-08-17",
        identityId: target,
        sourcePropertyId: null,
        limit: 1,
      });
      expect(preview!.conditions[10]!.status).toBe("UNRESOLVED");
      expect(preview!.conditions[10]!.reason).toBe("current_entity_conflict");
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
