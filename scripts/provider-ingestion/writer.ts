/**
 * The GENERIC provider ingestion writer.
 *
 * Knows migration 0027 — `source_runs`, `source_property_identities`,
 * `source_property_observations` — and knows nothing about any provider's
 * payload. A second provider needs another adapter, not another writer.
 *
 * Three properties this module is responsible for:
 *
 *  1. **Evaluation-locked.** It writes `source_environment = 'evaluation'` and
 *     there is no parameter to say otherwise. Not a default — a constant.
 *  2. **Idempotent.** The run id is derived from the manifest content, so
 *     replaying the same artifacts resolves to the same run and inserts
 *     nothing. `observation_count` cannot inflate on replay.
 *  3. **All-or-nothing per destination.** One `BEGIN … COMMIT` around the whole
 *     destination, so a failure at record 3,000 cannot leave 2,999 identities
 *     and no observations.
 *
 * It writes NO canonical row: no `hotels`, no `hotel_source_identities`, no
 * `source_match_candidates`, no `source_property_reviews`. There is no SQL for
 * those tables in this file, which is the cheapest possible guarantee.
 */
import type { Client } from "pg";

import {
  EVALUATION_ENVIRONMENT,
  emptyCounts,
  type IngestionCounts,
  type ProviderIngestionBatch,
  type SourcePropertyObservationInput,
} from "./types";

/**
 * Rows per multi-row INSERT. A transport detail, never a cap on how many
 * records are ingested: every observation is written regardless of this value.
 * Sized so `chunk × columns` stays well under Postgres's 65,535 bound
 * parameters per statement.
 */
export const DEFAULT_CHUNK_SIZE = 500;

export class IngestionWriteError extends Error {
  constructor(
    message: string,
    override readonly cause?: unknown,
  ) {
    super(message);
    this.name = "IngestionWriteError";
  }
}

function chunk<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/** Build `($1,$2,…),($n,…)` for a multi-row insert of `columns.length` columns. */
function placeholders(rowCount: number, columnCount: number): string {
  const rows: string[] = [];
  for (let r = 0; r < rowCount; r += 1) {
    const cells: string[] = [];
    for (let c = 0; c < columnCount; c += 1) cells.push(`$${r * columnCount + c + 1}`);
    rows.push(`(${cells.join(",")})`);
  }
  return rows.join(",");
}

/**
 * Reject a payload that would breach 0027's 8 KB `source_attributes` trigger
 * BEFORE it reaches the database.
 *
 * The trigger is the backstop and stays the authority; failing here means the
 * adapter reports which record is at fault instead of a transaction dying
 * mid-batch with a row we would then have to hunt for.
 */
export const SOURCE_ATTRIBUTES_SOFT_LIMIT_BYTES = 4096;

export function assertAttributesBounded(
  observations: readonly SourcePropertyObservationInput[],
): void {
  for (const obs of observations) {
    if (!obs.attributes) continue;
    const bytes = Buffer.byteLength(JSON.stringify(obs.attributes), "utf8");
    if (bytes > SOURCE_ATTRIBUTES_SOFT_LIMIT_BYTES) {
      throw new IngestionWriteError(
        `source_attributes for provider property ${obs.sourcePropertyId} is ${bytes} bytes, over the ` +
          `${SOURCE_ATTRIBUTES_SOFT_LIMIT_BYTES}-byte adapter bound. source_attributes is for provider ` +
          "fields not yet modelled, not for payloads — use source_payload_digest instead.",
      );
    }
  }
}

/** Preview: what WOULD change, computed with no writes of any kind. */
export async function previewIngestion(
  client: Client,
  batch: ProviderIngestionBatch,
): Promise<IngestionCounts> {
  const counts = emptyCounts();
  const { run, observations } = batch;

  const runExists = await client.query("select 1 from public.source_runs where id = $1", [run.id]);
  if (runExists.rowCount && runExists.rowCount > 0) counts.runsExisting = 1;
  else counts.runsCreated = 1;

  const ids = observations.map((o) => o.sourcePropertyId);
  const existing = await client.query<{ source_property_id: string; id: string }>(
    `select id, source_property_id from public.source_property_identities
      where source = $1 and source_environment = $2 and source_property_id = any($3::text[])`,
    [run.source, EVALUATION_ENVIRONMENT, ids],
  );
  const existingByProviderId = new Map(existing.rows.map((r) => [r.source_property_id, r.id]));
  counts.identitiesExisting = existingByProviderId.size;
  counts.identitiesCreated = new Set(ids).size - existingByProviderId.size;

  if (existingByProviderId.size > 0) {
    const observed = await client.query<{ n: string }>(
      `select count(*)::text as n from public.source_property_observations
        where source_run_id = $1 and source_property_identity_id = any($2::uuid[])`,
      [run.id, [...existingByProviderId.values()]],
    );
    counts.observationsExisting = Number(observed.rows[0]!.n);
  }
  counts.observationsCreated = observations.length - counts.observationsExisting;
  counts.observationCountIncrements = counts.observationsCreated;

  return counts;
}

const OBSERVATION_COLUMNS = [
  "source_run_id",
  "source_property_identity_id",
  "source",
  "source_environment",
  "observed_at",
  "source_name",
  "source_destination_code",
  "source_zone_code",
  "source_address",
  "source_postal_code",
  "source_city",
  "source_latitude",
  "source_longitude",
  "source_coordinates_plausible",
  "source_website_url",
  "source_email",
  "source_phone",
  "source_phone_type",
  "source_brand_code",
  "source_chain_code",
  "source_property_type_code",
  "source_property_type_label",
  "source_classification_code",
  "source_classification_label",
  "source_classification_group",
  "source_classification_simple_code",
  "source_lifecycle_status",
  "source_image_count",
  "source_provider_designated_principal_image",
  "source_attributes",
  "source_payload_digest",
  "source_payload_uri",
] as const;

/**
 * Apply one destination's batch inside ONE transaction.
 *
 * Caller supplies the client; this function owns the transaction boundary so a
 * partial write is impossible. Note what is deliberately absent:
 * `source_classification_evidence_kind` is never written, so it takes 0027's
 * single permitted value and no adapter can promote its provider to canonical
 * star authority even by accident.
 */
export async function applyIngestion(
  client: Client,
  batch: ProviderIngestionBatch,
  options: { chunkSize?: number } = {},
): Promise<IngestionCounts> {
  const { run, observations } = batch;
  const chunkSize = options.chunkSize ?? DEFAULT_CHUNK_SIZE;
  const counts = emptyCounts();

  assertAttributesBounded(observations);

  await client.query("begin");
  try {
    // ---- 1. The run. Deterministic id makes this the idempotency anchor. ----
    const runRes = await client.query<{ id: string }>(
      `insert into public.source_runs
         (id, source, source_environment, destination_id, provider_geography, run_mode,
          run_status, started_at, completed_at, raw_records_seen, unique_source_property_ids,
          provider_reported_total, pagination_walk_completed,
          provider_enumeration_exhaustion_proven, enumeration_risks, coverage_risks,
          request_count, cache_hit_count, harness_version, notes)
       values ($1,$2,$3,$4,$5::jsonb,$6,'completed',$7,$7,$8,$9,$10,$11,$12,$13,$14,0,0,$15,$16)
       on conflict (id) do nothing
       returning id`,
      [
        run.id,
        run.source,
        EVALUATION_ENVIRONMENT,
        run.destinationId,
        JSON.stringify(run.providerGeography),
        run.runMode,
        run.observedAt.toISOString(),
        run.evidence.rawRecordsSeen,
        run.evidence.uniqueSourcePropertyIds,
        run.evidence.providerReportedTotal,
        run.evidence.paginationWalkCompleted,
        // Exhaustion is the adapter's derivation from enumeration facts; 0027's
        // CHECK independently refuses it without a completed walk and zero
        // enumeration risks.
        run.evidence.paginationWalkCompleted && run.evidence.enumerationRisks.length === 0,
        run.evidence.enumerationRisks,
        run.evidence.coverageRisks,
        run.harnessVersion,
        run.notes,
      ],
    );
    // request_count / cache_hit_count are 0 above and that is SEMANTICALLY
    // HONEST: this replay made no provider requests. The original extraction's
    // request count lives in the run notes as historical evidence, where it
    // cannot be mistaken for this row's own activity.
    if (runRes.rowCount && runRes.rowCount > 0) counts.runsCreated = 1;
    else counts.runsExisting = 1;

    // ---- 2. Identities. Durable across runs; never forked. ----
    const identityIdByProviderId = new Map<string, string>();
    const createdProviderIds = new Set<string>();

    const IDENTITY_COLUMNS = [
      "source",
      "source_environment",
      "source_property_id",
      "source_url",
      "first_seen_run_id",
      "last_seen_run_id",
      "first_seen_at",
      "last_seen_at",
    ] as const;

    for (const part of chunk(observations, chunkSize)) {
      const values: unknown[] = [];
      const observedAt = run.observedAt.toISOString();
      for (const obs of part) {
        // first/last seen both start at this run; a later run advances last_seen
        // in step 5, and first_seen is never touched again.
        values.push(
          run.source,
          EVALUATION_ENVIRONMENT,
          obs.sourcePropertyId,
          obs.sourceUrl ?? null,
          run.id,
          run.id,
          observedAt,
          observedAt,
        );
      }
      // `do update` on a no-op column so every row is RETURNED, letting one
      // statement resolve ids for new and pre-existing identities alike.
      // `xmax = 0` distinguishes a genuine insert from a touched row.
      const res = await client.query<{ id: string; source_property_id: string; inserted: boolean }>(
        `insert into public.source_property_identities (${IDENTITY_COLUMNS.join(",")})
         values ${placeholders(part.length, IDENTITY_COLUMNS.length)}
         on conflict (source, source_environment, source_property_id)
           do update set source_url = coalesce(public.source_property_identities.source_url, excluded.source_url)
         returning id, source_property_id, (xmax = 0) as inserted`,
        values,
      );
      for (const row of res.rows) {
        identityIdByProviderId.set(row.source_property_id, row.id);
        if (row.inserted) createdProviderIds.add(row.source_property_id);
      }
    }
    counts.identitiesCreated = createdProviderIds.size;
    counts.identitiesExisting = identityIdByProviderId.size - createdProviderIds.size;

    // ---- 3. Observations. Append-only; one per (run, identity). ----
    const insertedIdentityIds: string[] = [];
    for (const part of chunk(observations, chunkSize)) {
      const values: unknown[] = [];
      for (const obs of part) {
        const identityId = identityIdByProviderId.get(obs.sourcePropertyId);
        if (!identityId) {
          throw new IngestionWriteError(
            `No identity resolved for provider property ${obs.sourcePropertyId}.`,
          );
        }
        values.push(
          run.id,
          identityId,
          run.source,
          EVALUATION_ENVIRONMENT,
          run.observedAt.toISOString(),
          obs.name ?? null,
          obs.destinationCode ?? null,
          obs.zoneCode ?? null,
          obs.address ?? null,
          obs.postalCode ?? null,
          obs.city ?? null,
          obs.latitude ?? null,
          obs.longitude ?? null,
          obs.coordinatesPlausible ?? null,
          obs.websiteUrl ?? null,
          obs.email ?? null,
          obs.phone ?? null,
          obs.phoneType ?? null,
          obs.brandCode ?? null,
          obs.chainCode ?? null,
          obs.propertyTypeCode ?? null,
          obs.propertyTypeLabel ?? null,
          obs.classificationCode ?? null,
          obs.classificationLabel ?? null,
          obs.classificationGroup ?? null,
          obs.classificationSimpleCode ?? null,
          obs.lifecycleStatus ?? null,
          obs.imageCount ?? null,
          obs.providerDesignatedPrincipalImage ?? null,
          JSON.stringify(obs.attributes ?? {}),
          obs.payloadDigest ?? null,
          obs.payloadUri ?? null,
        );
      }
      const res = await client.query<{ source_property_identity_id: string }>(
        `insert into public.source_property_observations (${OBSERVATION_COLUMNS.join(",")})
         values ${placeholders(part.length, OBSERVATION_COLUMNS.length)}
         on conflict (source_run_id, source_property_identity_id) do nothing
         returning source_property_identity_id`,
        values,
      );
      for (const row of res.rows) insertedIdentityIds.push(row.source_property_identity_id);
    }
    counts.observationsCreated = insertedIdentityIds.length;
    counts.observationsExisting = observations.length - insertedIdentityIds.length;

    // ---- 4. observation_count: ONLY for genuinely new observations. ----
    for (const part of chunk(insertedIdentityIds, chunkSize)) {
      const res = await client.query(
        `update public.source_property_identities
            set observation_count = observation_count + 1
          where id = any($1::uuid[])`,
        [part],
      );
      counts.observationCountIncrements += res.rowCount ?? 0;
    }

    // ---- 5. last_seen: advance ONLY for a genuinely newer run. ----
    // Replaying the same run is a no-op (the run is not newer than itself), and
    // ingesting an OLDER cached run must not rewrite an identity's last-seen
    // backwards.
    for (const part of chunk(insertedIdentityIds, chunkSize)) {
      const res = await client.query(
        `update public.source_property_identities spi
            set last_seen_run_id = $1, last_seen_at = $2
          where spi.id = any($3::uuid[])
            and spi.last_seen_run_id <> $1
            and (select r.started_at from public.source_runs r where r.id = $1)
                > (select p.started_at from public.source_runs p where p.id = spi.last_seen_run_id)`,
        [run.id, run.observedAt.toISOString(), part],
      );
      counts.lastSeenAdvanced += res.rowCount ?? 0;
    }

    await client.query("commit");
    return counts;
  } catch (err) {
    await client.query("rollback").catch(() => {
      /* the original error is the one worth reporting */
    });
    throw err instanceof IngestionWriteError
      ? err
      : new IngestionWriteError(
          `Ingestion rolled back for ${run.source}/${run.id}: ${(err as Error).message}`,
          err,
        );
  }
}
