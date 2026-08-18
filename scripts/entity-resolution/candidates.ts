/**
 * Candidate discovery for pre-publication entity resolution.
 *
 * WHAT A BLOCKING RULE DECIDES
 * ----------------------------
 * Only this: **is this pair worth comparing?** It is not a match, not a partial
 * match, not a reason to accept anything, and not a persistence-ownership
 * decision. A newly machine-owned relationship may be persisted as a pending
 * `source_match_candidates` row by the writer; an existing manual or decided
 * relationship is not rewritten into machine state. BLOCKING != MATCH.
 *
 * A KEY MUST IDENTIFY, NOT GROUP
 * ------------------------------
 * The real Bali/Dubai evidence made this the load-bearing rule. Exact domain
 * looks like a strong anchor until you look at the distribution: 69 domains are
 * shared by exactly two properties, and then there is `oyorooms.com` with 31,
 * `ihg.com` with 25, `all.accor.com` with 25. The same shape appears on phone —
 * 160 numbers shared by two properties, and one shared by 47, which is a call
 * centre.
 *
 * Those large keys are not weak identity evidence. They are evidence about a
 * DIFFERENT thing — a chain, an operator, a reservations desk — and expanding
 * them pairwise would bury 229 genuine 1:1 collisions under ~4,100 pairs of
 * "these are both Accor hotels". So:
 *
 *   a key generates a candidate pair only when it selects EXACTLY TWO
 *   identities in scope; a key selecting three or more is recorded as a
 *   SHARED-KEY CLUSTER for review and never expanded.
 *
 * That is a distinction between cardinalities — does this key name a property or
 * a group? — rather than a tuned constant, and it invents no score. Its cost is
 * stated plainly: a genuine triplicate is reported as a cluster rather than as
 * three pairs, so it reaches a reviewer as one finding instead of three. Nothing
 * is hidden; it is just not pre-paired.
 *
 * DESTINATION SCOPE
 * -----------------
 * Keys are scoped to the destination. A Ritz-Carlton in Bali and a Ritz-Carlton
 * in Dubai share `ritzcarlton.com` and are two properties. They are reported as
 * ANOMALIES and never paired. This does not assert that one physical property
 * can never span a destination boundary — it asserts that a shared chain asset
 * is not the evidence that would establish it.
 *
 * And that is a fact about the KEY, not about the destination you are standing
 * in: `marriott.com` does not become property-level identity evidence inside
 * Bali just because the Dubai Marriotts are in a different bucket. So a key
 * appearing in more than one KNOWN destination is VETOED GLOBALLY — it
 * contributes zero pairs anywhere, in every destination, and the veto is decided
 * before any scoped bucket is expanded.
 *
 * The veto removes a REASON, not a pair. Two Bali properties sharing both
 * `marriott.com` and a local phone still surface as one candidate on the phone.
 * And it does not touch clusters, which are not pairs.
 *
 * WHAT IS NOT HERE
 * ----------------
 * No fuzzy score, no edit distance, no coordinate cutoff, no weighted total, no
 * confidence percentage, no embedding, no model. Equality of a normalised value,
 * or nothing.
 */
import { comparablePhone, type ComparableRecord } from "./evidence";
import { normalizeDomain, normalizeName } from "./normalize";

/** Why a pair became worth comparing. Persisted verbatim as `match_method`. */
export type BlockingReason = "exact_domain" | "exact_phone" | "exact_name_in_destination";

export const BLOCKING_REASONS: readonly BlockingReason[] = [
  "exact_domain",
  "exact_phone",
  "exact_name_in_destination",
];

export interface BlockableIdentity extends ComparableRecord {
  identityId: string;
  /**
   * The destination of the LATEST observation being compared, read through that
   * observation's own `source_run` — never the run that first saw the identity.
   * The observation and its geography are one current evidence unit.
   *
   * NULL = the destination is unknown, which is NOT a destination: it scopes
   * nothing, and it never equals another NULL.
   */
  destinationId: string | null;
  observationId: string;
}

export interface CandidatePair {
  /** Lexicographically smaller identity, so a pair is ONE row, not two. */
  leftIdentityId: string;
  rightIdentityId: string;
  /** Every reason this pair surfaced, sorted — the `match_method` value. */
  reasons: BlockingReason[];
}

/** A key that named a group rather than a property. Never expanded to pairs. */
export interface SharedKeyCluster {
  reason: BlockingReason;
  key: string;
  destinationId: string | null;
  identityIds: string[];
}

/** The same key seen in more than one destination. Reported, never paired. */
export interface CrossDestinationCollision {
  reason: BlockingReason;
  key: string;
  destinationIds: (string | null)[];
  identityIds: string[];
}

/** A key shared by identities whose destination is unknown. Never a pair. */
export interface IncompleteGeographyKey {
  reason: BlockingReason;
  key: string;
  identityIds: string[];
}

export interface DiscoveryResult {
  pairs: CandidatePair[];
  sharedKeyClusters: SharedKeyCluster[];
  crossDestinationCollisions: CrossDestinationCollision[];
  incompleteGeography: IncompleteGeographyKey[];
  /** Pair counts per reason, for the stress report. */
  pairsByReason: Record<BlockingReason, number>;
}

/** The blocking key a rule extracts from one identity, or null if it has none. */
function keyFor(reason: BlockingReason, identity: BlockableIdentity): string | null {
  switch (reason) {
    case "exact_domain":
      return normalizeDomain(identity.websiteUrl);
    case "exact_phone":
      return comparablePhone(identity);
    case "exact_name_in_destination":
      return normalizeName(identity.name);
  }
}

/**
 * UNKNOWN GEOGRAPHY IS NOT THE SAME PLACE
 * ---------------------------------------
 * Every blocking rule in this V1 contract is destination-scoped, so an identity
 * whose destination is unknown cannot satisfy any of them. Mapping NULL to a
 * shared sentinel would make two unknown-geography identities "the same
 * destination" on the fiction that NULL equals NULL — and a shared name, domain
 * or phone between them would then become a pair on the strength of a fact
 * nobody has.
 *
 * They are not discarded. They are reported as an INCOMPLETE-GEOGRAPHY finding,
 * which is the honest description: the pair may well be real, and this contract
 * cannot say so.
 */
function scopeOf(identity: BlockableIdentity): string | null {
  return identity.destinationId;
}

export function discoverCandidates(input: readonly BlockableIdentity[]): DiscoveryResult {
  // One entry per identity. A caller passing the same identity twice must not
  // be able to produce a self-pair through the back door; the database refuses
  // one anyway (`source_match_candidates_no_self_match`), and discovery should
  // never hand it a row to refuse.
  const identities = [...new Map(input.map((i) => [i.identityId, i])).values()];
  const pairReasons = new Map<string, Set<BlockingReason>>();
  const sharedKeyClusters: SharedKeyCluster[] = [];
  const crossDestinationCollisions: CrossDestinationCollision[] = [];
  const incompleteGeography: IncompleteGeographyKey[] = [];
  const pairsByReason = Object.fromEntries(BLOCKING_REASONS.map((r) => [r, 0])) as Record<
    BlockingReason,
    number
  >;

  for (const reason of BLOCKING_REASONS) {
    // Grouped twice: once within the destination, which is what may produce
    // pairs, and once across all destinations, which may only produce anomalies.
    const scoped = new Map<string, BlockableIdentity[]>();
    const global = new Map<string, BlockableIdentity[]>();
    const unknownGeography = new Map<string, BlockableIdentity[]>();

    for (const identity of identities) {
      const key = keyFor(reason, identity);
      if (key === null) continue;
      const scope = scopeOf(identity);
      const bucket = scope === null ? unknownGeography : scoped;
      const bucketKey = scope === null ? key : `${scope} ${key}`;
      (bucket.get(bucketKey) ?? bucket.set(bucketKey, []).get(bucketKey)!).push(identity);
      (global.get(key) ?? global.set(key, []).get(key)!).push(identity);
    }

    // THE CROSS-DESTINATION VETO, DECIDED BEFORE ANY PAIR EXISTS.
    //
    // A key seen in more than one KNOWN destination is evidence about a chain,
    // an operator or a booking desk — `marriott.com` is not a property anywhere,
    // and that is a fact about the key itself, not about the destination you
    // happen to be standing in. Scoping first and checking afterwards would let
    // the two Bali properties on `marriott.com` become a pair while the same key
    // was simultaneously reported as a cross-destination anomaly: the contract
    // says such a key contributes ZERO pairs, so the veto has to be known before
    // the scoped buckets are expanded.
    //
    // A NULL destination is not a second destination, so it can never veto
    // anything; unknown geography is reported on its own terms below.
    const vetoed = new Set<string>();
    for (const [key, members] of global) {
      const destinations = new Set(members.map((m) => scopeOf(m)));
      destinations.delete(null);
      if (destinations.size > 1) vetoed.add(key);
    }

    for (const [scopedKey, members] of scoped) {
      if (members.length < 2) continue;
      const key = scopedKey.slice(scopedKey.indexOf(" ") + 1);
      const destinationId = members[0]!.destinationId;

      // The veto removes this REASON from this pair, and nothing else. An
      // independent reason that is destination-safe still stands on its own: two
      // Bali properties sharing both `marriott.com` and a local phone number are
      // still worth comparing, on the phone — the pair survives with
      // `blocking:exact_phone`, not `blocking:exact_domain+exact_phone`.
      //
      // A CLUSTER is not vetoed: it is not a pair, and "these four Bali
      // properties share a chain domain that also appears in Dubai" is a true
      // and useful thing to show a reviewer.
      if (vetoed.has(key) && members.length === 2) continue;

      if (members.length > 2) {
        // A key naming a GROUP. Recorded so a reviewer can see it; not expanded.
        sharedKeyClusters.push({
          reason,
          key,
          destinationId,
          identityIds: members.map((m) => m.identityId).sort(),
        });
        continue;
      }

      const [a, b] = members as [BlockableIdentity, BlockableIdentity];
      const [left, right] =
        a.identityId < b.identityId ? [a.identityId, b.identityId] : [b.identityId, a.identityId];
      const id = `${left} ${right}`;
      const set = pairReasons.get(id) ?? pairReasons.set(id, new Set()).get(id)!;
      set.add(reason);
    }

    // A key shared by identities whose destination nobody knows. Surfaced, and
    // never paired: see the note above `scopeOf`.
    for (const [key, members] of unknownGeography) {
      if (members.length < 2) continue;
      incompleteGeography.push({
        reason,
        key,
        identityIds: members.map((m) => m.identityId).sort(),
      });
    }

    // The anomalies are exactly the vetoed keys — one computation, so what is
    // REPORTED and what is REFUSED can never disagree.
    for (const [key, members] of global) {
      if (!vetoed.has(key)) continue;
      crossDestinationCollisions.push({
        reason,
        key,
        destinationIds: [...new Set(members.map((m) => m.destinationId))],
        identityIds: members.map((m) => m.identityId).sort(),
      });
    }
  }

  const pairs: CandidatePair[] = [...pairReasons.entries()]
    .map(([id, reasons]) => {
      const [leftIdentityId, rightIdentityId] = id.split(" ") as [string, string];
      const sorted = BLOCKING_REASONS.filter((r) => reasons.has(r));
      for (const reason of sorted) pairsByReason[reason] += 1;
      return { leftIdentityId, rightIdentityId, reasons: sorted };
    })
    .sort((a, b) =>
      a.leftIdentityId === b.leftIdentityId
        ? a.rightIdentityId.localeCompare(b.rightIdentityId)
        : a.leftIdentityId.localeCompare(b.leftIdentityId),
    );

  return {
    pairs,
    sharedKeyClusters,
    crossDestinationCollisions,
    incompleteGeography,
    pairsByReason,
  };
}
/** The deterministic `match_method` for a pair: its reasons, sorted and joined. */
export function matchMethodFor(reasons: readonly BlockingReason[]): string {
  return `blocking:${[...reasons].sort().join("+")}`;
}
