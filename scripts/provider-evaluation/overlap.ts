/**
 * Cross-source overlap analysis (brief §14).
 *
 * This produces an EVIDENCE MATRIX for a future entity-resolution policy. It
 * does not produce canonical matches and it never touches `hotels`.
 *
 * ## Why there are no default numeric thresholds
 *
 * An earlier version hard-coded "within 150m = close", "beyond 2km =
 * contradiction" and ">= 2 signals = high confidence". Those numbers were chosen
 * with zero live provider data in hand. D063 explicitly defers numeric
 * entity-resolution thresholds until evidence exists, and a number invented here
 * would later be quoted as a decision — so they are gone.
 *
 * What remains is observation: for every candidate pair, which signals agree and
 * what the RAW coordinate distance is. Distances are recorded, never bucketed.
 *
 * A `ProvisionalEvaluationHeuristic` may be supplied to organise an evaluation
 * output once live data exists. It is off by default, it is data-driven, and it
 * is labelled PROVISIONAL everywhere it appears. It is not canonical matching
 * policy and must never be described as one.
 */
import type {
  AmbiguityCluster,
  EvaluationDestination,
  EvaluationRecord,
  OverlapAnalysis,
  PairEvidence,
} from "./types";

/** Normalize a property name for comparison only. Never stored as canonical. */
export function normalizeName(name: string | null): string {
  if (!name) return "";
  return name
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/** Host-only comparison, so a tracking query string cannot break a match. */
export function normalizeDomain(url: string | null): string {
  if (!url) return "";
  try {
    const parsed = new URL(url.startsWith("http") ? url : `https://${url}`);
    return parsed.hostname.replace(/^www\./, "").toLowerCase();
  } catch {
    return "";
  }
}

/** Digits only, so formatting differences do not defeat comparison. */
export function normalizePhone(phone: string | null): string {
  if (!phone) return "";
  return phone.replace(/\D/g, "");
}

/** Great-circle distance in metres. Recorded as evidence, never thresholded. */
export function haversineMetres(aLat: number, aLon: number, bLat: number, bLon: number): number {
  const R = 6_371_000;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(bLat - aLat);
  const dLon = toRad(bLon - aLon);
  const lat1 = toRad(aLat);
  const lat2 = toRad(bLat);
  const h = Math.sin(dLat / 2) ** 2 + Math.sin(dLon / 2) ** 2 * Math.cos(lat1) * Math.cos(lat2);
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

/**
 * Observe a candidate pair. No judgement, no scoring, no verdict.
 *
 * Note that `websiteDomainAgrees` is genuinely weak on its own: an entire hotel
 * chain can share one domain across many physical properties. It is recorded as
 * a signal, not as proof, which is precisely why no default rule promotes it.
 */
export function observePair(a: EvaluationRecord, b: EvaluationRecord): PairEvidence {
  const nameA = normalizeName(a.name);
  const nameB = normalizeName(b.name);
  const domainA = normalizeDomain(a.websiteUrl);
  const domainB = normalizeDomain(b.websiteUrl);
  const brandA = normalizeName(a.brand);
  const brandB = normalizeName(b.brand);
  const phoneA = normalizePhone(a.phone);
  const phoneB = normalizePhone(b.phone);

  const bothCoordinatesPresent =
    a.latitude !== null && a.longitude !== null && b.latitude !== null && b.longitude !== null;

  return {
    aId: a.sourcePropertyId,
    bId: b.sourcePropertyId,
    exactNormalizedNameAgrees: nameA !== "" && nameA === nameB,
    websiteDomainAgrees: domainA !== "" && domainA === domainB,
    brandAgrees: brandA !== "" && brandA === brandB,
    phoneAgrees: phoneA !== "" && phoneA === phoneB,
    addressEvidenceAvailable: a.address !== null && b.address !== null,
    bothCoordinatesPresent,
    coordinateDistanceMetres: bothCoordinatesPresent
      ? Math.round(
          haversineMetres(
            a.latitude as number,
            a.longitude as number,
            b.latitude as number,
            b.longitude as number,
          ),
        )
      : null,
  };
}

/** Does this pair carry any positive signal at all? */
export function hasAnyEvidence(evidence: PairEvidence): boolean {
  return (
    evidence.exactNormalizedNameAgrees ||
    evidence.websiteDomainAgrees ||
    evidence.brandAgrees ||
    evidence.phoneAgrees
  );
}

/**
 * A PROVISIONAL evaluation heuristic.
 *
 * Supplied by the caller to organise output once live evidence exists. Every
 * field is `null` by default, meaning "no rule". This is NOT canonical matching
 * policy, and the analysis labels it as provisional wherever it is used.
 */
export interface ProvisionalEvaluationHeuristic {
  /** Metres within which coordinates are treated as agreeing. */
  coordinatesAgreeWithinMetres: number | null;
  /** Metres beyond which coordinates are treated as contradicting. */
  coordinatesContradictBeyondMetres: number | null;
  /** How many agreeing signals to group a pair as a candidate. */
  minimumAgreeingSignals: number | null;
}

export const NO_HEURISTIC: ProvisionalEvaluationHeuristic = {
  coordinatesAgreeWithinMetres: null,
  coordinatesContradictBeyondMetres: null,
  minimumAgreeingSignals: null,
};

/**
 * Apply a provisional heuristic, if one is configured.
 *
 * Returns null when no rule is configured — the default. Callers must treat null
 * as "not assessed", never as "no match".
 */
export function applyProvisionalHeuristic(
  evidence: PairEvidence,
  heuristic: ProvisionalEvaluationHeuristic,
): "candidate" | "contradicted" | "not_candidate" | null {
  const { minimumAgreeingSignals } = heuristic;
  if (minimumAgreeingSignals === null) return null;

  if (
    heuristic.coordinatesContradictBeyondMetres !== null &&
    evidence.coordinateDistanceMetres !== null &&
    evidence.coordinateDistanceMetres > heuristic.coordinatesContradictBeyondMetres
  ) {
    return "contradicted";
  }

  const coordinatesAgree =
    heuristic.coordinatesAgreeWithinMetres !== null &&
    evidence.coordinateDistanceMetres !== null &&
    evidence.coordinateDistanceMetres <= heuristic.coordinatesAgreeWithinMetres;

  const agreeing = [
    evidence.exactNormalizedNameAgrees,
    evidence.websiteDomainAgrees,
    evidence.brandAgrees,
    evidence.phoneAgrees,
    coordinatesAgree,
  ].filter(Boolean).length;

  return agreeing >= minimumAgreeingSignals ? "candidate" : "not_candidate";
}

/** Candidate duplicates WITHIN one provider — a real resolution cost. */
export function intraProviderDuplicateCandidates(records: readonly EvaluationRecord[]): number {
  let count = 0;
  for (let i = 0; i < records.length; i += 1) {
    for (let j = i + 1; j < records.length; j += 1) {
      const a = records[i];
      const b = records[j];
      if (!a || !b) continue;
      if (a.sourcePropertyId === b.sourcePropertyId) continue;
      // Within one provider, a shared name AND a shared domain is the weakest
      // thing worth flagging for review. It is a review flag, not a merge.
      const evidence = observePair(a, b);
      if (evidence.exactNormalizedNameAgrees && evidence.websiteDomainAgrees) count += 1;
    }
  }
  return count;
}

/**
 * Group entangled candidates into review clusters.
 *
 * The many-to-many problem: if one A record carries evidence against three B
 * records, that is not "one clean overlap" — it is four records nobody has
 * resolved. Counting it as a single match would understate the union and
 * overstate how much of the work is done. Connected components over the
 * evidence graph put every entangled record into a cluster instead.
 */
export function buildClusters(evidencePairs: readonly PairEvidence[]): {
  oneToOne: PairEvidence[];
  clusters: AmbiguityCluster[];
} {
  const aToB = new Map<string, Set<string>>();
  const bToA = new Map<string, Set<string>>();

  for (const pair of evidencePairs) {
    if (!aToB.has(pair.aId)) aToB.set(pair.aId, new Set());
    if (!bToA.has(pair.bId)) bToA.set(pair.bId, new Set());
    aToB.get(pair.aId)?.add(pair.bId);
    bToA.get(pair.bId)?.add(pair.aId);
  }

  const oneToOne: PairEvidence[] = [];
  const clusters: AmbiguityCluster[] = [];
  const visitedA = new Set<string>();

  for (const pair of evidencePairs) {
    if (visitedA.has(pair.aId)) continue;

    const bSet = aToB.get(pair.aId) ?? new Set<string>();
    const firstB = [...bSet][0];

    // Clean 1:1 — this A has exactly one B candidate, and that B has only this A.
    if (bSet.size === 1 && firstB !== undefined && (bToA.get(firstB)?.size ?? 0) === 1) {
      visitedA.add(pair.aId);
      oneToOne.push(pair);
      continue;
    }

    // Otherwise walk the connected component across both sides.
    const aIds = new Set<string>();
    const bIds = new Set<string>();
    const queueA = [pair.aId];

    while (queueA.length > 0) {
      const aId = queueA.pop();
      if (aId === undefined || aIds.has(aId)) continue;
      aIds.add(aId);
      for (const bId of aToB.get(aId) ?? []) {
        if (bIds.has(bId)) continue;
        bIds.add(bId);
        for (const backA of bToA.get(bId) ?? []) {
          if (!aIds.has(backA)) queueA.push(backA);
        }
      }
    }

    for (const aId of aIds) visitedA.add(aId);
    clusters.push({
      aIds: [...aIds],
      bIds: [...bIds],
      reason:
        `${aIds.size} ${pair.aId === undefined ? "" : ""}A-side and ${bIds.size} B-side records are linked by shared evidence ` +
        "and cannot be resolved 1:1 without human review.",
    });
  }

  return { oneToOne, clusters };
}

export function analyseOverlap(
  destination: EvaluationDestination,
  aRecords: readonly EvaluationRecord[],
  bRecords: readonly EvaluationRecord[],
  heuristic: ProvisionalEvaluationHeuristic = NO_HEURISTIC,
): OverlapAnalysis {
  const providerA = aRecords[0]?.provider ?? "a";
  const providerB = bRecords[0]?.provider ?? "b";

  const evidencePairs: PairEvidence[] = [];
  for (const a of aRecords) {
    for (const b of bRecords) {
      const evidence = observePair(a, b);
      if (!hasAnyEvidence(evidence)) continue;
      // When a provisional heuristic IS configured, let it veto a pair; with no
      // heuristic (the default) every evidenced pair is retained for review.
      if (applyProvisionalHeuristic(evidence, heuristic) === "contradicted") continue;
      evidencePairs.push(evidence);
    }
  }

  const { oneToOne, clusters } = buildClusters(evidencePairs);

  const aWithEvidence = new Set(evidencePairs.map((p) => p.aId));
  const bWithEvidence = new Set(evidencePairs.map((p) => p.bId));
  // NOTE: these are records with no TEXTUAL evidence. They are not
  // "provider-only" and must never be reported as such — see the notes below.
  const aIds = new Set(aRecords.map((r) => r.sourcePropertyId));
  const bIds = new Set(bRecords.map((r) => r.sourcePropertyId));

  const notes = [
    "EVIDENCE ONLY. No canonical match is asserted and no matching threshold is proposed (D063).",
    "Coordinate distances are recorded in metres and are NOT bucketed by any default rule.",
    "A shared website domain is a weak signal on its own: a chain can share one domain across many physical properties.",
    "Records in an ambiguity cluster are unresolved, not matched — a 1:many candidate set is review work, not an overlap.",
    "NO_TEXTUAL_EVIDENCE is NOT the same as NO_POSSIBLE_MATCH. A record with no exact name/domain/brand/phone agreement may still have a counterpart: names get transliterated, chains share or omit domains, phones are absent and addresses are formatted differently. These counts must never be reported as provider-unique inventory.",
    "Coordinate-only and address-only candidate generation is NOT_YET_ASSESSED: it needs distance thresholds that no live evidence supports yet (D063).",
  ];

  if (heuristic.minimumAgreeingSignals === null) {
    notes.push(
      "No provisional evaluation heuristic is configured, so the union is deliberately NOT estimated: computing one would require invented thresholds and would be falsely precise.",
    );
  } else {
    notes.push(
      `A PROVISIONAL EVALUATION HEURISTIC was configured (minimumAgreeingSignals=${heuristic.minimumAgreeingSignals}, agreeWithin=${heuristic.coordinatesAgreeWithinMetres}m, contradictBeyond=${heuristic.coordinatesContradictBeyondMetres}m). It organises this output only. It is NOT canonical matching policy.`,
    );
  }

  return {
    destination,
    providerA,
    providerB,
    aTotal: aIds.size,
    bTotal: bIds.size,
    evidencePairs,
    oneToOneCandidatePairs: oneToOne.length,
    ambiguityClusters: clusters,
    aWithNoTextualEvidence: [...aIds].filter((id) => !aWithEvidence.has(id)).length,
    bWithNoTextualEvidence: [...bIds].filter((id) => !bWithEvidence.has(id)).length,
    // Coordinate/address-only candidate generation needs thresholds that do not
    // exist yet (D063), so it has NOT been attempted.
    spatialCandidateGeneration: "not_yet_assessed",
    intraProviderDuplicateCandidates: {
      [providerA]: intraProviderDuplicateCandidates(aRecords),
      [providerB]: intraProviderDuplicateCandidates(bRecords),
    },
    // Only estimable once a heuristic exists to say what counts as one property.
    estimatedUnionBeforeResolution:
      heuristic.minimumAgreeingSignals === null ? null : aIds.size + bIds.size - oneToOne.length,
    notes,
  };
}
