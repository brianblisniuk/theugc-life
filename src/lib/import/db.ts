/**
 * Import persistence layer (admin/service-role tooling). Talks to Postgres via
 * `pg` using DATABASE_URL. All writes target import/provenance tables only —
 * this module never writes canonical hotels/contacts (no promotion in 1A) and
 * never writes creator-intelligence tables.
 */
import type { Client } from "pg";

import { nameMatchKey, normalizeUrl } from "./normalize";
import type { ExistingData, ExistingDestination, ExistingHotel, ResolutionResult } from "./resolve";
import type { ReportBatchMeta, ReportInput } from "./report";
import type { PropertyResolution } from "./resolve";
import type { StagedRow, ValidationStatus } from "./stage";
import type { RowKind } from "./contract";

const SAFE_METHODS = new Set(["exact_name_plus_destination", "canonical_url_plus_name"]);

// Deterministic scope -> organization type (mirrors resolve.ts). Reconstructed
// from scope, never from free-text review_note (review F5).
const ORG_SCOPE_TO_TYPE: Record<string, string> = {
  group: "hotel_group",
  operator: "operator",
  agency: "pr_agency",
  brand: "hotel_group",
};

export interface BatchMeta {
  sourceName: string;
  sourceFileName: string | null;
  sourceKind: "canonical" | "legacy";
  parserName: string;
  parserVersion: string;
  fileSha256: string | null;
}

export interface RowCounters {
  total: number;
  valid: number;
  warning: number;
  review: number;
  rejected: number;
}

function rowKey(sheet: string, rowNum: number): string {
  return `${sheet}#${rowNum}`;
}

/** Load existing canonical entities used for matching. */
export async function loadExistingData(client: Client): Promise<ExistingData> {
  const hotels = await client.query<{
    id: string;
    name: string;
    destination_id: string | null;
    country_code: string | null;
    website_url: string | null;
  }>("select id, name, destination_id, country_code, website_url from public.hotels");

  const destinations = await client.query<{
    id: string;
    name: string;
    slug: string;
    country_code: string | null;
  }>("select id, name, slug, country_code from public.destinations");

  const hotelRows: ExistingHotel[] = hotels.rows.map((h) => {
    const url = normalizeUrl(h.website_url);
    return {
      id: h.id,
      name: h.name,
      nameMatchKey: nameMatchKey(h.name),
      destinationId: h.destination_id,
      countryCode: h.country_code,
      websiteNormalized: url.normalized,
      websiteHost: url.host,
    };
  });

  const destRows: ExistingDestination[] = destinations.rows.map((d) => ({
    id: d.id,
    name: d.name,
    nameFold: nameMatchKey(d.name),
    slug: d.slug,
    countryCode: d.country_code,
  }));

  return { hotels: hotelRows, destinations: destRows };
}

/** Find a prior batch for the same file+parser (idempotency / repeat detection). */
export async function findReusableBatch(
  client: Client,
  meta: BatchMeta,
): Promise<{ id: string; status: string } | null> {
  if (!meta.fileSha256) return null;
  const res = await client.query<{ id: string; status: string }>(
    `select id, status from public.import_batches
       where file_sha256 = $1 and parser_name = $2 and parser_version = $3
       order by created_at desc limit 1`,
    [meta.fileSha256, meta.parserName, meta.parserVersion],
  );
  return res.rows[0] ?? null;
}

export async function createBatch(client: Client, meta: BatchMeta): Promise<string> {
  const res = await client.query<{ id: string }>(
    `insert into public.import_batches
       (source_name, source_file_name, source_kind, parser_name, parser_version,
        file_sha256, status, started_at)
     values ($1,$2,$3,$4,$5,$6,'parsing', now())
     returning id`,
    [
      meta.sourceName,
      meta.sourceFileName,
      meta.sourceKind,
      meta.parserName,
      meta.parserVersion,
      meta.fileSha256,
    ],
  );
  return res.rows[0]!.id;
}

/** Insert staged rows; returns a map of sheet#rowNumber -> import_row_id. */
export async function insertStagedRows(
  client: Client,
  batchId: string,
  rows: StagedRow[],
): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  for (const r of rows) {
    const res = await client.query<{ id: string }>(
      `insert into public.import_rows
         (import_batch_id, sheet_name, source_row_number, row_kind, source_property_key,
          raw_data, raw_fingerprint, normalized_data, validation_status,
          validation_errors, validation_warnings)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
       returning id`,
      [
        batchId,
        r.sheetName,
        r.sourceRowNumber,
        r.rowKind,
        r.sourcePropertyKey,
        JSON.stringify(r.raw),
        r.rawFingerprint,
        r.normalized ? JSON.stringify(r.normalized) : null,
        r.status,
        r.errors,
        r.warnings,
      ],
    );
    map.set(rowKey(r.sheetName, r.sourceRowNumber), res.rows[0]!.id);
  }
  return map;
}

export async function updateBatchCounters(
  client: Client,
  batchId: string,
  counters: RowCounters,
  status: string,
): Promise<void> {
  await client.query(
    `update public.import_batches set
       total_rows=$2, valid_rows=$3, warning_rows=$4, review_rows=$5, rejected_rows=$6,
       status=$7, completed_at=now()
     where id=$1`,
    [
      batchId,
      counters.total,
      counters.valid,
      counters.warning,
      counters.review,
      counters.rejected,
      status,
    ],
  );
}

/** Persist match candidates (hotel + destination + organization) for a batch. */
export async function persistResolution(
  client: Client,
  resolution: ResolutionResult,
  rowIdMap: Map<string, string>,
): Promise<void> {
  for (const pr of resolution.properties) {
    const importRowId = rowIdMap.get(rowKey(pr.stagedRow.sheetName, pr.stagedRow.sourceRowNumber));
    if (!importRowId) continue;

    // Destination resolution as a candidate (explicit unresolved marker too).
    await client.query(
      `insert into public.import_match_candidates
         (import_row_id, candidate_entity_type, candidate_entity_id, score, match_method, review_note)
       values ($1,'destination',$2,$3,$4,$5)`,
      [
        importRowId,
        pr.destinationId,
        pr.destinationId ? 1 : 0,
        pr.destinationUnresolved ? "unresolved" : (pr.destinationMethod ?? "resolved"),
        pr.destinationUnresolved
          ? "Destination could not be resolved against the hierarchy."
          : null,
      ],
    );

    for (const c of pr.hotelCandidates) {
      await client.query(
        `insert into public.import_match_candidates
           (import_row_id, candidate_entity_type, candidate_entity_id, score, match_method, review_note)
         values ($1,$2,$3,$4,$5,$6)`,
        [
          importRowId,
          c.candidateEntityType,
          c.candidateEntityId,
          c.score,
          c.matchMethod,
          c.explanation,
        ],
      );
    }
  }

  for (const org of resolution.organizationCandidates) {
    const importRowId = rowIdMap.get(rowKey(org.sheetName, org.sourceRowNumber));
    if (!importRowId) continue;
    await client.query(
      `insert into public.import_match_candidates
         (import_row_id, candidate_entity_type, candidate_entity_id, score, match_method, review_note)
       values ($1,'organization',null,0,$2,$3)`,
      [importRowId, `org_scope:${org.scope}`, `${org.inferredType}: ${org.reason}`],
    );
  }
}

async function getBatchMeta(client: Client, batchId: string): Promise<ReportBatchMeta> {
  const res = await client.query(
    `select id, source_name, source_file_name, source_kind, parser_name, parser_version,
            file_sha256, status, created_at
       from public.import_batches where id = $1`,
    [batchId],
  );
  const b = res.rows[0];
  if (!b) throw new Error(`Batch not found: ${batchId}`);
  return {
    id: b.id,
    sourceName: b.source_name,
    sourceFileName: b.source_file_name,
    sourceKind: b.source_kind,
    parserName: b.parser_name,
    parserVersion: b.parser_version,
    fileSha256: b.file_sha256,
    status: b.status,
    createdAt: new Date(b.created_at).toISOString(),
  };
}

/** Rebuild the full report input (rows + resolution) from persisted DB state. */
export async function getBatchReportInput(client: Client, batchId: string): Promise<ReportInput> {
  const batch = await getBatchMeta(client, batchId);

  const rowsRes = await client.query(
    `select id, sheet_name, source_row_number, row_kind, source_property_key,
            raw_data, raw_fingerprint, normalized_data, validation_status,
            validation_errors, validation_warnings
       from public.import_rows where import_batch_id = $1
       order by sheet_name, source_row_number`,
    [batchId],
  );

  const rows: StagedRow[] = rowsRes.rows.map((r) => ({
    sheetName: r.sheet_name,
    sourceRowNumber: r.source_row_number,
    rowKind: r.row_kind as RowKind,
    sourcePropertyKey: r.source_property_key,
    raw: r.raw_data,
    rawFingerprint: r.raw_fingerprint,
    normalized: r.normalized_data,
    status: r.validation_status as ValidationStatus,
    errors: r.validation_errors ?? [],
    warnings: r.validation_warnings ?? [],
  }));

  const rowById = new Map(rowsRes.rows.map((r) => [r.id as string, r]));

  const candRes = await client.query(
    `select mc.import_row_id, mc.candidate_entity_type, mc.candidate_entity_id,
            mc.score, mc.match_method, mc.review_note
       from public.import_match_candidates mc
       join public.import_rows ir on ir.id = mc.import_row_id
       where ir.import_batch_id = $1`,
    [batchId],
  );

  // Rebuild resolution grouped by property row.
  const propertyResolutions = new Map<string, PropertyResolution>();
  const orgCandidates: ResolutionResult["organizationCandidates"] = [];

  for (const r of rows) {
    if (r.rowKind !== "property" || !r.normalized) continue;
    propertyResolutions.set(rowKey(r.sheetName, r.sourceRowNumber), {
      stagedRow: r,
      property: r.normalized as never,
      destinationId: null,
      destinationMethod: null,
      destinationUnresolved: true,
      hotelCandidates: [],
    });
  }

  for (const c of candRes.rows) {
    const srcRow = rowById.get(c.import_row_id);
    if (!srcRow) continue;
    const key = rowKey(srcRow.sheet_name, srcRow.source_row_number);
    if (c.candidate_entity_type === "organization") {
      // Identity comes ONLY from the persisted contact row's explicit
      // normalized organizationName — never from review_note, contact person,
      // email, or property key (review F5). Type is derived from scope.
      const scope = String(c.match_method).replace("org_scope:", "");
      const normalized = (srcRow.normalized_data ?? {}) as { organizationName?: string | null };
      const orgName = normalized.organizationName ?? null;
      if (orgName) {
        orgCandidates.push({
          name: orgName,
          inferredType: ORG_SCOPE_TO_TYPE[scope] ?? "other",
          scope,
          sourcePropertyKey: srcRow.source_property_key ?? "",
          sheetName: srcRow.sheet_name,
          sourceRowNumber: srcRow.source_row_number,
          reason: c.review_note ?? "",
        });
      }
      continue;
    }
    const pr = propertyResolutions.get(key);
    if (!pr) continue;
    if (c.candidate_entity_type === "destination") {
      pr.destinationUnresolved = c.match_method === "unresolved" || c.candidate_entity_id === null;
      pr.destinationId = c.candidate_entity_id;
      pr.destinationMethod = c.match_method === "unresolved" ? null : c.match_method;
    } else if (c.candidate_entity_type === "hotel") {
      pr.hotelCandidates.push({
        candidateEntityType: "hotel",
        candidateEntityId: c.candidate_entity_id,
        score: Number(c.score),
        matchMethod: c.match_method,
        explanation: c.review_note ?? "",
        deterministicSafe: SAFE_METHODS.has(c.match_method),
      });
    }
  }

  return {
    batch,
    rows,
    resolution: {
      properties: Array.from(propertyResolutions.values()),
      organizationCandidates: orgCandidates,
    },
  };
}
