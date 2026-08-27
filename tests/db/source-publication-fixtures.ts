/**
 * Shared A05 publication fixtures.
 *
 * Three suites need the same legitimate state — a PRODUCTION source identity
 * resolved so every non-review D062 condition passes, carried through the REAL
 * A04.5 review path to an 11/11 PASS — and they must build it the SAME way. A
 * second, subtly different fixture builder is how two suites end up proving
 * things about two different systems.
 *
 * Every fixture here is SYNTHETIC. `production` means the provider's
 * `source_environment`, not the database deployment target: these run against a
 * disposable LOCAL PostgreSQL, and the production-only source-environment
 * constraint is never relaxed because of it.
 */
import { Client } from "pg";
import { expect } from "vitest";

import { adminQuery } from "./harness";
import { loadPreviewResults } from "../../scripts/prepublication-preview/preview";
import { applyReviewedManifest, type ReviewedItem } from "../../scripts/human-review/apply";
import { REVIEW_DIMENSIONS, type ReviewVerdict } from "../../scripts/human-review/pack";
import {
  applyRevocationManifest,
  type RevocationItem,
} from "../../scripts/human-review-revocation/revoke";
import {
  applyPublicationManifest,
  type PublicationItem,
} from "../../scripts/source-publication/publish";

export const SOURCE = "hotelbeds";
export const AS_OF = "2026-08-17";
export const POLICY = {
  provider: "hotelbeds",
  star: "hotelbeds-classification/1",
  scope: "hotelbeds-hospitality-scope/1",
  location: "hotelbeds-location/1",
};
export const STAR_CODE = "4EST";
export const SCOPE_CODE = "H";
export const AUTHORIZER = "test-publisher";
export const NOTE = "Authorized for publication after reviewing the D062 evidence.";

export type Environment = "evaluation" | "production";

let counter = 0;
export const uniq = () => `P${Date.now().toString(36)}${(counter += 1)}`;

export interface Fixture {
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

export async function client(): Promise<Client> {
  const c = new Client({ connectionString: process.env.TEST_DATABASE_URL });
  await c.connect();
  return c;
}

export async function destination(
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

export async function newRun(
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

export async function setStar(
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

export async function setScope(
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

export async function setLocation(
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

export async function setCompleteLifecycleSnapshot(
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
export async function readyProperty(opts?: {
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

export async function preview(sourcePropertyId: string, environment: Environment) {
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

export async function applyReview(
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
export async function approvedProperty(
  opts?: Parameters<typeof readyProperty>[0],
  verdicts?: Partial<Record<(typeof REVIEW_DIMENSIONS)[number], ReviewVerdict>>,
): Promise<Fixture> {
  const f = await readyProperty(opts);
  const report = await applyReview(f, {}, verdicts);
  expect(report.outcomes[0]!.state).toBe("applied");
  return f;
}

export interface Pins {
  receiptId: string;
  reviewId: string;
  findingId: string;
  starRevisionId: string;
  locationRevisionId: string;
  scopeRevisionId: string;
}

export async function pinsFor(f: Fixture): Promise<Pins> {
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

export async function publicationItem(
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

export async function publish(
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

export async function canonicalCounts(): Promise<{
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

export async function hotelRow(hotelId: string) {
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

export async function identityRow(identityId: string) {
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
export async function revoke(f: Fixture): Promise<void> {
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
 * A publication item for an identity that has NO human review. Every pin that
 * depends on the review is filled with a syntactically valid placeholder, so a
 * test exercises the refusal rather than a missing-field crash.
 */
export async function publicationItemWithoutReview(f: Fixture): Promise<PublicationItem> {
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
