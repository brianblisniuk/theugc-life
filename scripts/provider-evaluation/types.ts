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

/**
 * Evaluation capabilities, assessed independently.
 *
 * The layered-source principle means a provider can be an excellent inventory,
 * location and media source while its classification needs secondary
 * verification. An all-or-nothing gate would refuse to measure any of that,
 * which is precisely backwards: the bake-off exists to find out WHICH layers a
 * source can carry.
 */
export type EvaluationCapability =
  | "enumerate_inventory"
  | "measure_location"
  | "measure_media"
  | "assess_classification"
  | "resolve_d060_classification";

/**
 * Runtime observations — what is true RIGHT NOW, not what a descriptor recorded.
 *
 * The distinction matters because a historical observation was being used as a
 * permanent fact: "EGRESS BLOCKED" sat in the descriptor's static blockers, so
 * allowlisting the host would have left every capability blocked by a stale
 * string from a previous run.
 *
 * Static descriptor facts answer "what do we know about this provider?"
 * (endpoint, field semantics, issuer, geography). Runtime observations answer
 * "what happened when we last tried?" (egress, credentials, quota). Only the
 * first belongs in a descriptor.
 */
export interface RuntimeObservation {
  /** `unknown` until something actually tried. Never defaulted to blocked. */
  egress: "unknown" | "reachable" | "blocked";
  credentials: "untested" | "valid" | "invalid";
  /** When this observation was made, for staleness judgement by a human. */
  observedAt?: string;
  detail?: string;
}

export function unknownRuntime(): RuntimeObservation {
  return { egress: "unknown", credentials: "untested" };
}

export interface CapabilityAssessment {
  capability: EvaluationCapability;
  runnable: boolean;
  /** Why not, when not. Empty when runnable. */
  reasons: string[];
}

/**
 * How a provider expresses a property's classification.
 *
 * `code_with_master_lookup` is the Hotelbeds shape: the hotels response carries
 * a CODE and a separate master operation supplies its meaning. Modelling that
 * explicitly is what stops us inventing a `category.simpleCode` path the hotels
 * payload may never contain.
 */
export type ClassificationMode = "inline_value_and_kind" | "code_with_master_lookup" | "unknown";

export interface ClassificationConfig {
  mode: ClassificationMode;
  /** For `code_with_master_lookup`: path to the code on the PROPERTY record. */
  codePath?: string | null;
  /**
   * accommodationType values whose classification is a HOTEL star classification.
   *
   * Empty until established. `APARTMENT` with "5 KEY" is a real classification
   * and is NOT five hotel stars, so it must never be counted as one.
   */
  hotelAccommodationTypes: string[];
  /** Whether an issuing authority is established (D062 condition 7). */
  issuerEstablished: boolean;
}

/** One classification master record (e.g. a Hotelbeds category). */
export interface ClassificationMaster {
  code: string;
  simpleCode: string | null;
  accommodationType: string | null;
  group: string | null;
  description: string | null;
}

/** Reference/master data joined into normalization. */
export interface ReferenceData {
  /** Classification master, keyed by code. */
  classifications: Map<string, ClassificationMaster>;
}

export function emptyReferenceData(): ReferenceData {
  return { classifications: new Map() };
}

/**
 * The RAW classification observation, before any D060 judgement.
 *
 * Kept separate from `StarObservation` on purpose: what the source said and what
 * D060 concludes are different layers, and collapsing them is how "simpleCode 5"
 * silently becomes "five-star hotel".
 */
export interface RawClassificationObservation {
  /** Code exactly as it appeared on the property record. */
  sourceCode: string | null;
  /** Master record, when the join succeeded. */
  master: ClassificationMaster | null;
  resolution: "resolved" | "unresolved_no_code" | "unresolved_no_master_entry" | "not_applicable";
}

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
  /** Raw provider classification evidence; null when the provider uses stars inline. */
  classification: RawClassificationObservation | null;
  photoCount: number;
  /**
   * Derived, not read from a field path.
   *
   * Hotelbeds marks a principal image with `visualOrder = 0` inside the images
   * collection; there is no "hero image" field to point at. Deriving it keeps
   * the descriptor honest about what the provider actually supplies.
   */
  /**
   * The PROVIDER-DESIGNATED principal image, per documented semantics only.
   *
   * Never satisfied by a locally-chosen fallback: "we can pick one image
   * deterministically" and "the provider says this is the main image" are
   * different claims, and only the second belongs in hero-image coverage.
   */
  hasProviderDesignatedPrincipal: boolean;
  /**
   * A locally-selected representative image, `selection_origin =
   * local_deterministic_fallback`. Engineering/UI convenience, NOT provider
   * semantic truth — it must never be reported as principal, main or hero.
   */
  hasDeterministicRepresentativeCandidate: boolean;
  /** Image `type` values observed on this property. */
  imageTypes: string[];
  /** Images carrying a usable path/URL. */
  imagesWithPath: number;
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
  /**
   * Path to a principal-image marker, when the provider HAS one.
   *
   * `null` when the principal image must instead be derived from the images
   * collection (see `ProviderImageFieldMap`), which is the Hotelbeds case.
   */
  heroImage?: string | null;
  activeStatus?: string | null;
}

/**
 * How to read an entry INSIDE the images collection.
 *
 * Separate from `ProviderFieldMap` because these are paths within each image
 * object, not on the property record.
 */
export interface ProviderImageFieldMap {
  /** Path to the image path/URL within one image entry. */
  path?: string | null;
  /** Path to the image type/category within one image entry. */
  type?: string | null;
  /** Path to a visual-order value within one image entry. */
  visualOrder?: string | null;
  /**
   * How a principal-image candidate is identified.
   *
   * `visual_order_zero` (default) is the documented Hotelbeds rule. It is kept
   * as the default because it is what provider documentation says — but
   * documentation can be wrong about live data, and when it is, the failure is
   * silent: every property reports "no principal image" and the provider looks
   * weak at media when it is not.
   *
   * `deterministic_representative_fallback` additionally derives a LOCAL
   * fallback for properties the provider did not designate one for. It proves
   * only "one image can be selected deterministically" — never that the image
   * is the provider's principal one, since the provider has not documented
   * whether maximum, minimum, array order or another transformation is
   * intended. It is reported separately, tagged
   * `selection_origin = local_deterministic_fallback`, and never counted as
   * hero-image coverage.
   */
  principalSelector?: "visual_order_zero" | "deterministic_representative_fallback";
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
    /** How classification-code joins resolved, so a failed join stays visible. */
    classificationResolutionDistribution: Record<string, number>;
    /** accommodationType distribution from resolved classification masters. */
    classificationAccommodationTypeDistribution: Record<string, number>;
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
  /**
   * The CONSERVATIVE flag: the walk finished AND no coverage risk was recorded.
   * This is the one that may be cited as "we have the whole set".
   */
  exhaustionProven: boolean;
  /**
   * Did the pagination WALK itself run to completion — every page consumed and
   * the provider's own total satisfied?
   *
   * Kept separate from `exhaustionProven` because the two fail for different
   * reasons and demand different responses. A walk that stopped early means
   * re-run and spend more requests. A completed walk carrying a geography
   * caveat means the records are all there but the mapping needs review — and
   * reporting that as "pagination not exhaustive" sends someone to fix a
   * paginator that worked perfectly.
   */
  walkCompleted: boolean;
  coverageRisks: string[];
}

/** Media evidence (brief §13 MEDIA). Slots are null until measured. */
export interface MediaEvidence {
  propertiesWithAnyImage: number;
  /** Derived from the images collection, not read from a field path. */
  propertiesWithProviderDesignatedPrincipal: number;
  /**
   * Share of imaged properties carrying that designation.
   *
   * Reported as a plain coverage figure with NO verdict attached. HBX documents
   * `visualOrder = 0` as the principal image AND explicitly notes that some
   * hotels may not carry the designation, so a property without one is in a
   * documented, allowed state — not a contradiction, and not evidence the
   * provider lacks images. There is deliberately no threshold here: any cutoff
   * separating "normal" from "contradicted" would be invented.
   */
  providerDesignatedPrincipalCoveragePct: number;
  totalImages: number;
  /** Images carrying a usable path/URL. */
  imagesWithPath: number;
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
  /** What this run was able to measure, dimension by dimension. */
  capabilities: CapabilityAssessment[];
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
  /** How to read entries inside the images collection. */
  imageFieldMap: ProviderImageFieldMap;
  /** How the provider expresses classification, and what it means. */
  classification: ClassificationConfig;
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
  /**
   * Blockers that stop EVERYTHING (egress, credentials, no endpoint).
   *
   * Anything that only stops one dimension belongs in `capabilityBlockers`, so
   * an unresolved star issuer cannot veto measuring coordinates.
   */
  blockers: string[];
  /** Blockers scoped to a single capability. */
  capabilityBlockers: Partial<Record<EvaluationCapability, string[]>>;
}
