/** Staff-only, read-only D062 preview. There is intentionally no --apply. */
import { Client } from "pg";

import { discoverCandidates } from "../entity-resolution/candidates";
import {
  compareMachinePairSync,
  partitionForReview,
  type PairKey,
} from "../entity-resolution/queues";
import { loadBlockableIdentities } from "../entity-resolution/writer";
import { resolveIngestionTarget } from "../provider-ingestion/db-target";
import { loadEvaluableProperties, loadLifecyclePolicy } from "../lifecycle/store";
import { isValidIsoDate } from "../lifecycle/policy";
import { evaluatePreview, type PreviewInput } from "./evaluate";

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
  const identityId = get("identity-id");
  const sourcePropertyId = get("source-property-id");
  if (!identityId && !sourcePropertyId)
    throw new Error(
      "Scope explicitly with --identity-id or --source-property-id; an all-properties default is forbidden.",
    );
  if (identityId && sourcePropertyId)
    throw new Error("Use exactly one of --identity-id or --source-property-id.");
  return {
    source: get("source") ?? "hotelbeds",
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
  scope: PreviewInput["scope"];
  star: PreviewInput["star"];
  location: PreviewInput["location"];
};

export const BUNDLE_QUERY = `
select i.id identity_id, i.source, i.source_environment, i.source_property_id, o.id observation_id,
  case when rv.id is null then null else jsonb_build_object('id',rv.id,'decision',rv.decision,'destinationId',rv.destination_id,'targetHotelId',rv.target_hotel_id,'decidedInRunId',rv.decided_in_run_id) end review,
  case when d.id is null then null else jsonb_build_object('id',d.id,'slug',d.slug) end destination,
  case when sc.id is null then null else jsonb_build_object('revisionId',sc.id,'observationId',sc.evidence_observation_id,'outcome',sc.outcome,'policyProvider',sc.policy_provider,'policyVersion',sc.policy_version,'sourceValue',sc.source_value) end scope,
  case when st.id is null then null else jsonb_build_object('revisionId',st.id,'observationId',st.evidence_observation_id,'outcome',st.outcome,'resolvedStarValue',st.resolved_star_value,'conflictState',st.conflict_state,'policyProvider',st.policy_provider,'policyVersion',st.policy_version,'sourceValue',st.source_value) end star,
  case when lo.id is null then null else jsonb_build_object('revisionId',lo.id,'observationId',lo.evidence_observation_id,'outcome',lo.outcome,'latitude',lo.resolved_latitude::text,'longitude',lo.resolved_longitude::text,'conflictState',lo.conflict_state,'unresolvedReason',lo.unresolved_reason,'policyProvider',lo.policy_provider,'policyVersion',lo.policy_version) end location
from public.source_property_identities i
left join public.source_property_observations o on o.source_property_identity_id=i.id and o.source_run_id=i.last_seen_run_id
left join public.source_property_reviews rv on rv.source_property_identity_id=i.id
left join public.destinations d on d.id=rv.destination_id
left join public.source_property_current_scope_resolutions sc on sc.source_property_identity_id=i.id
left join public.source_property_current_star_resolutions st on st.source_property_identity_id=i.id
left join public.source_property_current_location_resolutions lo on lo.source_property_identity_id=i.id
where i.source=$1 and i.source_environment=$2 and ($3::uuid is not null and i.id=$3 or $4::text is not null and i.source_property_id=$4)
order by i.source_property_id limit $5`;

export async function loadPreviewResults(client: Client, args: Args) {
  const [bundleRows, properties, policy, identities] = await Promise.all([
    client.query<BundleRow>(BUNDLE_QUERY, [
      args.source,
      args.environment,
      args.identityId,
      args.sourcePropertyId,
      args.limit,
    ]),
    loadEvaluableProperties(client, { source: args.source, environment: args.environment }),
    loadLifecyclePolicy(client, { provider: args.source }),
    loadBlockableIdentities(client, { source: args.source, environment: args.environment }),
  ]);
  if (!policy) throw new Error(`No approved lifecycle policy exists for ${args.source}.`);
  if (bundleRows.rows.length === 0) throw new Error("No identity matched the explicit scope.");

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
    id: string;
  }>(
    `select source_property_identity_id left_id, candidate_source_property_identity_id right_id,
              status, candidate_kind kind, match_method method, superseded_reason, candidate_hotel_id, id
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

  return bundleRows.rows.map((row) => {
    const p = byIdentity.get(row.identity_id);
    const related = persisted.rows.filter(
      (c) => c.left_id === row.identity_id || c.right_id === row.identity_id,
    );
    const newFinding = related.find((c) => c.kind === "new_property" && c.status === "accepted");
    const canonical = related.find((c) => c.kind === "canonical_hotel" && c.status === "accepted");
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
      scope: row.scope,
      star: row.star,
      location: row.location,
      entity: {
        synchronized: sync.inSync,
        acceptedNewPropertyFindingId: newFinding?.id ?? null,
        acceptedCanonicalCandidateId: canonical?.id ?? null,
        acceptedCanonicalHotelId: canonical?.candidate_hotel_id ?? null,
        pendingCandidateIds: pending,
        currentAnomalyReasons: anomalies,
      },
      lifecycle: { snapshot: p?.snapshot ?? null, policy },
    };
    return evaluatePreview(input, args.asOf);
  });
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const target = resolveIngestionTarget(process.env);
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
