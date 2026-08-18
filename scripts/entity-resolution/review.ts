/**
 * source:match:review — the review manifest.
 *
 *   npm run source:match:review -- --provider hotelbeds
 *   npm run source:match:review -- --provider hotelbeds --queue no-candidate --limit 20
 *
 * READ-ONLY. This command has no `--apply`, writes nothing, and contains no
 * INSERT or UPDATE of any kind. It exists to put evidence in front of a human,
 * because a human is the only thing in this architecture that may decide a
 * match (D063 §12.2 — there is no approved threshold, and no code here computes
 * one).
 *
 * EVERY invocation begins with ONE current evidence unit —
 * `loadBlockableIdentities` → `discoverCandidates` → `partitionForReview` — and
 * all three queues are answered from it.
 *
 *   CANDIDATES            pairs AWAITING A DECISION — `status = 'pending'` and
 *                         nothing else. Pending may be generator-owned or
 *                         manual; each row is labelled `machine` or `MANUAL`.
 *                         A machine-superseded row is history, an
 *                         accepted/rejected one is decided, and a
 *                         human-superseded one is decided too; none is
 *                         actionable, and showing them together would put four
 *                         meanings behind one word.
 *                         These rows are PERSISTED, so before they may be shown
 *                         as current they are checked against the live sweep —
 *                         see the SYNC GATE below.
 *   ANOMALIES             shared-key clusters, cross-destination collisions AND
 *                         incomplete geography — real findings that are not
 *                         pairwise evidence.
 *   NO MACHINE CANDIDATE  identities current discovery surfaced NOTHING for —
 *                         no pair, no cluster, no cross-destination collision,
 *                         no incomplete-geography key. Computed by subtraction
 *                         from the same discovery result, never from the absence
 *                         of a historical row.
 *                         NOT "new property": the rules finding nothing is a
 *                         statement about the rules, not about the world.
 *
 * THE SYNC GATE
 * -------------
 * ANOMALIES and NO MACHINE CANDIDATE are computed live, so they are current by
 * construction. CANDIDATES is not: it reads persisted pending rows from an
 * earlier moment. Between that moment and now a provider correction can remove
 * the blocking relation behind a generator-owned pending row, or create a pair
 * nothing has persisted or otherwise accounted for yet. Either way the queue can
 * silently stop describing the present, and nothing in the row itself shows it.
 *
 * So the generator-owned pair set is compared against the live sweep, while
 * human-decided and manual pending source-identity pairs count as accounted for
 * on the discovered side. A disagreement STOPS the review with an instruction
 * to run the generator. It is deliberately not a filter: intersecting the two
 * would hide a newly discovered pair that was never persisted, and hide a stale
 * machine pending row without recording the supersession it is owed. Fail
 * closed, and let the operator resynchronise.
 *
 * This command still writes NOTHING. It reports the disagreement; it does not
 * fix it, and it does not run the generator for you.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";

import { Client } from "pg";

import {
  resolveIngestionTarget,
  UnsafeIngestionTargetError,
} from "../provider-ingestion/db-target";
import { discoverCandidates } from "./candidates";
import {
  ACTIONABLE_CANDIDATE_STATUS,
  compareMachinePairSync,
  isGeneratorOwned,
  MACHINE_MATCH_METHOD_PREFIX,
  partitionForReview,
  type MachineSyncResult,
  type PairKey,
} from "./queues";
import { loadBlockableIdentities } from "./writer";

const EVALUATION = "evaluation" as const;
type Queue = "candidates" | "no-candidate" | "anomalies";

export interface ReviewArgs {
  provider: string;
  queue: Queue;
  limit: number;
}

export function parseArgs(argv: readonly string[]): ReviewArgs {
  const get = (name: string): string | null => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 && argv[i + 1] ? argv[i + 1]! : null;
  };
  const queue = (get("queue") ?? "candidates") as Queue;
  if (!["candidates", "no-candidate", "anomalies"].includes(queue)) {
    throw new Error(`--queue ${queue} is not one of candidates | no-candidate | anomalies.`);
  }
  return { provider: get("provider") ?? "hotelbeds", queue, limit: Number(get("limit") ?? 25) };
}

interface CandidateRow {
  candidate_id: string;
  status: string;
  match_method: string;
  candidate_kind: string;
  left_identity: string;
  left_source_id: string;
  left_name: string | null;
  left_destination: string | null;
  right_identity: string | null;
  right_source_id: string | null;
  right_name: string | null;
  right_destination: string | null;
  name_evidence: string;
  domain_evidence: string;
  address_evidence: string;
  phone_evidence: string;
  brand_evidence: string;
  coordinate_distance_metres: string | null;
  known_source_mapping: boolean;
  agreeing_dimensions: number;
  review_note: string | null;
  superseded_reason: string | null;
}

export const CANDIDATE_QUERY = `
  select c.id as candidate_id, c.status, c.match_method, c.candidate_kind,
         c.source_property_identity_id as left_identity,
         li.source_property_id as left_source_id,
         lo.source_name as left_name, ld.slug as left_destination,
         c.candidate_source_property_identity_id as right_identity,
         ri.source_property_id as right_source_id,
         ro.source_name as right_name, rd.slug as right_destination,
         c.name_evidence, c.domain_evidence, c.address_evidence, c.phone_evidence,
         c.brand_evidence, c.coordinate_distance_metres::text as coordinate_distance_metres,
         c.known_source_mapping, c.agreeing_dimensions, c.review_note, c.superseded_reason
    from public.source_match_candidates c
    join public.source_property_identities li on li.id = c.source_property_identity_id
    join lateral (select o.source_name, o.source_run_id
                    from public.source_property_observations o
                   where o.source_property_identity_id = li.id
                   order by o.observed_at desc, o.id desc limit 1) lo on true
    join public.source_runs lr on lr.id = lo.source_run_id
    left join public.destinations ld on ld.id = lr.destination_id
    left join public.source_property_identities ri
           on ri.id = c.candidate_source_property_identity_id
    left join lateral (select o.source_name, o.source_run_id
                         from public.source_property_observations o
                        where o.source_property_identity_id = ri.id
                        order by o.observed_at desc, o.id desc limit 1) ro on true
    left join public.source_runs rr on rr.id = ro.source_run_id
    left join public.destinations rd on rd.id = rr.destination_id
   where c.source = $1 and c.source_environment = $2
     and c.status = $4
   order by c.agreeing_dimensions desc, c.match_method, c.id
   limit $3`;

/** The same filter the queue uses, so the count and the list cannot disagree. */
export const ACTIONABLE_COUNT_QUERY = `
  select count(*)::text as n from public.source_match_candidates
   where source = $1 and source_environment = $2 and status = $3`;

/**
 * The persisted side of the sync gate: ACTIONABLE rows in the GENERATOR'S OWN
 * namespace, and nothing else.
 *
 *   - `status = 'pending'`     — a decided or machine-superseded row is history,
 *                                and history is not a claim about now;
 *   - `candidate_kind`         — only source↔source pairs are discovered;
 *   - `match_method like`      — the generator's mark. A `manual_search` row is
 *                                a reviewer's pair, which discovery never
 *                                claimed to produce and must not be called stale
 *                                for being absent from it.
 */
export const PERSISTED_MACHINE_PAIRS_QUERY = `
  select source_property_identity_id as left_identity,
         candidate_source_property_identity_id as right_identity
    from public.source_match_candidates
   where source = $1 and source_environment = $2
     and status = $3
     and candidate_kind = 'source_identity'
     and match_method like $4`;

/**
 * Pairs that are in front of a reviewer WITHOUT belonging to the generator.
 *
 * Two kinds, and the gate needs both:
 *
 *   - DECIDED — `accepted`, `rejected`, or the `superseded` a reviewer set
 *     aside, which is exactly a `superseded` row with NO `superseded_reason`,
 *     since only the machine records one;
 *   - MANUAL PENDING — a `source_identity` row a reviewer created, whose
 *     `match_method` is not the generator's. One pair is one row, so the
 *     generator may not add a second for the same relationship, and it may not
 *     seize this one.
 *
 * Neither is machine state, and the generator is forbidden from touching
 * either — which is precisely why they count as ACCOUNTED FOR. Calling them
 * missing would raise an alarm no run could ever clear.
 */
export const ACCOUNTED_NON_MACHINE_PAIRS_QUERY = `
  select source_property_identity_id as left_identity,
         candidate_source_property_identity_id as right_identity
    from public.source_match_candidates
   where source = $1 and source_environment = $2
     and candidate_kind = 'source_identity'
     and (status in ('accepted', 'rejected')
          or (status = 'superseded' and superseded_reason is null)
          or (status = 'pending' and match_method not like $3))`;

export class ReviewOutOfSyncError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReviewOutOfSyncError";
  }
}

/**
 * Read the persisted machine pair set for the sync gate.
 *
 * Exported so the gate can be exercised against a real database without going
 * through the CLI. Read-only, like everything else here.
 */
export async function loadPersistedMachinePairs(
  client: Pick<Client, "query">,
  opts: { source: string; environment: string },
): Promise<PairKey[]> {
  const res = await client.query<{ left_identity: string; right_identity: string }>(
    PERSISTED_MACHINE_PAIRS_QUERY,
    [opts.source, opts.environment, ACTIONABLE_CANDIDATE_STATUS, `${MACHINE_MATCH_METHOD_PREFIX}%`],
  );
  return res.rows.map((r) => ({
    leftIdentityId: r.left_identity,
    rightIdentityId: r.right_identity,
  }));
}

/** Read the accounted-for non-machine pair set. Read-only, like the rest. */
export async function loadAccountedNonMachinePairs(
  client: Pick<Client, "query">,
  opts: { source: string; environment: string },
): Promise<PairKey[]> {
  const res = await client.query<{ left_identity: string; right_identity: string }>(
    ACCOUNTED_NON_MACHINE_PAIRS_QUERY,
    [opts.source, opts.environment, `${MACHINE_MATCH_METHOD_PREFIX}%`],
  );
  return res.rows.map((r) => ({
    leftIdentityId: r.left_identity,
    rightIdentityId: r.right_identity,
  }));
}

/** The operator-facing message. Names the command, and runs nothing itself. */
export function outOfSyncMessage(sync: MachineSyncResult, provider: string): string {
  const lines = [
    "The CANDIDATES queue is NOT current.",
    "",
    "Persisted candidate rows and current discovery disagree, so the queue would",
    "show a decision surface that the evidence no longer supports:",
    "",
    `  discovered now, never persisted   ${sync.discoveredNotPersisted.length}` +
      "   (a real pair no reviewer can see)",
    `  persisted, no longer discovered   ${sync.persistedNotDiscovered.length}` +
      "   (a pending row nothing supports)",
    "",
    "Nothing is filtered out and nothing is guessed at: showing the intersection",
    "would hide both of those, and this command may not write the supersession a",
    "stale row is owed.",
    "",
    "Synchronise first, then review:",
    "",
    `  npm run source:match -- --provider ${provider} --apply`,
    "",
    "ANOMALIES and NO MACHINE CANDIDATE are computed live and remain available.",
  ];
  return lines.join("\n");
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const target = resolveIngestionTarget(process.env);

  console.info("\n[source:match:review] entity-resolution review manifest (READ-ONLY)\n");
  console.info(`  provider      ${args.provider}`);
  console.info(`  environment   ${EVALUATION} (locked)`);
  console.info(`  queue         ${args.queue}`);
  console.info(`  database      ${target.classification.redactedTarget}\n`);

  const client = new Client({ connectionString: target.url });
  await client.connect();
  try {
    // ONE current evidence unit, for every queue. The candidates queue needs it
    // as much as the other two — it just needs it to CHECK persisted rows rather
    // than to produce them.
    const identities = await loadBlockableIdentities(client, {
      source: args.provider,
      environment: EVALUATION,
    });
    const discovery = discoverCandidates(identities);
    const partition = partitionForReview(identities, discovery);

    if (args.queue === "candidates") {
      const scope = { source: args.provider, environment: EVALUATION };
      const sync = compareMachinePairSync(
        discovery.pairs,
        await loadPersistedMachinePairs(client, scope),
        await loadAccountedNonMachinePairs(client, scope),
      );
      if (!sync.inSync) throw new ReviewOutOfSyncError(outOfSyncMessage(sync, args.provider));
      console.info(
        `  sync          current discovery and persisted machine candidates AGREE ` +
          `(${discovery.pairs.length} pair(s))\n`,
      );

      const res = await client.query<CandidateRow>(CANDIDATE_QUERY, [
        args.provider,
        EVALUATION,
        args.limit,
        ACTIONABLE_CANDIDATE_STATUS,
      ]);
      const total = await client.query<{ n: string }>(ACTIONABLE_COUNT_QUERY, [
        args.provider,
        EVALUATION,
        ACTIONABLE_CANDIDATE_STATUS,
      ]);
      const history = await client.query<{ status: string; reason: string | null; n: string }>(
        `select status, superseded_reason as reason, count(*)::text as n
           from public.source_match_candidates
          where source = $1 and source_environment = $2 and status <> $3
          group by 1, 2 order by 1, 2`,
        [args.provider, EVALUATION, ACTIONABLE_CANDIDATE_STATUS],
      );
      console.info(
        `  ${total.rows[0]!.n} candidate(s) AWAITING REVIEW; showing ${res.rows.length}`,
      );
      // History is not hidden — it is just not in the actionable queue.
      const historyLine = history.rows
        .map((h) => `${h.status}${h.reason ? `/${h.reason}` : ""}=${h.n}`)
        .join("  ");
      console.info(`  not actionable (history): ${historyLine || "none"}\n`);
      for (const r of res.rows) {
        // A machine pair and a reviewer's own pair are both legitimate review
        // work, and they carry different authority. Only the first is
        // generator-owned; the sync gate treats machine state and accounted
        // non-machine state differently, so the reviewer is told which row they
        // are reading.
        const origin = isGeneratorOwned({
          candidateKind: r.candidate_kind,
          matchMethod: r.match_method,
        })
          ? "machine"
          : "MANUAL";
        console.info(
          `  ── ${r.candidate_kind} · ${origin} · ${r.status}${r.superseded_reason ? ` (${r.superseded_reason})` : ""} · ${r.match_method}`,
        );
        console.info(
          `     A  ${r.left_source_id}  ${r.left_name ?? "(no name)"}  [${r.left_destination ?? "?"}]`,
        );
        console.info(
          `     B  ${r.right_source_id ?? "—"}  ${r.right_name ?? "(no name)"}  [${r.right_destination ?? "?"}]`,
        );
        console.info(
          `     name=${r.name_evidence} domain=${r.domain_evidence} address=${r.address_evidence} ` +
            `phone=${r.phone_evidence} brand=${r.brand_evidence} known_mapping=${r.known_source_mapping}`,
        );
        console.info(
          `     coordinate_distance_metres=${r.coordinate_distance_metres ?? "null"} (raw) · ` +
            `agreeing_dimensions=${r.agreeing_dimensions} (descriptive)`,
        );
        if (r.review_note) console.info(`     note: ${r.review_note}`);
        console.info("");
      }
      console.info("  A human decides each of these. No count, distance or evidence");
      console.info("  combination above accepts anything on its own.\n");
      return;
    }

    if (args.queue === "anomalies") {
      console.info(`  SHARED-KEY CLUSTERS  ${discovery.sharedKeyClusters.length}`);
      console.info("  A key naming a GROUP — a chain, an operator, a reservations desk.");
      console.info("  Real, and not pairwise identity evidence, so never expanded to pairs.\n");
      for (const c of [...discovery.sharedKeyClusters]
        .sort((a, b) => b.identityIds.length - a.identityIds.length)
        .slice(0, args.limit)) {
        console.info(`    ${c.reason.padEnd(28)}${c.key}  → ${c.identityIds.length} identities`);
      }

      console.info(
        `\n  CROSS-DESTINATION COLLISIONS  ${discovery.crossDestinationCollisions.length}`,
      );
      console.info("  The same key in more than one destination. Surfaced, never merged.\n");
      for (const c of discovery.crossDestinationCollisions.slice(0, args.limit)) {
        console.info(`    ${c.reason.padEnd(28)}${c.key}  → ${c.identityIds.length} identities`);
      }

      console.info(`\n  INCOMPLETE GEOGRAPHY  ${discovery.incompleteGeography.length}`);
      console.info("  A key shared by identities whose destination is unknown. Every blocking");
      console.info("  rule here is destination-scoped, so these cannot be paired — unknown is");
      console.info("  not the same place. The pair may well be real; this contract cannot say.\n");
      for (const c of discovery.incompleteGeography.slice(0, args.limit)) {
        console.info(`    ${c.reason.padEnd(28)}${c.key}  → ${c.identityIds.length} identities`);
      }

      console.info(
        `\n  identities involved: pairs ${partition.inPairs.size} · clusters ` +
          `${partition.inSharedKeyClusters.size} · cross-destination ` +
          `${partition.inCrossDestinationAnomalies.size} · incomplete geography ` +
          `${partition.inIncompleteGeography.size}`,
      );
      console.info("  (these sets OVERLAP by design — one identity can be in several)\n");
      return;
    }

    console.info(`  NO MACHINE CANDIDATE: ${partition.noMachineFinding.length} identities`);
    console.info("  Current discovery surfaced NOTHING for these: no pair, no shared-key");
    console.info("  cluster, no cross-destination collision, no incomplete-geography key.");
    console.info("  That is a statement about the RULES, not about the world — these are");
    console.info("  NOT new properties, and nothing here may be promoted on this queue.\n");

    if (partition.noMachineFinding.length > 0) {
      // Display geography from the SAME observation that supplies the displayed
      // facts — the latest one — not from the run that first saw the identity.
      const rows = await client.query<{
        source_property_id: string;
        source_name: string | null;
        slug: string | null;
      }>(
        `select i.source_property_id, o.source_name, d.slug
           from public.source_property_identities i
           join lateral (select o.source_name, o.source_run_id
                           from public.source_property_observations o
                          where o.source_property_identity_id = i.id
                          order by o.observed_at desc, o.id desc limit 1) o on true
           join public.source_runs r on r.id = o.source_run_id
           left join public.destinations d on d.id = r.destination_id
          where i.id = any($1::uuid[])
          order by i.source_property_id
          limit $2`,
        [partition.noMachineFinding, args.limit],
      );
      for (const r of rows.rows) {
        console.info(
          `    ${r.source_property_id}  ${r.source_name ?? "(no name)"}  [${r.slug ?? "?"}]`,
        );
      }
    }
    console.info("");
  } finally {
    await client.end();
  }
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (invokedDirectly) {
  main().catch((err: unknown) => {
    if (err instanceof UnsafeIngestionTargetError) {
      console.error(`\n[source:match:review] STOP\n\n${err.message}\n`);
      process.exit(2);
    }
    if (err instanceof ReviewOutOfSyncError) {
      console.error(`\n[source:match:review] STOP — OUT OF SYNC\n\n${err.message}\n`);
      process.exit(3);
    }
    console.error(`\n[source:match:review] failed: ${(err as Error).message}\n`);
    process.exit(1);
  });
}