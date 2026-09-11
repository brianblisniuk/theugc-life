import type {
  ReplyEvidenceMessage,
  ReplyEvidenceReferenceToken,
  RelationStatus,
} from "@/lib/gmail/reply/contract";

/**
 * Reply-relationship evidence, PRESERVED SEPARATELY from human/automated/
 * delivery classification (contract §7). `chronologyConflict` is true when a
 * direct/references relationship was established but `internal_date` places
 * the response at or before its own referenced creator send — the relation
 * survives; latency built from it must not (contract §10, "Timestamp
 * conflicts").
 */
export interface RelationResult {
  relationStatus: RelationStatus;
  referencedCreatorSentProviderMessageId: string | null;
  /**
   * The creator-sent touch with the greatest internal_date STRICTLY before
   * this candidate, independent of whether a direct/references relationship
   * was ALSO established — feeds CLOCK B (contract §10) for whichever
   * candidate becomes the first qualifying human reply. Null when there is
   * no preceding creator send, OR when two or more TIE for the latest one
   * (closure pass §17) — `latestPrecedingCreatorSentAtMs` still carries the
   * known timestamp in that case, since a tied SINGULAR identity must never
   * destroy an otherwise-knowable latency.
   */
  latestPrecedingCreatorSentProviderMessageId: string | null;
  latestPrecedingCreatorSentAtMs: number | null;
  chronologyConflict: boolean;
}

/**
 * Every LOCAL message's own `Message-ID` declaration, keyed by the raw
 * token — regardless of whether that message is creator-sent. CLOSURE PASS
 * §11: a prior version indexed creator-sent messages' own Message-IDs only,
 * so a non-SENT message that (via duplicate/malformed evidence) ALSO
 * declared the identical literal Message-ID as some creator-sent message
 * was invisible to this index — an `In-Reply-To`/`References` token
 * pointing at that shared literal string then resolved, silently and
 * incorrectly, to the creator-sent message alone. Indexing every local
 * owner and treating >1 owner as ambiguous (below) closes that gap: D071
 * requires that when one token could name more than one LOCAL message, B06
 * must not silently pick one.
 */
function buildMessageIdOwnerIndex(
  messages: readonly ReplyEvidenceMessage[],
  referenceTokens: readonly ReplyEvidenceReferenceToken[],
): Map<string, Set<string>> {
  const localIds = new Set(messages.map((m) => m.providerMessageId));
  const index = new Map<string, Set<string>>();

  for (const token of referenceTokens) {
    if (token.headerRole !== "message-id" || token.parseStatus !== "valid_msgid") continue;
    if (!localIds.has(token.providerMessageId)) continue;

    const existing = index.get(token.rawToken);
    if (existing) {
      existing.add(token.providerMessageId);
    } else {
      index.set(token.rawToken, new Set([token.providerMessageId]));
    }
  }

  return index;
}

/**
 * The set of creator-sent provider ids any of `tokens` unambiguously
 * resolves to, via `ownerIndex` — a token whose raw string names MORE THAN
 * ONE local message (any owner, not just creator-sent ones) contributes
 * nothing here; it is surfaced as ambiguous by the caller instead of being
 * silently narrowed to whichever owner happens to be creator-sent.
 */
function matchTokens(
  tokens: readonly ReplyEvidenceReferenceToken[],
  headerRole: "in-reply-to" | "references",
  candidateProviderMessageId: string,
  ownerIndex: Map<string, Set<string>>,
  creatorSentIds: ReadonlySet<string>,
): { matched: Set<string>; sawAmbiguousLocalOwner: boolean } {
  const matched = new Set<string>();
  let sawAmbiguousLocalOwner = false;
  for (const token of tokens) {
    if (
      token.providerMessageId !== candidateProviderMessageId ||
      token.headerRole !== headerRole ||
      token.parseStatus !== "valid_msgid"
    ) {
      continue;
    }
    const owners = ownerIndex.get(token.rawToken);
    if (!owners) continue;
    if (owners.size > 1) {
      sawAmbiguousLocalOwner = true;
      continue;
    }
    const [ownerId] = owners;
    if (ownerId && creatorSentIds.has(ownerId)) matched.add(ownerId);
  }
  return { matched, sawAmbiguousLocalOwner };
}

/**
 * Computes reply-relationship evidence for every NON-SENT message in a
 * thread, given the full evidence set. `messages` need not be sorted; this
 * function sorts internally by `(internalDateMs, providerMessageId)` —
 * deterministic reading order only, never proof of causal order (contract
 * §10, "Equal-time/tie cases").
 */
export function computeRelations(
  messages: readonly ReplyEvidenceMessage[],
  referenceTokens: readonly ReplyEvidenceReferenceToken[],
): Map<string, RelationResult> {
  const sorted = [...messages].sort((a, b) =>
    a.internalDateMs !== b.internalDateMs
      ? a.internalDateMs - b.internalDateMs
      : a.providerMessageId < b.providerMessageId
        ? -1
        : a.providerMessageId > b.providerMessageId
          ? 1
          : 0,
  );

  const creatorSentMessages = sorted.filter((m) => m.providerSent);
  const creatorSentIds = new Set(creatorSentMessages.map((m) => m.providerMessageId));
  const messageIdOwnerIndex = buildMessageIdOwnerIndex(sorted, referenceTokens);
  const byProviderMessageId = new Map(sorted.map((m) => [m.providerMessageId, m]));

  const results = new Map<string, RelationResult>();

  for (const candidate of sorted) {
    if (candidate.providerSent) continue;

    // The creator-sent touch with the greatest internal_date STRICTLY
    // before this candidate — independent of reference-token evidence.
    // CLOSURE PASS §17: two or more creator sends sharing that maximal
    // preceding timestamp is a TIE — the identity is null, but the
    // timestamp survives so CLOCK B's latency need not be destroyed.
    let latestPrecedingAtMs: number | null = null;
    let latestPrecedingId: string | null = null;
    let latestPrecedingTieCount = 0;
    for (const sent of creatorSentMessages) {
      if (sent.internalDateMs >= candidate.internalDateMs) continue;
      if (latestPrecedingAtMs === null || sent.internalDateMs > latestPrecedingAtMs) {
        latestPrecedingAtMs = sent.internalDateMs;
        latestPrecedingId = sent.providerMessageId;
        latestPrecedingTieCount = 1;
      } else if (sent.internalDateMs === latestPrecedingAtMs) {
        latestPrecedingTieCount += 1;
      }
    }
    if (latestPrecedingTieCount > 1) latestPrecedingId = null;

    const direct = matchTokens(
      referenceTokens,
      "in-reply-to",
      candidate.providerMessageId,
      messageIdOwnerIndex,
      creatorSentIds,
    );
    if (direct.matched.size === 1 && !direct.sawAmbiguousLocalOwner) {
      const referencedId = [...direct.matched][0]!;
      results.set(candidate.providerMessageId, {
        relationStatus: "direct_in_reply_to",
        referencedCreatorSentProviderMessageId: referencedId,
        latestPrecedingCreatorSentProviderMessageId: latestPrecedingId,
        latestPrecedingCreatorSentAtMs: latestPrecedingAtMs,
        chronologyConflict: isChronologyConflict(byProviderMessageId, referencedId, candidate),
      });
      continue;
    }
    if (direct.matched.size > 1 || direct.sawAmbiguousLocalOwner) {
      results.set(candidate.providerMessageId, {
        relationStatus: "ambiguous_reference",
        referencedCreatorSentProviderMessageId: null,
        latestPrecedingCreatorSentProviderMessageId: latestPrecedingId,
        latestPrecedingCreatorSentAtMs: latestPrecedingAtMs,
        chronologyConflict: false,
      });
      continue;
    }

    const references = matchTokens(
      referenceTokens,
      "references",
      candidate.providerMessageId,
      messageIdOwnerIndex,
      creatorSentIds,
    );
    if (references.matched.size === 1 && !references.sawAmbiguousLocalOwner) {
      const referencedId = [...references.matched][0]!;
      results.set(candidate.providerMessageId, {
        relationStatus: "references_chain",
        referencedCreatorSentProviderMessageId: referencedId,
        latestPrecedingCreatorSentProviderMessageId: latestPrecedingId,
        latestPrecedingCreatorSentAtMs: latestPrecedingAtMs,
        chronologyConflict: isChronologyConflict(byProviderMessageId, referencedId, candidate),
      });
      continue;
    }
    if (references.matched.size > 1 || references.sawAmbiguousLocalOwner) {
      results.set(candidate.providerMessageId, {
        relationStatus: "ambiguous_reference",
        referencedCreatorSentProviderMessageId: null,
        latestPrecedingCreatorSentProviderMessageId: latestPrecedingId,
        latestPrecedingCreatorSentAtMs: latestPrecedingAtMs,
        chronologyConflict: false,
      });
      continue;
    }

    if (latestPrecedingAtMs !== null) {
      results.set(candidate.providerMessageId, {
        relationStatus: "thread_sequence_only",
        referencedCreatorSentProviderMessageId: null,
        latestPrecedingCreatorSentProviderMessageId: latestPrecedingId,
        latestPrecedingCreatorSentAtMs: latestPrecedingAtMs,
        chronologyConflict: false,
      });
      continue;
    }

    results.set(candidate.providerMessageId, {
      relationStatus: "no_preceding_creator_sent",
      referencedCreatorSentProviderMessageId: null,
      latestPrecedingCreatorSentProviderMessageId: null,
      latestPrecedingCreatorSentAtMs: null,
      chronologyConflict: false,
    });
  }

  return results;
}

function isChronologyConflict(
  byProviderMessageId: Map<string, ReplyEvidenceMessage>,
  referencedProviderMessageId: string,
  candidate: ReplyEvidenceMessage,
): boolean {
  const referenced = byProviderMessageId.get(referencedProviderMessageId);
  if (!referenced) return true;
  return referenced.internalDateMs >= candidate.internalDateMs;
}
