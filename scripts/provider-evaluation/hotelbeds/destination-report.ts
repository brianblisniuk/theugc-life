/**
 * Per-destination source analysis for the Hotelbeds bake-off.
 *
 * Answers "what does Hotelbeds KNOW about this destination" before anything
 * asks "what could be promoted into V1". That ordering is the point: every
 * record the provider returned is retained and described, and nothing is
 * discarded for being unrecognised. A source record that disappears because we
 * do not yet understand it looks identical, in the output, to a record the
 * provider never had.
 *
 * Two rules this module exists to enforce:
 *
 *  - **Provider classification is not D060 classification.** Distributions are
 *    reported as PROVIDER-APPARENT evidence and labelled as such. `H4_5`
 *    ("4 STARS AND A HALF") never becomes exact 4.
 *  - **A missing value is not automatically a provider gap.** Fields that
 *    resolve nowhere are classified against the observed payload shape, so our
 *    wrong path is never published as the provider's zero.
 *
 * Evaluation-only. Writes gitignored artifacts, never Supabase, never `hotels`.
 */
import { readPath } from "../normalize";
import type { AdapterDescriptor, ClassificationMaster } from "../types";

/** Where a mapped-but-empty field's fault actually lies. */
export type FieldVerdict =
  "populated" | "field_not_populated" | "field_map_mismatch" | "not_mapped";

export interface LiveFieldFinding {
  field: string;
  path: string | null;
  /** Records where the path resolved to a usable value. */
  resolved: number;
  sampleSize: number;
  /** True when the KEY exists in the payload, even if the value is empty. */
  keyPresentSomewhere: boolean;
  verdict: FieldVerdict;
  note?: string;
}

export interface DestinationAnalysis {
  destination: string;
  providerEntityIds: string[];
  inventory: {
    rawRecords: number;
    uniqueProviderIds: number;
    duplicateProviderIds: number;
    duplicateIdSamples: string[];
    recordsMissingProviderId: number;
    providerReportedTotal: number | null;
    requests: number;
    pages: number;
    exhaustionProven: boolean;
  };
  geography: {
    destinationCodesReturned: Record<string, number>;
    uniqueZoneCodes: number;
    zoneDistributionTop: [string, number][];
    recordsWithoutZone: number;
    /** Records whose destinationCode is NOT one of the mapped entity ids. */
    contradictions: number;
    contradictionSamples: string[];
  };
  /** PROVIDER CLASSIFICATION EVIDENCE. Never a D060 resolution. */
  providerClassification: {
    categoryCodeDistribution: Record<string, number>;
    recordsWithCategoryCode: number;
    masterJoinResolved: number;
    masterJoinResolvedPct: number;
    codesMissingFromMaster: string[];
    simpleCodeDistribution: Record<string, number>;
    categoryGroupDistribution: Record<string, number>;
    starLabelled: number;
    keyLabelled: number;
    otherLabelled: number;
    unjoined: number;
    /** Exact provider star buckets, reported WITHOUT D060 meaning. */
    providerApparent: Record<string, number>;
    accommodationTypeCodeDistribution: Record<string, number>;
    /**
     * accommodationTypeCode × category label, for records the provider labels
     * with a STAR category. PROVIDER-APPARENT ONLY — the issuing authority is
     * still unestablished, so none of this resolves D060.
     */
    starLabelledByAccommodationType: Record<string, number>;
  };
  location: {
    coordinatesPresent: number;
    coordinatesValid: number;
    coordinatesZeroZero: number;
    coordinatesOutOfRange: number;
    addressPresent: number;
    postalCodePresent: number;
  };
  identity: {
    namePresent: number;
    chainPresent: number;
    websitePresent: number;
    phoneAnyPresent: number;
    nonFaxPhonePresent: number;
    emailPresent: number;
  };
  media: {
    propertiesWithAnyImage: number;
    propertiesWithDeterministicPrincipal: number;
    propertiesWithDocumentedVisualOrderZero: number;
    totalImages: number;
    averageImages: number;
    medianImages: number;
    imagesWithUsablePath: number;
    imageTypeDistribution: Record<string, number>;
  };
  fieldFindings: LiveFieldFinding[];
}

type Row = Record<string, unknown>;

function count<T extends string | number>(values: readonly T[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const v of values) {
    const key = String(v);
    out[key] = (out[key] ?? 0) + 1;
  }
  return out;
}

function topEntries(dist: Record<string, number>, n: number): [string, number][] {
  return Object.entries(dist)
    .sort((a, b) => b[1] - a[1])
    .slice(0, n);
}

function median(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[mid] ?? 0;
  return ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2;
}

function nonEmpty(value: unknown): boolean {
  if (value === null || value === undefined) return false;
  if (typeof value === "string") return value.trim() !== "";
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.length > 0;
  return true;
}

/** Does this key path exist anywhere in the sample, even holding an empty value? */
function keyExistsSomewhere(rows: readonly Row[], path: string | null | undefined): boolean {
  if (!path) return false;
  const head = path.split(".")[0];
  if (!head) return false;
  return rows.some((r) => head in r);
}

/**
 * Classify a mapped field that resolved on few or no records.
 *
 * The distinction the brief insists on: if the provider's payload has no such
 * key at all, our descriptor is wrong (`field_map_mismatch`). If the key exists
 * but is empty, the provider genuinely does not populate it here
 * (`field_not_populated`). Collapsing the two publishes our bug as their gap.
 */
function classifyField(
  field: string,
  path: string | null | undefined,
  resolved: number,
  rows: readonly Row[],
  note?: string,
): LiveFieldFinding {
  const sampleSize = rows.length;
  if (!path) {
    return {
      field,
      path: null,
      resolved: 0,
      sampleSize,
      keyPresentSomewhere: false,
      verdict: "not_mapped",
      ...(note ? { note } : {}),
    };
  }
  const keyPresentSomewhere = keyExistsSomewhere(rows, path);
  let verdict: FieldVerdict = "populated";
  if (resolved === 0) verdict = keyPresentSomewhere ? "field_not_populated" : "field_map_mismatch";
  return {
    field,
    path,
    resolved,
    sampleSize,
    keyPresentSomewhere,
    verdict,
    ...(note ? { note } : {}),
  };
}

const FAX_HINT = /FAX/i;

/**
 * Analyse one destination's raw provider payloads.
 *
 * `payloads` are the untransformed provider records; `master` is the joined
 * category reference. Nothing is filtered out on the way in.
 */
export function analyseDestination(
  destination: string,
  providerEntityIds: readonly string[],
  payloads: readonly unknown[],
  descriptor: AdapterDescriptor,
  master: ReadonlyMap<string, ClassificationMaster>,
  pagination: {
    requests: number;
    pages: number;
    providerReportedTotal: number | null;
    exhaustionProven: boolean;
  },
): DestinationAnalysis {
  const rows = payloads.filter((p): p is Row => typeof p === "object" && p !== null);
  const { fieldMap, imageFieldMap } = descriptor;

  // ---- inventory -----------------------------------------------------------
  const ids = rows
    .map((r) => readPath(r, fieldMap.sourcePropertyId))
    .map((v) => (v === null || v === undefined ? null : String(v)));
  const presentIds = ids.filter((v): v is string => v !== null && v !== "");
  const idCounts = count(presentIds);
  const duplicates = Object.entries(idCounts).filter(([, n]) => n > 1);

  // ---- geography -----------------------------------------------------------
  const destCodes = rows.map((r) => String(readPath(r, "destinationCode") ?? ""));
  const zoneCodes = rows.map((r) => readPath(r, "zoneCode"));
  const zonePresent = zoneCodes.filter((z) => z !== null && z !== undefined);
  const zoneDist = count(zonePresent.map((z) => String(z)));
  const mapped = new Set(providerEntityIds);
  const contradictionRows = rows.filter((_r, i) => {
    const code = destCodes[i] ?? "";
    return code !== "" && !mapped.has(code);
  });

  // ---- provider classification --------------------------------------------
  const codePath = descriptor.classification.codePath ?? null;
  const categoryCodes = rows.map((r) => (codePath ? readPath(r, codePath) : null));
  const categoryPresent = categoryCodes.filter((c): c is string | number => nonEmpty(c));
  const categoryDist = count(categoryPresent.map((c) => String(c)));

  const missingFromMaster = new Set<string>();
  let joined = 0;
  const simpleCodes: string[] = [];
  const groups: string[] = [];
  let starLabelled = 0;
  let keyLabelled = 0;
  let otherLabelled = 0;

  for (const raw of categoryPresent) {
    const code = String(raw);
    const entry = master.get(code);
    if (!entry) {
      missingFromMaster.add(code);
      continue;
    }
    joined += 1;
    simpleCodes.push(entry.simpleCode ?? "(none)");
    groups.push(entry.group ?? "(none)");
    const description = entry.description ?? "";
    if (/STAR/i.test(description)) starLabelled += 1;
    else if (/KEY/i.test(description)) keyLabelled += 1;
    else otherLabelled += 1;
  }

  // Exact provider star buckets. These are PROVIDER-APPARENT labels, reported
  // verbatim so that "4 STARS AND A HALF" stays visibly distinct from "4 STARS"
  // and can never be rounded into an exact-four count.
  const providerApparent: Record<string, number> = {};
  for (const raw of categoryPresent) {
    const code = String(raw);
    const entry = master.get(code);
    if (!entry) {
      providerApparent["unjoined_no_master_entry"] =
        (providerApparent["unjoined_no_master_entry"] ?? 0) + 1;
      continue;
    }
    const description = entry.description ?? "";
    const bucket =
      /STAR/i.test(description) || /KEY/i.test(description)
        ? `${code} — ${description}`
        : "other_provider_category";
    providerApparent[bucket] = (providerApparent[bucket] ?? 0) + 1;
  }

  const accommodationTypes = rows.map((r) =>
    String(readPath(r, "accommodationTypeCode") ?? "(none)"),
  );

  // Cross-tab: what accommodation type carries a STAR-labelled category? This
  // is the pairing D060 eventually needs (HOTEL + "5 STARS"), which is exactly
  // why it must stay labelled PROVIDER-APPARENT — the issuing authority is
  // unestablished, so a convincing-looking pairing still resolves nothing.
  const starLabelledByAccommodationType: Record<string, number> = {};
  for (const r of rows) {
    const code = codePath ? readPath(r, codePath) : null;
    if (!nonEmpty(code)) continue;
    const entry = master.get(String(code));
    if (!entry || !/STAR/i.test(entry.description ?? "")) continue;
    const type = String(readPath(r, "accommodationTypeCode") ?? "(none)");
    const bucket = `${type} × ${entry.description ?? String(code)}`;
    starLabelledByAccommodationType[bucket] = (starLabelledByAccommodationType[bucket] ?? 0) + 1;
  }

  // ---- location ------------------------------------------------------------
  let coordsPresent = 0;
  let coordsValid = 0;
  let coordsZero = 0;
  let coordsOutOfRange = 0;
  for (const r of rows) {
    const lat = readPath(r, fieldMap.latitude);
    const lon = readPath(r, fieldMap.longitude);
    if (typeof lat !== "number" || typeof lon !== "number") continue;
    coordsPresent += 1;
    if (lat === 0 && lon === 0) {
      coordsZero += 1;
      continue;
    }
    if (Math.abs(lat) > 90 || Math.abs(lon) > 180) {
      coordsOutOfRange += 1;
      continue;
    }
    coordsValid += 1;
  }

  const addressPresent = rows.filter((r) => nonEmpty(readPath(r, fieldMap.address))).length;
  const postalPresent = rows.filter((r) => nonEmpty(readPath(r, "postalCode"))).length;

  // ---- identity / contact --------------------------------------------------
  const namePresent = rows.filter((r) => nonEmpty(readPath(r, fieldMap.name))).length;
  const chainPresent = rows.filter((r) => nonEmpty(readPath(r, fieldMap.chain))).length;
  const websitePresent = rows.filter((r) => nonEmpty(readPath(r, fieldMap.websiteUrl))).length;
  const emailPresent = rows.filter((r) => nonEmpty(readPath(r, fieldMap.providerContact))).length;

  // Phones are an ARRAY with a type. `phones.0.phoneNumber` can land on a fax,
  // so "has a phone" and "has a phone that is not a fax" are counted apart.
  let phoneAny = 0;
  let phoneNonFax = 0;
  for (const r of rows) {
    const phones = readPath(r, "phones");
    if (!Array.isArray(phones) || phones.length === 0) continue;
    phoneAny += 1;
    const usable = phones.some((p) => {
      const type = String(readPath(p, "phoneType") ?? "");
      return nonEmpty(readPath(p, "phoneNumber")) && !FAX_HINT.test(type);
    });
    if (usable) phoneNonFax += 1;
  }

  // ---- media ---------------------------------------------------------------
  const imageCounts: number[] = [];
  let withAnyImage = 0;
  let deterministicPrincipal = 0;
  let documentedZero = 0;
  let imagesWithPath = 0;
  const imageTypes: string[] = [];

  for (const r of rows) {
    const raw = fieldMap.photos ? readPath(r, fieldMap.photos) : null;
    const images = Array.isArray(raw) ? raw : [];
    imageCounts.push(images.length);
    if (images.length > 0) withAnyImage += 1;

    const orders: number[] = [];
    for (const image of images) {
      if (imageFieldMap.path && nonEmpty(readPath(image, imageFieldMap.path))) imagesWithPath += 1;
      if (imageFieldMap.type) {
        const t = readPath(image, imageFieldMap.type);
        if (nonEmpty(t)) imageTypes.push(String(t));
      }
      if (imageFieldMap.visualOrder) {
        const v = readPath(image, imageFieldMap.visualOrder);
        if (typeof v === "number") orders.push(v);
      }
    }
    if (orders.includes(0)) documentedZero += 1;
    if (orders.length > 0) {
      const max = Math.max(...orders);
      if (orders.filter((v) => v === max).length === 1) deterministicPrincipal += 1;
    }
  }

  const totalImages = imageCounts.reduce((a, b) => a + b, 0);

  // ---- field findings ------------------------------------------------------
  const fieldFindings: LiveFieldFinding[] = [
    classifyField("sourcePropertyId", fieldMap.sourcePropertyId, presentIds.length, rows),
    classifyField("name", fieldMap.name, namePresent, rows),
    classifyField("classification.codePath", codePath, categoryPresent.length, rows),
    classifyField(
      "destinationCode",
      "destinationCode",
      destCodes.filter((c) => c !== "").length,
      rows,
    ),
    classifyField("zoneCode", "zoneCode", zonePresent.length, rows),
    classifyField(
      "propertyType (accommodationTypeCode)",
      fieldMap.propertyType,
      rows.filter((r) => nonEmpty(readPath(r, fieldMap.propertyType))).length,
      rows,
    ),
    classifyField("latitude", fieldMap.latitude, coordsPresent, rows),
    classifyField("longitude", fieldMap.longitude, coordsPresent, rows),
    classifyField("address", fieldMap.address, addressPresent, rows),
    classifyField("postalCode", "postalCode", postalPresent, rows),
    classifyField("chain (chainCode)", fieldMap.chain, chainPresent, rows),
    classifyField("websiteUrl", fieldMap.websiteUrl, websitePresent, rows),
    classifyField(
      "phone",
      fieldMap.phone,
      rows.filter((r) => nonEmpty(readPath(r, fieldMap.phone))).length,
      rows,
      "phones[] carries phoneType; index 0 can be a FAXNUMBER, so a non-fax count is reported separately.",
    ),
    classifyField("providerContact (email)", fieldMap.providerContact, emailPresent, rows),
    classifyField("photos (images)", fieldMap.photos, withAnyImage, rows),
    classifyField(
      "image path",
      imageFieldMap.path ? `images[].${imageFieldMap.path}` : null,
      imagesWithPath,
      rows,
      "Counted per IMAGE, not per property.",
    ),
    classifyField(
      "image type",
      imageFieldMap.type ? `images[].${imageFieldMap.type}` : null,
      imageTypes.length,
      rows,
      "Counted per IMAGE, not per property.",
    ),
    classifyField(
      "image visualOrder === 0 (DOCUMENTED principal rule)",
      imageFieldMap.visualOrder ? `images[].${imageFieldMap.visualOrder}` : null,
      documentedZero,
      rows,
      "The documented rule. Live visualOrder values are large ranks, so a zero result here contradicts the documentation rather than showing missing data.",
    ),
    classifyField(
      "activeStatus",
      fieldMap.activeStatus,
      0,
      rows,
      "Unmapped on purpose: the hotels response carries no lifecycle field.",
    ),
  ];

  return {
    destination,
    providerEntityIds: [...providerEntityIds],
    inventory: {
      rawRecords: rows.length,
      uniqueProviderIds: Object.keys(idCounts).length,
      duplicateProviderIds: duplicates.reduce((sum, [, n]) => sum + (n - 1), 0),
      duplicateIdSamples: duplicates.slice(0, 10).map(([id, n]) => `${id} x${n}`),
      recordsMissingProviderId: rows.length - presentIds.length,
      providerReportedTotal: pagination.providerReportedTotal,
      requests: pagination.requests,
      pages: pagination.pages,
      exhaustionProven: pagination.exhaustionProven,
    },
    geography: {
      destinationCodesReturned: count(destCodes.filter((c) => c !== "")),
      uniqueZoneCodes: Object.keys(zoneDist).length,
      zoneDistributionTop: topEntries(zoneDist, 15),
      recordsWithoutZone: rows.length - zonePresent.length,
      contradictions: contradictionRows.length,
      contradictionSamples: contradictionRows
        .slice(0, 10)
        .map(
          (r) =>
            `${String(readPath(r, fieldMap.sourcePropertyId))}:${String(readPath(r, "destinationCode"))}`,
        ),
    },
    providerClassification: {
      categoryCodeDistribution: categoryDist,
      recordsWithCategoryCode: categoryPresent.length,
      masterJoinResolved: joined,
      masterJoinResolvedPct:
        categoryPresent.length === 0
          ? 0
          : Number(((joined / categoryPresent.length) * 100).toFixed(2)),
      codesMissingFromMaster: [...missingFromMaster],
      simpleCodeDistribution: count(simpleCodes),
      categoryGroupDistribution: count(groups),
      starLabelled,
      keyLabelled,
      otherLabelled,
      unjoined: categoryPresent.length - joined,
      providerApparent,
      accommodationTypeCodeDistribution: count(accommodationTypes),
      starLabelledByAccommodationType,
    },
    location: {
      coordinatesPresent: coordsPresent,
      coordinatesValid: coordsValid,
      coordinatesZeroZero: coordsZero,
      coordinatesOutOfRange: coordsOutOfRange,
      addressPresent,
      postalCodePresent: postalPresent,
    },
    identity: {
      namePresent,
      chainPresent,
      websitePresent,
      phoneAnyPresent: phoneAny,
      nonFaxPhonePresent: phoneNonFax,
      emailPresent,
    },
    media: {
      propertiesWithAnyImage: withAnyImage,
      propertiesWithDeterministicPrincipal: deterministicPrincipal,
      propertiesWithDocumentedVisualOrderZero: documentedZero,
      totalImages,
      averageImages: rows.length === 0 ? 0 : Number((totalImages / rows.length).toFixed(2)),
      medianImages: median(imageCounts),
      imagesWithUsablePath: imagesWithPath,
      imageTypeDistribution: count(imageTypes),
    },
    fieldFindings,
  };
}

/** Raised when live records contradict the approved geography mapping. */
export class GeographyMappingContradictionError extends Error {
  constructor(
    readonly destination: string,
    readonly expected: readonly string[],
    readonly observed: Record<string, number>,
  ) {
    super(
      `GEOGRAPHY_MAPPING_CONTRADICTION for "${destination}": records were returned whose ` +
        `destinationCode is outside the approved mapping [${expected.join(", ")}]. ` +
        `Observed: ${JSON.stringify(observed)}.\n\n` +
        "Stopping rather than reconciling silently — an extraction whose geography does not " +
        "mean what the mapping says it means produces counts that look precise and are not.",
    );
    this.name = "GeographyMappingContradictionError";
  }
}
