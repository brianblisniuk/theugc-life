/**
 * Persist issue evidence, and read it back for evaluation.
 *
 * The write side is append-only by construction, and 0031's triggers enforce it
 * independently: this module contains no UPDATE and no DELETE against either
 * evidence table, and could not perform one if it tried.
 */
import type { Client } from "pg";

import { digestValue } from "../provider-ingestion/digest";
import type { ExtractedIssueSnapshot } from "./extract";
import type { IssueSnapshot, LifecyclePolicy } from "./policy";

export interface ProvenanceMismatch {
  sourcePropertyId: string;
  /**
   * `no_exact_observation_match` rather than the older
   * `no_observation_with_this_payload`, which stopped being true when the
   * lookup gained the RUN: an observation carrying this payload may well exist
   * — in a DIFFERENT run — and saying otherwise would send a reader looking for
   * the wrong thing. What is missing is the exact `(run, property, payload)`
   * triple.
   */
  reason: "no_ingested_property" | "no_exact_observation_match";
  sourceRunId: string;
  wholeRecordPayloadDigest: string;
}

export interface ExtractionCounts {
  /** Records the artifact yielded a COMPLETE snapshot for. Not raw records read. */
  completeSnapshotsExtracted: number;
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
 * Two inputs claim the same observation and disagree about what to write.
 *
 * Refused BEFORE any write, because there is no honest way to choose: picking
 * the first or the last would let ARRAY ORDER decide which extraction becomes
 * the permanent, append-only record of what the provider said.
 */
export class MalformedIssueBatchError extends Error {
  constructor(
    readonly observationId: string,
    readonly variants: number,
  ) {
    super(
      `Malformed batch: ${variants} different extractions target observation ${observationId}. ` +
        "One observation may have exactly one complete extraction, and this batch does not say " +
        "which. Nothing was written. Deduplicate the input — for example a repeated " +
        "`--destinations` argument — or resolve the disagreement before extracting.",
    );
    this.name = "MalformedIssueBatchError";
  }
}

/**
 * What this input INTENDS to persist, as one comparable value.
 *
 * Everything that would reach a column: the provenance the snapshot claims, the
 * count it asserts, and every issue row it would write, in order. Two inputs
 * agreeing on all of it are the same instruction repeated; disagreeing on any of
 * it is a contradiction, not a duplicate.
 */
function intendedWriteDigest(snapshot: ExtractedIssueSnapshot): string {
  return digestValue({
    sourceRunId: snapshot.sourceRunId,
    sourcePropertyId: snapshot.sourcePropertyId,
    wholeRecordPayloadDigest: snapshot.wholeRecordPayloadDigest,
    providerIssueCount: snapshot.providerIssueCount,
    issues: snapshot.issues,
  });
}

/**
 * ONE PLAN ITEM PER TARGET OBSERVATION.
 *
 * The write plan is only a preview of the apply if each observation appears in
 * it once. It did not: a batch containing the same extraction twice planned two
 * creations, while apply inserted one and let `on conflict do nothing` swallow
 * the second — so `--destinations bali,bali` made the dry-run wrong by exactly
 * one duplicate. Fixing that with arithmetic would be patching the symptom; the
 * plan itself has to be a set.
 *
 * EXACT duplicates collapse deterministically — repeating an identical
 * instruction is not a conflict, and the second one adds nothing.
 *
 * DISAGREEING duplicates FAIL CLOSED, before any write. Choosing one by input
 * order would let array position decide which extraction becomes the permanent
 * record of what the provider said.
 */
function collapseByObservation(
  matched: readonly {
    snapshot: ExtractedIssueSnapshot;
    identityId: string;
    observationId: string;
  }[],
): { snapshot: ExtractedIssueSnapshot; identityId: string; observationId: string }[] {
  const byObservation = new Map<string, { item: (typeof matched)[number]; digests: Set<string> }>();

  for (const item of matched) {
    const digest = intendedWriteDigest(item.snapshot);
    const existing = byObservation.get(item.observationId);
    if (!existing) {
      byObservation.set(item.observationId, { item, digests: new Set([digest]) });
      continue;
    }
    existing.digests.add(digest);
  }

  for (const [observationId, { digests }] of byObservation) {
    if (digests.size > 1) throw new MalformedIssueBatchError(observationId, digests.size);
  }

  return [...byObservation.values()].map((v) => v.item);
}

/**
 * Resolve `(source run, provider id, whole-record digest) -> THAT observation`.
 *
 * THE BINDING IS THE POINT, so it is worth being explicit about the two things
 * that were wrong before.
 *
 * First it resolved `provider id -> LATEST observation`, which answers "which
 * observation is newest?" rather than "which observation did this artifact
 * record produce?". Re-extracting an OLD cached artifact after a newer run
 * existed would attach the old closure to the new observation.
 *
 * Then it resolved `(provider id, whole-record digest)`, which is better and
 * still ambiguous: TWO RUNS MAY LEGITIMATELY CONTAIN THE SAME UNCHANGED RECORD.
 * Observations are unique per `(source_run_id, source_property_identity_id)`,
 * NOT per digest, so `123 + D -> observation A` and `123 + D -> observation B`
 * are both valid rows. A map keyed on `(id, digest)` cannot even represent both,
 * and whichever survived would decide provenance by insertion order.
 *
 * A digest proves CONTENT equality. It does not name a run. So the key includes
 * the SOURCE RUN, taken from the ingestion pipeline's own deterministic run
 * identity, and an extraction from run A binds only to run A's observation —
 * regardless of row order, map order, `observed_at`, or which is latest.
 */
async function observationsByRunAndPayload(
  client: Client,
  opts: { source: string; environment: string },
): Promise<Map<string, { identityId: string; observationId: string }>> {
  const res = await client.query<{
    key: string;
    identity_id: string;
    observation_id: string;
  }>(
    `select o.source_run_id::text || ' ' || i.source_property_id || ' ' || o.source_payload_digest
              as key,
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

/** The key that names ONE observation. Run first: it is what disambiguates. */
const provenanceKey = (s: {
  sourceRunId: string;
  sourcePropertyId: string;
  wholeRecordPayloadDigest: string;
}) => `${s.sourceRunId} ${s.sourcePropertyId} ${s.wholeRecordPayloadDigest}`;

/**
 * Which of THESE observations already carry a complete snapshot?
 *
 * Batch-scoped on purpose: the only thing that can make this apply write less
 * than it plans to is an existing snapshot on one of ITS OWN observations.
 * Snapshots belonging to properties outside the batch are irrelevant, and
 * counting them globally is what made the old preview wrong.
 */
async function snapshotsPresentFor(
  client: Client,
  observationIds: readonly string[],
): Promise<Set<string>> {
  if (observationIds.length === 0) return new Set();
  const res = await client.query<{ evidence_observation_id: string }>(
    `select evidence_observation_id from public.source_property_issue_snapshots
      where evidence_observation_id = any($1::uuid[])`,
    [observationIds],
  );
  return new Set(res.rows.map((r) => r.evidence_observation_id));
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
  const byRunAndPayload = await observationsByRunAndPayload(client, opts);
  const knownIds = await knownSourcePropertyIds(client, opts);
  const counts: ExtractionCounts = {
    completeSnapshotsExtracted: snapshots.length,
    snapshotsCreated: 0,
    snapshotsAlreadyPresent: 0,
    issuesCreated: 0,
    provenanceMismatches: [],
  };

  const matched: { snapshot: ExtractedIssueSnapshot; identityId: string; observationId: string }[] =
    [];
  for (const snapshot of snapshots) {
    const target = byRunAndPayload.get(provenanceKey(snapshot));
    if (!target) {
      // Two different failures, kept apart because they mean different things:
      // the property was never ingested here at all, or it was ingested from a
      // DIFFERENT provider record than the one being extracted. Neither is a
      // reason to attach the evidence to the nearest available observation.
      counts.provenanceMismatches.push({
        sourcePropertyId: snapshot.sourcePropertyId,
        reason: knownIds.has(snapshot.sourcePropertyId)
          ? "no_exact_observation_match"
          : "no_ingested_property",
        sourceRunId: snapshot.sourceRunId,
        wholeRecordPayloadDigest: snapshot.wholeRecordPayloadDigest,
      });
      continue;
    }
    matched.push({ snapshot, ...target });
  }

  // ONE PLAN ITEM PER OBSERVATION, before anything is counted or written.
  // Throws on a contradictory duplicate, so a malformed batch writes nothing.
  const plan = collapseByObservation(matched);

  // ONE WRITE PLAN, computed from THIS BATCH, consumed by both modes.
  //
  // The dry-run used to subtract a GLOBAL snapshot count from the batch size,
  // which is not a preview of anything. Extracting Dubai alone against a
  // database already holding 3,275 Bali snapshots reported "3,275 already
  // present, 0 would be created" — while `--apply` went on to create all 835.
  // And after a full apply, a replay dry-run still counted every incoming issue
  // as `issuesCreated`, though apply writes none.
  //
  // So the question is asked properly: FOR THE OBSERVATIONS IN THIS BATCH, which
  // already have a snapshot? Both modes read the same answer, so their semantics
  // cannot drift — a dry-run is the apply, minus the writing.
  const present = await snapshotsPresentFor(
    client,
    plan.map((m) => m.observationId),
  );

  for (const m of plan) {
    if (present.has(m.observationId)) {
      // An immutable observation already has its complete extraction. Apply
      // would insert nothing here, and neither would it write issue rows: it
      // `continue`s past them.
      counts.snapshotsAlreadyPresent += 1;
    } else {
      counts.snapshotsCreated += 1;
      counts.issuesCreated += m.snapshot.issues.length;
    }
  }

  // A provenance mismatch writes nothing in either mode; it is already counted.
  if (!opts.apply) return counts;

  // APPLY re-derives its counters from what the database actually did, so a
  // concurrent writer between the plan and the insert is reported truthfully
  // rather than assumed away.
  counts.snapshotsCreated = 0;
  counts.snapshotsAlreadyPresent = 0;
  counts.issuesCreated = 0;

  await client.query("begin");
  try {
    for (const { snapshot, identityId, observationId } of plan) {
      const inserted = await client.query<{ id: string }>(
        `insert into public.source_property_issue_snapshots
           (source_property_identity_id, source, source_environment, evidence_observation_id,
            evidence_source_run_id, extraction_status, provider_issue_count,
            source_payload_digest, extraction_method)
         values ($1,$2,$3,$4,$5,'complete',$6,$7,$8)
         on conflict (evidence_observation_id) do nothing
         returning id`,
        [
          identityId,
          opts.source,
          opts.environment,
          observationId,
          snapshot.sourceRunId,
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
  /** The identity's authoritative current run pointer. */
  lastSeenRunId: string;
  /**
   * The observation belonging to THAT run.
   *
   * `null` when the pointer resolves to no observation of this identity. The
   * property is still evaluated — and fails closed as `unresolved` — rather than
   * dropped, because silently omitting a property from a lifecycle sweep hides
   * it from D062 instead of flagging it.
   */
  currentObservationId: string | null;
  /** NULL when the CURRENT observation has no complete snapshot. */
  snapshot: IssueSnapshot | null;
}

export async function loadEvaluableProperties(
  client: Pick<Client, "query">,
  opts: { source: string; environment: string },
): Promise<EvaluableProperty[]> {
  const res = await client.query<{
    identity_id: string;
    source_property_id: string;
    last_seen_run_id: string;
    source_name: string | null;
    slug: string | null;
    observation_id: string | null;
    snapshot_id: string | null;
    provider_issue_count: number | null;
  }>(
    // CURRENTNESS COMES FROM `last_seen_run_id`, NOT FROM A UUID.
    //
    // The previous ordering was `observed_at desc, id desc`, which used the
    // UUID as a temporal tie-breaker. Observations are unique per
    // `(source_run_id, source_property_identity_id)` — NOT per
    // `(identity, observed_at)` — so two observations of one identity may
    // legitimately share an `observed_at`. Where one carried HOTEL/CLOSED and
    // the other did not, the lifecycle answer would then have been decided by
    // which UUID happened to sort later. A random identifier is not evidence
    // about time.
    //
    // Ingestion already owns this question: `last_seen_run_id` advances only
    // when the new run's `started_at` is STRICTLY newer, so a tie is never
    // promoted arbitrarily. Lifecycle uses that same pointer rather than
    // inventing a second notion of "current", and the join is on the run — which
    // by the uniqueness above selects at most ONE observation per identity, with
    // no ordering involved at all.
    //
    // A LEFT join, deliberately: if the pointer resolves to no observation of
    // this identity the property still appears, with a null observation, and the
    // evaluator fails closed. Dropping it would hide it from the sweep entirely.
    `select i.id as identity_id, i.source_property_id, i.last_seen_run_id,
            o.source_name, d.slug,
            o.id as observation_id,
            s.id as snapshot_id, s.provider_issue_count
       from public.source_property_identities i
       left join public.source_property_observations o
              on o.source_property_identity_id = i.id
             and o.source_run_id = i.last_seen_run_id
       left join public.source_runs r on r.id = i.last_seen_run_id
       left join public.destinations d on d.id = r.destination_id
       left join public.source_property_issue_snapshots s on s.evidence_observation_id = o.id
      where i.source = $1 and i.source_environment = $2
      order by i.source_property_id`,
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
    lastSeenRunId: r.last_seen_run_id,
    currentObservationId: r.observation_id,
    snapshot:
      r.snapshot_id === null || r.observation_id === null
        ? null
        : {
            snapshotId: r.snapshot_id,
            observationId: r.observation_id,
            providerIssueCount: r.provider_issue_count ?? 0,
            issues: issues.get(r.snapshot_id) ?? [],
          },
  }));
}
