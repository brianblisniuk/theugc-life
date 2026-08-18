/**
 * The review partition, derived from ONE current discovery result.
 *
 * WHY THIS IS A MODULE AND NOT FOUR QUERIES
 * -----------------------------------------
 * The queues have to agree with each other, and the way they stop agreeing is
 * by being computed in different places from different sources. The dangerous
 * one is "NO MACHINE CANDIDATE": if it is derived from the ABSENCE OF A ROW in
 * `source_match_candidates`, it answers a question nobody asked —
 *
 *   - a pair that existed and was stood down leaves a row behind, so its two
 *     identities would be excluded from "nothing surfaced" forever, even though
 *     current discovery surfaces nothing for them;
 *   - the 31 identities sharing `oyorooms.com` produce a shared-key cluster and
 *     no rows at all, so they would appear as "nothing surfaced" even though the
 *     machine found something material about every one of them.
 *
 * So every queue here is computed from the SAME `DiscoveryResult`, and the
 * residual queue is defined by subtraction rather than by a separate query.
 *
 * IT STILL DOES NOT MEAN "NEW PROPERTY".
 * `noMachineFinding` means the current blocking rules surfaced nothing to
 * compare — a statement about the RULES, not about the world. Nothing may be
 * promoted on the strength of membership in it.
 */
import type { BlockableIdentity, DiscoveryResult } from "./candidates";

export interface ReviewPartition {
  /** Identities in at least one current candidate pair. */
  inPairs: Set<string>;
  /** Identities in a key that named a GROUP rather than a property. */
  inSharedKeyClusters: Set<string>;
  /** Identities sharing a key across destinations. */
  inCrossDestinationAnomalies: Set<string>;
  /** Identities sharing a key while their destination is unknown. */
  inIncompleteGeography: Set<string>;
  /**
   * Identities in NONE of the above.
   *
   * NOT "new properties", NOT "unique", NOT "confirmed distinct".
   */
  noMachineFinding: string[];
}

/**
 * The four finding sets OVERLAP by design — one identity can be in a pair on its
 * phone and in a shared-key cluster on its chain domain, and both facts are
 * true. Only the residual is exclusive, and it is exclusive by construction: an
 * identity appears there exactly when it appears in none of the others.
 */
export function partitionForReview(
  identities: readonly BlockableIdentity[],
  discovery: DiscoveryResult,
): ReviewPartition {
  const inPairs = new Set<string>();
  for (const pair of discovery.pairs) {
    inPairs.add(pair.leftIdentityId);
    inPairs.add(pair.rightIdentityId);
  }

  const collect = (groups: readonly { identityIds: string[] }[]): Set<string> =>
    new Set(groups.flatMap((g) => g.identityIds));

  const inSharedKeyClusters = collect(discovery.sharedKeyClusters);
  const inCrossDestinationAnomalies = collect(discovery.crossDestinationCollisions);
  const inIncompleteGeography = collect(discovery.incompleteGeography);

  const noMachineFinding = identities
    .map((i) => i.identityId)
    .filter(
      (id) =>
        !inPairs.has(id) &&
        !inSharedKeyClusters.has(id) &&
        !inCrossDestinationAnomalies.has(id) &&
        !inIncompleteGeography.has(id),
    );

  return {
    inPairs,
    inSharedKeyClusters,
    inCrossDestinationAnomalies,
    inIncompleteGeography,
    noMachineFinding,
  };
}

/**
 * The statuses a CANDIDATES review queue may show.
 *
 * Exactly one: `pending`. A machine-superseded row is history, an
 * accepted/rejected row is decided, and a human-superseded row is decided too —
 * none of the three is waiting for anybody. Showing them in the actionable queue
 * would put four different meanings behind one word.
 */
export const ACTIONABLE_CANDIDATE_STATUS = "pending" as const;

/**
 * The generator's own namespace.
 *
 * A machine candidate is a `source_identity` row whose `match_method` starts
 * with `blocking:` — the mark `generateCandidates` puts on everything it
 * creates. Rows outside it (a `manual_search` pair a reviewer added, a
 * `canonical_hotel` candidate, a `new_property` finding) belong to somebody
 * else, and this module never claims authority over them.
 */
export const MACHINE_MATCH_METHOD_PREFIX = "blocking:" as const;
export const MACHINE_CANDIDATE_KIND = "source_identity" as const;

/**
 * Is this row the generator's to touch?
 *
 * BOTH halves are required. One ownership definition governs the writer, review
 * origin label and sync gate: `candidate_kind = 'source_identity'` plus a
 * `blocking:` match method. This TypeScript helper implements that definition;
 * the writer and sync SQL mirror the same two conditions at their database
 * boundaries. `match_method` alone is too weak: a `canonical_hotel` row is not
 * something `generateCandidates` produces at all, and nothing stops a future
 * tool writing one with a blocking-shaped method. Ownership is the pair of
 * facts, or it is not ownership.
 */
export function isGeneratorOwned(row: { candidateKind: string; matchMethod: string }): boolean {
  return (
    row.candidateKind === MACHINE_CANDIDATE_KIND &&
    row.matchMethod.startsWith(MACHINE_MATCH_METHOD_PREFIX)
  );
}

/** An unordered source↔source pair, in the canonical orientation 0030 enforces. */
export interface PairKey {
  leftIdentityId: string;
  rightIdentityId: string;
}

const pairId = (p: PairKey): string =>
  p.leftIdentityId < p.rightIdentityId
    ? `${p.leftIdentityId} ${p.rightIdentityId}`
    : `${p.rightIdentityId} ${p.leftIdentityId}`;

export interface MachineSyncResult {
  inSync: boolean;
  /** Discovered now, and nothing has accounted for it — the writer has not run. */
  discoveredNotPersisted: PairKey[];
  /** A pending machine row current discovery no longer produces — stale. */
  persistedNotDiscovered: PairKey[];
}

/**
 * Is the persisted ACTIONABLE machine state the same claim current discovery
 * makes?
 *
 * The CANDIDATES queue reads persisted rows, and the other two queues are
 * computed from a live sweep. Those are two different moments, and between them
 * a provider correction can leave the queue describing a relationship that no
 * longer has evidence — or hide one that just gained it. Neither is visible from
 * the queue itself: a stale row looks exactly like a current one.
 *
 * So the two are compared before the queue is shown, and DISAGREEMENT IS AN
 * ERROR rather than a filter. Silently intersecting them would hide a newly
 * discovered pair that was never persisted, and would hide a stale pending row
 * without recording the supersession it is owed — both of which leave a reviewer
 * believing they saw everything current.
 *
 * Only the generator's own namespace is compared. A `manual_search` pending row
 * is legitimate review work that discovery never claimed to produce, so its
 * absence from the sweep is not a disagreement about anything.
 *
 * THE COMPARISON IS NOT SYMMETRIC, and it must not be.
 *
 * The question the discovered side asks is "does a reviewer have this
 * relationship in front of them?", NOT "does the generator own a row for it?".
 * Three different things answer yes:
 *
 *   1. a current actionable MACHINE pair — the generator's own row;
 *   2. a pair a human DECIDED — accepted, rejected, or set aside. Its evidence
 *      did not change, so discovery keeps producing it while its row is no
 *      longer `pending`;
 *   3. a MANUAL pending pair — a reviewer's own `source_identity` row that the
 *      generator did not create. One pair is one row, so the generator may not
 *      add a second, and it may not seize this one.
 *
 * Only (1) is generator-owned. (2) and (3) are ACCOUNTED FOR and never machine
 * state — which is exactly why the gate must count them: treating either as
 * missing would raise an alarm no run of the generator could ever clear, since
 * it is forbidden from touching both. The gate would then refuse review forever
 * over a relationship a reviewer can already see.
 *
 * The reverse direction stays narrow: only an actionable MACHINE row may be
 * called stale, because only the generator can stand one down.
 */
export function compareMachinePairSync(
  discovered: readonly PairKey[],
  persistedActionableMachine: readonly PairKey[],
  accountedNonMachine: readonly PairKey[] = [],
): MachineSyncResult {
  const discoveredById = new Map(discovered.map((p) => [pairId(p), p]));
  const persistedById = new Map(persistedActionableMachine.map((p) => [pairId(p), p]));
  const accountedIds = new Set(accountedNonMachine.map(pairId));

  const discoveredNotPersisted = [...discoveredById]
    .filter(([id]) => !persistedById.has(id) && !accountedIds.has(id))
    .map(([, p]) => p);
  const persistedNotDiscovered = [...persistedById]
    .filter(([id]) => !discoveredById.has(id))
    .map(([, p]) => p);

  return {
    inSync: discoveredNotPersisted.length === 0 && persistedNotDiscovered.length === 0,
    discoveredNotPersisted,
    persistedNotDiscovered,
  };
}