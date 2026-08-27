/**
 * A05 §18 — THE REAL A04.7 PILOT MUST REMAIN UNPUBLISHABLE.
 *
 * On 2026-08-27 the project owner authorized eight real `approve_create`
 * decisions and two defers on Hotelbeds identities. All eight reached a genuine
 * 11/11 D062 PASS, and the corpus moved 1677 FAIL / 2433 UNRESOLVED / 0 PASS to
 * 1677 FAIL / 2425 UNRESOLVED / 8 PASS.
 *
 * Every one of those identities is `source_environment = 'evaluation'`.
 *
 * They are therefore the exact population A05's hard wall exists for, and this
 * suite is the regression that keeps them unpublished. It reconstructs the pilot
 * shape in a disposable database — the same eight provider ids, carried through
 * the REAL A04.5 review path to a REAL 11/11 PASS — and then proves that A05
 * prepare offers none of them and A05 apply refuses all eight with
 * `evaluation_identity_not_publishable` and zero canonical writes.
 *
 * The provider ids are reused deliberately, so a future change that starts
 * publishing evaluation data fails HERE, naming the real properties it would
 * have published.
 *
 * NOTE what this suite does NOT do: it does not UPDATE those identities to
 * `production` to make anything pass. Relabelling evaluation evidence is the
 * precise failure the isolation axis exists to prevent, and doing it in a test
 * would quietly retire the guarantee.
 */
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { adminQuery, hasTestDb, setupDatabase, teardownDatabase } from "./harness";
import { seed } from "../rls/seed";
import { loadPreviewResults } from "../../scripts/prepublication-preview/preview";
import { applyReviewedManifest, type ReviewedItem } from "../../scripts/human-review/apply";
import { REVIEW_DIMENSIONS } from "../../scripts/human-review/pack";
import {
  applyPublicationManifest,
  type PublicationItem,
} from "../../scripts/source-publication/publish";
import { buildPublicationPack } from "../../scripts/source-publication/pack";

const d = describe.skipIf(!hasTestDb);
const SOURCE = "hotelbeds";
const AS_OF = "2026-08-17";
const POLICY = {
  provider: "hotelbeds",
  star: "hotelbeds-classification/1",
  scope: "hotelbeds-hospitality-scope/1",
  location: "hotelbeds-location/1",
};

/** The eight real provider ids that reached 11/11 PASS in the A04.7 pilot. */
const PILOT_BALI = ["1000964", "1005697", "1007779", "1008877"] as const;
const PILOT_DUBAI = ["1000476", "1000543", "1004956", "101140"] as const;
const PILOT_IDS = [...PILOT_BALI, ...PILOT_DUBAI];

interface PilotFixture {
  identityId: string;
  observationId: string;
  sourcePropertyId: string;
  runId: string;
  digest: string;
  destinationId: string;
  destinationSlug: string;
}

async function client(): Promise<Client> {
  const c = new Client({ connectionString: process.env.TEST_DATABASE_URL });
  await c.connect();
  return c;
}

async function destination(slug: string, countryCode: string): Promise<string> {
  const existing = await adminQuery<{ id: string }>(
    "select id from public.destinations where slug = $1",
    [slug],
  );
  if (existing.length > 0) return existing[0]!.id;
  const rows = await adminQuery<{ id: string }>(
    `insert into public.destinations (slug, name, type, country_code)
     values ($1,$1,'city',$2) returning id`,
    [slug, countryCode],
  );
  return rows[0]!.id;
}

/**
 * One pilot identity, in `evaluation`, resolved so that every non-review D062
 * condition passes — the state the real 867 review-ready identities were in.
 */
async function pilotIdentity(
  sourcePropertyId: string,
  slug: string,
  countryCode: string,
): Promise<PilotFixture> {
  const destinationId = await destination(slug, countryCode);
  const [run] = await adminQuery<{ id: string }>(
    `insert into public.source_runs (source, source_environment, destination_id, run_mode)
     values ($1,'evaluation',$2,'evaluation') returning id`,
    [SOURCE, destinationId],
  );
  const runId = run!.id;
  const digest = `pilot-digest-${sourcePropertyId}`;

  const [identity] = await adminQuery<{ id: string }>(
    `insert into public.source_property_identities
       (source, source_environment, source_property_id, first_seen_run_id, last_seen_run_id)
     values ($1,'evaluation',$2,$3,$3) returning id`,
    [SOURCE, sourcePropertyId, runId],
  );
  const identityId = identity!.id;

  const [observation] = await adminQuery<{ id: string }>(
    `insert into public.source_property_observations
       (source_run_id, source_property_identity_id, source, source_environment, observed_at,
        source_name, source_city, source_address, source_latitude, source_longitude,
        source_coordinates_plausible, source_classification_code, source_property_type_code,
        source_payload_digest)
     values ($1,$2,$3,'evaluation', now(), $4, $5, $6, -8.5, 115.26, true, '4EST', 'H', $7)
     returning id`,
    [
      runId,
      identityId,
      SOURCE,
      `Pilot Property ${sourcePropertyId}`,
      slug,
      `Jl Pilot ${sourcePropertyId}`,
      digest,
    ],
  );
  const observationId = observation!.id;

  const [star] = await adminQuery<{ id: string }>(
    `insert into public.source_property_star_resolution_revisions
       (source_property_identity_id, source, source_environment, evidence_observation_id,
        policy_provider, policy_version, policy_field, source_value, outcome, resolved_star_value,
        conflict_state)
     values ($1,$2,'evaluation',$3,$4,$5,'categoryCode','4EST','exact_four',4,'none') returning id`,
    [identityId, SOURCE, observationId, POLICY.provider, POLICY.star],
  );
  await adminQuery(
    `insert into public.source_property_star_resolutions (source_property_identity_id, current_revision_id)
     values ($1,$2)`,
    [identityId, star!.id],
  );

  const [scope] = await adminQuery<{ id: string }>(
    `insert into public.source_property_scope_resolution_revisions
       (source_property_identity_id, source, source_environment, evidence_observation_id,
        policy_provider, policy_version, policy_field, source_value, outcome)
     values ($1,$2,'evaluation',$3,$4,$5,'accommodationTypeCode','H','physical_hospitality')
     returning id`,
    [identityId, SOURCE, observationId, POLICY.provider, POLICY.scope],
  );
  await adminQuery(
    `insert into public.source_property_scope_resolutions (source_property_identity_id, current_revision_id)
     values ($1,$2)`,
    [identityId, scope!.id],
  );

  const [location] = await adminQuery<{ id: string }>(
    `insert into public.source_property_location_resolution_revisions
       (source_property_identity_id, source, source_environment, evidence_observation_id,
        policy_provider, policy_version, outcome, resolved_latitude, resolved_longitude,
        unresolved_reason, conflict_state)
     values ($1,$2,'evaluation',$3,$4,$5,'resolved',-8.5,115.26,null,'none') returning id`,
    [identityId, SOURCE, observationId, POLICY.provider, POLICY.location],
  );
  await adminQuery(
    `insert into public.source_property_location_resolutions (source_property_identity_id, current_revision_id)
     values ($1,$2)`,
    [identityId, location!.id],
  );

  await adminQuery(
    `insert into public.source_property_issue_snapshots
       (source_property_identity_id, source, source_environment, evidence_observation_id,
        extraction_status, provider_issue_count, source_payload_digest, evidence_source_run_id,
        extraction_method)
     values ($1,$2,'evaluation',$3,'complete',0,$4,$5,'a04-7-pilot-fixture/1')`,
    [identityId, SOURCE, observationId, digest, runId],
  );

  return {
    identityId,
    observationId,
    sourcePropertyId,
    runId,
    digest,
    destinationId,
    destinationSlug: slug,
  };
}

async function preview(sourcePropertyId: string) {
  const c = await client();
  try {
    const [result] = await loadPreviewResults(c, {
      source: SOURCE,
      environment: "evaluation",
      asOf: AS_OF,
      identityId: null,
      sourcePropertyId,
      limit: 1,
    });
    return result!;
  } finally {
    await c.end();
  }
}

/** The real A04.5 approve_create, applied exactly as the pilot applied it. */
async function approve(f: PilotFixture): Promise<void> {
  const p = await preview(f.sourcePropertyId);
  const item: ReviewedItem = {
    identityId: f.identityId,
    sourcePropertyId: f.sourcePropertyId,
    currentObservationId: f.observationId,
    currentSourceRunId: f.runId,
    sourcePayloadDigest: f.digest,
    prereviewFingerprint: p.fingerprint,
    prereviewAsOf: AS_OF,
    decision: "approve_create",
    canonicalDestinationSlug: f.destinationSlug,
    reviewerLabel: "Project owner — explicit human authorization 2026-08-27",
    reviewerUserId: null,
    humanNote: null,
    verifications: REVIEW_DIMENSIONS.map((dimension) => ({
      dimension,
      verdict: "supports" as const,
    })),
    evidenceReferences: [
      {
        referenceKind: "official_property_site",
        locator: "https://example.invalid/official",
        bearsOnDimensions: ["distinct_property", "destination_membership"],
        stance: "supports" as const,
      },
    ],
  };
  const c = await client();
  try {
    const report = await applyReviewedManifest(c, [item], {
      source: SOURCE,
      environment: "evaluation",
      asOf: AS_OF,
      apply: true,
    });
    expect(report.outcomes[0]!.state).toBe("applied");
  } finally {
    await c.end();
  }
}

async function publicationItemFor(f: PilotFixture): Promise<PublicationItem> {
  const p = await preview(f.sourcePropertyId);
  const [pins] = await adminQuery<{
    receipt_id: string;
    review_id: string;
    finding_id: string;
    star_revision_id: string;
    location_revision_id: string;
    scope_revision_id: string;
  }>(
    `select rv.current_receipt_id receipt_id, rv.id review_id, r.new_property_finding_id finding_id,
            st.id star_revision_id, lo.id location_revision_id, sc.id scope_revision_id
       from public.source_property_reviews rv
       join public.source_property_review_receipts r on r.id = rv.current_receipt_id
       join public.source_property_current_star_resolutions st on st.source_property_identity_id = rv.source_property_identity_id
       join public.source_property_current_location_resolutions lo on lo.source_property_identity_id = rv.source_property_identity_id
       join public.source_property_current_scope_resolutions sc on sc.source_property_identity_id = rv.source_property_identity_id
      where rv.source_property_identity_id = $1`,
    [f.identityId],
  );
  return {
    sourcePropertyIdentityId: f.identityId,
    source: SOURCE,
    // The manifest LIES about the environment on purpose: the refusal must come
    // from the identity's own `source_environment`, not from a writer's label.
    sourceEnvironment: "production",
    sourcePropertyId: f.sourcePropertyId,
    currentObservationId: f.observationId,
    currentSourceRunId: f.runId,
    sourcePayloadDigest: f.digest,
    asOf: AS_OF,
    previewSchemaVersion: p.schemaVersion,
    previewFingerprint: p.fingerprint,
    humanReviewReceiptId: pins!.receipt_id,
    reviewProjectionId: pins!.review_id,
    reviewCurrentReceiptId: pins!.receipt_id,
    humanNewPropertyFindingId: pins!.finding_id,
    destinationId: f.destinationId,
    starRevisionId: pins!.star_revision_id,
    locationRevisionId: pins!.location_revision_id,
    scopeRevisionId: pins!.scope_revision_id,
    publicationAuthorized: true,
    authorizedByLabel: "Project owner — explicit human authorization 2026-08-27",
    authorizedByUserId: null,
    authorizationNote: "Attempting to publish the A04.7 pilot. This must be refused.",
  };
}

async function canonicalCounts() {
  const [row] = await adminQuery<{
    hotels: string;
    links: string;
    receipts: string;
    terminal: string;
  }>(
    `select (select count(*) from public.hotels)::text hotels,
            (select count(*) from public.hotel_source_identities)::text links,
            (select count(*) from public.source_property_publication_receipts)::text receipts,
            (select count(*) from public.source_property_identities
              where resolution_state <> 'unresolved')::text terminal`,
  );
  return {
    hotels: Number(row!.hotels),
    links: Number(row!.links),
    receipts: Number(row!.receipts),
    terminal: Number(row!.terminal),
  };
}

d("A05 — the real A04.7 evaluation pilot stays unpublishable", () => {
  const fixtures: PilotFixture[] = [];

  beforeAll(async () => {
    await setupDatabase();
    await seed();
    for (const id of PILOT_BALI) fixtures.push(await pilotIdentity(id, "bali", "ID"));
    for (const id of PILOT_DUBAI) fixtures.push(await pilotIdentity(id, "dubai", "AE"));
    for (const f of fixtures) await approve(f);
  }, 120_000);
  afterAll(teardownDatabase);

  it("all eight still reach a genuine 11/11 D062 PASS", async () => {
    for (const f of fixtures) {
      const p = await preview(f.sourcePropertyId);
      expect(p.overall, `${f.sourcePropertyId} overall`).toBe("PASS");
      expect(
        p.conditions.filter((c) => c.status === "PASS").length,
        `${f.sourcePropertyId} conditions`,
      ).toBe(11);
    }
    // The pilot's shape, restated as a fact rather than a comment.
    expect(fixtures.map((f) => f.sourcePropertyId).sort()).toEqual([...PILOT_IDS].sort());
    const [row] = await adminQuery<{ n: string }>(
      `select count(*)::text n from public.source_property_identities
        where source_environment = 'evaluation' and source_property_id = any($1)`,
      [PILOT_IDS],
    );
    expect(Number(row!.n)).toBe(8);
  });

  it("A05 prepare offers none of them: a production pack is EMPTY", async () => {
    const c = await client();
    try {
      const pack = await buildPublicationPack(c, {
        source: SOURCE,
        environment: "production",
        asOf: AS_OF,
        limit: null,
      });
      // Prepare reads only production identities, so a corpus of eight
      // evaluation PASSes offers nothing at all — the eight are never even
      // candidates a human could authorize by mistake.
      expect(pack.items).toHaveLength(0);
      expect(pack.preparedFrom.identitiesEvaluated).toBe(0);
      expect(pack.preparedFrom.d062Pass).toBe(0);
    } finally {
      await c.end();
    }
  });

  it("A05 apply refuses all eight, and writes nothing canonical", async () => {
    // The RLS seed creates a few legacy canonical hotels; what matters is that
    // no SOURCE identity has produced one. Nothing below may change any of it.
    const before = await canonicalCounts();
    expect(before.links).toBe(0);
    expect(before.receipts).toBe(0);
    expect(before.terminal).toBe(0);

    const items = await Promise.all(fixtures.map(publicationItemFor));
    const c = await client();
    let report;
    try {
      report = await applyPublicationManifest(c, items, {
        source: SOURCE,
        environment: "evaluation",
        asOf: AS_OF,
        apply: true,
      });
    } finally {
      await c.end();
    }

    expect(report.outcomes).toHaveLength(8);
    for (const o of report.outcomes) {
      expect(o.state, `${o.sourcePropertyId}`).toBe("refused");
      if (o.state !== "refused") throw new Error("expected a refusal");
      expect(o.refusal, `${o.sourcePropertyId}`).toBe("evaluation_identity_not_publishable");
    }
    expect(report.canonicalWrites).toEqual({
      hotels: 0,
      hotelSourceIdentities: 0,
      publicationReceipts: 0,
    });

    // 0 hotels, 0 hotel_source_identities, 0 publication receipts,
    // 0 terminal resolution transitions — across all eight.
    expect(await canonicalCounts()).toEqual(before);
    for (const f of fixtures) {
      const [row] = await adminQuery<{
        resolution_state: string;
        promoted_hotel_id: string | null;
      }>(
        "select resolution_state, promoted_hotel_id from public.source_property_identities where id = $1",
        [f.identityId],
      );
      expect(row!.resolution_state).toBe("unresolved");
      expect(row!.promoted_hotel_id).toBeNull();
    }
  }, 120_000);

  it("their human approvals are untouched: the review evidence still stands", async () => {
    // Refusing to publish is not refusing the review. A04.5's receipts, its
    // findings and the current projections are all exactly as the pilot left
    // them, so re-review is never forced by a publication refusal.
    const [row] = await adminQuery<{
      reviews: string;
      receipts: string;
      findings: string;
      revocations: string;
    }>(
      `select (select count(*) from public.source_property_reviews)::text reviews,
              (select count(*) from public.source_property_review_receipts)::text receipts,
              (select count(*) from public.source_match_candidates
                where match_method = 'human_review:distinct_property' and status = 'accepted')::text findings,
              (select count(*) from public.source_property_review_revocations)::text revocations`,
    );
    expect(Number(row!.reviews)).toBe(8);
    expect(Number(row!.receipts)).toBe(8);
    expect(Number(row!.findings)).toBe(8);
    expect(Number(row!.revocations)).toBe(0);
  });
});
