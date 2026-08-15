/**
 * Property-source evaluation — shared types.
 *
 * This harness answers ONE question: what can a candidate inventory source
 * actually supply for the coverage problem defined in
 * `docs/PROPERTY_CONTENT_COVERAGE_CONTRACT.md` (D060–D064)?
 *
 * It is evaluation-only. It never writes to Supabase, never touches `hotels`,
 * never promotes anything, and is not an application runtime dependency.
 *
 * The design constraint that shapes every type below: a provider's schema is
 * EVIDENCE WE DO NOT HAVE until it is read from that provider's official
 * documentation. So the provider-specific part of this harness is a declarative
 * descriptor rather than hand-written parsing code, and a descriptor that has
 * not been verified against official documentation refuses to run (see
 * `adapters/registry.ts`). A harness that guesses field names would produce
 * numbers indistinguishable from measured ones, which is the one failure mode
 * this block cannot afford.
 */

/** Our canonical destination identity — never a provider's geography. */
export type EvaluationDestination = "bali" | "dubai";

/**
 * How a provider models one of our destinations.
 *
 * Kept explicit because "Bali" is the case that breaks naive assumptions: it is
 * an island containing several areas a traveller thinks of separately, and a
 * provider may model it as a region, a set of cities, an administrative area, or
 * something that needs a union of several queries. Recording the resolution
 * method is part of the evidence, not bookkeeping.
 */
export interface ProviderGeographyResolution {
  destination: EvaluationDestination;
  /** Provider-native entity ids used to enumerate the destination. */
  providerEntityIds: string[];
  /** What kind of entity those ids are, in the PROVIDER's vocabulary. */
  providerEntityKind: string;
  /** How the ids were discovered — the reproducible method, not a guess. */
  resolutionMethod: string;
  /** True when several provider entities must be unioned to cover our node. */
  requiresUnion: boolean;
  /** Anything that makes the mapping imperfect (overlap, gaps, ambiguity). */
  caveats: string[];
}

/**
 * A star observation exactly as the provider supplied it, before any judgement.
 *
 * `value` and `kind` are kept separate from `reviewScore` at the type level so
 * that a guest-review average can never be silently read as a classification.
 * D060 prohibits that conflation, and both numbers are "out of five", so the
 * separation is enforced structurally rather than by convention.
 */
export interface StarObservation {
  /** Raw numeric value of the provider's star-shaped field, if present. */
  value: number | null;
  /** The provider's own type/qualifier for that value, verbatim. */
  kind: string | null;
  /** Guest-review score. NEVER star evidence. Carried only to prove separation. */
  reviewScore: number | null;
}

/**
 * Verdict on whether a provider's star field can serve as D060 evidence.
 *
 * Deliberately allowed to be destination-specific: a provider may carry official
 * local-authority classifications in one market and its own normalisation in
 * another, and forcing a single global verdict would hide exactly that.
 */
export type StarSuitability = "suitable" | "unsuitable" | "requires_secondary_verification";

export interface StarSemanticsFinding {
  provider: string;
  destination: EvaluationDestination | "global";
  /** Exact provider field path, e.g. "rating.stars". */
  fieldName: string;
  /** What the provider's OFFICIAL documentation says the field is. */
  documentedSemantics: string;
  /** Does it represent a hospitality classification, or something else? */
  isHospitalityClassification: boolean | null;
  issuer: string | null;
  origin:
    | "official_authority"
    | "property_supplied"
    | "provider_normalized"
    | "provider_inferred"
    | "unclear"
    | null;
  scale: string | null;
  refreshBehaviour: string | null;
  /** Can we store and cite it? Publishability condition 7 depends on this. */
  provenanceAvailableToUs: boolean | null;
  observedConflicts: string[];
  verdict: StarSuitability | null;
  /** Official documentation URLs backing every claim above. */
  sources: DocumentationSource[];
}

export interface DocumentationSource {
  url: string;
  /** ISO date the URL was read. A capability claim without one is not evidence. */
  accessedAt: string;
  note?: string;
}

/**
 * One property as normalized for evaluation only.
 *
 * This is NOT a canonical hotel and must never be promoted. It exists to be
 * counted, compared and thrown away.
 */
export interface EvaluationRecord {
  provider: string;
  destination: EvaluationDestination;
  /** Provider's own property id. Never a canonical PK (D063). */
  sourcePropertyId: string;
  name: string | null;
  propertyType: string | null;
  address: string | null;
  latitude: number | null;
  longitude: number | null;
  brand: string | null;
  chain: string | null;
  websiteUrl: string | null;
  /** A provider's generic/reservations contact. NOT our premium target contact. */
  providerContact: string | null;
  star: StarObservation;
  photoCount: number;
  hasHeroImage: boolean;
  /** Provider's active/closed signal, verbatim, when it supplies one at all. */
  activeStatus: string | null;
}

/** Per-provider, per-destination metrics (evaluation spec §4, brief §13). */
export interface ProviderMetrics {
  provider: string;
  destination: EvaluationDestination;
  inventory: {
    totalRawRecords: number;
    uniqueSourcePropertyIds: number;
    duplicateIdRecords: number;
    apparentFourStar: number;
    apparentFiveStar: number;
    apparentLowerStar: number;
    unknownStar: number;
    propertyTypeDistribution: Record<string, number>;
    activeStatusDistribution: Record<string, number>;
  };
  fieldCoverage: {
    coordinatesPct: number;
    validCoordinatesPct: number;
    addressPct: number;
    starFieldPct: number;
    /** Share whose star field carries a kind we judged suitable for D060. */
    starSuitableForD060Pct: number;
    brandPct: number;
    chainPct: number;
    websitePct: number;
    providerContactPct: number;
    photoPct: number;
    heroImagePct: number;
    averagePhotosPerProperty: number;
    medianPhotosPerProperty: number;
  };
  pagination: PaginationEvidence;
}

/**
 * Proof of how far an extraction actually got.
 *
 * `exhaustionProven` is the field that matters. Brief §10 forbids calling a
 * partial result "the provider's Bali universe", and D061's closure rule makes
 * an unprovable extraction a coverage risk rather than a coverage number.
 */
export interface PaginationEvidence {
  requests: number;
  pages: number;
  totalRecords: number;
  method: string;
  documentedHardCap: number | null;
  exhaustionProven: boolean;
  coverageRisks: string[];
}

/** Cross-source overlap analysis (brief §14). Evidence, never canonical matches. */
export interface OverlapAnalysis {
  destination: EvaluationDestination;
  providerA: string;
  providerB: string;
  aTotal: number;
  bTotal: number;
  highConfidenceOverlap: number;
  ambiguous: number;
  aOnly: number;
  bOnly: number;
  intraProviderDuplicateCandidates: Record<string, number>;
  estimatedUnionBeforeResolution: number;
  /** Which signals produced each high-confidence pairing, for auditability. */
  signalsUsed: string[];
}

/**
 * A provider adapter descriptor.
 *
 * Every provider-specific fact lives here as DATA, sourced from official
 * documentation, so that the reviewable artifact is a field map rather than
 * parsing code buried in a module.
 */
export interface AdapterDescriptor {
  provider: string;
  displayName: string;
  /**
   * `unverified` means nobody has read this provider's official documentation
   * in an environment that could reach it. The runner refuses to execute an
   * unverified descriptor — see `assertRunnable`.
   */
  documentationStatus: "verified" | "unverified";
  sources: DocumentationSource[];
  /** Env var names only. Values are never read into this object. */
  requiredCredentialEnvVars: string[];
  /**
   * The static-content endpoint used to enumerate what EXISTS.
   * Availability/search endpoints answer a different question and must not
   * define a coverage universe (brief §4A).
   */
  staticContentEndpoint: string | null;
  /** Explicitly recorded so a reviewer can confirm we did not use search. */
  usesAvailabilityEndpointForCoverage: false;
  pagination: {
    method: string;
    pageSizeParam: string | null;
    maxPageSize: number | null;
    documentedHardCap: number | null;
  } | null;
  /** Provider field path for each evaluation field. Null = not supplied. */
  fieldMap: Partial<Record<keyof EvaluationRecord | "photos" | "heroImage", string | null>>;
  /** Star field semantics, from official docs. */
  starSemantics: StarSemanticsFinding | null;
  /** Star `kind` values accepted as D060 evidence. Empty until verified. */
  starKindsAcceptedAsD060Evidence: string[];
  geography: ProviderGeographyResolution[];
  /** Why this descriptor cannot run yet, when it cannot. */
  blockers: string[];
}
