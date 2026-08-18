import { createHash } from "node:crypto";

import { evaluateLifecycle, type IssueSnapshot, type LifecyclePolicy } from "../lifecycle/policy";

export type PreviewStatus = "PASS" | "FAIL" | "UNRESOLVED";

type EvidenceValue = boolean | number | string | null | EvidenceRef | EvidenceValue[];
export interface EvidenceRef {
  [key: string]: EvidenceValue;
}

export interface ConditionResult {
  number: number;
  name: string;
  status: PreviewStatus;
  reason: string;
  explanation: string;
  evidence: EvidenceRef;
  asOf: string | null;
}

export interface PreviewInput {
  identity: {
    id: string;
    source: string;
    environment: string;
    currentObservationId: string | null;
  };
  review: null | {
    id: string;
    decision: "approve_create" | "approve_match" | "reject" | "defer";
    destinationId: string | null;
    targetHotelId: string | null;
    decidedInRunId: string | null;
    reviewerUserId: string | null;
    reviewerLabel: string;
    reviewedAt: string;
    reviewNote: string | null;
  };
  destination: null | { id: string; slug: string };
  entity: {
    synchronized: boolean;
    acceptedCandidates: CandidateEvidence[];
    pendingCandidateIds: string[];
    currentAnomalyReasons: string[];
  };
  scope: null | {
    revisionId: string;
    observationId: string;
    outcome: "physical_hospitality" | "not_physical_hospitality" | "unresolved";
    policyProvider: string;
    policyVersion: string;
    sourceValue: string | null;
  };
  star: null | {
    revisionId: string;
    observationId: string;
    outcome: "exact_four" | "exact_five" | "classified_not_v1_scope" | "unresolved";
    resolvedStarValue: number | null;
    conflictState: "none" | "conflict";
    policyProvider: string;
    policyVersion: string;
    sourceValue: string | null;
  };
  location: null | {
    revisionId: string;
    observationId: string;
    outcome: "resolved" | "unresolved";
    latitude: string | null;
    longitude: string | null;
    conflictState: "none" | "conflict";
    unresolvedReason: string | null;
    policyProvider: string;
    policyVersion: string;
  };
  lifecycle: { snapshot: IssueSnapshot | null; policy: LifecyclePolicy };
}

export interface CandidateEvidence extends EvidenceRef {
  id: string;
  kind: "canonical_hotel" | "source_identity" | "new_property";
  status: string;
  candidateHotelId: string | null;
  candidateSourcePropertyIdentityId: string | null;
  sourceRunId: string | null;
  matchMethod: string;
  nameEvidence: string;
  domainEvidence: string;
  addressEvidence: string;
  phoneEvidence: string;
  brandEvidence: string;
  coordinateDistanceMetres: string | null;
  knownSourceMapping: boolean;
  reviewNote: string | null;
  resolvedAt: string | null;
  supersededReason: string | null;
}

export interface PreviewResult {
  schemaVersion: "d062-prepublication-preview/1";
  identityId: string;
  source: string;
  environment: string;
  asOf: string;
  overall: PreviewStatus;
  conditions: ConditionResult[];
  fingerprintAlgorithm: "sha256";
  fingerprint: string;
  meaning: string;
}

export interface FingerprintPayload {
  fingerprintSchemaVersion: "d062-prepublication-preview-fingerprint/1";
  identity: PreviewInput["identity"];
  asOf: string;
  conditions: Array<
    Pick<ConditionResult, "number" | "name" | "status" | "reason" | "evidence" | "asOf">
  >;
}

const names = [
  "canonical_property_identity_resolved",
  "supported_canonical_destination",
  "physical_hospitality_property",
  "not_blocked_by_property_level_closure",
  "v1_scope_resolved",
  "canonical_star_exactly_four_or_five",
  "star_classification_provenance_exists",
  "canonical_latitude_exists",
  "canonical_longitude_exists",
  "coordinate_location_provenance_exists",
  "no_unresolved_entity_resolution_conflict",
] as const;

function result(
  number: number,
  status: PreviewStatus,
  reason: string,
  explanation: string,
  evidence: EvidenceRef,
  asOf: string | null = null,
): ConditionResult {
  return { number, name: names[number - 1]!, status, reason, explanation, evidence, asOf };
}

function stable(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${JSON.stringify(k)}:${stable(v)}`)
    .join(",")}}`;
}

export function fingerprintSemanticBundle(bundle: object): string {
  return createHash("sha256").update(stable(bundle)).digest("hex");
}

/** Machine-stable semantics only. Human display copy is deliberately excluded. */
export function buildFingerprintPayload(args: {
  identity: PreviewInput["identity"];
  asOf: string;
  conditions: readonly ConditionResult[];
}): FingerprintPayload {
  return {
    fingerprintSchemaVersion: "d062-prepublication-preview-fingerprint/1",
    identity: args.identity,
    asOf: args.asOf,
    conditions: args.conditions.map(({ number, name, status, reason, evidence, asOf }) => ({
      number,
      name,
      status,
      reason,
      evidence,
      asOf,
    })),
  };
}

export function evaluatePreview(input: PreviewInput, asOf: string): PreviewResult {
  const current = input.identity.currentObservationId;
  const currentOk = current !== null;
  const acceptedCandidates = [...input.entity.acceptedCandidates].sort((a, b) =>
    `${a.kind}|${a.candidateHotelId ?? ""}|${a.candidateSourcePropertyIdentityId ?? ""}|${a.id}`.localeCompare(
      `${b.kind}|${b.candidateHotelId ?? ""}|${b.candidateSourcePropertyIdentityId ?? ""}|${b.id}`,
    ),
  );
  const canonicalCandidates = acceptedCandidates.filter((c) => c.kind === "canonical_hotel");
  const newCandidates = acceptedCandidates.filter((c) => c.kind === "new_property");
  const distinctCanonicalTargets = new Set(canonicalCandidates.map((c) => c.candidateHotelId));
  const acceptedContradiction =
    distinctCanonicalTargets.size > 1 ||
    (canonicalCandidates.length > 0 && newCandidates.length > 0);
  const noConflict =
    currentOk &&
    input.entity.synchronized &&
    !acceptedContradiction &&
    input.entity.pendingCandidateIds.length === 0 &&
    input.entity.currentAnomalyReasons.length === 0;
  const entityEvidence: EvidenceRef = {
    synchronized: input.entity.synchronized,
    acceptedCandidates,
    acceptedContradiction,
    pendingCandidateIds: [...input.entity.pendingCandidateIds].sort(),
    currentAnomalyReasons: [...input.entity.currentAnomalyReasons].sort(),
  };
  const reviewEvidence: EvidenceRef = input.review ? { ...input.review } : { review: null };

  let c1: ConditionResult;
  if (!input.review || input.review.decision === "defer")
    c1 = result(
      1,
      "UNRESOLVED",
      "identity_review_missing_or_deferred",
      "An explicit human identity decision is required; no machine finding is treated as NEW.",
      { ...reviewEvidence, ...entityEvidence },
    );
  else if (input.review.decision === "reject")
    c1 = result(
      1,
      "FAIL",
      "identity_rejected",
      "The current human review rejects publication identity resolution.",
      { ...reviewEvidence, ...entityEvidence },
    );
  else if (acceptedContradiction)
    c1 = result(
      1,
      "UNRESOLVED",
      "accepted_entity_evidence_inconsistent",
      "Accepted entity decisions contradict one another and no row order may resolve them.",
      { ...reviewEvidence, ...entityEvidence },
    );
  else if (!noConflict)
    c1 = result(
      1,
      "UNRESOLVED",
      "entity_conflict_or_sync_hold",
      "The identity decision cannot pass while current entity evidence is conflicting or out of sync.",
      { ...reviewEvidence, ...entityEvidence },
    );
  else if (input.review.decision === "approve_create" && newCandidates.length === 1)
    c1 = result(
      1,
      "PASS",
      "reviewed_distinct_property",
      "Human approve_create is supported by an explicit accepted distinct-property finding.",
      { ...reviewEvidence, ...entityEvidence },
    );
  else if (
    input.review.decision === "approve_match" &&
    input.review.targetHotelId &&
    canonicalCandidates.length === 1 &&
    canonicalCandidates[0]!.candidateHotelId === input.review.targetHotelId
  )
    c1 = result(
      1,
      "PASS",
      "reviewed_explicit_canonical_match",
      "Human approve_match names the same canonical target as accepted entity evidence.",
      { ...reviewEvidence, ...entityEvidence },
    );
  else
    c1 = result(
      1,
      "UNRESOLVED",
      "identity_decision_lacks_support",
      "The review is not backed by the required explicit entity-resolution finding.",
      { ...reviewEvidence, ...entityEvidence },
    );

  const c2 =
    input.review?.destinationId && input.destination?.id === input.review.destinationId
      ? result(
          2,
          "PASS",
          "reviewed_destination_supported",
          "The reviewed destination resolves to the canonical destination catalogue.",
          {
            ...reviewEvidence,
            destinationId: input.destination.id,
            destinationSlug: input.destination.slug,
          },
        )
      : result(
          2,
          "UNRESOLVED",
          "reviewed_destination_missing_or_invalid",
          "No valid reviewed canonical destination can be established.",
          {
            ...reviewEvidence,
            reviewedDestinationId: input.review?.destinationId ?? null,
          },
        );

  const scopeCurrent = currentOk && input.scope?.observationId === current;
  const c3 = !scopeCurrent
    ? result(
        3,
        "UNRESOLVED",
        "current_scope_provenance_invalid",
        "The current-run observation has no matching current scope revision.",
        {
          currentObservationId: current,
          scopeRevisionId: input.scope?.revisionId ?? null,
          evidenceObservationId: input.scope?.observationId ?? null,
        },
      )
    : input.scope!.outcome === "physical_hospitality"
      ? result(
          3,
          "PASS",
          "physical_hospitality",
          "The current approved scope resolution is physical hospitality.",
          input.scope as unknown as EvidenceRef,
        )
      : input.scope!.outcome === "not_physical_hospitality"
        ? result(
            3,
            "FAIL",
            "not_physical_hospitality",
            "The current approved scope resolution affirmatively excludes physical hospitality.",
            input.scope as unknown as EvidenceRef,
          )
        : result(
            3,
            "UNRESOLVED",
            "hospitality_scope_unresolved",
            "The current hospitality scope resolution is unresolved.",
            input.scope as unknown as EvidenceRef,
          );

  const lifecycle = evaluateLifecycle({
    snapshot:
      current !== null && input.lifecycle.snapshot?.observationId === current
        ? input.lifecycle.snapshot
        : null,
    policy: input.lifecycle.policy,
    asOf,
    currentObservationId: current,
    hasCurrentObservation: currentOk,
  });
  const c4 =
    lifecycle.outcome === "known_closed"
      ? result(
          4,
          "FAIL",
          "known_property_closed",
          "A HOTEL+CLOSED window covers the explicit as-of date; this is not permanent-closure inference.",
          lifecycle as unknown as EvidenceRef,
          asOf,
        )
      : lifecycle.outcome === "no_known_closure"
        ? result(
            4,
            "PASS",
            "no_known_property_closure",
            "No property-level closure covers this date. This does not mean active, open, or operating.",
            lifecycle as unknown as EvidenceRef,
            asOf,
          )
        : result(
            4,
            "UNRESOLVED",
            "lifecycle_evidence_unresolved",
            "Current lifecycle evidence is insufficient; historical evidence is not substituted.",
            lifecycle as unknown as EvidenceRef,
            asOf,
          );

  const starCurrent =
    currentOk && input.star?.observationId === current && input.star.conflictState === "none";
  const eligibleStar =
    starCurrent && (input.star!.outcome === "exact_four" || input.star!.outcome === "exact_five");
  const c6 = !starCurrent
    ? result(
        6,
        "UNRESOLVED",
        "current_star_resolution_invalid",
        "The current-run observation has no consistent current star resolution.",
        {
          currentObservationId: current,
          starRevisionId: input.star?.revisionId ?? null,
          evidenceObservationId: input.star?.observationId ?? null,
        },
      )
    : eligibleStar
      ? result(
          6,
          "PASS",
          input.star!.outcome,
          "The immutable current star resolution is exactly four or five.",
          input.star as unknown as EvidenceRef,
        )
      : input.star!.outcome === "classified_not_v1_scope"
        ? result(
            6,
            "FAIL",
            "star_classified_outside_v1",
            "The approved classification policy affirmatively places the star class outside V1.",
            input.star as unknown as EvidenceRef,
          )
        : result(
            6,
            "UNRESOLVED",
            "star_classification_unresolved",
            "The star classification is unresolved.",
            input.star as unknown as EvidenceRef,
          );
  const c7 =
    starCurrent && input.star!.revisionId && input.star!.policyProvider && input.star!.policyVersion
      ? result(
          7,
          c6.status === "UNRESOLVED" ? "UNRESOLVED" : "PASS",
          c6.status === "UNRESOLVED" ? "star_result_not_proven" : "exact_star_provenance",
          c6.status === "UNRESOLVED"
            ? "No usable current star result exists to provenance."
            : "The exact current immutable star revision and its observation/policy chain are cited.",
          input.star as unknown as EvidenceRef,
        )
      : result(
          7,
          "UNRESOLVED",
          "star_provenance_missing_or_inconsistent",
          "Exact current star provenance cannot be reconstructed.",
          { currentObservationId: current, revisionId: input.star?.revisionId ?? null },
        );

  const locationCurrent =
    currentOk &&
    input.location?.observationId === current &&
    input.location.conflictState === "none" &&
    input.location.outcome === "resolved";
  const c8 =
    locationCurrent && input.location!.latitude !== null
      ? result(
          8,
          "PASS",
          "canonical_latitude_resolved",
          "Canonical latitude exists in the exact current location revision.",
          input.location as unknown as EvidenceRef,
        )
      : result(
          8,
          "UNRESOLVED",
          "canonical_latitude_unresolved",
          "A usable canonical latitude is not established; none is fabricated.",
          { currentObservationId: current, revisionId: input.location?.revisionId ?? null },
        );
  const c9 =
    locationCurrent && input.location!.longitude !== null
      ? result(
          9,
          "PASS",
          "canonical_longitude_resolved",
          "Canonical longitude exists in the exact current location revision.",
          input.location as unknown as EvidenceRef,
        )
      : result(
          9,
          "UNRESOLVED",
          "canonical_longitude_unresolved",
          "A usable canonical longitude is not established; none is fabricated.",
          { currentObservationId: current, revisionId: input.location?.revisionId ?? null },
        );
  const c10 =
    locationCurrent &&
    input.location!.latitude !== null &&
    input.location!.longitude !== null &&
    input.location!.policyProvider &&
    input.location!.policyVersion
      ? result(
          10,
          "PASS",
          "exact_location_provenance",
          "The exact current immutable location revision and observation/policy chain are cited.",
          input.location as unknown as EvidenceRef,
        )
      : result(
          10,
          "UNRESOLVED",
          "location_provenance_missing_or_inconsistent",
          "Exact current coordinate provenance cannot be reconstructed.",
          { currentObservationId: current, revisionId: input.location?.revisionId ?? null },
        );
  const c11 = noConflict
    ? result(
        11,
        "PASS",
        "no_current_entity_conflict",
        "Synchronized current entity evidence contains no unresolved conflict; superseded history does not block.",
        entityEvidence,
      )
    : result(
        11,
        "UNRESOLVED",
        acceptedContradiction
          ? "accepted_entity_evidence_inconsistent"
          : input.entity.synchronized
            ? "current_entity_conflict"
            : "entity_sync_gate_failed",
        "Current entity evidence is conflicting or cannot safely establish absence of conflict.",
        entityEvidence,
      );

  const critical = [c1, c2, c3, c4, c6, c7, c11];
  const c5 = critical.some((c) => c.status === "FAIL")
    ? result(
        5,
        "FAIL",
        "authoritative_input_outside_v1",
        "At least one authoritative scope-critical input affirmatively places the property outside V1.",
        {
          inputConditions: critical.map((c) => ({
            number: c.number,
            status: c.status,
            reason: c.reason,
          })),
        },
      )
    : critical.some((c) => c.status === "UNRESOLVED")
      ? result(
          5,
          "UNRESOLVED",
          "scope_critical_input_unresolved",
          "At least one scope-critical pre-publication input is unresolved.",
          {
            inputConditions: critical.map((c) => ({
              number: c.number,
              status: c.status,
              reason: c.reason,
            })),
          },
        )
      : result(
          5,
          "PASS",
          "all_scope_critical_inputs_in_scope",
          "All independently evaluated scope-critical inputs resolve in scope.",
          {
            inputConditions: critical.map((c) => ({
              number: c.number,
              status: c.status,
              reason: c.reason,
            })),
          },
        );

  const conditions = [c1, c2, c3, c4, c5, c6, c7, c8, c9, c10, c11];
  const overall: PreviewStatus = conditions.every((c) => c.status === "PASS")
    ? "PASS"
    : conditions.some((c) => c.status === "FAIL")
      ? "FAIL"
      : "UNRESOLVED";
  const fingerprintPayload = buildFingerprintPayload({
    identity: input.identity,
    asOf,
    conditions,
  });
  return {
    schemaVersion: "d062-prepublication-preview/1",
    identityId: input.identity.id,
    source: input.identity.source,
    environment: input.identity.environment,
    overall,
    fingerprintAlgorithm: "sha256",
    asOf,
    conditions,
    fingerprint: fingerprintSemanticBundle(fingerprintPayload),
    meaning:
      "D062 preconditions currently appear satisfied only when PASS; authorization and publication remain separate A05 actions.",
  };
}
