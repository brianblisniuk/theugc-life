/**
 * Persist issue evidence, and read it back for evaluation.
 *
 * The write side is append-only by construction, and 0031's triggers enforce it
 * independently: this module contains no UPDATE and no DELETE against either
 * evidence table, and could not perform one if it tried.
 */
import type { Client } from "pg";

import type { ExtractedIssueSnapshot } from "./extract";
import type { IssueSnapshot, LifecyclePolicy } from "./policy";

export interface ProvenanceMismatch {
  sourcePropertyId: string;
  reason: "no_ingested_property" | "no_observation_with_this_payload";
  wholeRecordPayloadDigest: string;
}

export interface ExtractionCounts {
  /** Properties the artifact described. */
  extracted: number;
  /** Snapshots actually INSERTED. A replay must add none. */
  snapshotsCreated: number;
  /** Snapshots already present for that observation, left untouched. */
  snapshotsAlreadyPresent: number;
  /** Issue rows actually INSERTED. */
  issuesCreated: number;
  /** Records whose exact provider record could not be tied to an observation. */
  provenanceMismatches: ProvenanceMismatch[];
}

export const EXTRACTION_METHOD = "cached-artifact/hotelbeds/1.0.0" as const;

/**
 * Resolve `(provider id, whole-record digest) -> (identity, THAT observation)`.
 *
 * THE BINDING IS THE POINT, so it is worth being explicit about what the
 * previous version did wrong. It resolved `provider id -> LATEST observation`,
 * which is not the same question at all: extracting a CACHED ARTIFACT tells you
 * which provider RECORD you are reading, and "latest" tells you which record is
 * newest in the database. Those coincide right up until they matter.
 *
 * Concretely: run A observes property 123 with a HOTEL/CLOSED issue; run B
 * observes it later with different evidence. Re-extract artifact A afterwards
 * and the old closure lands on run B's observation — the provenance is now a
 * lie, and the CURRENT lifecycle answer changes because of a record that is not
 * current.
 *
 * So the lookup is keyed on the digest of the WHOLE provider record, which the
 * ingestion adapter already wrote to `source_payload_digest` for the observation
 * that record produced. Same bytes, same observation. If no observation carries
 * that digest, this artifact record was never ingested here and NO snapshot is
 * written — reported as a provenance mismatch rather than attached to the
 * closest available row.
 */
async function observationsByPayload(
  client: Client,
  opts: { source: string; environment: string },
): Promise<Map<string, { identityId: string; observationId: string }>> {
  const res = await client.query<{
    key: string;
    identity_id: string;
    observation_id: string;
  }>(
    `select i.source_property_id || ' ' || o.source_payload_digest as key,
            i.id as identity_id, o.id as observation_id
       from public.source_property_identities i
       join public.source_property_observations o on o.source_property_identity_id = i.id
      where i.source = $1 and i.source_environment = $2
        and o.source_payload_digest is not null`,
    [opts.source, opts.environment],
  );
  return new Map(
    res.rows.map((r) => [r.key, { identityId: r.identity_id, observationId: r.observation_id }]),
  );
}

/** Provider ids that exist here at all, to tell "not ingested" from "wrong record". */
async function knownSourcePropertyIds(
  client: Client,
  opts: { source: string; environment: string },
): Promise<Set<string>> {
  const res = await client.query<{ source_property_id: string }>(
    `select source_property_id from public.source_property_identities
      where source = $1 and source_environment = $2`,
    [opts.source, opts.environment],
  );
  return new Set(res.rows.map((r) => r.source_property_id));
}

/**
 * Write snapshots and their issue rows.
 *
 * Idempotent by the observation: a snapshot is UNIQUE per observation, so a
 * replay conflicts and does nothing. It does not "update" the existing one —
 * an immutable observation cannot acquire a second complete extraction that
 * says something different.
 */
export async function persistIssueEvidence(
  client: Client,
  snapshots: readonly ExtractedIssueSnapshot[],
  opts: { source: string; environment: string; apply: boolean },
): Promise<ExtractionCounts> {
  const byPayload = await observationsByPayload(client, opts);
  const knownIds = await knownSourcePropertyIds(client, opts);
  const counts: ExtractionCounts = {
    extracted: snapshots.length,
    snapshotsCreated: 0,
    snapshotsAlreadyPresent: 0,
    issuesCreated: 0,
    provenanceMismatches: [],
  };

  const matched: { snapshot: ExtractedIssueSnapshot; identityId: string; observationId: string }[] =
    [];
  for (const snapshot of snapshots) {
    const target = byPayload.get(
      `${snapshot.sourcePropertyId} ${snapshot.wholeRecordPayloadDigest}`,
    );
    if (!target) {
      // Two different failures, kept apart because they mean different things:
      // the property was never ingested here at all, or it was ingested from a
      // DIFFERENT provider record than the one being extracted. Neither is a
      // reason to attach the evidence to the nearest available observation.
      counts.provenanceMismatches.push({
        sourcePropertyId: snapshot.sourcePropertyId,
        reason: knownIds.has(snapshot.sourcePropertyId)
          ? "no_observation_with_this_payload"
          : "no_ingested_property",
        wholeRecordPayloadDigest: snapshot.wholeRecordPayloadDigest,
      });
      continue;
    }
    matched.push({ snapshot, ...target });
  }

  if (!opts.apply) {
    const existing = await client.query<{ n: string }>(
      `select count(*)::text as n from public.source_property_issue_snapshots
        where source = $1 and source_environment = $2`,
      [opts.source, opts.environment],
    );
    counts.snapshotsAlreadyPresent = Number(existing.rows[0]!.n);
    counts.snapshotsCreated = matched.length - counts.snapshotsAlreadyPresent;
    if (counts.snapshotsCreated < 0) counts.snapshotsCreated = 0;
    counts.issuesCreated = matched.reduce((n, m) => n + m.snapshot.issues.length, 0);
    return counts;
  }

  await client.query("begin");
  try {
    for (const { snapshot, identityId, observationId } of matched) {
      const inserted = await client.query<{ id: string }>(
        `insert into public.source_property_issue_snapshots
           (source_property_identity_id, source, source_environment, evidence_observation_id,
            extraction_status, provider_issue_count, source_payload_digest, extraction_method)
         values ($1,$2,$3,$4,'complete',$5,$6,$7)
         on conflict (evidence_observation_id) do nothing
         returning id`,
        [
          identityId,
          opts.source,
          opts.environment,
          observationId,
          snapshot.providerIssueCount,
          snapshot.wholeRecordPayloadDigest,
          EXTRACTION_METHOD,
        ],
      );

      if ((inserted.rowCount ?? 0) === 0) {
        counts.snapshotsAlreadyPresent += 1;
        continue;
      }
      counts.snapshotsCreated += 1;
      const snapshotId = inserted.rows[0]!.id;

      for (const issue of snapshot.issues) {
        const row = await client.query(
          `insert into public.source_property_issue_evidence
             (snapshot_id, source_property_identity_id, issue_code, issue_type,
              date_from_raw, date_to_raw, provider_order, alternative, description)
           values ($1,$2,$3,$4,$5,$6,$7,$8,$9)
           on conflict do nothing
           returning id`,
          [
            snapshotId,
            identityId,
            issue.issueCode,
            issue.issueType,
            issue.dateFromRaw,
            issue.dateToRaw,
            issue.providerOrder,
            issue.alternative,
            issue.description,
          ],
        );
        if ((row.rowCount ?? 0) > 0) counts.issuesCreated += 1;
      }
    }
    await client.query("commit");
  } catch (err) {
    await client.query("rollback");
    throw err;
  }

  return counts;
}

/** Load the approved policy. A draft is returned as such and refused later. */
export async function loadLifecyclePolicy(
  client: Pick<Client, "query">,
  opts: { provider: string; version?: string },
): Promise<LifecyclePolicy | null> {
  const policy = await client.query<{
    provider: string;
    version: string;
    date_semantics: string;
    approved: boolean;
  }>(
    `select provider, version, date_semantics, approved_at is not null as approved
       from public.provider_lifecycle_issue_policies
      where provider = $1 and ($2::text is null or version = $2)
      order by approved_at desc nulls last, created_at desc
      limit 1`,
    [opts.provider, opts.version ?? null],
  );
  const row = policy.rows[0];
  if (!row) return null;

  const mappings = await client.query<{
    issue_code: string;
    issue_type: string;
    outcome: string;
  }>(
    `select issue_code, issue_type, outcome
       from public.provider_lifecycle_issue_policy_mappings
      where provider = $1 and version = $2`,
    [row.provider, row.version],
  );

  return {
    provider: row.provider,
    version: row.version,
    approved: row.approved,
    dateSemantics: row.date_semantics as "inclusive_day_interval",
    mappings: mappings.rows.map((m) => ({
      issueCode: m.issue_code,
      issueType: m.issue_type,
      outcome: m.outcome as "property_closed_window",
    })),
  };
}

export interface EvaluableProperty {
  identityId: string;
  sourcePropertyId: string;
  name: string | null;
  destinationSlug: string | null;
  latestObservationId: string;
  /** NULL when the LATEST observation has no complete snapshot. */
  snapshot: IssueSnapshot | null;
}

/**
 * Load every identity with its LATEST observation and THAT observation's
 * snapshot.
 *
 * The join is deliberately `left`, and the snapshot is looked up by the latest
 * observation id alone. An older observation's snapshot is therefore invisible
 * here — which is the point: a lifted closure must not survive because a
 * historical row still says it, and a stale clean bill must not cover an
 * observation nobody extracted.
 */
export async function loadEvaluableProperties(
  client: Pick<Client, "query">,
  opts: { source: string; environment: string },
): Promise<EvaluableProperty[]> {
  const res = await client.query<{
    identity_id: string;
    source_property_id: string;
    source_name: string | null;
    slug: string | null;
    observation_id: string;
    snapshot_id: string | null;
    provider_issue_count: number | null;
  }>(
    `select distinct on (i.id)
            i.id as identity_id, i.source_property_id,
            o.source_name, d.slug,
            o.id as observation_id,
            s.id as snapshot_id, s.provider_issue_count
       from public.source_property_identities i
       join public.source_property_observations o on o.source_property_identity_id = i.id
       join public.source_runs r on r.id = o.source_run_id
       left join public.destinations d on d.id = r.destination_id
       left join public.source_property_issue_snapshots s on s.evidence_observation_id = o.id
      where i.source = $1 and i.source_environment = $2
      order by i.id, o.observed_at desc, o.id desc`,
    [opts.source, opts.environment],
  );

  const snapshotIds = res.rows.map((r) => r.snapshot_id).filter((v): v is string => v !== null);
  const issues = new Map<string, IssueSnapshot["issues"]>();
  if (snapshotIds.length > 0) {
    const rows = await client.query<{
      snapshot_id: string;
      issue_code: string;
      issue_type: string;
      date_from_raw: string | null;
      date_to_raw: string | null;
      provider_order: number | null;
      alternative: boolean | null;
    }>(
      `select snapshot_id, issue_code, issue_type,
              date_from_raw, date_to_raw,
              provider_order, alternative
         from public.source_property_issue_evidence
        where snapshot_id = any($1::uuid[])
        order by snapshot_id, provider_order nulls last, id`,
      [snapshotIds],
    );
    for (const r of rows.rows) {
      const list = issues.get(r.snapshot_id) ?? issues.set(r.snapshot_id, []).get(r.snapshot_id)!;
      list.push({
        issueCode: r.issue_code,
        issueType: r.issue_type,
        dateFromRaw: r.date_from_raw,
        dateToRaw: r.date_to_raw,
        providerOrder: r.provider_order,
        alternative: r.alternative,
      });
    }
  }

  return res.rows.map((r) => ({
    identityId: r.identity_id,
    sourcePropertyId: r.source_property_id,
    name: r.source_name,
    destinationSlug: r.slug,
    latestObservationId: r.observation_id,
    snapshot:
      r.snapshot_id === null
        ? null
        : {
            snapshotId: r.snapshot_id,
            observationId: r.observation_id,
            providerIssueCount: r.provider_issue_count ?? 0,
            issues: issues.get(r.snapshot_id) ?? [],
          },
  }));
}
