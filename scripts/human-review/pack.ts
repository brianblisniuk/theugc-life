/**
 * READ-ONLY review-pack generator.
 *
 * Produces everything a human needs to decide "is this a distinct property, and
 * does it belong to this supported canonical destination?" without opening a
 * database client — and nothing they do not need. No raw provider payloads, no
 * credentials.
 *
 * The pack PINS the evidence it was built from. Apply refuses when any pin has
 * moved, so a decision prepared against observation A can never silently attach
 * to observation B.
 */
import type { Client } from "pg";

import {
  composeAllPreviewResultsInCallerTransaction,
  inPreviewSnapshot,
} from "../prepublication-preview/preview";
import { partitionByReadiness } from "./readiness";
import type { PreviewResult } from "../prepublication-preview/evaluate";

export const PACK_FORMAT_VERSION = "a04-5-human-review-pack/1" as const;

/** The six dimensions a reviewer must record a state for. */
export const REVIEW_DIMENSIONS = [
  "distinct_property",
  "name",
  "city_locality",
  "address",
  "coordinates",
  "destination_membership",
] as const;
export type ReviewDimension = (typeof REVIEW_DIMENSIONS)[number];

export const REVIEW_VERDICTS = ["supports", "contradicts", "unavailable"] as const;
export type ReviewVerdict = (typeof REVIEW_VERDICTS)[number];

export const EVIDENCE_REFERENCE_KINDS = [
  "official_property_site",
  "official_brand_page",
  "official_address_page",
  "map_place_source",
  "other_public_authoritative",
] as const;

export interface ReviewPackItem {
  /** ---- PINNED EVIDENCE. Apply refuses if any of these has moved. ---- */
  identityId: string;
  sourcePropertyId: string;
  source: string;
  environment: string;
  currentObservationId: string;
  currentSourceRunId: string;
  sourcePayloadDigest: string;
  prereviewFingerprint: string;
  prereviewAsOf: string;

  /** ---- WHAT THE PROVIDER SAYS. Context, never a decision. ---- */
  providerName: string | null;
  providerDestinationCode: string | null;
  providerZoneCode: string | null;
  sourceCity: string | null;
  sourceAddress: string | null;
  sourcePostalCode: string | null;
  sourceLatitude: string | null;
  sourceLongitude: string | null;
  sourceWebsiteUrl: string | null;

  /** ---- WHAT THE MACHINE LAYERS RESOLVED, with their provenance. ---- */
  starOutcome: string | null;
  starValue: number | null;
  starRevisionId: string | null;
  scopeOutcome: string | null;
  scopeRevisionId: string | null;
  locationOutcome: string | null;
  locationRevisionId: string | null;
  lifecycleOutcome: string;
  entityAnomalyReasons: string[];
  entityPendingCandidateIds: string[];
  entityAcceptedCandidateIds: string[];

  /** Conditions 3/4/6/7/8/9/10/11 as the real evaluator reported them. */
  nonReviewConditions: Array<{ number: number; name: string; status: string; reason: string }>;

  /** ---- EMPTY. A human fills these in; this generator never does. ---- */
  humanDecision: null;
  canonicalDestinationSlug: null;
  verifications: Record<ReviewDimension, null>;
  evidenceReferences: never[];
  humanNote: null;
}

export interface ReviewPack {
  formatVersion: typeof PACK_FORMAT_VERSION;
  source: string;
  environment: string;
  asOf: string;
  destinationSlug: string | null;
  preparedFrom: { evaluated: number; ready: number };
  items: ReviewPackItem[];
}

interface ProviderRow {
  identity_id: string;
  source_property_id: string;
  observation_id: string;
  source_run_id: string;
  source_payload_digest: string;
  source_name: string | null;
  source_destination_code: string | null;
  source_zone_code: string | null;
  source_city: string | null;
  source_address: string | null;
  source_postal_code: string | null;
  source_latitude: string | null;
  source_longitude: string | null;
  source_website_url: string | null;
  destination_slug: string | null;
}

const evidenceOf = (r: PreviewResult, n: number) =>
  r.conditions.find((c) => c.number === n)?.evidence;
const str = (v: unknown): string | null => (typeof v === "string" ? v : null);

export async function buildReviewPack(
  client: Client,
  args: {
    source: string;
    environment: "evaluation" | "production";
    asOf: string;
    destinationSlug: string | null;
    limit: number;
    /** Provider ids that must appear if they are genuinely ready. Never approved. */
    require?: readonly string[];
  },
): Promise<ReviewPack> {
  // ONE read-only snapshot for BOTH halves of the pack. The pins (observation,
  // run, payload digest) and the fingerprint they are supposed to describe must
  // come from the same instant, or the pack could pin observation B while
  // carrying the fingerprint of observation A — and apply would accept it,
  // because every individual check would pass.
  return inPreviewSnapshot(client, async () => {
    const population = partitionByReadiness(
      await composeAllPreviewResultsInCallerTransaction(client, args),
    );

    const provider = await client.query<ProviderRow>(
      `select i.id identity_id, i.source_property_id, o.id observation_id,
            o.source_run_id, o.source_payload_digest, o.source_name,
            o.source_destination_code, o.source_zone_code, o.source_city, o.source_address,
            o.source_postal_code, o.source_latitude::text, o.source_longitude::text,
            o.source_website_url, d.slug destination_slug
       from public.source_property_identities i
       join public.source_property_observations o
         on o.source_property_identity_id = i.id and o.source_run_id = i.last_seen_run_id
       join public.source_runs r on r.id = o.source_run_id
       left join public.destinations d on d.id = r.destination_id
      where i.source = $1 and i.source_environment = $2`,
      [args.source, args.environment],
    );
    const byIdentity = new Map(provider.rows.map((r) => [r.identity_id, r]));

    const candidates = population.ready
      .map((result) => ({ result, provider: byIdentity.get(result.identityId) }))
      .filter((x): x is { result: PreviewResult; provider: ProviderRow } => Boolean(x.provider))
      .filter((x) => !args.destinationSlug || x.provider.destination_slug === args.destinationSlug);

    // DETERMINISTIC selection. Required adversarial ids first (only if they really
    // are ready — membership is verified, never assumed), then ascending provider
    // id. Never "the easy ones".
    const required = new Set(args.require ?? []);
    const sorted = [...candidates].sort((a, b) => {
      const ar = required.has(a.provider.source_property_id) ? 0 : 1;
      const br = required.has(b.provider.source_property_id) ? 0 : 1;
      if (ar !== br) return ar - br;
      return a.provider.source_property_id < b.provider.source_property_id
        ? -1
        : a.provider.source_property_id > b.provider.source_property_id
          ? 1
          : 0;
    });

    const items = sorted
      .slice(0, args.limit)
      .map(({ result, provider: p }) => toItem(result, p, args.asOf));
    return {
      formatVersion: PACK_FORMAT_VERSION,
      source: args.source,
      environment: args.environment,
      asOf: args.asOf,
      destinationSlug: args.destinationSlug,
      preparedFrom: { evaluated: population.evaluated, ready: population.ready.length },
      items,
    };
  });
}

function toItem(result: PreviewResult, p: ProviderRow, asOf: string): ReviewPackItem {
  const star = evidenceOf(result, 6) ?? {};
  const scope = evidenceOf(result, 3) ?? {};
  const location = evidenceOf(result, 8) ?? {};
  const locationFull = evidenceOf(result, 10) ?? {};
  const lifecycle = evidenceOf(result, 4) ?? {};
  const entity = evidenceOf(result, 11) ?? {};

  const accepted = Array.isArray(entity.acceptedCandidates)
    ? (entity.acceptedCandidates as Array<{ id?: unknown }>)
    : [];

  return {
    identityId: result.identityId,
    sourcePropertyId: p.source_property_id,
    source: result.source,
    environment: result.environment,
    currentObservationId: p.observation_id,
    currentSourceRunId: p.source_run_id,
    sourcePayloadDigest: p.source_payload_digest,
    prereviewFingerprint: result.fingerprint,
    prereviewAsOf: asOf,

    providerName: p.source_name,
    providerDestinationCode: p.source_destination_code,
    providerZoneCode: p.source_zone_code,
    sourceCity: p.source_city,
    sourceAddress: p.source_address,
    sourcePostalCode: p.source_postal_code,
    sourceLatitude: p.source_latitude,
    sourceLongitude: p.source_longitude,
    sourceWebsiteUrl: p.source_website_url,

    starOutcome: str(star.outcome),
    starValue: typeof star.resolvedStarValue === "number" ? star.resolvedStarValue : null,
    starRevisionId: str(star.revisionId),
    scopeOutcome: str(scope.outcome),
    scopeRevisionId: str(scope.revisionId),
    locationOutcome: str(location.outcome) ?? str(locationFull.outcome),
    locationRevisionId: str(location.revisionId) ?? str(locationFull.revisionId),
    lifecycleOutcome: str(lifecycle.outcome) ?? "unknown",
    entityAnomalyReasons: Array.isArray(entity.currentAnomalyReasons)
      ? (entity.currentAnomalyReasons as string[])
      : [],
    entityPendingCandidateIds: Array.isArray(entity.pendingCandidateIds)
      ? (entity.pendingCandidateIds as string[])
      : [],
    entityAcceptedCandidateIds: accepted.map((c) => String(c.id ?? "")),

    nonReviewConditions: result.conditions
      .filter((c) => ![1, 2, 5].includes(c.number))
      .map((c) => ({ number: c.number, name: c.name, status: c.status, reason: c.reason })),

    humanDecision: null,
    canonicalDestinationSlug: null,
    verifications: Object.fromEntries(REVIEW_DIMENSIONS.map((d) => [d, null])) as Record<
      ReviewDimension,
      null
    >,
    evidenceReferences: [],
    humanNote: null,
  };
}
