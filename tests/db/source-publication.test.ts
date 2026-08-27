/**
 * A05 — ATOMIC D062 PUBLICATION (migration 0034 + the publication path).
 *
 * A04 previews. A04.5 records the human decision. A04.6 withdraws it. None of
 * them writes a canonical row. This layer crosses the irreversible boundary, so
 * the suite is organised around the ways that crossing goes wrong:
 *
 *   1. PUBLISHING SOMETHING THAT WAS NEVER AUTHORIZED. A D062 PASS is necessary
 *      and is not permission; `--apply` is a flag, not a person.
 *   2. EVALUATION DATA BECOMING CANONICAL DATA. The provider test environment is
 *      not production evidence, and no PASS on it is ever publishable.
 *   3. PUBLISHING THE PROVIDER RECORD INSTEAD OF THE APPROVED EVIDENCE. Star
 *      comes from the star resolution, coordinates from the location resolution,
 *      destination from the human, country from canonical geography — and a
 *      human's recorded CONTRADICTION is preserved, never normalized away.
 *   4. PUBLISHING AN APPROVAL THAT HAS SINCE BEEN WITHDRAWN OR DRIFTED. The
 *      prepared fingerprint is a pin, not cached authorization, and a concurrent
 *      A04.6 revocation must win.
 *   5. A HALF-PUBLICATION. Hotel, link, receipt and terminal state move together
 *      or not at all.
 *   6. A SECOND CANONICAL PROPERTY FOR ONE SOURCE IDENTITY. An exact replay is
 *      `already_published`; anything else is refused.
 *
 * Every fixture is SYNTHETIC. Fixtures marked `production` are synthetic
 * provider ids in a disposable local database — a database deployment target and
 * a provider `source_environment` are different concepts, and the production-only
 * source-environment constraint is never relaxed because the database is local.
 * The real A04.7 evaluation pilot is covered separately in
 * `source-publication-pilot.test.ts`, where it must stay UNPUBLISHABLE.
 */
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { adminQuery, hasTestDb, queryAs, setupDatabase, teardownDatabase } from "./harness";
import { seed, USERS } from "../rls/seed";
import { loadPreviewResults } from "../../scripts/prepublication-preview/preview";
import { applyReviewedManifest, type ReviewedItem } from "../../scripts/human-review/apply";
import { REVIEW_DIMENSIONS, type ReviewVerdict } from "../../scripts/human-review/pack";
import {
  applyRevocationManifest,
  type RevocationItem,
} from "../../scripts/human-review-revocation/revoke";
import {
  applyPublicationManifest,
  publicationDigestOf,
  PublicationRefusal,
  PUBLICATION_MATCH_METHOD,
  validatePublicationItem,
  type PublicationItem,
} from "../../scripts/source-publication/publish";
import { buildPublicationPack } from "../../scripts/source-publication/pack";
import { resolvePublicationTarget } from "../../scripts/source-publication/target";

const d = describe.skipIf(!hasTestDb);
const SOURCE = "hotelbeds";
const AS_OF = "2026-08-17";
const POLICY = {
  provider: "hotelbeds",
  star: "hotelbeds-classification/1",
  scope: "hotelbeds-hospitality-scope/1",
  location: "hotelbeds-location/1",
};
const STAR_CODE = "4EST";
const SCOPE_CODE = "H";
const AUTHORIZER = "test-publisher";
const NOTE = "Authorized for publication after reviewing the D062 evidence.";

type Environment = "evaluation" | "production";

let counter = 0;
const uniq = () => `P${Date.now().toString(36)}${(counter += 1)}`;

interface Fixture {
  identityId: string;
  observationId: string;
  sourcePropertyId: string;
  runId: string;
  digest: string;
  destinationId: string;
  destinationSlug: string;
  environment: Environment;
  name: string;
  address: string;
}

async function client(): Promise<Client> {
  const c = new Client({ connectionString: process.env.TEST_DATABASE_URL });
  await c.connect();
  return c;
}

async function destination(
  slug: string,
  countryCode: string | null = "ID",
): Promise<{ id: string; countryCode: string | null }> {
  const existing = await adminQuery<{ id: string; country_code: string | null }>(
    "select id, country_code from public.destinations where slug = $1",
    [slug],
  );
  if (existing.length > 0) return { id: existing[0]!.id, countryCode: existing[0]!.country_code };
  const rows = await adminQuery<{ id: string; country_code: string | null }>(
    `insert into public.destinations (slug, name, type, country_code)
     values ($1, $1, 'city', $2) returning id, country_code`,
    [slug, countryCode],
  );
  return { id: rows[0]!.id, countryCode: rows[0]!.country_code };
}

async function newRun(
  destinationId: string,
  environment: Environment,
  offsetSeconds = 0,
): Promise<string> {
  const rows = await adminQuery<{ id: string }>(
    `insert into public.source_runs (source, source_environment, destination_id, run_mode, started_at)
     values ($1,$2,$3,'evaluation', now() + ($4 || ' seconds')::interval) returning id`,
    [SOURCE, environment, destinationId, String(offsetSeconds)],
  );
  return rows[0]!.id;
}

async function setStar(
  identityId: string,
  observationId: string,
  environment: Environment,
  outcome = "exact_four",
): Promise<string> {
  const value = outcome === "exact_four" ? 4 : outcome === "exact_five" ? 5 : null;
  const rev = await adminQuery<{ id: string }>(
    `insert into public.source_property_star_resolution_revisions
       (source_property_identity_id, source, source_environment, evidence_observation_id,
        policy_provider, policy_version, policy_field, source_value, outcome, resolved_star_value,
        conflict_state)
     values ($1,$2,$8,$3,$4,$5,'categoryCode',$9,$6,$7,'none') returning id`,
    [
      identityId,
      SOURCE,
      observationId,
      POLICY.provider,
      POLICY.star,
      outcome,
      value,
      environment,
      outcome === "exact_five" ? "5EST" : STAR_CODE,
    ],
  );
  await adminQuery(
    `insert into public.source_property_star_resolutions (source_property_identity_id, current_revision_id)
     values ($1,$2)
     on conflict (source_property_identity_id) do update set current_revision_id = excluded.current_revision_id`,
    [identityId, rev[0]!.id],
  );
  return rev[0]!.id;
}

async function setScope(
  identityId: string,
  observationId: string,
  environment: Environment,
): Promise<string> {
  const rev = await adminQuery<{ id: string }>(
    `insert into public.source_property_scope_resolution_revisions
       (source_property_identity_id, source, source_environment, evidence_observation_id,
        policy_provider, policy_version, policy_field, source_value, outcome)
     values ($1,$2,$6,$3,$4,$5,'accommodationTypeCode',$7,'physical_hospitality') returning id`,
    [identityId, SOURCE, observationId, POLICY.provider, POLICY.scope, environment, SCOPE_CODE],
  );
  await adminQuery(
    `insert into public.source_property_scope_resolutions (source_property_identity_id, current_revision_id)
     values ($1,$2)
     on conflict (source_property_identity_id) do update set current_revision_id = excluded.current_revision_id`,
    [identityId, rev[0]!.id],
  );
  return rev[0]!.id;
}

async function setLocation(
  identityId: string,
  observationId: string,
  environment: Environment,
): Promise<string> {
  const rev = await adminQuery<{ id: string }>(
    `insert into public.source_property_location_resolution_revisions
       (source_property_identity_id, source, source_environment, evidence_observation_id,
        policy_provider, policy_version, outcome, resolved_latitude, resolved_longitude,
        unresolved_reason, conflict_state)
     values ($1,$2,$6,$3,$4,$5,'resolved',-8.5,115.26,null,'none') returning id`,
    [identityId, SOURCE, observationId, POLICY.provider, POLICY.location, environment],
  );
  await adminQuery(
    `insert into public.source_property_location_resolutions (source_property_identity_id, current_revision_id)
     values ($1,$2)
     on conflict (source_property_identity_id) do update set current_revision_id = excluded.current_revision_id`,
    [identityId, rev[0]!.id],
  );
  return rev[0]!.id;
}

async function setCompleteLifecycleSnapshot(
  identityId: string,
  observationId: string,
  runId: string,
  digest: string,
  environment: Environment,
  closure?: { from: string; to: string },
): Promise<void> {
  const [snapshot] = await adminQuery<{ id: string }>(
    `insert into public.source_property_issue_snapshots
       (source_property_identity_id, source, source_environment, evidence_observation_id,
        extraction_status, provider_issue_count, source_payload_digest, evidence_source_run_id,
        extraction_method)
     values ($1,$2,$6,$3,'complete',$7,$4,$5,'test-fixture/1')
     returning id`,
    [identityId, SOURCE, observationId, digest, runId, environment, closure ? 1 : 0],
  );
  if (!closure) return;
  // The ONE approved property-level pair (0031 §6). A closure window is a date
  // range, never permanent closure, however distant `dateTo` may be.
  await adminQuery(
    `insert into public.source_property_issue_evidence
       (snapshot_id, source_property_identity_id, issue_code, issue_type,
        date_from_raw, date_to_raw, provider_order, alternative)
     values ($1,$2,'HOTEL','CLOSED',$3,$4,1,false)`,
    [snapshot!.id, identityId, closure.from, closure.to],
  );
}

/**
 * An identity for which every non-review D062 condition passes. `production` by
 * default, because A05's subject is production evidence.
 */
async function readyProperty(opts?: {
  slug?: string;
  environment?: Environment;
  countryCode?: string | null;
  star?: string;
  address?: string;
  sourcePropertyId?: string;
  closure?: { from: string; to: string };
}): Promise<Fixture> {
  const slug = opts?.slug ?? "bali";
  const environment = opts?.environment ?? "production";
  const dest = await destination(slug, opts?.countryCode === undefined ? "ID" : opts.countryCode);
  const runId = await newRun(dest.id, environment);
  const sourcePropertyId = opts?.sourcePropertyId ?? uniq();
  const digest = `digest-${uniq()}`;
  const name = `Ready Property ${sourcePropertyId}`;
  const address = opts?.address ?? `Jl Test ${sourcePropertyId}`;

  const identity = await adminQuery<{ id: string }>(
    `insert into public.source_property_identities
       (source, source_environment, source_property_id, first_seen_run_id, last_seen_run_id)
     values ($1,$4,$2,$3,$3) returning id`,
    [SOURCE, sourcePropertyId, runId, environment],
  );
  const identityId = identity[0]!.id;

  const observation = await adminQuery<{ id: string }>(
    `insert into public.source_property_observations
       (source_run_id, source_property_identity_id, source, source_environment, observed_at,
        source_name, source_city, source_address, source_latitude, source_longitude,
        source_coordinates_plausible, source_classification_code, source_property_type_code,
        source_payload_digest)
     values ($1,$2,$3,$8, now(), $4, 'Ubud', $9, -8.5, 115.26,
             true, $6, $7, $5)
     returning id`,
    [
      runId,
      identityId,
      SOURCE,
      name,
      digest,
      opts?.star === "exact_five" ? "5EST" : STAR_CODE,
      SCOPE_CODE,
      environment,
      address,
    ],
  );
  const observationId = observation[0]!.id;

  await setStar(identityId, observationId, environment, opts?.star ?? "exact_four");
  await setScope(identityId, observationId, environment);
  await setLocation(identityId, observationId, environment);
  await setCompleteLifecycleSnapshot(
    identityId,
    observationId,
    runId,
    digest,
    environment,
    opts?.closure,
  );

  return {
    identityId,
    observationId,
    sourcePropertyId,
    runId,
    digest,
    destinationId: dest.id,
    destinationSlug: slug,
    environment,
    name,
    address,
  };
}

async function preview(sourcePropertyId: string, environment: Environment) {
  const c = await client();
  try {
    const [result] = await loadPreviewResults(c, {
      source: SOURCE,
      environment,
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

async function applyReview(
  f: Fixture,
  overrides: Partial<ReviewedItem> = {},
  verdicts: Partial<Record<(typeof REVIEW_DIMENSIONS)[number], ReviewVerdict>> = {},
) {
  const p = await preview(f.sourcePropertyId, f.environment);
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
    reviewerLabel: "test-reviewer",
    humanNote: "Verified against the official property site.",
    verifications: REVIEW_DIMENSIONS.map((dimension) => ({
      dimension,
      verdict: (verdicts[dimension] ?? "supports") as ReviewVerdict,
      note:
        (verdicts[dimension] ?? "supports") === "contradicts"
          ? "The provider value disagrees with the official source."
          : null,
    })),
    evidenceReferences: [
      {
        referenceKind: "official_property_site",
        locator: "https://example.invalid/official",
        bearsOnDimensions: ["distinct_property", "destination_membership"],
        stance: "supports" as const,
      },
    ],
    ...overrides,
  };
  const c = await client();
  try {
    return await applyReviewedManifest(c, [item], {
      source: SOURCE,
      environment: f.environment,
      asOf: AS_OF,
      apply: true,
    });
  } finally {
    await c.end();
  }
}

/** A fully approved, publication-ready production identity. */
async function approvedProperty(
  opts?: Parameters<typeof readyProperty>[0],
  verdicts?: Partial<Record<(typeof REVIEW_DIMENSIONS)[number], ReviewVerdict>>,
): Promise<Fixture> {
  const f = await readyProperty(opts);
  const report = await applyReview(f, {}, verdicts);
  expect(report.outcomes[0]!.state).toBe("applied");
  return f;
}

interface Pins {
  receiptId: string;
  reviewId: string;
  findingId: string;
  starRevisionId: string;
  locationRevisionId: string;
  scopeRevisionId: string;
}

async function pinsFor(f: Fixture): Promise<Pins> {
  const [row] = await adminQuery<{
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
    receiptId: row!.receipt_id,
    reviewId: row!.review_id,
    findingId: row!.finding_id,
    starRevisionId: row!.star_revision_id,
    locationRevisionId: row!.location_revision_id,
    scopeRevisionId: row!.scope_revision_id,
  };
}

async function publicationItem(
  f: Fixture,
  overrides: Partial<PublicationItem> = {},
): Promise<PublicationItem> {
  const p = await preview(f.sourcePropertyId, f.environment);
  const pins = await pinsFor(f);
  return {
    sourcePropertyIdentityId: f.identityId,
    source: SOURCE,
    sourceEnvironment: f.environment,
    sourcePropertyId: f.sourcePropertyId,
    currentObservationId: f.observationId,
    currentSourceRunId: f.runId,
    sourcePayloadDigest: f.digest,
    asOf: AS_OF,
    previewSchemaVersion: p.schemaVersion,
    previewFingerprint: p.fingerprint,
    humanReviewReceiptId: pins.receiptId,
    reviewProjectionId: pins.reviewId,
    reviewCurrentReceiptId: pins.receiptId,
    humanNewPropertyFindingId: pins.findingId,
    destinationId: f.destinationId,
    starRevisionId: pins.starRevisionId,
    locationRevisionId: pins.locationRevisionId,
    scopeRevisionId: pins.scopeRevisionId,
    publicationAuthorized: true,
    authorizedByLabel: AUTHORIZER,
    authorizedByUserId: null,
    authorizationNote: NOTE,
    ...overrides,
  };
}

async function publish(
  items: PublicationItem[],
  opts: { apply: boolean; environment?: Environment; asOf?: string },
) {
  const c = await client();
  try {
    return await applyPublicationManifest(c, items, {
      source: SOURCE,
      environment: opts.environment ?? "production",
      asOf: opts.asOf ?? AS_OF,
      apply: opts.apply,
    });
  } finally {
    await c.end();
  }
}

async function canonicalCounts(): Promise<{
  hotels: number;
  links: number;
  receipts: number;
  contacts: number;
  resolved: number;
}> {
  const [row] = await adminQuery<{
    hotels: string;
    links: string;
    receipts: string;
    contacts: string;
    resolved: string;
  }>(
    `select (select count(*) from public.hotels)::text hotels,
            (select count(*) from public.hotel_source_identities)::text links,
            (select count(*) from public.source_property_publication_receipts)::text receipts,
            (select count(*) from public.hotel_contacts)::text contacts,
            (select count(*) from public.source_property_identities
              where resolution_state <> 'unresolved')::text resolved`,
  );
  return {
    hotels: Number(row!.hotels),
    links: Number(row!.links),
    receipts: Number(row!.receipts),
    contacts: Number(row!.contacts),
    resolved: Number(row!.resolved),
  };
}

async function hotelRow(hotelId: string) {
  const [row] = await adminQuery<{
    name: string;
    slug: string;
    destination_id: string;
    country_code: string | null;
    address: string | null;
    latitude: string | null;
    longitude: string | null;
    star_rating: string | null;
    active_status: string;
    website_url: string | null;
    instagram_url: string | null;
    description_short: string | null;
    hotel_type: string | null;
    brand_id: string | null;
    editorial_verification_status: string;
    editorial_verified_at: string | null;
  }>(
    `select name, slug, destination_id, country_code, address, latitude::text, longitude::text,
            star_rating::text, active_status, website_url, instagram_url, description_short,
            hotel_type, brand_id, editorial_verification_status, editorial_verified_at
       from public.hotels where id = $1`,
    [hotelId],
  );
  return row!;
}

async function identityRow(identityId: string) {
  const [row] = await adminQuery<{
    resolution_state: string;
    promoted_hotel_id: string | null;
    resolution_reason: string | null;
  }>(
    `select resolution_state, promoted_hotel_id, resolution_reason
       from public.source_property_identities where id = $1`,
    [identityId],
  );
  return row!;
}

/** Withdraw an approval through the REAL A04.6 path. */
async function revoke(f: Fixture): Promise<void> {
  const pins = await pinsFor(f);
  const [r] = await adminQuery<{ receipt_digest: string; evidence_observation_id: string }>(
    "select receipt_digest, evidence_observation_id from public.source_property_review_receipts where id = $1",
    [pins.receiptId],
  );
  const item: RevocationItem = {
    reviewId: pins.reviewId,
    identityId: f.identityId,
    sourcePropertyId: f.sourcePropertyId,
    expectedDecision: "approve_create",
    expectedReviewStatus: "active",
    expectedCurrentReceiptId: pins.receiptId,
    expectedReceiptDigest: r!.receipt_digest,
    expectedEvidenceObservationId: r!.evidence_observation_id,
    reviewerLabel: "test-reviewer",
    reviewerUserId: null,
    revocationNote: "Withdrawn for the publication race test.",
  };
  const c = await client();
  try {
    const report = await applyRevocationManifest(c, [item], {
      source: SOURCE,
      environment: f.environment,
      apply: true,
    });
    expect(report.outcomes[0]!.state).toBe("revoked");
  } finally {
    await c.end();
  }
}

/**
 * Start a publication and pause it immediately BEFORE the first statement
 * matching `pauseBefore`, so the test decides the interleaving exactly rather
 * than guessing at timing.
 */
function startPausedPublication(
  c: Client,
  items: PublicationItem[],
  pauseBefore: RegExp,
  opts: { apply: boolean; environment?: Environment } = { apply: true },
) {
  let signalReached!: () => void;
  const reached = new Promise<void>((r) => (signalReached = r));
  let signalRelease!: () => void;
  const gate = new Promise<void>((r) => (signalRelease = r));
  let armed = true;

  const proxy = {
    query: async (...args: unknown[]) => {
      const first = args[0];
      const sql = typeof first === "string" ? first : ((first as { text?: string })?.text ?? "");
      if (armed && pauseBefore.test(sql)) {
        armed = false;
        signalReached();
        await gate;
      }
      return (c.query as (...a: unknown[]) => Promise<unknown>)(...args);
    },
  } as unknown as Client;

  const settled = applyPublicationManifest(proxy, items, {
    source: SOURCE,
    environment: opts.environment ?? "production",
    asOf: AS_OF,
    apply: opts.apply,
  }).then(
    (report) => ({ ok: true as const, report }),
    (error: unknown) => ({ ok: false as const, error }),
  );
  void settled.then(() => signalReached());

  return { reached, release: () => signalRelease(), settled, end: () => c.end() };
}

d("A05 atomic D062 publication (0034)", () => {
  beforeAll(async () => {
    await setupDatabase();
    await seed();
  });
  afterAll(teardownDatabase);

  // =====================================================================
  describe("the publication itself", () => {
    it("1. an authorized production 11/11 PASS becomes a canonical hotel", async () => {
      const f = await approvedProperty();
      const p = await preview(f.sourcePropertyId, "production");
      expect(p.overall).toBe("PASS");
      expect(p.conditions.filter((c) => c.status === "PASS")).toHaveLength(11);

      const report = await publish([await publicationItem(f)], { apply: true });
      const [outcome] = report.outcomes;
      expect(outcome!.state).toBe("published");
      expect(report.canonicalWrites).toEqual({
        hotels: 1,
        hotelSourceIdentities: 1,
        publicationReceipts: 1,
      });
    });

    it("2. a dry-run runs every write and leaves ZERO rows behind", async () => {
      const f = await approvedProperty();
      const before = await canonicalCounts();

      const report = await publish([await publicationItem(f)], { apply: false });
      expect(report.outcomes[0]!.state).toBe("would_publish");
      expect(report.canonicalWrites).toEqual({
        hotels: 0,
        hotelSourceIdentities: 0,
        publicationReceipts: 0,
      });

      expect(await canonicalCounts()).toEqual(before);
      expect((await identityRow(f.identityId)).resolution_state).toBe("unresolved");
    });

    it("3/4/5. exactly one hotel, one ACTIVE link and one immutable receipt", async () => {
      const f = await approvedProperty();
      const report = await publish([await publicationItem(f)], { apply: true });
      const o = report.outcomes[0]!;
      if (o.state === "refused") throw new Error(o.detail);

      const hotels = await adminQuery(
        `select h.id from public.hotels h
           join public.source_property_publication_receipts p on p.hotel_id = h.id
          where p.source_property_identity_id = $1`,
        [f.identityId],
      );
      expect(hotels).toHaveLength(1);

      const links = await adminQuery<{ id: string; link_status: string; match_method: string }>(
        "select id, link_status, match_method from public.hotel_source_identities where source_property_identity_id = $1",
        [f.identityId],
      );
      expect(links).toHaveLength(1);
      expect(links[0]!.link_status).toBe("active");
      // Never `blocking:*`: a human created this link, and A02's stand-down
      // sweep must never be able to supersede it as a stale machine guess.
      expect(links[0]!.match_method).toBe(PUBLICATION_MATCH_METHOD);
      expect(links[0]!.match_method.startsWith("blocking:")).toBe(false);
      expect(links[0]!.id).toBe(o.hotelSourceIdentityId);

      const receipts = await adminQuery(
        "select id from public.source_property_publication_receipts where source_property_identity_id = $1",
        [f.identityId],
      );
      expect(receipts).toHaveLength(1);
    });

    it("6/7. the identity becomes resolved_eligible against the hotel it produced", async () => {
      const f = await approvedProperty();
      const report = await publish([await publicationItem(f)], { apply: true });
      const o = report.outcomes[0]!;
      if (o.state === "refused") throw new Error(o.detail);

      const identity = await identityRow(f.identityId);
      expect(identity.resolution_state).toBe("resolved_eligible");
      expect(identity.promoted_hotel_id).toBe(o.hotelId);
      // D061 §9 `resolution_reason` is EXCLUSION vocabulary. A published
      // property is the opposite of an exclusion.
      expect(identity.resolution_reason).toBeNull();
    });
  });

  // =====================================================================
  // THE CANONICAL ROW IS BUILT FROM APPROVED EVIDENCE, NOT FROM THE PROVIDER
  // RECORD. Every field below has a source that is NOT "whatever the observation
  // happened to contain".
  // =====================================================================
  describe("canonical field policy", () => {
    it("8. destination comes from the human review, never provider geography", async () => {
      const f = await approvedProperty({ slug: "dubai", countryCode: "AE" });
      const report = await publish([await publicationItem(f)], { apply: true });
      const o = report.outcomes[0]!;
      if (o.state === "refused") throw new Error(o.detail);
      const hotel = await hotelRow(o.hotelId);
      expect(hotel.destination_id).toBe(f.destinationId);
    });

    it("9. star comes from the star resolution: exact_five publishes 5", async () => {
      const f = await approvedProperty({ star: "exact_five" });
      const report = await publish([await publicationItem(f)], { apply: true });
      const o = report.outcomes[0]!;
      if (o.state === "refused") throw new Error(o.detail);
      expect(Number((await hotelRow(o.hotelId)).star_rating)).toBe(5);
    });

    it("10. lat/lon come from the location RESOLUTION, and its revision is cited", async () => {
      const f = await approvedProperty();
      const report = await publish([await publicationItem(f)], { apply: true });
      const o = report.outcomes[0]!;
      if (o.state === "refused") throw new Error(o.detail);

      const [head] = await adminQuery<{ id: string; lat: string; lon: string }>(
        `select id, resolved_latitude::text lat, resolved_longitude::text lon
           from public.source_property_current_location_resolutions
          where source_property_identity_id = $1`,
        [f.identityId],
      );
      const hotel = await hotelRow(o.hotelId);
      expect(Number(hotel.latitude)).toBe(Number(head!.lat));
      expect(Number(hotel.longitude)).toBe(Number(head!.lon));

      // Provenance, not coincidence: the receipt names the exact revision the
      // published coordinates came from, and 0034 refuses a receipt whose hotel
      // disagrees with it.
      const [receipt] = await adminQuery<{ location_revision_id: string }>(
        "select location_revision_id from public.source_property_publication_receipts where id = $1",
        [o.publicationReceiptId],
      );
      expect(receipt!.location_revision_id).toBe(head!.id);
    });

    it("10b. an UNRESOLVED location is refused — raw coordinates never substitute", async () => {
      // The observation carries coordinates the provider supplied; the approved
      // location policy did not resolve them. D054/D062 make a canonical
      // coordinate a publishability precondition, and "the provider sent a
      // number" is not a resolution.
      const dest = await destination("bali");
      const runId = await newRun(dest.id, "production");
      const sourcePropertyId = uniq();
      const digest = `digest-${uniq()}`;
      const [identity] = await adminQuery<{ id: string }>(
        `insert into public.source_property_identities
           (source, source_environment, source_property_id, first_seen_run_id, last_seen_run_id)
         values ($1,'production',$2,$3,$3) returning id`,
        [SOURCE, sourcePropertyId, runId],
      );
      const [observation] = await adminQuery<{ id: string }>(
        `insert into public.source_property_observations
           (source_run_id, source_property_identity_id, source, source_environment, observed_at,
            source_name, source_address, source_latitude, source_longitude,
            source_coordinates_plausible, source_classification_code, source_property_type_code,
            source_payload_digest)
         values ($1,$2,$3,'production', now(), $4, 'Jl Test', 999.9, 999.9, false, $6, $7, $5)
         returning id`,
        [
          runId,
          identity!.id,
          SOURCE,
          `Unlocated ${sourcePropertyId}`,
          digest,
          STAR_CODE,
          SCOPE_CODE,
        ],
      );
      await setStar(identity!.id, observation!.id, "production");
      await setScope(identity!.id, observation!.id, "production");
      const [rev] = await adminQuery<{ id: string }>(
        `insert into public.source_property_location_resolution_revisions
           (source_property_identity_id, source, source_environment, evidence_observation_id,
            policy_provider, policy_version, outcome, resolved_latitude, resolved_longitude,
            unresolved_reason, conflict_state)
         values ($1,$2,'production',$3,$4,$5,'unresolved',null,null,'coordinates_implausible','none')
         returning id`,
        [identity!.id, SOURCE, observation!.id, POLICY.provider, POLICY.location],
      );
      await adminQuery(
        `insert into public.source_property_location_resolutions (source_property_identity_id, current_revision_id)
         values ($1,$2)`,
        [identity!.id, rev!.id],
      );
      await setCompleteLifecycleSnapshot(
        identity!.id,
        observation!.id,
        runId,
        digest,
        "production",
      );

      const p = await preview(sourcePropertyId, "production");
      expect(p.conditions.find((c) => c.number === 8)!.status).not.toBe("PASS");
      const before = await canonicalCounts();
      const item = await publicationItemWithoutReview({
        identityId: identity!.id,
        observationId: observation!.id,
        sourcePropertyId,
        runId,
        digest,
        destinationId: dest.id,
        destinationSlug: "bali",
        environment: "production",
        name: `Unlocated ${sourcePropertyId}`,
        address: "Jl Test",
      });
      const report = await publish([item], { apply: true });
      expect(report.outcomes[0]!.state).toBe("refused");
      expect(await canonicalCounts()).toEqual(before);
    });

    it("11. country comes from the canonical destination", async () => {
      const f = await approvedProperty({ slug: "phuket", countryCode: "TH" });
      const report = await publish([await publicationItem(f)], { apply: true });
      const o = report.outcomes[0]!;
      if (o.state === "refused") throw new Error(o.detail);
      expect((await hotelRow(o.hotelId)).country_code).toBe("TH");
    });

    it("12. active_status is `unknown`; no_known_closure is not evidence of open", async () => {
      const f = await approvedProperty();
      const report = await publish([await publicationItem(f)], { apply: true });
      const o = report.outcomes[0]!;
      if (o.state === "refused") throw new Error(o.detail);
      const hotel = await hotelRow(o.hotelId);
      expect(hotel.active_status).toBe("unknown");
      // A05 publishes identity, not enrichment. Nothing here is invented.
      expect(hotel.website_url).toBeNull();
      expect(hotel.instagram_url).toBeNull();
      expect(hotel.description_short).toBeNull();
      expect(hotel.hotel_type).toBeNull();
      expect(hotel.brand_id).toBeNull();
      expect(hotel.editorial_verification_status).toBe("unverified");
      expect(hotel.editorial_verified_at).toBeNull();
    });

    it("13. address `supports` is copied", async () => {
      const f = await approvedProperty();
      const report = await publish([await publicationItem(f)], { apply: true });
      const o = report.outcomes[0]!;
      if (o.state === "refused") throw new Error(o.detail);
      expect((await hotelRow(o.hotelId)).address).toBe(f.address);
    });

    it("14. address `unavailable` publishes NULL, never the provider string", async () => {
      const f = await approvedProperty(undefined, { address: "unavailable" });
      const report = await publish([await publicationItem(f)], { apply: true });
      const o = report.outcomes[0]!;
      if (o.state === "refused") throw new Error(o.detail);
      expect((await hotelRow(o.hotelId)).address).toBeNull();
    });

    it("15. address `contradicts` publishes NULL — the human is not overruled", async () => {
      // The A04.7 pilot proved a property can validly reach 11/11 while its
      // address contradicts. Publishing that address anyway would silently
      // normalize away a recorded human disagreement.
      const f = await approvedProperty(undefined, { address: "contradicts" });
      const p = await preview(f.sourcePropertyId, "production");
      expect(p.overall).toBe("PASS");
      const report = await publish([await publicationItem(f)], { apply: true });
      const o = report.outcomes[0]!;
      if (o.state === "refused") throw new Error(o.detail);
      expect((await hotelRow(o.hotelId)).address).toBeNull();
    });

    it("16. a name the human did not affirm is REFUSED, with zero writes", async () => {
      for (const verdict of ["unavailable", "contradicts"] as const) {
        const f = await approvedProperty(undefined, { name: verdict });
        const before = await canonicalCounts();
        const report = await publish([await publicationItem(f)], { apply: true });
        const o = report.outcomes[0]!;
        expect(o.state).toBe("refused");
        if (o.state !== "refused") throw new Error("expected a refusal");
        expect(o.refusal).toBe("publication_name_not_human_supported");
        expect(await canonicalCounts()).toEqual(before);
      }
    });
  });

  // =====================================================================
  // THE HARD WALL. This is the single most load-bearing test in the suite.
  // =====================================================================
  describe("evaluation data never becomes canonical data", () => {
    it("17. an EVALUATION identity at 11/11 PASS is refused, with zero writes", async () => {
      const f = await approvedProperty({ environment: "evaluation" });
      const p = await preview(f.sourcePropertyId, "evaluation");
      expect(p.overall).toBe("PASS");
      expect(p.conditions.filter((c) => c.status === "PASS")).toHaveLength(11);

      const before = await canonicalCounts();
      const item = await publicationItem(f);

      // Layer 1: the manifest shape refuses before the database is opened.
      expect(() => validatePublicationItem(item)).toThrow(PublicationRefusal);
      await expect(publish([item], { apply: true, environment: "evaluation" })).rejects.toThrow(
        /evaluation_identity_not_publishable|EVALUATION DATA NEVER BECOMES CANONICAL DATA/,
      );

      // Layer 2: even a manifest that LIES about its environment is refused by
      // the locked identity's own `source_environment`, per item, before writes.
      const lying = { ...item, sourceEnvironment: "production" };
      const report = await publish([lying], { apply: true, environment: "evaluation" });
      const o = report.outcomes[0]!;
      expect(o.state).toBe("refused");
      if (o.state !== "refused") throw new Error("expected a refusal");
      expect(o.refusal).toBe("evaluation_identity_not_publishable");

      expect(await canonicalCounts()).toEqual(before);
      expect((await identityRow(f.identityId)).resolution_state).toBe("unresolved");
    });

    it("17b. the database refuses an evaluation publication receipt outright", async () => {
      // Layer 3, independent of the writer: 0027 makes an evaluation identity
      // unlinkable and ineligible, and 0034 refuses the receipt.
      const f = await approvedProperty({ environment: "evaluation" });
      const [hotel] = await adminQuery<{ id: string }>(
        `insert into public.hotels (name, slug, destination_id, active_status)
         values ($1,$2,$3,'unknown') returning id`,
        [`Illegal ${f.sourcePropertyId}`, `illegal-${f.sourcePropertyId}`, f.destinationId],
      );
      await expect(
        adminQuery(
          `insert into public.hotel_source_identities
             (hotel_id, source_property_identity_id, source, source_environment, source_property_id,
              link_status, match_method)
           values ($1,$2,$3,'evaluation',$4,'active','human_review:d062_approve_create')`,
          [hotel!.id, f.identityId, SOURCE, f.sourcePropertyId],
        ),
      ).rejects.toThrow(/production_only|violates check constraint/i);
      await adminQuery("delete from public.hotels where id = $1", [hotel!.id]);
    });
  });

  // =====================================================================
  describe("authorization is separate from the verdict", () => {
    it("18. an UNRESOLVED identity is refused", async () => {
      // No human review at all: conditions 1, 2 and 5 hold.
      const f = await readyProperty();
      const p = await preview(f.sourcePropertyId, "production");
      expect(p.overall).toBe("UNRESOLVED");
      const before = await canonicalCounts();
      const item = await publicationItemWithoutReview(f);
      const report = await publish([item], { apply: true });
      const o = report.outcomes[0]!;
      expect(o.state).toBe("refused");
      if (o.state !== "refused") throw new Error("expected a refusal");
      expect(o.refusal).toBe("human_review_missing");
      expect(await canonicalCounts()).toEqual(before);
    });

    it("19. a FAILing identity is refused with the failing conditions named", async () => {
      // A property-level HOTEL+CLOSED window that does NOT cover the review date
      // but DOES cover the publication date. The identity was legitimately
      // approved; publishing it on a date it is closed is a definitive FAIL on
      // D062 condition 4, and lifecycle is evaluated AS OF an explicit date
      // precisely so this question has an answer that can change.
      const f = await approvedProperty({ closure: { from: "2027-01-01", to: "2027-12-31" } });
      expect((await preview(f.sourcePropertyId, "production")).overall).toBe("PASS");

      const before = await canonicalCounts();
      const item = await publicationItem(f);
      const report = await publish([item], { apply: true, asOf: "2027-06-01" });
      const o = report.outcomes[0]!;
      expect(o.state).toBe("refused");
      if (o.state !== "refused") throw new Error("expected a refusal");
      expect(o.refusal).toBe("d062_not_pass");
      expect(o.detail).toMatch(/c4=FAIL\(known_property_closed\)/);
      expect(await canonicalCounts()).toEqual(before);
    });

    it("20. a REVOKED approval is refused, with zero writes", async () => {
      const f = await approvedProperty();
      const item = await publicationItem(f);
      await revoke(f);

      const before = await canonicalCounts();
      const report = await publish([item], { apply: true });
      const o = report.outcomes[0]!;
      expect(o.state).toBe("refused");
      if (o.state !== "refused") throw new Error("expected a refusal");
      expect(o.refusal).toBe("human_review_revoked");
      expect(await canonicalCounts()).toEqual(before);
    });

    it("21. a STALE human receipt (superseded observation) is refused", async () => {
      const f = await approvedProperty();
      const item = await publicationItem(f);
      // Ingestion advances the identity; the approval now describes evidence
      // that is no longer current.
      const runId = await newRun(f.destinationId, "production", 3600);
      const digest = `digest-${uniq()}`;
      await adminQuery(
        `insert into public.source_property_observations
           (source_run_id, source_property_identity_id, source, source_environment, observed_at,
            source_name, source_address, source_latitude, source_longitude,
            source_coordinates_plausible, source_classification_code, source_property_type_code,
            source_payload_digest)
         values ($1,$2,$3,'production', now() + interval '1 hour', $4, $8, -8.5, 115.26, true, $6, $7, $5)`,
        [runId, f.identityId, SOURCE, f.name, digest, STAR_CODE, SCOPE_CODE, f.address],
      );
      await adminQuery(
        "update public.source_property_identities set last_seen_run_id = $2 where id = $1",
        [f.identityId, runId],
      );

      const before = await canonicalCounts();
      const report = await publish([item], { apply: true });
      const o = report.outcomes[0]!;
      expect(o.state).toBe("refused");
      if (o.state !== "refused") throw new Error("expected a refusal");
      expect(o.refusal).toBe("stale_observation");
      expect(await canonicalCounts()).toEqual(before);
    });

    it("22. a changed D062 fingerprint is refused", async () => {
      const f = await approvedProperty();
      const item = await publicationItem(f);
      // The fingerprint is a pin, not cached authorization: a manifest carrying
      // a different fingerprint describes evidence the human never saw.
      const tampered = {
        ...item,
        previewFingerprint: "f".repeat(64),
      };
      const before = await canonicalCounts();
      const report = await publish([tampered], { apply: true });
      const o = report.outcomes[0]!;
      expect(o.state).toBe("refused");
      if (o.state !== "refused") throw new Error("expected a refusal");
      expect(o.refusal).toBe("stale_preview_fingerprint");
      expect(await canonicalCounts()).toEqual(before);
    });

    it("33. `approve_match` is refused as NOT IMPLEMENTED, not silently handled", async () => {
      const f = await approvedProperty();
      const item = await publicationItem(f);
      const [target] = await adminQuery<{ id: string }>(
        `insert into public.hotels (name, slug, destination_id, active_status)
         values ($1,$2,$3,'unknown') returning id`,
        [
          `Match target ${f.sourcePropertyId}`,
          `match-target-${f.sourcePropertyId}`,
          f.destinationId,
        ],
      );
      // The projection's vocabulary (0027) is wider than the receipt's (0032),
      // so this state is representable and must be refused explicitly.
      await adminQuery(
        `update public.source_property_reviews
            set decision = 'approve_match', target_hotel_id = $2, destination_id = null,
                current_receipt_id = null
          where source_property_identity_id = $1`,
        [f.identityId, target!.id],
      );

      const before = await canonicalCounts();
      const report = await publish([item], { apply: true });
      const o = report.outcomes[0]!;
      expect(o.state).toBe("refused");
      if (o.state !== "refused") throw new Error("expected a refusal");
      expect(o.refusal).toBe("approve_match_not_implemented");
      // The target hotel stays: `source_property_reviews.target_hotel_id` now
      // references it, and A05 never deletes a canonical row.
      expect(await canonicalCounts()).toEqual(before);
    });

    it("an unedited prepared pack authorizes nothing", async () => {
      const f = await approvedProperty();
      const c = await client();
      let pack;
      try {
        pack = await buildPublicationPack(c, {
          source: SOURCE,
          environment: "production",
          asOf: AS_OF,
          limit: null,
        });
      } finally {
        await c.end();
      }
      const item = pack.items.find((i) => i.sourcePropertyId === f.sourcePropertyId);
      expect(item).toBeDefined();
      expect(item!.publicationAuthorized).toBe(false);
      expect(item!.authorizedByLabel).toBeNull();
      expect(item!.authorizationNote).toBeNull();

      // `--apply` is a flag, not a person.
      expect(() => validatePublicationItem(item as unknown as PublicationItem)).toThrow(
        /publication_not_authorized|not publication-authorized/,
      );
    });

    it("a missing authorization note is refused before the database is opened", async () => {
      const f = await approvedProperty();
      const item = await publicationItem(f, { authorizationNote: "   " });
      expect(() => validatePublicationItem(item)).toThrow(PublicationRefusal);
      try {
        validatePublicationItem(item);
        throw new Error("expected a refusal");
      } catch (error) {
        expect((error as PublicationRefusal).refusal).toBe("publication_authorization_incomplete");
      }
      const before = await canonicalCounts();
      await expect(publish([item], { apply: true })).rejects.toThrow(
        /publication_authorization_incomplete|no authorization note/,
      );
      expect(await canonicalCounts()).toEqual(before);
    });
  });

  // =====================================================================
  describe("concurrency", () => {
    it("23. a concurrent revocation means the publication cannot commit", async () => {
      const f = await approvedProperty();
      const item = await publicationItem(f);
      const before = await canonicalCounts();

      // The publication holds the identity lock and is about to take the
      // projection lock. The revocation takes the projection lock first.
      const pubClient = await client();
      const paused = startPausedPublication(pubClient, [item], /for update of rv/, { apply: true });
      await paused.reached;

      await revoke(f);
      paused.release();

      const result = await paused.settled;
      await paused.end();

      // TWO correct outcomes, and the test accepts either because both are the
      // brake working. The projection row was updated by the revocation after
      // this transaction's snapshot, so `for update of rv` may raise 40001 —
      // surfaced as a refusal, never retried. If it does not, the publication
      // reads the withdrawn approval and refuses on its own evidence.
      if (result.ok) {
        const o = result.report.outcomes[0]!;
        expect(o.state).toBe("refused");
        if (o.state !== "refused") throw new Error("expected a refusal");
        expect(o.refusal).toBe("human_review_revoked");
      } else {
        expect(String(result.error)).toMatch(
          /publication_evidence_changed_concurrently|concurrent transaction/,
        );
      }

      // The invariant either way: the withdrawal won, and nothing was published.
      expect(await canonicalCounts()).toEqual(before);
      expect((await identityRow(f.identityId)).resolution_state).toBe("unresolved");
    });

    it("24. evidence drift between prepare and apply is refused, with zero writes", async () => {
      const f = await approvedProperty();
      const item = await publicationItem(f);
      const before = await canonicalCounts();

      // Entity evidence drifts without the observation, the review or any
      // resolution moving: a machine discovers a pending candidate pair. D062
      // condition 11 stops passing, so the authorized verdict no longer holds.
      const other = await readyProperty();
      // 0030 gives a source-to-source pair ONE canonical orientation, so the
      // endpoints are ordered here rather than assumed.
      const [left, right] =
        f.identityId < other.identityId
          ? [f.identityId, other.identityId]
          : [other.identityId, f.identityId];
      await adminQuery(
        `insert into public.source_match_candidates
           (source_property_identity_id, candidate_source_property_identity_id, source,
            source_environment, candidate_kind, match_method, status)
         values ($1,$2,$3,'production','source_identity','blocking:exact_phone','pending')`,
        [left, right, SOURCE],
      );
      try {
        expect((await preview(f.sourcePropertyId, "production")).overall).not.toBe("PASS");

        const report = await publish([item], { apply: true });
        const o = report.outcomes[0]!;
        expect(o.state).toBe("refused");
        if (o.state !== "refused") throw new Error("expected a refusal");
        // Both are correct diagnoses of the same drift; the invariant under test
        // is that a prepared fingerprint is a PIN and never cached authorization.
        expect(["d062_not_pass", "stale_preview_fingerprint"]).toContain(o.refusal);
        expect(await canonicalCounts()).toEqual(before);
      } finally {
        // A leftover pending pair would hold condition 11 for the whole corpus.
        await adminQuery(
          `delete from public.source_match_candidates
            where source_property_identity_id = $1 and candidate_source_property_identity_id = $2`,
          [left, right],
        );
      }
    });

    it("25. a serialization failure is a refusal and is NEVER retried", async () => {
      const f = await approvedProperty();
      const item = await publicationItem(f);
      const before = await canonicalCounts();

      const c = await client();
      let commits = 0;
      const proxy = {
        query: async (...args: unknown[]) => {
          const first = args[0];
          const sql =
            typeof first === "string" ? first : ((first as { text?: string })?.text ?? "");
          if (sql.trim() === "commit") {
            commits += 1;
            throw Object.assign(new Error("could not serialize access"), { code: "40001" });
          }
          return (c.query as (...x: unknown[]) => Promise<unknown>)(...args);
        },
      } as unknown as Client;

      await expect(
        applyPublicationManifest(proxy, [item], {
          source: SOURCE,
          environment: "production",
          asOf: AS_OF,
          apply: true,
        }),
      ).rejects.toThrow(
        /publication_evidence_changed_concurrently|changed by a concurrent transaction/,
      );
      await c.end();

      // Retrying would re-run a human's irreversible authorization against a
      // snapshot the human never saw.
      expect(commits).toBe(1);
      expect(await canonicalCounts()).toEqual(before);
      expect((await identityRow(f.identityId)).resolution_state).toBe("unresolved");
    });
  });

  // =====================================================================
  describe("atomicity and idempotency", () => {
    it("26. a failure mid-transaction rolls back hotel, link, receipt AND state", async () => {
      const good = await approvedProperty();
      const bad = await approvedProperty();
      const before = await canonicalCounts();

      // A `publicationAuthorizedByUserId` naming nobody is a real operator
      // mistake, and `users(id)` is the authority on whether a user exists. The
      // FK fires on the SECOND item's link insert — after the FIRST item has
      // already written its hotel, link, receipt and terminal state.
      const items = [
        await publicationItem(good),
        await publicationItem(bad, {
          authorizedByUserId: "00000000-0000-4000-8000-0000000000ff",
        }),
      ];
      await expect(publish(items, { apply: true })).rejects.toThrow(
        /violates foreign key constraint/i,
      );

      expect(await canonicalCounts()).toEqual(before);
      expect((await identityRow(good.identityId)).resolution_state).toBe("unresolved");
      expect((await identityRow(good.identityId)).promoted_hotel_id).toBeNull();
      expect((await identityRow(bad.identityId)).resolution_state).toBe("unresolved");
    });

    it("27. an EXACT replay is `already_published` with the same three ids", async () => {
      const f = await approvedProperty();
      const item = await publicationItem(f);
      const first = await publish([item], { apply: true });
      const a = first.outcomes[0]!;
      if (a.state === "refused") throw new Error(a.detail);
      const after = await canonicalCounts();

      const second = await publish([item], { apply: true });
      const b = second.outcomes[0]!;
      expect(b.state).toBe("already_published");
      if (b.state === "refused") throw new Error(b.detail);
      expect(b.hotelId).toBe(a.hotelId);
      expect(b.hotelSourceIdentityId).toBe(a.hotelSourceIdentityId);
      expect(b.publicationReceiptId).toBe(a.publicationReceiptId);
      expect(second.canonicalWrites).toEqual({
        hotels: 0,
        hotelSourceIdentities: 0,
        publicationReceipts: 0,
      });
      expect(await canonicalCounts()).toEqual(after);
    });

    it("28. a materially DIFFERENT replay is refused, never a second hotel", async () => {
      const f = await approvedProperty();
      const item = await publicationItem(f);
      const first = await publish([item], { apply: true });
      if (first.outcomes[0]!.state === "refused") throw new Error("expected a publication");
      const after = await canonicalCounts();

      const different = await publicationItem(f, {
        authorizationNote: "A different human said something different.",
      });
      expect(publicationDigestOf(different)).not.toBe(publicationDigestOf(item));

      const second = await publish([different], { apply: true });
      const o = second.outcomes[0]!;
      expect(o.state).toBe("refused");
      if (o.state !== "refused") throw new Error("expected a refusal");
      expect(o.refusal).toBe("conflicting_publication_exists");
      expect(await canonicalCounts()).toEqual(after);
    });

    it("the digest ignores the clock but not the authorization", async () => {
      const f = await approvedProperty();
      const item = await publicationItem(f);
      expect(publicationDigestOf(item)).toBe(publicationDigestOf({ ...item }));
      expect(publicationDigestOf({ ...item, authorizedByLabel: "someone else" })).not.toBe(
        publicationDigestOf(item),
      );
    });

    it("the DATABASE refuses a second publication receipt for one identity", async () => {
      const f = await approvedProperty();
      const report = await publish([await publicationItem(f)], { apply: true });
      const o = report.outcomes[0]!;
      if (o.state === "refused") throw new Error(o.detail);
      const [receipt] = await adminQuery<Record<string, unknown>>(
        "select * from public.source_property_publication_receipts where id = $1",
        [o.publicationReceiptId],
      );
      await expect(
        adminQuery(
          `insert into public.source_property_publication_receipts
             (source_property_identity_id, source, source_environment, source_property_id, hotel_id,
              evidence_observation_id, human_review_receipt_id, human_new_property_finding_id,
              star_revision_id, location_revision_id, scope_revision_id, preview_as_of,
              preview_schema_version, preview_fingerprint, publication_authorized_by_label,
              authorization_note, authorized_at, publication_digest)
           values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16, now(), $17)`,
          [
            receipt!.source_property_identity_id,
            receipt!.source,
            receipt!.source_environment,
            receipt!.source_property_id,
            receipt!.hotel_id,
            receipt!.evidence_observation_id,
            receipt!.human_review_receipt_id,
            receipt!.human_new_property_finding_id,
            receipt!.star_revision_id,
            receipt!.location_revision_id,
            receipt!.scope_revision_id,
            receipt!.preview_as_of,
            receipt!.preview_schema_version,
            receipt!.preview_fingerprint,
            "someone",
            "again",
            receipt!.publication_digest,
          ],
        ),
      ).rejects.toThrow(/identity_uk|hotel_uk|duplicate key/i);
    });
  });

  // =====================================================================
  describe("the receipt is append-only and internal", () => {
    it("30. no role may UPDATE or DELETE a publication receipt", async () => {
      const f = await approvedProperty();
      const report = await publish([await publicationItem(f)], { apply: true });
      const o = report.outcomes[0]!;
      if (o.state === "refused") throw new Error(o.detail);

      await expect(
        adminQuery(
          "update public.source_property_publication_receipts set authorization_note = 'edited' where id = $1",
          [o.publicationReceiptId],
        ),
      ).rejects.toThrow(/APPEND-ONLY/);
      await expect(
        adminQuery("delete from public.source_property_publication_receipts where id = $1", [
          o.publicationReceiptId,
        ]),
      ).rejects.toThrow(/APPEND-ONLY/);

      // …and the grants say the same thing, so the trigger is the second layer
      // rather than the only one.
      const privileges = await adminQuery<{ grantee: string; privilege_type: string }>(
        `select grantee, privilege_type from information_schema.role_table_grants
          where table_schema = 'public' and table_name = 'source_property_publication_receipts'
          order by grantee, privilege_type`,
      );
      const byRole = new Map<string, string[]>();
      for (const p of privileges) {
        if (!byRole.has(p.grantee)) byRole.set(p.grantee, []);
        byRole.get(p.grantee)!.push(p.privilege_type);
      }
      for (const role of ["authenticated", "service_role"]) {
        expect(byRole.get(role)?.sort()).toEqual(["INSERT", "SELECT"]);
      }
      expect(byRole.has("anon")).toBe(false);
    });

    it("29. anon and an ordinary creator read nothing and cannot mutate", async () => {
      const f = await approvedProperty();
      const report = await publish([await publicationItem(f)], { apply: true });
      if (report.outcomes[0]!.state === "refused") throw new Error("expected a publication");

      const anon = await queryAs(
        { role: "anon", sub: null },
        "select id from public.source_property_publication_receipts",
      );
      expect(anon.error).not.toBeNull();

      const creator = await queryAs(
        { role: "authenticated", sub: USERS.pro },
        "select id from public.source_property_publication_receipts",
      );
      expect(creator.error).toBeNull();
      expect(creator.rows).toHaveLength(0);

      const creatorWrite = await queryAs(
        { role: "authenticated", sub: USERS.pro },
        "update public.source_property_publication_receipts set authorization_note = 'x'",
      );
      expect(creatorWrite.error).not.toBeNull();
    });
  });

  // =====================================================================
  describe("publication is identity, not enrichment", () => {
    it("31/32. no hotel_contacts, no outreach and no intelligence rows are written", async () => {
      const f = await approvedProperty();
      const before = await adminQuery<{ contacts: string; events: string; intel: string }>(
        `select (select count(*) from public.hotel_contacts)::text contacts,
                (select count(*) from public.outreach_events)::text events,
                (select count(*) from public.hotel_intelligence)::text intel`,
      );
      const report = await publish([await publicationItem(f)], { apply: true });
      if (report.outcomes[0]!.state === "refused") throw new Error("expected a publication");
      const after = await adminQuery<{ contacts: string; events: string; intel: string }>(
        `select (select count(*) from public.hotel_contacts)::text contacts,
                (select count(*) from public.outreach_events)::text events,
                (select count(*) from public.hotel_intelligence)::text intel`,
      );
      expect(after).toEqual(before);
    });
  });

  // =====================================================================
  describe("the database owns the invariants too", () => {
    it("a receipt cannot exist without the identity being promoted to its hotel", async () => {
      // The deferred constraint trigger fires at COMMIT from BOTH tables, so a
      // later demotion cannot leave a receipt claiming a publication that the
      // database no longer reflects.
      const f = await approvedProperty();
      const report = await publish([await publicationItem(f)], { apply: true });
      const o = report.outcomes[0]!;
      if (o.state === "refused") throw new Error(o.detail);

      await expect(
        adminQuery(
          `update public.source_property_identities
              set resolution_state = 'unresolved', promoted_hotel_id = null
            where id = $1`,
          [f.identityId],
        ),
      ).rejects.toThrow(/publication receipt|resolved_eligible/i);
    });

    it("a receipt cannot claim a hotel whose star the resolution never resolved", async () => {
      const f = await approvedProperty();
      const pins = await pinsFor(f);
      // A hotel that says 3 stars while the cited revision resolved 4. Every
      // composite FK is satisfied — the evidence all belongs to this identity —
      // and the receipt is still refused, because the FKs prove WHICH row is
      // cited and this trigger proves WHAT it says.
      const [hotel] = await adminQuery<{ id: string }>(
        `insert into public.hotels (name, slug, destination_id, star_rating, latitude, longitude, active_status)
         values ($1,$2,$3,3,-8.5,115.26,'unknown') returning id`,
        [`Wrong star ${f.sourcePropertyId}`, `wrong-star-${f.sourcePropertyId}`, f.destinationId],
      );
      await adminQuery(
        `insert into public.hotel_source_identities
           (hotel_id, source_property_identity_id, source, source_environment, source_property_id,
            link_status, match_method)
         values ($1,$2,$3,'production',$4,'active','human_review:d062_approve_create')`,
        [hotel!.id, f.identityId, SOURCE, f.sourcePropertyId],
      );
      await expect(
        adminQuery(
          `insert into public.source_property_publication_receipts
             (source_property_identity_id, source, source_environment, source_property_id, hotel_id,
              evidence_observation_id, human_review_receipt_id, human_new_property_finding_id,
              star_revision_id, location_revision_id, scope_revision_id, preview_as_of,
              preview_schema_version, preview_fingerprint, publication_authorized_by_label,
              authorization_note, authorized_at, publication_digest)
           values ($1,$2,'production',$3,$4,$5,$6,$7,$8,$9,$10,$11::date,$12,$13,$14,$15, now(), $16)`,
          [
            f.identityId,
            SOURCE,
            f.sourcePropertyId,
            hotel!.id,
            f.observationId,
            pins.receiptId,
            pins.findingId,
            pins.starRevisionId,
            pins.locationRevisionId,
            pins.scopeRevisionId,
            AS_OF,
            "d062-prepublication-preview/1",
            "a".repeat(64),
            "someone",
            "because",
            "b".repeat(64),
          ],
        ),
      ).rejects.toThrow(/published star_rating 3 while star revision/);
    });
  });

  // =====================================================================
  describe("write-target safety", () => {
    it("a real --apply refuses a non-remote database, with no override", () => {
      expect(() =>
        resolvePublicationTarget(
          { DATABASE_URL: "postgresql://u:p@localhost:5432/theugc" },
          { apply: true },
        ),
      ).toThrow(/non-remote|persistent/i);
      // TEST_DATABASE_URL is never a fallback for a real publication.
      expect(() =>
        resolvePublicationTarget(
          { TEST_DATABASE_URL: "postgresql://u:p@db.example.com:5432/theugc" },
          { apply: true },
        ),
      ).toThrow(/DATABASE_URL is required/);
      // A dry-run against a disposable database is fine.
      expect(
        resolvePublicationTarget(
          { TEST_DATABASE_URL: "postgresql://u:p@localhost:5432/theugc_test" },
          { apply: false },
        ).classification.hostClass,
      ).toBe("localhost");
    });
  });
});

/**
 * A publication item for an identity that has NO human review. Every pin that
 * depends on the review is filled with a syntactically valid placeholder, so the
 * test exercises the refusal rather than a missing-field crash.
 */
async function publicationItemWithoutReview(f: Fixture): Promise<PublicationItem> {
  const p = await preview(f.sourcePropertyId, f.environment);
  const [heads] = await adminQuery<{
    star_revision_id: string;
    location_revision_id: string;
    scope_revision_id: string;
  }>(
    `select st.id star_revision_id, lo.id location_revision_id, sc.id scope_revision_id
       from public.source_property_current_star_resolutions st
       join public.source_property_current_location_resolutions lo
         on lo.source_property_identity_id = st.source_property_identity_id
       join public.source_property_current_scope_resolutions sc
         on sc.source_property_identity_id = st.source_property_identity_id
      where st.source_property_identity_id = $1`,
    [f.identityId],
  );
  const placeholder = "00000000-0000-4000-8000-000000000001";
  return {
    sourcePropertyIdentityId: f.identityId,
    source: SOURCE,
    sourceEnvironment: f.environment,
    sourcePropertyId: f.sourcePropertyId,
    currentObservationId: f.observationId,
    currentSourceRunId: f.runId,
    sourcePayloadDigest: f.digest,
    asOf: AS_OF,
    previewSchemaVersion: p.schemaVersion,
    previewFingerprint: p.fingerprint,
    humanReviewReceiptId: placeholder,
    reviewProjectionId: placeholder,
    reviewCurrentReceiptId: placeholder,
    humanNewPropertyFindingId: placeholder,
    destinationId: f.destinationId,
    starRevisionId: heads!.star_revision_id,
    locationRevisionId: heads!.location_revision_id,
    scopeRevisionId: heads!.scope_revision_id,
    publicationAuthorized: true,
    authorizedByLabel: AUTHORIZER,
    authorizedByUserId: null,
    authorizationNote: NOTE,
  };
}
