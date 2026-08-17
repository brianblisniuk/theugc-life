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
