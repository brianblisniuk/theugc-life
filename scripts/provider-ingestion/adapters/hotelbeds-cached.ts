/**
 * Hotelbeds CACHED-EVALUATION adapter.
 *
 * Reads artifacts the PR #21 evaluation harness already wrote and turns them
 * into provider-agnostic ingestion input. It imports the harness's PURE
 * modules — the verified field map, the classification master builder, the
 * image-evidence and coordinate-plausibility rules — and imports nothing that
 * can reach the network. There is no client, no transport, no signature, no
 * credential read, and no `fetch` on any path this file can take.
 *
 * Field semantics are the ones VERIFIED against live payloads in PR #21, not
 * remembered ones: they come from `hotelbedsContentDescriptor`, so a correction
 * there is a correction here.
 */
import { readFile } from "node:fs/promises";
import path from "node:path";

import { hotelbedsContentDescriptor } from "../../provider-evaluation/adapters/hotelbeds";
import { buildClassificationMaster } from "../../provider-evaluation/classification";
import { deriveImageEvidence, readPath } from "../../provider-evaluation/normalize";
import type { ClassificationMaster } from "../../provider-evaluation/types";
import { digestValue } from "../digest";
import type { IngestionManifest } from "../manifest";
import { runFingerprint } from "../manifest";
import { deterministicUuid } from "../digest";
import type { ProviderIngestionBatch, SourcePropertyObservationInput } from "../types";

export const HARNESS_VERSION = "provider-ingestion/1.0.0";

/**
 * Phone types that are NOT a contact phone.
 *
 * A fax number silently reported as a phone is the exact class of quiet
 * meaning-upgrade this pipeline exists to prevent, so the selection is explicit
 * rather than "the first entry in the array".
 */
const NON_VOICE_PHONE_TYPES = new Set(["PHONEFAX", "FAX"]);

function asString(value: unknown): string | null {
  if (typeof value === "string") return value.trim() === "" ? null : value.trim();
  if (typeof value === "number") return String(value);
  return null;
}

function asNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/**
 * Coordinate plausibility, using the SAME rule the evaluation reported against.
 *
 * Deliberately mirrors `hasValidCoordinates` in the evaluation harness — range
 * check plus the 0,0 null-island sentinel — rather than inventing a second
 * interpretation. `null` means "no coordinates supplied", which is a different
 * fact from "supplied and implausible" and must not collapse into `false`.
 */
export function coordinatePlausibility(
  latitude: number | null,
  longitude: number | null,
): boolean | null {
  if (latitude === null || longitude === null) return null;
  if (latitude < -90 || latitude > 90 || longitude < -180 || longitude > 180) return false;
  if (latitude === 0 && longitude === 0) return false;
  return true;
}

/** First voice phone, or null. Never a fax. */
export function selectVoicePhone(payload: unknown): {
  phone: string | null;
  phoneType: string | null;
} {
  const raw = readPath(payload, "phones");
  if (!Array.isArray(raw)) return { phone: null, phoneType: null };
  for (const entry of raw) {
    const type = asString(readPath(entry, "phoneType"));
    if (type && NON_VOICE_PHONE_TYPES.has(type.toUpperCase())) continue;
    const number = asString(readPath(entry, "phoneNumber"));
    if (number) return { phone: number, phoneType: type };
  }
  return { phone: null, phoneType: null };
}

export interface HotelbedsReferenceData {
  classifications: Map<string, ClassificationMaster>;
  /** accommodationTypeCode → human label, from the ACCOMMODATIONS master. */
  accommodationTypes: Map<string, string>;
}

/**
 * Load the cached master data.
 *
 * The accommodation label comes from the ACCOMMODATIONS master, not from the
 * category master's `accommodationType` field — PR #21 found that field empty
 * for every one of the 65 category codes, so using it as the property-type
 * discriminator would resolve every property to "(unknown)".
 */
export async function loadReferenceData(
  manifest: IngestionManifest,
  repoRoot: string,
): Promise<HotelbedsReferenceData> {
  const byRole = new Map(manifest.artifacts.map((a) => [a.role, a.relativePath]));

  const categoryRaw = JSON.parse(
    await readFile(path.resolve(repoRoot, byRole.get("classification_master")!), "utf8"),
  ) as { classifications?: unknown[] };
  const classifications = buildClassificationMaster(categoryRaw.classifications ?? [], {
    code: "code",
    simpleCode: "simpleCode",
    accommodationType: "accommodationType",
    group: "group",
    description: "description",
  });

  const accommodationRaw = JSON.parse(
    await readFile(path.resolve(repoRoot, byRole.get("accommodation_master")!), "utf8"),
  ) as { types?: { code?: string; description?: string }[] };
  const accommodationTypes = new Map<string, string>();
  for (const entry of accommodationRaw.types ?? []) {
    const code = asString(entry?.code);
    const description = asString(entry?.description);
    if (code && description) accommodationTypes.set(code, description);
  }

  return { classifications, accommodationTypes };
}

/**
 * Map ONE cached raw Hotelbeds property to a source observation.
 *
 * Everything here is source EVIDENCE. Nothing is upgraded: the category is not
 * a star value, the accommodation type is not a publication gate, the email is
 * not a verified marketing contact, and the images are a count rather than
 * rows.
 */
export function mapProperty(
  raw: unknown,
  reference: HotelbedsReferenceData,
): SourcePropertyObservationInput | null {
  const descriptor = hotelbedsContentDescriptor;
  const sourcePropertyId = asString(readPath(raw, descriptor.fieldMap.sourcePropertyId));
  // A record with no provider id cannot be an identity. The caller counts it.
  if (!sourcePropertyId) return null;

  const latitude = asNumber(readPath(raw, descriptor.fieldMap.latitude));
  const longitude = asNumber(readPath(raw, descriptor.fieldMap.longitude));
  const { phone, phoneType } = selectVoicePhone(raw);

  const classificationCode = asString(readPath(raw, "categoryCode"));
  const master = classificationCode
    ? (reference.classifications.get(classificationCode) ?? null)
    : null;

  const propertyTypeCode = asString(readPath(raw, "accommodationTypeCode"));
  const images = deriveImageEvidence(raw, descriptor);

  return {
    sourcePropertyId,
    // Hotelbeds Content API supplies no per-property canonical URL.
    sourceUrl: null,

    name: asString(readPath(raw, descriptor.fieldMap.name)),
    destinationCode: asString(readPath(raw, "destinationCode")),
    zoneCode: asString(readPath(raw, "zoneCode")),
    address: asString(readPath(raw, descriptor.fieldMap.address)),
    postalCode: asString(readPath(raw, "postalCode")),
    city: asString(readPath(raw, "city.content")),

    // Raw, unfiltered. An out-of-range value is retained as evidence and
    // flagged, never dropped, nulled or coerced to 0,0.
    latitude,
    longitude,
    coordinatesPlausible: coordinatePlausibility(latitude, longitude),

    websiteUrl: asString(readPath(raw, descriptor.fieldMap.websiteUrl)),
    email: asString(readPath(raw, descriptor.fieldMap.providerContact)),
    phone,
    phoneType,

    brandCode: asString(readPath(raw, "chainCode")),
    chainCode: asString(readPath(raw, "chainCode")),
    propertyTypeCode,
    propertyTypeLabel: propertyTypeCode
      ? (reference.accommodationTypes.get(propertyTypeCode) ?? null)
      : null,

    classificationCode,
    classificationLabel: master?.description ?? null,
    classificationGroup: master?.group ?? asString(readPath(raw, "categoryGroupCode")),
    // TEXT, always. `5` here covers 5 STARS, 5 KEYS, aparthotel and hostel.
    classificationSimpleCode: master?.simpleCode ?? null,

    // PR #21 established that the hotels payload carries NO structured lifecycle
    // field. Left null rather than invented from a destination-master name.
    lifecycleStatus: null,

    imageCount: images.photoCount,
    providerDesignatedPrincipalImage: images.hasProviderDesignatedPrincipal,

    // Deliberately empty. Every field this adapter reads has a typed column;
    // source_attributes is not a place to park the rest of the payload.
    attributes: {},

    // Digest over the WHOLE original record, so any provider change to any
    // field — including ones with no column — changes it.
    payloadDigest: digestValue(raw),
    // No durable off-database artifact store is chosen yet, and a local
    // filesystem path is not a URI. The manifest records which file was used.
    payloadUri: null,
  };
}

export interface AdapterOutcome extends ProviderIngestionBatch {
  /** Records the provider returned that carry no usable id. */
  recordsMissingSourcePropertyId: number;
  /** Provider ids appearing more than once in one artifact. */
  duplicateSourcePropertyIds: string[];
}

/**
 * Build the full ingestion batch for one manifest.
 *
 * `destinationId` is resolved by the caller from the `destinations` table —
 * this adapter never invents or hardcodes a canonical destination.
 */
export async function buildBatch(
  manifest: IngestionManifest,
  destinationId: string,
  repoRoot: string,
): Promise<AdapterOutcome> {
  const reference = await loadReferenceData(manifest, repoRoot);
  const rawPath = manifest.artifacts.find((a) => a.role === "raw_properties")!.relativePath;
  const payloads = JSON.parse(await readFile(path.resolve(repoRoot, rawPath), "utf8")) as unknown[];

  const observations: SourcePropertyObservationInput[] = [];
  const seen = new Set<string>();
  const duplicates: string[] = [];
  let missingId = 0;

  for (const raw of payloads) {
    const mapped = mapProperty(raw, reference);
    if (!mapped) {
      missingId += 1;
      continue;
    }
    if (seen.has(mapped.sourcePropertyId)) {
      // One run observes one property at most once (0027's unique key). A
      // duplicate is reported, never silently collapsed or double-inserted.
      duplicates.push(mapped.sourcePropertyId);
      continue;
    }
    seen.add(mapped.sourcePropertyId);
    observations.push(mapped);
  }

  const { evidence } = manifest;

  return {
    run: {
      id: deterministicUuid(runFingerprint(manifest)),
      source: manifest.provider,
      sourceEnvironment: "evaluation",
      destinationId,
      providerGeography: manifest.providerGeography,
      runMode: "evaluation",
      evidence: {
        rawRecordsSeen: evidence.rawRecordCount,
        uniqueSourcePropertyIds: evidence.uniqueSourcePropertyIdCount,
        providerReportedTotal: evidence.providerReportedTotal,
        paginationWalkCompleted: evidence.paginationWalkCompleted,
        enumerationRisks: evidence.enumerationRisks,
        coverageRisks: evidence.coverageRisks,
        originalRequestCount: evidence.originalRequestCount,
      },
      observedAt: new Date(manifest.observedAt),
      notes: buildRunNotes(manifest),
      harnessVersion: HARNESS_VERSION,
    },
    observations,
    recordsMissingSourcePropertyId: missingId,
    duplicateSourcePropertyIds: duplicates,
  };
}

/**
 * Run notes. These have one job: make it impossible to read this row as a live
 * provider extraction six months from now.
 */
export function buildRunNotes(manifest: IngestionManifest): string {
  const original =
    manifest.evidence.originalRequestCount === null
      ? "unrecorded"
      : String(manifest.evidence.originalRequestCount);
  return [
    "OFFLINE REPLAY OF A PRIOR CACHED HOTELBEDS EVALUATION EXTRACTION.",
    "This run made ZERO provider requests: request_count and cache_hit_count are 0 because",
    "this ingestion called nothing, not because the original extraction was free.",
    `Original extraction evidence: ${original} provider request(s), ` +
      `${manifest.evidence.rawRecordCount} raw records, ` +
      `provider reported total ${manifest.evidence.providerReportedTotal ?? "(none supplied)"}.`,
    `observed_at is the ARTIFACT CAPTURE timestamp (${manifest.observedAt}) — local evidence`,
    "about when the cached file was written, NOT a provider-authoritative observation time.",
    "The Hotelbeds Content API supplies no run timestamp.",
    `Manifest digest: ${manifest.manifestDigest}`,
  ].join(" ");
}
