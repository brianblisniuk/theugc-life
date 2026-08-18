/**
 * Persist entity-resolution EVIDENCE.
 *
 * What this writer may do, and nothing more — all of it inside ITS OWN
 * NAMESPACE, which is `candidate_kind = 'source_identity'` AND
 * `match_method like 'blocking:%'`:
 *
 *   - insert `source_match_candidates` rows with `status = 'pending'`;
 *   - refresh the evidence on a PENDING row IT CREATED, when the observations
 *     changed. A pending row a reviewer created by hand is left byte-identical:
 *     one pair is one row, so the insert conflicts with THEIRS, and without the
 *     ownership guard the refresh would seize it — rewriting `manual_search` to
 *     a blocking method, overwriting their evidence, and making the row
 *     machine-supersedable afterwards;
 *   - stand down its OWN pending rows the current rules no longer support,
 *     `status = 'superseded'` + `superseded_reason = 'no_current_blocking_rule'`;
 *   - reactivate one of those same rows — and only one carrying that reason —
 *     when the evidence returns.
 *
 * Every one of those is a statement about whether a pair is worth COMPARING.
 * **None of them decides a match.** There is no code path here that writes
 * `accepted` or `rejected`: those are a human's, and a test reads these source
 * files to prove no such write exists. A `superseded` row a human wrote carries
 * no reason, which is exactly what keeps this writer from touching it.
 *
 * What it may not do, and does not contain SQL for: `hotels`,
 * `hotel_source_identities`, `source_property_reviews`,
 * `source_property_identities.resolution_state`, `promoted_hotel_id`, or a
 * `new_property` candidate.
 */
import type { Client } from "pg";

import {
  discoverCandidates,
  matchMethodFor,
  type BlockableIdentity,
  type BlockingReason,
  type CandidatePair,
  type CrossDestinationCollision,
  type DiscoveryResult,
  type SharedKeyCluster,
} from "./candidates";
import { compareRecords, type PairEvidence } from "./evidence";
import { partitionForReview, type ReviewPartition } from "./queues";

export interface MatchCounts {
  identities: number;
  /** Identities in at least one PAIR. Says nothing about clusters or anomalies. */
  identitiesWithCandidate: number;
  /** Identities in no pair. NOT the "no machine candidate" queue — see `partition`. */
  identitiesWithoutCandidate: number;
  pairs: number;
  pairsByReason: Record<BlockingReason, number>;
  sharedKeyClusters: number;
  sharedKeyClusteredIdentities: number;
  crossDestinationCollisions: number;
  /** Rows actually INSERTED. A replay must add none. */
  candidatesCreated: number;
  /** Pending rows whose evidence actually CHANGED. A replay must change none. */
  candidatesEvidenceUpdated: number;
  /** Rows left alone because a human had already decided them. */
  candidatesDecidedSkipped: number;
  /** Pending rows left alone because a HUMAN created them, not the generator. */
  candidatesManualSkipped: number;
  /** Machine rows stood down because no current blocking rule supports them. */
  candidatesSuperseded: number;
  /** Machine-superseded rows the evidence brought back. */
  candidatesReactivated: number;
  evidence: {
    name: Record<string, number>;
    domain: Record<string, number>;
    address: Record<string, number>;
    phone: Record<string, number>;
    brand: Record<string, number>;
    coordinateDistanceKnown: number;
  };
  agreeingDimensions: Record<number, number>;
  discovery: DiscoveryResult;
  /**
   * The review partition of this same discovery result — the ONE definition of
   * "the machine surfaced nothing about this identity", shared with the review
   * manifest so the two commands cannot report different numbers under the same
   * heading.
   */
  partition: ReviewPartition;
}

/**
 * Load the latest observation per evaluation identity, with its destination.
 *
 * The LATEST observation, because a candidate is about what the property looks
 * like now — and the destination comes from THAT observation's own run, not
 * from the run that first saw the identity.
 *
 * Mixing the two would mix evidence from two different moments. If a provider
 * enumerated a property under destination A and a later run corrects it into
 * destination B, taking the name/domain/phone from the new observation and the
 * geography from the old one describes a property that never existed: it can
 * manufacture pairs, miss real ones, and invent a cross-destination anomaly out
 * of the seam. The latest observation and its run's geography are ONE current
 * evidence unit.
 */
export async function loadBlockableIdentities(
  client: Client,
  opts: { source: string; environment: string },
): Promise<BlockableIdentity[]> {
  const res = await client.query<{
    identity_id: string;
    observation_id: string;
    destination_id: string | null;
    source_name: string | null;
    source_website_url: string | null;
    source_address: string | null;
    source_phone: string | null;
    source_phone_type: string | null;
    source_brand_code: string | null;
    source_chain_code: string | null;
    latitude: string | null;
    longitude: string | null;
  }>(
    `select distinct on (i.id)
            i.id as identity_id,
            o.id as observation_id,
            latest_run.destination_id,
            o.source_name, o.source_website_url, o.source_address,
            o.source_phone, o.source_phone_type,
            o.source_brand_code, o.source_chain_code,
            case when o.source_coordinates_plausible then o.source_latitude::text end as latitude,
            case when o.source_coordinates_plausible then o.source_longitude::text end as longitude
       from public.source_property_identities i
       join public.source_property_observations o on o.source_property_identity_id = i.id
       join public.source_runs latest_run on latest_run.id = o.source_run_id
      where i.source = $1 and i.source_environment = $2
      order by i.id, o.observed_at desc, o.id desc`,
    [opts.source, opts.environment],
  );

  return res.rows.map((r) => ({
    identityId: r.identity_id,
    observationId: r.observation_id,
    destinationId: r.destination_id,
    name: r.source_name,
    websiteUrl: r.source_website_url,
    address: r.source_address,
    phone: r.source_phone,
    phoneType: r.source_phone_type,
    brandCode: r.source_brand_code,
    chainCode: r.source_chain_code,
    // Coordinates enter comparison only when the ingestion audit found them
    // plausible: an out-of-range point would produce a distance that is
    // arithmetic rather than evidence.
    latitude: r.latitude === null ? null : Number(r.latitude),
    longitude: r.longitude === null ? null : Number(r.longitude),
  }));
}

function bump(bucket: Record<string, number>, key: string): void {
  bucket[key] = (bucket[key] ?? 0) + 1;
}

function emptyCounts(
  discovery: DiscoveryResult,
  partition: ReviewPartition,
  identities: number,
): MatchCounts {
  return {
    identities,
    identitiesWithCandidate: 0,
    identitiesWithoutCandidate: 0,
    pairs: discovery.pairs.length,
    pairsByReason: discovery.pairsByReason,
    sharedKeyClusters: discovery.sharedKeyClusters.length,
    sharedKeyClusteredIdentities: new Set(discovery.sharedKeyClusters.flatMap((c) => c.identityIds))
      .size,
    crossDestinationCollisions: discovery.crossDestinationCollisions.length,
    candidatesCreated: 0,
    candidatesEvidenceUpdated: 0,
    candidatesDecidedSkipped: 0,
    candidatesManualSkipped: 0,
    candidatesSuperseded: 0,
    candidatesReactivated: 0,
    evidence: {
      name: {},
      domain: {},
      address: {},
      phone: {},
      brand: {},
      coordinateDistanceKnown: 0,
    },
    agreeingDimensions: {},
    discovery,
    partition,
  };
}

/**
 * The number of INDEPENDENT dimensions in agreement, recomputed here purely so
 * the dry-run report can show the same distribution the database will generate.
 *
 * It is not written: `agreeing_dimensions` is `GENERATED ALWAYS` in 0027, and a
 * writer-supplied copy would be duplicate truth. It decides nothing either —
 * there is no comparison against it anywhere in this codebase.
 */
function agreeingDimensions(evidence: PairEvidence): number {
  return (
    (evidence.nameEvidence !== "none" ? 1 : 0) +
    (evidence.domainEvidence === "agrees" ? 1 : 0) +
    (evidence.addressEvidence === "agrees" ? 1 : 0) +
    (evidence.phoneEvidence === "agrees" ? 1 : 0) +
    (evidence.brandEvidence === "agrees" ? 1 : 0)
  );
}

/**
 * Generate and persist candidate evidence for one provider/environment.
 *
 * Idempotent: 0030's partial unique index makes a pair one row, the insert is
 * `on conflict do nothing`, and the evidence refresh only touches rows that are
 * still `pending` AND whose evidence actually differs. A replay over unchanged
 * observations therefore creates nothing and updates nothing.
 */
export async function generateCandidates(
  client: Client,
  opts: { source: string; environment: string; runId: string | null; apply: boolean },
): Promise<MatchCounts> {
  const identities = await loadBlockableIdentities(client, opts);
  const byId = new Map(identities.map((i) => [i.identityId, i]));
  const discovery = discoverCandidates(identities);
  const counts = emptyCounts(
    discovery,
    partitionForReview(identities, discovery),
    identities.length,
  );

  const withCandidate = new Set<string>();
  const prepared: { pair: CandidatePair; evidence: PairEvidence }[] = [];

  for (const pair of discovery.pairs) {
    const left = byId.get(pair.leftIdentityId)!;
    const right = byId.get(pair.rightIdentityId)!;
    const evidence = compareRecords(left, right);
    prepared.push({ pair, evidence });

    withCandidate.add(pair.leftIdentityId);
    withCandidate.add(pair.rightIdentityId);
    bump(counts.evidence.name, evidence.nameEvidence);
    bump(counts.evidence.domain, evidence.domainEvidence);
    bump(counts.evidence.address, evidence.addressEvidence);
    bump(counts.evidence.phone, evidence.phoneEvidence);
    bump(counts.evidence.brand, evidence.brandEvidence);
    if (evidence.coordinateDistanceMetres !== null) counts.evidence.coordinateDistanceKnown += 1;
    const n = agreeingDimensions(evidence);
    counts.agreeingDimensions[n] = (counts.agreeingDimensions[n] ?? 0) + 1;
  }

  counts.identitiesWithCandidate = withCandidate.size;
  counts.identitiesWithoutCandidate = identities.length - withCandidate.size;

  if (!opts.apply) return counts;

  await client.query("begin");
  try {
    for (const { pair, evidence } of prepared) {
      const pairKeys = [pair.leftIdentityId, pair.rightIdentityId];
      const evidenceValues = [
        matchMethodFor(pair.reasons),
        evidence.nameEvidence,
        evidence.domainEvidence,
        evidence.addressEvidence,
        evidence.phoneEvidence,
        evidence.brandEvidence,
        evidence.coordinateDistanceMetres,
      ];
      const params = [...pairKeys, opts.source, opts.environment, opts.runId, ...evidenceValues];

      const inserted = await client.query(
        `insert into public.source_match_candidates
           (source_property_identity_id, candidate_source_property_identity_id, source,
            source_environment, source_run_id, candidate_kind, match_method,
            name_evidence, domain_evidence, address_evidence, phone_evidence, brand_evidence,
            coordinate_distance_metres, known_source_mapping, status)
         values ($1,$2,$3,$4,$5,'source_identity',$6,$7,$8,$9,$10,$11,$12,false,'pending')
         on conflict (source_property_identity_id, candidate_source_property_identity_id)
           where candidate_kind = 'source_identity'
           do nothing
         returning id`,
        params,
      );
      if ((inserted.rowCount ?? 0) > 0) {
        counts.candidatesCreated += 1;
        continue;
      }

      // The pair is already on record. Refresh its evidence only while it is
      // still PENDING — rewriting the evidence under a decision a human already
      // made would make the decision look as if it rested on facts that were
      // not in front of them.
      // The pair is current again after the generator itself stood it down.
      // ONLY a row carrying the machine's own reason may be revived: a human
      // `superseded` decision has no reason recorded, and reviving it would
      // overturn a decision by re-running a script.
      const reactivated = await client.query(
        `update public.source_match_candidates set
           status = 'pending', superseded_reason = null, resolved_at = null,
           match_method = $3, name_evidence = $4, domain_evidence = $5, address_evidence = $6,
           phone_evidence = $7, brand_evidence = $8, coordinate_distance_metres = $9
         where source_property_identity_id = $1
           and candidate_source_property_identity_id = $2
           and candidate_kind = 'source_identity'
           and status = 'superseded'
           and superseded_reason = 'no_current_blocking_rule'
         returning id`,
        [...pairKeys, ...evidenceValues],
      );
      if ((reactivated.rowCount ?? 0) > 0) {
        counts.candidatesReactivated += 1;
        continue;
      }

      // GENERATOR OWNERSHIP IS REQUIRED, not implied by "pending".
      //
      // One pair is one row, so when a reviewer has already created A↔B by hand
      // the INSERT above conflicts with THEIR row — and without this guard the
      // refresh would then take it: rewriting `manual_search` to
      // `blocking:exact_domain`, overwriting the evidence they recorded, and
      // leaving the generator free to machine-supersede it later. A human's pair
      // would have been quietly converted into machine state.
      //
      // So the refresh matches only rows the generator itself created, and a
      // manual row is left byte-identical. It does not need a machine row to
      // exist: the pair IS in front of a reviewer, which is the only thing that
      // mattered, and the sync gate counts it as accounted for.
      const updated = await client.query(
        `update public.source_match_candidates set
           match_method = $3, name_evidence = $4, domain_evidence = $5, address_evidence = $6,
           phone_evidence = $7, brand_evidence = $8, coordinate_distance_metres = $9
         where source_property_identity_id = $1
           and candidate_source_property_identity_id = $2
           and candidate_kind = 'source_identity'
           and status = 'pending'
           and match_method like 'blocking:%'
           and (match_method, name_evidence, domain_evidence, address_evidence,
                phone_evidence, brand_evidence, coordinate_distance_metres)
               is distinct from ($3,$4,$5,$6,$7,$8,$9::numeric)
         returning id`,
        [...pairKeys, ...evidenceValues],
      );
      if ((updated.rowCount ?? 0) > 0) counts.candidatesEvidenceUpdated += 1;
      else {
        const untouchable = await client.query<{ reason: string }>(
          `select case when status <> 'pending' then 'decided' else 'manual' end as reason
             from public.source_match_candidates
            where source_property_identity_id = $1
              and candidate_source_property_identity_id = $2
              and candidate_kind = 'source_identity'
              and (status <> 'pending' or match_method not like 'blocking:%')`,
          [pair.leftIdentityId, pair.rightIdentityId],
        );
        for (const row of untouchable.rows) {
          if (row.reason === "decided") counts.candidatesDecidedSkipped += 1;
          else counts.candidatesManualSkipped += 1;
        }
      }
    }
    // STAND DOWN what the current evidence no longer supports.
    //
    // A pending candidate is a claim about the CURRENT evidence. When the
    // provider corrects a property so the pair shares no domain, no phone and no
    // destination-scoped name, discovery stops returning it — and a generator
    // that only visits current pairs would never look at the row again. It would
    // sit in the review queue forever, describing a relationship nothing
    // supports.
    //
    // Three things this deliberately does NOT do: it deletes no row, it rewrites
    // no evidence (the reader can still see what the pair looked like when it
    // stood), and it touches nothing a human decided — `match_method like
    // 'blocking:%'` is the generator's own mark, and only `pending` is eligible.
    const stood = await client.query(
      `update public.source_match_candidates set
         status = 'superseded', superseded_reason = 'no_current_blocking_rule',
         resolved_at = now()
       where source = $1 and source_environment = $2
         and candidate_kind = 'source_identity'
         and status = 'pending'
         and match_method like 'blocking:%'
         and not exists (
           select 1 from unnest($3::uuid[], $4::uuid[]) as current_pair(l, r)
            where current_pair.l = source_property_identity_id
              and current_pair.r = candidate_source_property_identity_id)
       returning id`,
      [
        opts.source,
        opts.environment,
        prepared.map((p) => p.pair.leftIdentityId),
        prepared.map((p) => p.pair.rightIdentityId),
      ],
    );
    counts.candidatesSuperseded = stood.rowCount ?? 0;

    await client.query("commit");
  } catch (err) {
    await client.query("rollback").catch(() => {
      /* the original error is the one worth reporting */
    });
    throw err;
  }

  return counts;
}

export type { CandidatePair, CrossDestinationCollision, SharedKeyCluster };
