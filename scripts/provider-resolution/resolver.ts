/**
 * Pre-publication star and location resolution.
 *
 * Turns persisted provider OBSERVATIONS into resolved PRODUCT facts, attached to
 * the SOURCE PROPERTY IDENTITY — never to a `hotel_id`, because under D062 a row
 * in `hotels` is publication and a candidate has none until after the gate
 * (`PROPERTY_CONTENT_IMPLEMENTATION_SPEC.md` §21.1).
 *
 * Two things this module refuses to do, both load-bearing:
 *
 *  1. **It never accepts a caller-supplied value.** Every resolution is computed
 *     from a row already in `source_property_observations`, and migration 0028's
 *     triggers independently verify that the persisted resolution restates what
 *     its cited observation says. A string handed in from anywhere else cannot be
 *     blessed, from this module or from psql.
 *  2. **It invents no precedence.** There is no "newest wins", no provider
 *     ranking, no majority vote, no confidence score and no distance tolerance.
 *     The first approved observation resolves the candidate (D066); a later
 *     approved observation that disagrees is recorded as a CONFLICT for review,
 *     never averaged and never silently substituted.
 *
 * Persistence is APPEND-ONLY. A resolution is written as an immutable REVISION
 * and a head pointer is moved to name it. Re-deriving the same conclusion from
 * the same evidence under the same policy produces the same revision digest, so
 * a replay inserts nothing and moves no pointer; new evidence that changes the
 * conclusion mints a NEW revision and leaves the old one exactly as it was.
 */
import type { Client } from "pg";

import {
  classifyProviderCode,
  type ClassificationPolicy,
  type StarEligibility,
} from "../provider-classification/policy";
import { HOTELBEDS_CLASSIFICATION_POLICY } from "../provider-classification/hotelbeds";

/** Reviewed classification policies, by provider. */
export const CLASSIFICATION_POLICIES: Record<string, ClassificationPolicy> = {
  hotelbeds: HOTELBEDS_CLASSIFICATION_POLICY,
};

/**
 * The location policy.
 *
 * Versioned like a classification policy because it is the same kind of object:
 * a reviewed statement of what this provider's field means. Hotelbeds is an
 * APPROVED location source per the source evaluation (99.91% valid in Bali,
 * 100% in Dubai), and the rule is deliberately trivial — coordinates are usable
 * exactly when the provider supplied both and the ingestion audit found them
 * plausible.
 */
export const LOCATION_POLICY_VERSION = "hotelbeds-location/1";

export type StarOutcome = StarEligibility;
export type LocationOutcome = "resolved" | "unresolved";
export type LocationUnresolvedReason = "coordinates_missing" | "coordinates_implausible";

interface ObservationRow {
  id: string;
  source_property_identity_id: string;
  source: string;
  source_environment: string;
  source_classification_code: string | null;
  source_latitude: string | null;
  source_longitude: string | null;
  source_coordinates_plausible: boolean | null;
  observed_at: string;
}

export interface StarResolution {
  identityId: string;
  source: string;
  environment: string;
  evidenceObservationId: string;
  policyProvider: string;
  policyVersion: string;
  policyField: string;
  sourceValue: string | null;
  outcome: StarOutcome;
  resolvedStarValue: 4 | 5 | null;
  conflictObservationId: string | null;
  conflictOutcome: StarOutcome | null;
}

export interface LocationResolution {
  identityId: string;
  source: string;
  environment: string;
  evidenceObservationId: string;
  policyProvider: string;
  policyVersion: string;
  outcome: LocationOutcome;
  latitude: string | null;
  longitude: string | null;
  unresolvedReason: LocationUnresolvedReason | null;
  conflictObservationId: string | null;
}

/**
 * Fold one identity's observations, in observation order, into a star
 * resolution.
 *
 * `unresolved` observations are not competing claims — a provider code we have
 * not reviewed says nothing, so it cannot unset a resolution and cannot create a
 * conflict (D066's `no_change`). What it CAN do is be the cited evidence when
 * nothing else resolved, which is how "we looked at this and the code means
 * nothing to us" stays auditable rather than looking like we never looked.
 */
export function resolveStarFromObservations(
  observations: readonly ObservationRow[],
  policy: ClassificationPolicy,
): StarResolution | null {
  if (observations.length === 0) return null;
  const first = observations[0]!;

  let decided: { obs: ObservationRow; outcome: StarOutcome } | null = null;
  let conflict: { obs: ObservationRow; outcome: StarOutcome } | null = null;

  for (const obs of observations) {
    const outcome = classifyProviderCode(policy, obs.source_classification_code);
    if (outcome === "unresolved") continue;
    if (decided === null) {
      decided = { obs, outcome };
      continue;
    }
    // A disagreement is recorded, not resolved. Only the FIRST one is kept: a
    // candidate is either in conflict or it is not, and enumerating every later
    // disagreement would be a review queue, which this block does not build.
    if (outcome !== decided.outcome && conflict === null) {
      conflict = { obs, outcome };
    }
  }

  if (decided === null) {
    // Nothing resolvable. Cite the most recent observation as what was examined.
    const latest = observations[observations.length - 1]!;
    return {
      identityId: latest.source_property_identity_id,
      source: latest.source,
      environment: latest.source_environment,
      evidenceObservationId: latest.id,
      policyProvider: policy.provider,
      policyVersion: policy.version,
      policyField: policy.field,
      sourceValue: latest.source_classification_code,
      outcome: "unresolved",
      resolvedStarValue: null,
      conflictObservationId: null,
      conflictOutcome: null,
    };
  }

  return {
    identityId: first.source_property_identity_id,
    source: decided.obs.source,
    environment: decided.obs.source_environment,
    evidenceObservationId: decided.obs.id,
    policyProvider: policy.provider,
    policyVersion: policy.version,
    policyField: policy.field,
    sourceValue: decided.obs.source_classification_code,
    outcome: decided.outcome,
    resolvedStarValue:
      decided.outcome === "exact_four" ? 4 : decided.outcome === "exact_five" ? 5 : null,
    conflictObservationId: conflict?.obs.id ?? null,
    conflictOutcome: conflict?.outcome ?? null,
  };
}

/**
 * Fold one identity's observations into a location resolution.
 *
 * Two coordinates that differ AT ALL are a conflict. That is deliberate: any
 * tolerance would be a distance threshold, and D063 §12.2 refuses to invent one.
 * A provider correcting its own coordinates between runs is a real change and a
 * human should see it.
 */
export function resolveLocationFromObservations(
  observations: readonly ObservationRow[],
): LocationResolution | null {
  if (observations.length === 0) return null;

  let decided: ObservationRow | null = null;
  let conflict: ObservationRow | null = null;

  for (const obs of observations) {
    const usable =
      obs.source_latitude !== null &&
      obs.source_longitude !== null &&
      obs.source_coordinates_plausible === true;
    if (!usable) continue;
    if (decided === null) {
      decided = obs;
      continue;
    }
    if (
      (obs.source_latitude !== decided.source_latitude ||
        obs.source_longitude !== decided.source_longitude) &&
      conflict === null
    ) {
      conflict = obs;
    }
  }

  if (decided === null) {
    const latest = observations[observations.length - 1]!;
    // "Not supplied" and "supplied but implausible" are different facts about
    // the provider and are recorded as such.
    const reason: LocationUnresolvedReason =
      latest.source_latitude === null || latest.source_longitude === null
        ? "coordinates_missing"
        : "coordinates_implausible";
    return {
      identityId: latest.source_property_identity_id,
      source: latest.source,
      environment: latest.source_environment,
      evidenceObservationId: latest.id,
      policyProvider: latest.source,
      policyVersion: LOCATION_POLICY_VERSION,
      outcome: "unresolved",
      latitude: null,
      longitude: null,
      unresolvedReason: reason,
      conflictObservationId: null,
    };
  }

  return {
    identityId: decided.source_property_identity_id,
    source: decided.source,
    environment: decided.source_environment,
    evidenceObservationId: decided.id,
    policyProvider: decided.source,
    policyVersion: LOCATION_POLICY_VERSION,
    outcome: "resolved",
    // Verbatim. 0028's trigger independently checks this against the evidence.
    latitude: decided.source_latitude,
    longitude: decided.source_longitude,
    unresolvedReason: null,
    conflictObservationId: conflict?.id ?? null,
  };
}

export interface ResolutionCounts {
  identities: number;
  star: Record<StarOutcome, number>;
  starConflicts: number;
  location: { resolved: number; coordinates_missing: number; coordinates_implausible: number };
  locationConflicts: number;
  /** Revisions actually APPENDED by this run. A replay must add none. */
  revisionsCreated: { star: number; location: number };
  /** Head pointers actually MOVED by this run. A replay must move none. */
  pointerMoves: { star: number; location: number };
}

function emptyCounts(): ResolutionCounts {
  return {
    identities: 0,
    star: { exact_four: 0, exact_five: 0, classified_not_v1_scope: 0, unresolved: 0 },
    starConflicts: 0,
    location: { resolved: 0, coordinates_missing: 0, coordinates_implausible: 0 },
    locationConflicts: 0,
    revisionsCreated: { star: 0, location: 0 },
    pointerMoves: { star: 0, location: 0 },
  };
}

/** Load every observation for one destination's identities, grouped by identity. */
async function loadObservations(
  client: Client,
  opts: { source: string; environment: string; destinationId: string | null },
): Promise<Map<string, ObservationRow[]>> {
  const params: unknown[] = [opts.source, opts.environment];
  let destinationFilter = "";
  if (opts.destinationId) {
    params.push(opts.destinationId);
    destinationFilter = " and r.destination_id = $3";
  }
  const res = await client.query<ObservationRow>(
    `select o.id, o.source_property_identity_id, o.source, o.source_environment,
            o.source_classification_code, o.source_latitude::text as source_latitude,
            o.source_longitude::text as source_longitude, o.source_coordinates_plausible,
            o.observed_at
       from public.source_property_observations o
       join public.source_runs r on r.id = o.source_run_id
      where o.source = $1 and o.source_environment = $2${destinationFilter}
      order by o.source_property_identity_id, o.observed_at, o.id`,
    params,
  );
  const grouped = new Map<string, ObservationRow[]>();
  for (const row of res.rows) {
    const list = grouped.get(row.source_property_identity_id) ?? [];
    list.push(row);
    grouped.set(row.source_property_identity_id, list);
  }
  return grouped;
}

/**
 * The semantic columns of a star revision, in digest order.
 *
 * They are listed once and used twice: to INSERT, and — when the insert hits the
 * digest unique constraint because this exact conclusion is already on record —
 * to find the revision that already says it. `is not distinct from` rather than
 * `=` so a NULL source value or a null star value matches itself.
 */
const STAR_SEMANTIC_COLUMNS = [
  "evidence_observation_id",
  "policy_provider",
  "policy_version",
  "policy_field",
  "source_value",
  "outcome",
  "resolved_star_value",
  "conflict_state",
  "conflicting_observation_id",
  "conflicting_outcome",
] as const;

const LOCATION_SEMANTIC_COLUMNS = [
  "evidence_observation_id",
  "policy_provider",
  "policy_version",
  "outcome",
  "resolved_latitude",
  "resolved_longitude",
  "unresolved_reason",
  "conflict_state",
  "conflicting_observation_id",
] as const;

interface AppendResult {
  revisionCreated: boolean;
  pointerMoved: boolean;
}

/**
 * Every current head pointer for one dimension, read once per run.
 *
 * A candidate is resolved once per run, so a head read at the start cannot go
 * stale before it is used, and this keeps the per-candidate work to the writes
 * themselves rather than a lookup each time.
 */
async function loadHeads(client: Client, headTable: string): Promise<Map<string, string>> {
  const res = await client.query<{
    source_property_identity_id: string;
    current_revision_id: string;
  }>(`select source_property_identity_id, current_revision_id from ${headTable}`);
  return new Map(res.rows.map((r) => [r.source_property_identity_id, r.current_revision_id]));
}

/**
 * Append one revision and point the head at it.
 *
 * Three statements, and each one is a decision:
 *
 *  1. INSERT the revision, recording the head it supersedes. `on conflict ... do
 *     nothing` — never `do update`, which would be a rewrite of an immutable row
 *     and is refused by the table's own trigger anyway.
 *  2. If the insert added nothing, this exact conclusion from this exact evidence
 *     is already recorded; find it. This is the idempotent path: same evidence,
 *     same policy, zero new rows.
 *  3. Move the head — but only `where` it would actually change. A no-op replay
 *     must not even bump `updated_at`, or "nothing happened" and "we rewrote
 *     everything identically" would be indistinguishable in the table.
 */
async function appendRevision(
  client: Client,
  spec: {
    revisionTable: string;
    headTable: string;
    identityColumns: readonly string[];
    semanticColumns: readonly string[];
    identityValues: readonly unknown[];
    semanticValues: readonly unknown[];
    supersedesRevisionId: string | null;
  },
): Promise<AppendResult> {
  const { revisionTable, headTable, identityColumns, semanticColumns } = spec;
  const identityId = spec.identityValues[0] as string;
  const values = [...spec.identityValues, ...spec.semanticValues, spec.supersedesRevisionId];
  const placeholders = values.map((_, i) => `$${i + 1}`);

  const inserted = await client.query<{ id: string }>(
    `insert into ${revisionTable}
       (${[...identityColumns, ...semanticColumns].join(", ")}, supersedes_revision_id)
     values (${placeholders.join(", ")})
     on conflict (source_property_identity_id, revision_digest) do nothing
     returning id`,
    values,
  );

  let revisionId = inserted.rows[0]?.id ?? null;
  const revisionCreated = revisionId !== null;

  if (revisionId === null) {
    const semanticParams = spec.semanticValues.map((_, i) => `$${i + 2}`);
    const existing = await client.query<{ id: string }>(
      `select id from ${revisionTable}
        where source_property_identity_id = $1
          and ${semanticColumns.map((c, i) => `${c} is not distinct from ${semanticParams[i]}`).join(" and ")}
        limit 1`,
      [identityId, ...spec.semanticValues],
    );
    revisionId = existing.rows[0]?.id ?? null;
    if (revisionId === null) {
      throw new Error(
        `${revisionTable}: the digest for candidate ${identityId} already exists but no revision ` +
          "matches its semantic columns. That should be impossible and means the digest and the " +
          "columns it is derived from have diverged.",
      );
    }
  }

  const moved = await client.query(
    `insert into ${headTable} (source_property_identity_id, current_revision_id)
     values ($1, $2)
     on conflict (source_property_identity_id) do update
       set current_revision_id = excluded.current_revision_id
     where ${headTable}.current_revision_id is distinct from excluded.current_revision_id
     returning source_property_identity_id`,
    [identityId, revisionId],
  );

  return { revisionCreated, pointerMoved: (moved.rowCount ?? 0) > 0 };
}

/**
 * Resolve every candidate for one provider/environment/destination.
 *
 * Idempotent by CONCLUSION, not by row count: replaying identical evidence under
 * an identical policy re-derives the same revision digest, so nothing is appended
 * and no head pointer moves.
 */
export async function resolveDestination(
  client: Client,
  opts: {
    source: string;
    environment: string;
    destinationId: string | null;
    apply: boolean;
  },
): Promise<ResolutionCounts> {
  const policy = CLASSIFICATION_POLICIES[opts.source];
  if (!policy) {
    throw new Error(
      `No reviewed classification policy for provider '${opts.source}'. A provider without an ` +
        "approved policy resolves nothing — see docs/PROPERTY_SOURCE_CLASSIFICATION_POLICY.md §6.",
    );
  }

  const grouped = await loadObservations(client, opts);
  const counts = emptyCounts();
  const stars: StarResolution[] = [];
  const locations: LocationResolution[] = [];

  for (const observations of grouped.values()) {
    counts.identities += 1;

    const star = resolveStarFromObservations(observations, policy);
    if (star) {
      counts.star[star.outcome] += 1;
      if (star.conflictObservationId) counts.starConflicts += 1;
      stars.push(star);
    }

    const location = resolveLocationFromObservations(observations);
    if (location) {
      if (location.outcome === "resolved") counts.location.resolved += 1;
      else counts.location[location.unresolvedReason!] += 1;
      if (location.conflictObservationId) counts.locationConflicts += 1;
      locations.push(location);
    }
  }

  if (!opts.apply) return counts;

  await client.query("begin");
  try {
    const starHeads = await loadHeads(client, "public.source_property_star_resolutions");
    const locationHeads = await loadHeads(client, "public.source_property_location_resolutions");

    for (const s of stars) {
      const result = await appendRevision(client, {
        revisionTable: "public.source_property_star_resolution_revisions",
        headTable: "public.source_property_star_resolutions",
        identityColumns: ["source_property_identity_id", "source", "source_environment"],
        semanticColumns: STAR_SEMANTIC_COLUMNS,
        identityValues: [s.identityId, s.source, s.environment],
        semanticValues: [
          s.evidenceObservationId,
          s.policyProvider,
          s.policyVersion,
          s.policyField,
          s.sourceValue,
          s.outcome,
          s.resolvedStarValue,
          s.conflictObservationId ? "conflict" : "none",
          s.conflictObservationId,
          s.conflictOutcome,
        ],
        supersedesRevisionId: starHeads.get(s.identityId) ?? null,
      });
      if (result.revisionCreated) counts.revisionsCreated.star += 1;
      if (result.pointerMoved) counts.pointerMoves.star += 1;
    }

    for (const l of locations) {
      const result = await appendRevision(client, {
        revisionTable: "public.source_property_location_resolution_revisions",
        headTable: "public.source_property_location_resolutions",
        identityColumns: ["source_property_identity_id", "source", "source_environment"],
        semanticColumns: LOCATION_SEMANTIC_COLUMNS,
        identityValues: [l.identityId, l.source, l.environment],
        semanticValues: [
          l.evidenceObservationId,
          l.policyProvider,
          l.policyVersion,
          l.outcome,
          l.latitude,
          l.longitude,
          l.unresolvedReason,
          l.conflictObservationId ? "conflict" : "none",
          l.conflictObservationId,
        ],
        supersedesRevisionId: locationHeads.get(l.identityId) ?? null,
      });
      if (result.revisionCreated) counts.revisionsCreated.location += 1;
      if (result.pointerMoved) counts.pointerMoves.location += 1;
    }

    await client.query("commit");
  } catch (err) {
    await client.query("rollback").catch(() => {
      /* the original error is the one worth reporting */
    });
    throw err;
  }

  return counts;
}
