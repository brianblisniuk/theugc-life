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
 * EVIDENCE, and evidence has a source. Provider-specific facts therefore live in
 * a declarative descriptor whose every field is traceable to official
 * documentation, and the runner refuses to execute a descriptor whose required
 * facts are still missing (`adapters/registry.ts`). A harness that guessed field
 * names would not crash — it would read `undefined` and report 0% coverage for
 * fields the provider actually supplies, which is indistinguishable from a
 * measurement.
 */

/** Our canonical destination identity — never a provider's geography. */
export type EvaluationDestination = "bali" | "dubai";

/**
 * How a provider models one of our destinations.
 *
 * "Bali" is the case that breaks naive assumptions: an island containing several
 * areas a traveller thinks of separately, which a provider may model as a
 * region, a set of cities, or something needing a union of queries. Recording
 * the resolution METHOD is part of the evidence, not bookkeeping.
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
 * `value`/`kind` are separated from `reviewScore` at the type level so a
 * guest-review average can never be silently read as a classification. D060
 * prohibits that conflation and both numbers are "out of five", so the
 * separation is structural rather than conventional.
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
 * The D060 eligibility state of one observation.
 *
 * Deliberately more than a boolean, because three different things get confused
 * otherwise:
 *
 *  - `exact_four` / `exact_five` — resolves V1 eligibility;
 *  - `classified_not_v1_scope` — a real classification that is not 4 or 5
 *    (3-star, or a half-star such as 3.5/4.5 which is a genuine classification
 *    in several markets but is NOT exactly 4 or 5);
 *  - `unresolved` — no value, an unusable kind, or an out-of-range/unexpected
 *    number. Under D061 this is a REVIEW state and is never the same fact as
 *    "confirmed below scope".
 */
export type StarEligibility =
  "exact_four" | "exact_five" | "classified_not_v1_scope" | "unresolved";

/** Verdict on whether a provider's star field can serve as D060 evidence. */
export type StarSuitability = "suitable" | "unsuitable" | "requires_secondary_verification";

export interface StarSemanticsFinding {
  provider: string;
  /** May be destination-specific: authority-issued in one market, not another. */
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
  /** `null` until live evidence exists. A hypothesis is not a verdict. */
  verdict: StarSuitability | null;
  /** Stated only when the evidence is documentary, pending a live run. */
  hypothesis?: string;
  sources: DocumentationSource[];
}

export interface DocumentationSource {
  url: string;
  /** ISO date the URL was read. A capability claim without one is not evidence. */
  accessedAt: string;
  /** WHO read it. Provenance of our own evidence matters as much as the claim. */
  verifiedBy: "claude_code" | "external_review";
  note?: string;
}

/**
 * One property as normalized for evaluation only.
 *
 * NOT a canonical hotel and never promotable. It exists to be counted, compared
 * and thrown away.
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
  phone: string | null;
  /** A provider's generic/reservations contact. NOT our premium target contact. */
  providerContact: string | null;
  star: StarObservation;
  photoCount: number;
  hasHeroImage: boolean;
  /** Provider's active/closed signal, verbatim, when it supplies one at all. */
  activeStatus: string | null;
}

/**
 * Field map — every path the harness will read, named explicitly.
 *
 * A dedicated interface rather than a `Partial<Record<keyof EvaluationRecord>>`
 * so that `starValue`, `starKind` and `reviewScore` are first-class typed keys.
 * The previous shape needed a cast to carry them, and a cast is exactly how an
 * unverified path sneaks in.
 *
 * `null` means "the provider documentably does NOT supply this". `undefined`
 * means "not yet established" — the gate treats those differently, because
 * "absent" is a finding and "unknown" is a gap.
 */
export interface ProviderFieldMap {
  sourcePropertyId?: string | null;
  name?: string | null;
  propertyType?: string | null;
  address?: string | null;
  latitude?: string | null;
  longitude?: string | null;
  brand?: string | null;
  chain?: string | null;
  websiteUrl?: string | null;
  phone?: string | null;
  providerContact?: string | null;
  /** Path to the star CLASSIFICATION value. */
  starValue?: string | null;
  /** Path to the star qualifier/type. `null` = provider supplies none. */
  starKind?: string | null;
  /** Path to the guest-review score. Never read as a classification. */
  reviewScore?: string | null;
  photos?: string | null;
  heroImage?: string | null;
  activeStatus?: string | null;
}

/** Counts describing what arrived vs what survived normalization. */
export interface RecordAccounting {
  /** Records the provider actually returned, before any of our processing. */
  rawRecordsReturned: number;
  /** Records that produced a usable evaluation record. */
  normalizedRecords: number;
  /** Dropped for lacking a provider property id — itself source-quality evidence. */
  recordsMissingSourcePropertyId: number;
  /** Dropped for any other normalization failure. */
  otherNormalizationRejects: number;
  uniqueSourcePropertyIds: number;
  /** Normalized records sharing an id with another record. */
  duplicateIdRecords: number;
}

/** Per-provider, per-destination metrics (brief §13). */
export interface ProviderMetrics {
  provider: string;
  destination: EvaluationDestination;
  accounting: RecordAccounting;
  inventory: {
    /** Exactly 4. Half-stars are NOT counted here. */
    apparentExactFourStar: number;
    /** Exactly 5. */
    apparentExactFiveStar: number;
    /** Real classification, not 4 or 5 — includes 3, 3.5, 4.5. */
    classifiedNotV1Scope: number;
    /** No value, unusable kind, or unexpected/out-of-range number. */
    unresolvedStar: number;
    /** Distinct star values seen, so an unexpected scale is visible not silent. */
    starValueDistribution: Record<string, number>;
    propertyTypeDistribution: Record<string, number>;
    activeStatusDistribution: Record<string, number>;
    /**
     * Physical hospitality properties per the descriptor's documented
     * classification of provider property types. `null` while that mapping is
     * unestablished — D060 §2.2 makes type a real dimension, and guessing which
     * provider categories are "hospitality" would prejudge eligibility.
     */
    apparentPhysicalHospitalityProperties: number | null;
  };
  fieldCoverage: {
    coordinatesPct: number;
    validCoordinatesPct: number;
    addressPct: number;
    starFieldPct: number;
    /** Share whose star carries a kind accepted as D060 evidence. */
    starUsableAsD060EvidencePct: number;
    brandPct: number;
    chainPct: number;
    websitePct: number;
    phonePct: number;
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
  /** Provider's own claimed total, when it supplies one. */
  reportedTotal: number | null;
  exhaustionProven: boolean;
  coverageRisks: string[];
}

/** Media evidence (brief §13 MEDIA). Slots are null until measured. */
export interface MediaEvidence {
  propertiesWithAnyImage: number;
  propertiesWithHeroImage: number;
  totalImages: number;
  /** Image categories the provider supplied, with counts, when categorised. */
  categoryDistribution: Record<string, number>;
  /** Whether the provider supplied dimensions/sizes at all. */
  dimensionsSupplied: boolean | null;
  /** Attribution/provenance metadata available on the asset. */
  provenanceMetadataAvailable: boolean | null;
  /** Usage/storage constraints from OFFICIAL terms — documentary, not measured. */
  documentedUsageConstraints: string[];
}

/** Operational evidence (brief §13 OPERATIONS). Mostly documentary. */
export interface OperationsEvidence {
  paginationMethod: string | null;
  stablePropertyIds: boolean | null;
  updateMechanism: string | null;
  closedOrInactiveSupport: string | null;
  documentedRefreshCadence: string | null;
  documentedRateLimits: string | null;
  credentialLevelRequired: string | null;
  sandboxVsProductionNotes: string | null;
}

/** The full result of one provider × destination evaluation run. */
export interface EvaluationRunResult {
  provider: string;
  destination: EvaluationDestination;
  /** Supplied by the caller; the harness never reads a clock itself. */
  runLabel: string;
  metrics: ProviderMetrics;
  media: MediaEvidence;
  operations: OperationsEvidence;
  /** Paths of gitignored artifacts written by this run. */
  artifacts: string[];
  /** Never a coverage claim — see D061 closure. */
  coverageDisclaimer: string;
}

/** Cross-source overlap analysis (brief §14). Evidence, never canonical matches. */
export interface OverlapAnalysis {
  destination: EvaluationDestination;
  providerA: string;
  providerB: string;
  aTotal: number;
  bTotal: number;
  /** Every pair for which ANY evidence was observed, with the raw signals. */
  evidencePairs: PairEvidence[];
  /** Records whose candidate set is 1↔1 — still not a canonical match. */
  oneToOneCandidatePairs: number;
  /** Records entangled in many-to-many candidate sets: review clusters. */
  ambiguityClusters: AmbiguityCluster[];
  /**
   * Records for which NO TEXTUAL evidence was observed.
   *
   * Deliberately NOT called "provider-only". Absence of an exact name, domain,
   * brand or phone agreement is not proof that no counterpart exists: names get
   * transliterated, chains share or omit domains, phones are missing and
   * addresses are formatted differently. Calling these "source-only" would
   * produce a falsely precise count of provider-unique inventory.
   */
  aWithNoTextualEvidence: number;
  bWithNoTextualEvidence: number;
  /**
   * Whether spatial/address candidate generation has been attempted.
   *
   * `not_yet_assessed` until real data supports thresholds (D063). Until then no
   * record may be classified as having NO POSSIBLE MATCH.
   */
  spatialCandidateGeneration: "not_yet_assessed" | "assessed";
  intraProviderDuplicateCandidates: Record<string, number>;
  /**
   * `null` unless a provisional heuristic was explicitly configured. A union
   * computed through invented thresholds would be falsely precise (D063).
   */
  estimatedUnionBeforeResolution: number | null;
  notes: string[];
}

/** Raw, uninterpreted signals for one candidate pair. */
export interface PairEvidence {
  aId: string;
  bId: string;
  exactNormalizedNameAgrees: boolean;
  websiteDomainAgrees: boolean;
  brandAgrees: boolean;
  phoneAgrees: boolean;
  addressEvidenceAvailable: boolean;
  bothCoordinatesPresent: boolean;
  /** Raw distance in metres. RECORDED, never thresholded by default. */
  coordinateDistanceMetres: number | null;
}

/** A set of records that cannot be resolved 1:1 without human review. */
export interface AmbiguityCluster {
  aIds: string[];
  bIds: string[];
  reason: string;
}

/**
 * A provider adapter descriptor.
 *
 * Every provider-specific fact lives here as DATA sourced from official
 * documentation, so the reviewable artifact is a field map rather than parsing
 * code buried in a module.
 */
export interface AdapterDescriptor {
  provider: string;
  displayName: string;
  /**
   * - `unverified` — nothing established from official documentation.
   * - `partially_verified` — some facts established, named gaps remain. Still
   *   not runnable; the gate lists exactly what is missing.
   * - `verified` — every fact the gate requires is documented and sourced.
   */
  documentationStatus: "unverified" | "partially_verified" | "verified";
  /**
   * Whether we can actually reach this provider commercially.
   *
   * Separate from documentation on purpose: Booking and Expedia are thoroughly
   * documented and completely unreachable without partner onboarding, which is a
   * different fact from "we have not read the docs".
   */
  accessStatus:
    | "credentials_available"
    | "direct_access_unavailable"
    | "self_service_available_credential_not_supplied";
  /**
   * Whether anything was ever observed from the live API.
   *
   * The third axis that must never be collapsed into the other two: documented,
   * observed live, and production-approved are three different claims.
   */
  liveValidationStatus: "not_run" | "validated" | "blocked";
  /** Commercial posture, so a deprioritised source is not mistaken for a rejected one. */
  strategicRole: "active_evaluation" | "future_strategic_source" | "secondary_candidate";
  sources: DocumentationSource[];
  /** Env var names only. Values are never read into this object. */
  requiredCredentialEnvVars: string[];
  /** Base URL of the provider API, when documented. */
  baseUrl: string | null;
  /**
   * The static-content endpoint used to enumerate what EXISTS. Availability and
   * search endpoints answer a different question and must not define a coverage
   * universe (brief §4A).
   */
  staticContentEndpoint: string | null;
  /** Recorded so a reviewer can confirm we did not use search. */
  usesAvailabilityEndpointForCoverage: false;
  pagination: {
    method: string;
    pageSizeParam: string | null;
    maxPageSize: number | null;
    documentedHardCap: number | null;
  } | null;
  fieldMap: ProviderFieldMap;
  /** Star semantics per destination, or one `global` entry. */
  starSemantics: StarSemanticsFinding[];
  /** Star `kind` values accepted as D060 evidence. Empty until established. */
  starKindsAcceptedAsD060Evidence: string[];
  /**
   * Explicit acknowledgement that the provider supplies no star qualifier at
   * all. Required to be `true` before an absent `starKind` is acceptable, so a
   * missing path can never be mistaken for a documented absence.
   */
  starKindDocumentedAbsent: boolean;
  /** Provider property types documented as physical hospitality properties. */
  hospitalityPropertyTypes: string[];
  geography: ProviderGeographyResolution[];
  /**
   * Risks in enumerating a destination's property set, kept SEPARATE from
   * content pagination.
   *
   * These are different mechanisms and conflating them produces a false alarm:
   * a capped region→property mapping is a geography-enumeration problem, while
   * a content endpoint's paging is its own contract. A content extraction of
   * 900 records must not raise a geography cap warning it never touched.
   */
  geographyEnumerationRisks: string[];
  operations: OperationsEvidence;
  media: { documentedUsageConstraints: string[] };
  /** Why this descriptor cannot run yet, when it cannot. */
  blockers: string[];
}
