/**
 * Dubai 30-property pilot × live Hotelbeds DXB population.
 *
 * NON-CANONICAL IDENTITY EVIDENCE (D063). This resolves nothing. It reports what
 * signals agree, what is ambiguous, and what carries no textual evidence at all
 * — and it invents no match threshold, because a threshold chosen to make the
 * numbers look decisive is not a measurement.
 *
 * The pilot has **0 of 30 coordinates**. That single fact governs how provider
 * coordinates may be described here: with nothing to compare against, a provider
 * coordinate can never be "agreement". It is **COORDINATE ENRICHMENT AVAILABLE**
 * — and only once identity is resolved does it become anything more.
 */
import { normalizeDomain, normalizeName, normalizePhone } from "../overlap";

export interface PilotEntryLike {
  sourcePropertyId: string | null;
  name: string | null;
  address: string | null;
  latitude: number | null;
  longitude: number | null;
  websiteUrl: string | null;
}

export interface ProviderRecordLike {
  id: string;
  name: string | null;
  address: string | null;
  websiteUrl: string | null;
  phone: string | null;
  chain: string | null;
  latitude: number | null;
  longitude: number | null;
}

/** Which signals agreed for one (pilot, provider) pair. */
export interface PilotPairEvidence {
  providerId: string;
  providerName: string | null;
  exactNormalizedNameAgrees: boolean;
  websiteDomainAgrees: boolean;
  phoneAgrees: boolean;
  /** Every whitespace-delimited token of the pilot name appears in the provider name. */
  allPilotNameTokensPresent: boolean;
  providerHasValidCoordinates: boolean;
}

export type PilotOutcome =
  | "strong_multi_signal"
  | "plausible_single_signal"
  | "ambiguous_multiple_candidates"
  | "no_textual_evidence"
  | "not_yet_assessable";

export interface PilotEntryFinding {
  pilotId: string | null;
  pilotName: string | null;
  outcome: PilotOutcome;
  candidates: PilotPairEvidence[];
  /** True when at least one candidate carries valid provider coordinates. */
  coordinateEnrichmentAvailable: boolean;
}

export interface PilotComparison {
  pilotEntries: number;
  providerRecords: number;
  pilotEntriesWithCoordinates: number;
  outcomes: Record<PilotOutcome, number>;
  coordinateEnrichmentAvailable: number;
  findings: PilotEntryFinding[];
  disclaimers: string[];
}

function validCoordinates(lat: number | null, lon: number | null): boolean {
  if (typeof lat !== "number" || typeof lon !== "number") return false;
  if (lat === 0 && lon === 0) return false;
  return Math.abs(lat) <= 90 && Math.abs(lon) <= 180;
}

/** Tokens long enough to carry signal; "the", "of" and friends are noise. */
function significantTokens(name: string): string[] {
  return normalizeName(name)
    .split(" ")
    .filter((t) => t.length >= 4);
}

function evidenceFor(pilot: PilotEntryLike, record: ProviderRecordLike): PilotPairEvidence {
  const pilotName = normalizeName(pilot.name);
  const providerName = normalizeName(record.name);
  const pilotDomain = normalizeDomain(pilot.websiteUrl);
  const providerDomain = normalizeDomain(record.websiteUrl);

  const tokens = significantTokens(pilot.name ?? "");
  const allPilotNameTokensPresent =
    tokens.length > 0 && tokens.every((t) => providerName.includes(t));

  return {
    providerId: record.id,
    providerName: record.name,
    exactNormalizedNameAgrees: pilotName !== "" && pilotName === providerName,
    websiteDomainAgrees: pilotDomain !== "" && pilotDomain === providerDomain,
    // The pilot carries no phone column, so this can only ever be false here.
    // Kept explicit so its absence is visible rather than assumed.
    phoneAgrees:
      normalizePhone(null) !== "" && normalizePhone(null) === normalizePhone(record.phone),
    allPilotNameTokensPresent,
    providerHasValidCoordinates: validCoordinates(record.latitude, record.longitude),
  };
}

function signalCount(e: PilotPairEvidence): number {
  return [
    e.exactNormalizedNameAgrees,
    e.websiteDomainAgrees,
    e.phoneAgrees,
    e.allPilotNameTokensPresent,
  ].filter(Boolean).length;
}

/**
 * Compare the pilot list against the live provider population.
 *
 * Deliberately NOT a resolver. Outcomes describe the STATE OF THE EVIDENCE:
 *
 *  - `strong_multi_signal` — one candidate agrees on two or more signals
 *  - `plausible_single_signal` — exactly one candidate, one signal
 *  - `ambiguous_multiple_candidates` — several candidates carry evidence, and
 *    picking one would require a threshold we have no basis to invent
 *  - `no_textual_evidence` — nothing agreed. NOT "the provider lacks it": names
 *    transliterate, rebrand and abbreviate
 *  - `not_yet_assessable` — the pilot entry has no usable signal to compare
 */
export function comparePilotAgainstProvider(
  pilot: readonly PilotEntryLike[],
  provider: readonly ProviderRecordLike[],
): PilotComparison {
  const findings: PilotEntryFinding[] = [];

  for (const entry of pilot) {
    const hasSignal = Boolean(normalizeName(entry.name) || normalizeDomain(entry.websiteUrl));
    if (!hasSignal) {
      findings.push({
        pilotId: entry.sourcePropertyId,
        pilotName: entry.name,
        outcome: "not_yet_assessable",
        candidates: [],
        coordinateEnrichmentAvailable: false,
      });
      continue;
    }

    const candidates = provider
      .map((record) => evidenceFor(entry, record))
      .filter((e) => signalCount(e) > 0)
      .sort((a, b) => signalCount(b) - signalCount(a));

    let outcome: PilotOutcome;
    if (candidates.length === 0) {
      outcome = "no_textual_evidence";
    } else if (candidates.length === 1) {
      outcome =
        signalCount(candidates[0] as PilotPairEvidence) >= 2
          ? "strong_multi_signal"
          : "plausible_single_signal";
    } else {
      // Several candidates carry evidence. One clear leader is reportable; a tie
      // is exactly the case a fabricated threshold would paper over.
      const top = signalCount(candidates[0] as PilotPairEvidence);
      const second = signalCount(candidates[1] as PilotPairEvidence);
      outcome = top >= 2 && top > second ? "strong_multi_signal" : "ambiguous_multiple_candidates";
    }

    findings.push({
      pilotId: entry.sourcePropertyId,
      pilotName: entry.name,
      outcome,
      candidates: candidates.slice(0, 5),
      coordinateEnrichmentAvailable: candidates.some((c) => c.providerHasValidCoordinates),
    });
  }

  const outcomes: Record<PilotOutcome, number> = {
    strong_multi_signal: 0,
    plausible_single_signal: 0,
    ambiguous_multiple_candidates: 0,
    no_textual_evidence: 0,
    not_yet_assessable: 0,
  };
  for (const f of findings) outcomes[f.outcome] += 1;

  return {
    pilotEntries: pilot.length,
    providerRecords: provider.length,
    pilotEntriesWithCoordinates: pilot.filter((p) => validCoordinates(p.latitude, p.longitude))
      .length,
    outcomes,
    coordinateEnrichmentAvailable: findings.filter((f) => f.coordinateEnrichmentAvailable).length,
    findings,
    disclaimers: [
      "NON-CANONICAL. No entity was resolved and no match threshold was invented (D063).",
      "The pilot carries 0 of 30 coordinates, so provider coordinates can never be coordinate AGREEMENT here. They are COORDINATE ENRICHMENT AVAILABLE, and only once identity is resolved do they become anything more.",
      "no_textual_evidence means our signals did not agree — NOT that the provider lacks the property. Names transliterate, rebrand and abbreviate.",
      "The 30-property pilot is a TECHNICAL PILOT (D061). It is not Dubai inventory and is not a coverage baseline.",
    ],
  };
}
