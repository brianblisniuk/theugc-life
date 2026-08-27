/** Staff-only, read-only D062 preview. There is intentionally no --apply. */
import { Client } from "pg";

import { discoverCandidates } from "../entity-resolution/candidates";
import {
  compareMachinePairSync,
  partitionForReview,
  type PairKey,
} from "../entity-resolution/queues";
import { loadBlockableIdentities } from "../entity-resolution/writer";
import { loadEvaluableProperties, loadLifecyclePolicy } from "../lifecycle/store";
import { isValidIsoDate } from "../lifecycle/policy";
import { compareStableStrings, evaluatePreview, type PreviewInput } from "./evaluate";
import { resolvePreviewTarget } from "./target";

interface Args {
  source: string;
  environment: "evaluation" | "production";
  asOf: string;
  identityId: string | null;
  sourcePropertyId: string | null;
  limit: number;
}

export function parseArgs(argv: readonly string[]): Args {
  const get = (name: string): string | null => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 && argv[i + 1] ? argv[i + 1]! : null;
  };
  const asOf = get("as-of");
  if (!asOf || !isValidIsoDate(asOf))
    throw new Error("--as-of YYYY-MM-DD is required and must be a real date.");
  const environment = get("environment");
  if (environment !== "evaluation" && environment !== "production")
    throw new Error("--environment must be explicit: evaluation or production.");
  const source = get("source");
  if (!source) throw new Error("--source <provider> is required and has no implicit default.");
  const identityId = get("identity-id");
  const sourcePropertyId = get("source-property-id");
  if (!identityId && !sourcePropertyId)
    throw new Error(
      "Scope explicitly with --identity-id or --source-property-id; an all-properties default is forbidden.",
    );
  if (identityId && sourcePropertyId)
    throw new Error("Use exactly one of --identity-id or --source-property-id.");
  return {
    source,
    environment,
    asOf,
    identityId,
    sourcePropertyId,
    limit: Number(get("limit") ?? 25),
  };
}

type BundleRow = {
  identity_id: string;
  source: string;
  source_environment: "evaluation" | "production";
  source_property_id: string;
  observation_id: string | null;
  review: PreviewInput["review"];
  destination: PreviewInput["destination"];
  target_hotel: PreviewInput["targetHotel"];
  scope: PreviewInput["scope"];
  star: PreviewInput["star"];
  location: PreviewInput["location"];
  human_review: PreviewInput["humanReview"];
};

export const BUNDLE_QUERY = `
select i.id identity_id, i.source, i.source_environment, i.source_property_id, o.id observation_id,
  case when rv.id is null then null else jsonb_build_object('id',rv.id,'decision',rv.decision,'destinationId',rv.destination_id,'targetHotelId',rv.target_hotel_id,'decidedInRunId',rv.decided_in_run_id,'reviewerUserId',rv.reviewer_user_id,'reviewerLabel',rv.reviewer_label,'reviewedAt',to_char(rv.reviewed_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),'reviewNote',rv.review_note,'reviewStatus',rv.review_status,'currentReceiptId',rv.current_receipt_id,'currentReceiptRevocationId',rvk.id,'currentReceiptRevoked',rvk.id is not null) end review,
  case when d.id is null then null else jsonb_build_object('id',d.id,'slug',d.slug) end destination,
  case when th.id is null then null else jsonb_build_object('id',th.id,'destinationId',th.destination_id,'destinationSlug',td.slug) end target_hotel,
  case when sc.id is null then null else jsonb_build_object('revisionId',sc.id,'observationId',sc.evidence_observation_id,'outcome',sc.outcome,'policyProvider',sc.policy_provider,'policyVersion',sc.policy_version,'sourceValue',sc.source_value) end scope,
  case when st.id is null then null else jsonb_build_object('revisionId',st.id,'observationId',st.evidence_observation_id,'outcome',st.outcome,'resolvedStarValue',st.resolved_star_value,'conflictState',st.conflict_state,'policyProvider',st.policy_provider,'policyVersion',st.policy_version,'sourceValue',st.source_value) end star,
  case when lo.id is null then null else jsonb_build_object('revisionId',lo.id,'observationId',lo.evidence_observation_id,'outcome',lo.outcome,'latitude',lo.resolved_latitude::text,'longitude',lo.resolved_longitude::text,'conflictState',lo.conflict_state,'unresolvedReason',lo.unresolved_reason,'policyProvider',lo.policy_provider,'policyVersion',lo.policy_version) end location,
  case when hr.id is null then null else jsonb_build_object('receiptId',hr.id,'decision',hr.decision,'evidenceObservationId',hr.evidence_observation_id,'evidenceSourceRunId',hr.evidence_source_run_id,'sourcePayloadDigest',hr.source_payload_digest,'destinationId',hr.destination_id,'newPropertyFindingId',hr.new_property_finding_id,'reviewerUserId',hr.reviewer_user_id,'reviewerLabel',hr.reviewer_label,'reviewedAt',to_char(hr.reviewed_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),'prereviewFingerprint',hr.prereview_fingerprint,'prereviewAsOf',to_char(hr.prereview_as_of,'YYYY-MM-DD'),'receiptDigest',hr.receipt_digest,'evidenceReferenceCount',coalesce(hrr.n,0),'verifications',coalesce(hrv.rows,'[]'::jsonb)) end human_review
from public.source_property_identities i
left join public.source_property_observations o on o.source_property_identity_id=i.id and o.source_run_id=i.last_seen_run_id
left join public.source_property_reviews rv on rv.source_property_identity_id=i.id
left join public.source_property_review_revocations rvk on rvk.revoked_receipt_id=rv.current_receipt_id
left join public.destinations d on d.id=rv.destination_id
left join public.hotels th on th.id=rv.target_hotel_id
left join public.destinations td on td.id=th.destination_id
left join public.source_property_current_scope_resolutions sc on sc.source_property_identity_id=i.id
left join public.source_property_current_star_resolutions st on st.source_property_identity_id=i.id
left join public.source_property_current_location_resolutions lo on lo.source_property_identity_id=i.id
left join lateral (
  select r.* from public.source_property_review_receipts r
   where r.source_property_identity_id=i.id
   -- A fresh-observation re-review is a SUPPORTED state, so one identity can
   -- legitimately hold several receipts. The receipt about the CURRENT
   -- observation is picked first and explicitly, rather than trusting wall-clock
   -- recency to imply it: conditions 1 and 2 ask "is there a current decision?",
   -- and that question is answered by the observation, not by a timestamp. When
   -- no receipt is current the newest is still surfaced, so A04 can report
   -- \`human_review_receipt_not_current\` instead of pretending none exists.
   order by coalesce(r.evidence_observation_id = o.id, false) desc,
            r.reviewed_at desc, r.id desc limit 1) hr on true
left join lateral (
  select count(*) n from public.source_property_review_evidence_references x where x.receipt_id=hr.id) hrr on true
left join lateral (
  select jsonb_agg(jsonb_build_object('dimension',v.dimension,'verdict',v.verdict,'note',v.note)
                   order by v.dimension) rows
    from public.source_property_review_verifications v where v.receipt_id=hr.id) hrv on true
where i.source=$1 and i.source_environment=$2 and ($3::uuid is not null and i.id=$3 or $4::text is not null and i.source_property_id=$4)
order by i.source_property_id limit $5`;

/**
 * The population variant of BUNDLE_QUERY. Byte-for-byte the same projection and
 * the same joins — including the `last_seen_run_id` currentness join — with the
 * explicit-scope predicate removed.
 *
 * It exists so A04.5 readiness can be computed for a whole source/environment
 * through the REAL evaluator instead of a SQL re-derivation of the eleven
 * conditions. A SQL shortcut cannot reproduce condition 11: its anomaly half is
 * the live discovery sweep, and a query that omitted it called 1,141 identities
 * ready where the evaluator says 867.
 *
 * The one-property CLI contract is unchanged: `parseArgs` still requires
 * `--identity-id` or `--source-property-id`, and there is still no unscoped
 * default on the command line.
 */
export const BUNDLE_QUERY_ALL = BUNDLE_QUERY.replace(
  "and ($3::uuid is not null and i.id=$3 or $4::text is not null and i.source_property_id=$4)\norder by i.source_property_id limit $5",
  "order by i.source_property_id",
);

async function composeFromBundleRows(
  client: Client,
  bundleRows: BundleRow[],
  args: { source: string; environment: "evaluation" | "production"; asOf: string },
) {
  const properties = await loadEvaluableProperties(client, {
    source: args.source,
    environment: args.environment,
  });
  const policy = await loadLifecyclePolicy(client, { provider: args.source });
  const identities = await loadBlockableIdentities(client, {
    source: args.source,
    environment: args.environment,
  });
  if (!policy) throw new Error(`No approved lifecycle policy exists for ${args.source}.`);

  const discovery = discoverCandidates(identities);
  const partitions = partitionForReview(identities, discovery);
  const persisted = await client.query<{
    left_id: string;
    right_id: string;
    status: string;
    kind: string;
    method: string;
    superseded_reason: string | null;
    candidate_hotel_id: string | null;
    candidate_source_identity_id: string | null;
    source_run_id: string | null;
    name_evidence: string;
    domain_evidence: string;
    address_evidence: string;
    phone_evidence: string;
    brand_evidence: string;
    coordinate_distance_metres: string | null;
    known_source_mapping: boolean;
    review_note: string | null;
    resolved_at: string | null;
    id: string;
  }>(
    `select source_property_identity_id left_id, candidate_source_property_identity_id right_id,
              status, candidate_kind kind, match_method method, superseded_reason,
              candidate_hotel_id, candidate_source_property_identity_id candidate_source_identity_id,
              source_run_id, name_evidence, domain_evidence, address_evidence, phone_evidence,
              brand_evidence, coordinate_distance_metres::text, known_source_mapping,
              review_note, case when resolved_at is null then null else to_char(resolved_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') end resolved_at, id
         from public.source_match_candidates
        where source = $1 and source_environment = $2`,
    [args.source, args.environment],
  );
  const machinePending: PairKey[] = persisted.rows
    .filter(
      (r) =>
        r.status === "pending" &&
        r.kind === "source_identity" &&
        r.method.startsWith("blocking:") &&
        r.right_id,
    )
    .map((r) => ({ leftIdentityId: r.left_id, rightIdentityId: r.right_id }));
  const accounted: PairKey[] = persisted.rows
    .filter(
      (r) =>
        r.kind === "source_identity" &&
        r.right_id &&
        (r.status === "accepted" ||
          r.status === "rejected" ||
          (r.status === "superseded" && r.superseded_reason === null) ||
          (r.status === "pending" && !r.method.startsWith("blocking:"))),
    )
    .map((r) => ({ leftIdentityId: r.left_id, rightIdentityId: r.right_id }));
  const sync = compareMachinePairSync(discovery.pairs, machinePending, accounted);
  const byIdentity = new Map(properties.map((p) => [p.identityId, p]));

  return bundleRows.map((row) => {
    const p = byIdentity.get(row.identity_id);
    const related = persisted.rows.filter(
      (c) => c.left_id === row.identity_id || c.right_id === row.identity_id,
    );
    const acceptedCandidates = related
      .filter((c) => c.status === "accepted")
      .map((c) => ({
        id: c.id,
        sourcePropertyIdentityId: c.left_id,
        kind: c.kind as "canonical_hotel" | "source_identity" | "new_property",
        status: c.status,
        candidateHotelId: c.candidate_hotel_id,
        candidateSourcePropertyIdentityId: c.candidate_source_identity_id,
        sourceRunId: c.source_run_id,
        matchMethod: c.method,
        nameEvidence: c.name_evidence,
        domainEvidence: c.domain_evidence,
        addressEvidence: c.address_evidence,
        phoneEvidence: c.phone_evidence,
        brandEvidence: c.brand_evidence,
        coordinateDistanceMetres: c.coordinate_distance_metres,
        knownSourceMapping: c.known_source_mapping,
        reviewNote: c.review_note,
        resolvedAt: c.resolved_at,
        supersededReason: c.superseded_reason,
      }))
      .sort((a, b) =>
        compareStableStrings(
          `${a.kind}|${a.sourcePropertyIdentityId}|${a.candidateHotelId ?? ""}|${a.candidateSourcePropertyIdentityId ?? ""}|${a.id}`,
          `${b.kind}|${b.sourcePropertyIdentityId}|${b.candidateHotelId ?? ""}|${b.candidateSourcePropertyIdentityId ?? ""}|${b.id}`,
        ),
      );
    const pending = related.filter((c) => c.status === "pending").map((c) => c.id);
    const anomalies = [
      ...(partitions.inSharedKeyClusters.has(row.identity_id) ? ["shared_key_cluster"] : []),
      ...(partitions.inCrossDestinationAnomalies.has(row.identity_id)
        ? ["cross_destination_collision"]
        : []),
      ...(partitions.inIncompleteGeography.has(row.identity_id) ? ["incomplete_geography"] : []),
    ];
    const input: PreviewInput = {
      identity: {
        id: row.identity_id,
        source: row.source,
        environment: row.source_environment,
        currentObservationId: row.observation_id,
      },
      review: row.review,
      destination: row.destination,
      targetHotel: row.target_hotel,
      scope: row.scope,
      star: row.star,
      location: row.location,
      entity: {
        synchronized: sync.inSync,
        acceptedCandidates,
        pendingCandidateIds: pending,
        currentAnomalyReasons: anomalies,
      },
      humanReview: row.human_review,
      lifecycle: { snapshot: p?.snapshot ?? null, policy },
    };
    return evaluatePreview(input, args.asOf);
  });
}

async function composePreviewResults(client: Client, args: Args) {
  const bundleRows = await client.query<BundleRow>(BUNDLE_QUERY, [
    args.source,
    args.environment,
    args.identityId,
    args.sourcePropertyId,
    args.limit,
  ]);
  if (bundleRows.rows.length === 0) throw new Error("No identity matched the explicit scope.");
  return composeFromBundleRows(client, bundleRows.rows, args);
}

async function composeAllPreviewResults(
  client: Client,
  args: { source: string; environment: "evaluation" | "production"; asOf: string },
) {
  const bundleRows = await client.query<BundleRow>(BUNDLE_QUERY_ALL, [
    args.source,
    args.environment,
  ]);
  return composeFromBundleRows(client, bundleRows.rows, args);
}

export async function inPreviewSnapshot<T>(client: Client, work: () => Promise<T>): Promise<T> {
  await client.query("begin isolation level repeatable read read only");
  try {
    const result = await work();
    await client.query("commit");
    return result;
  } catch (error) {
    await client.query("rollback");
    throw error;
  }
}

export function loadPreviewResults(client: Client, args: Args) {
  return inPreviewSnapshot(client, () => composePreviewResults(client, args));
}

/**
 * Every identity for one source/environment, through the SAME evaluator the
 * single-property CLI uses. A04.5 readiness is derived from these results; it is
 * never re-derived in SQL.
 */
export function loadAllPreviewResults(
  client: Client,
  args: { source: string; environment: "evaluation" | "production"; asOf: string },
) {
  return inPreviewSnapshot(client, () => composeAllPreviewResults(client, args));
}

/**
 * Same composition, run inside whatever transaction the CALLER has already
 * opened. It establishes no snapshot and no isolation level of its own.
 *
 * The name says so explicitly because the previous name — `…InSnapshot` —
 * asserted a guarantee this function does not provide, and a caller that
 * believed it (A04.5's apply path) ran the multi-statement evaluator under READ
 * COMMITTED, where every statement gets its own snapshot. The isolation level is
 * the caller's responsibility: `inPreviewSnapshot` for read-only work,
 * `begin isolation level serializable` for a transaction that writes.
 */
export function composeAllPreviewResultsInCallerTransaction(
  client: Client,
  args: { source: string; environment: "evaluation" | "production"; asOf: string },
) {
  return composeAllPreviewResults(client, args);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const target = resolvePreviewTarget(process.env);
  const client = new Client({ connectionString: target.url });
  await client.connect();
  try {
    for (const preview of await loadPreviewResults(client, args)) {
      console.info(JSON.stringify(preview, null, 2));
    }
  } finally {
    await client.end();
  }
}

if (process.argv[1]?.endsWith("preview.ts"))
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
