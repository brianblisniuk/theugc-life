/**
 * Provider-agnostic ingestion contract.
 *
 * These types are the boundary between a PROVIDER ADAPTER (which knows payload
 * shapes) and the GENERIC WRITER (which knows migration 0027). Adding a second
 * provider must mean writing another adapter, not another writer — so nothing
 * here mentions Hotelbeds, and nothing here is shaped by one provider's JSON.
 *
 * Every field maps to a column that already exists in 0027. If an adapter wants
 * to record something with no column, that is a schema conversation, not a
 * `source_attributes` improvisation.
 */

/** The only environment this block may write. See `writer.ts`. */
export const EVALUATION_ENVIRONMENT = "evaluation" as const;
export type SourceEnvironment = typeof EVALUATION_ENVIRONMENT | "production";

/**
 * Evidence about the ORIGINAL provider extraction, carried forward from cached
 * artifacts. Deliberately separate from anything this replay does now: the
 * writer makes zero provider requests, so it must not restate historical
 * request accounting as if it had.
 */
export interface ProviderExtractionEvidence {
  /** Records the provider actually returned, per the cached run. */
  rawRecordsSeen: number;
  uniqueSourcePropertyIds: number;
  /** NULL when the provider supplied no total. Never defaulted to 0. */
  providerReportedTotal: number | null;
  paginationWalkCompleted: boolean;
  /**
   * Risks to the ENUMERATION itself (cursor loop, total mismatch, budget stop).
   * Non-empty blocks exhaustion — see 0027's `exhaustion_requires_walk`.
   */
  enumerationRisks: string[];
  /**
   * Risks about what the enumerated set MEANS (geography caveats, open star
   * authority, pending second source). These never falsify a completed walk.
   */
  coverageRisks: string[];
  /**
   * Requests the ORIGINAL extraction made. Recorded in the run notes as
   * historical evidence, never written to `request_count` — that column
   * describes the run row's own activity, which for an offline replay is zero.
   */
  originalRequestCount: number | null;
}

/** One source run: provider × environment × destination × selected artifact. */
export interface ProviderSourceRunInput {
  /** Deterministic run id derived from the manifest fingerprint (idempotency). */
  id: string;
  source: string;
  sourceEnvironment: SourceEnvironment;
  /** Canonical destination, resolved from `destinations`. Never hardcoded. */
  destinationId: string;
  /** Provider-native geography actually used, e.g. `{ destinationCode: "BAI" }`. */
  providerGeography: Record<string, unknown>;
  runMode: "full" | "incremental" | "evaluation" | "master_data";
  evidence: ProviderExtractionEvidence;
  /**
   * The single timestamp all rows in this run share. For a cached replay this
   * is the frozen ARTIFACT CAPTURE time, not a provider-authoritative one — the
   * distinction is stated in the manifest and in the run notes.
   */
  observedAt: Date;
  /** Free text. Must state that this is an offline replay of a cached run. */
  notes: string;
  harnessVersion: string;
}

/**
 * One observation of one source property. Field names mirror 0027's columns
 * minus the `source_` prefix; the writer does the column mapping so an adapter
 * never writes SQL.
 */
export interface SourcePropertyObservationInput {
  /** Provider-native id, ALWAYS text. Never a canonical key. */
  sourcePropertyId: string;
  sourceUrl?: string | null;

  name?: string | null;
  destinationCode?: string | null;
  zoneCode?: string | null;
  address?: string | null;
  postalCode?: string | null;
  city?: string | null;

  /** Raw provider coordinates. Invalid values are STORED, never dropped. */
  latitude?: number | null;
  longitude?: number | null;
  /** The audit verdict about those coordinates, recorded not enforced. */
  coordinatesPlausible?: boolean | null;

  websiteUrl?: string | null;
  email?: string | null;
  /** Must never be a fax number. The adapter is responsible for that. */
  phone?: string | null;
  phoneType?: string | null;

  brandCode?: string | null;
  chainCode?: string | null;
  propertyTypeCode?: string | null;
  propertyTypeLabel?: string | null;

  /** PROVIDER classification evidence. Never a canonical star value. */
  classificationCode?: string | null;
  classificationLabel?: string | null;
  classificationGroup?: string | null;
  /** TEXT. `5` covers 5 STARS, 5 KEYS, aparthotel and hostel alike. */
  classificationSimpleCode?: string | null;

  /** Only when the provider actually supplies one. Never invented. */
  lifecycleStatus?: string | null;

  /** MEDIA SUMMARY ONLY — no rows, no URLs, no binaries (D064). */
  imageCount?: number | null;
  providerDesignatedPrincipalImage?: boolean | null;

  /** Bounded overflow. Not an escape hatch for the payload (0027 §8). */
  attributes?: Record<string, unknown>;

  /** SHA-256 over a canonical form of the ORIGINAL raw provider record. */
  payloadDigest?: string | null;
  /** Opaque off-database locator. NULL in this block. */
  payloadUri?: string | null;
}

/** What an adapter hands the writer: one run plus its observations. */
export interface ProviderIngestionBatch {
  run: ProviderSourceRunInput;
  observations: SourcePropertyObservationInput[];
}

/** Per-destination outcome, reported identically by preview and apply. */
export interface IngestionCounts {
  runsCreated: number;
  runsExisting: number;
  identitiesCreated: number;
  identitiesExisting: number;
  observationsCreated: number;
  observationsExisting: number;
  observationCountIncrements: number;
  lastSeenAdvanced: number;
}

export function emptyCounts(): IngestionCounts {
  return {
    runsCreated: 0,
    runsExisting: 0,
    identitiesCreated: 0,
    identitiesExisting: 0,
    observationsCreated: 0,
    observationsExisting: 0,
    observationCountIncrements: 0,
    lastSeenAdvanced: 0,
  };
}
