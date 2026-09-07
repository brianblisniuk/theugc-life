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
   * candidate becomes the first qualifying human reply.
   */
  latestPrecedingCreatorSentProviderMessageId: string | null;
  chronologyConflict: boolean;
}

/**
 * `Message-ID` is evidence only (contract §7) — provider message identity
 * remains `(mail_account_id, provider_message_id)`. Repeated/duplicate
 * Message-ID tokens across different creator-sent messages are preserved as
 * ambiguity, never silently resolved to one (contract §7, "Repeated/
 * ambiguous Message-ID evidence").
 */
function buildCreatorSentMessageIdIndex(
  creatorSentMessages: readonly ReplyEvidenceMessage[],
  referenceTokens: readonly ReplyEvidenceReferenceToken[],
): Map<string, Set<string>> {
  const creatorSentIds = new Set(creatorSentMessages.map((m) => m.providerMessageId));
  const index = new Map<string, Set<string>>();

  for (const token of referenceTokens) {
    if (token.headerRole !== "message-id" || token.parseStatus !== "valid_msgid") continue;
    if (!creatorSentIds.has(token.providerMessageId)) continue;

    const existing = index.get(token.rawToken);
    if (existing) {
      existing.add(token.providerMessageId);
    } else {
      index.set(token.rawToken, new Set([token.providerMessageId]));
    }
  }

  return index;
}

/** Union of every creator-sent provider id any of `tokens` resolves to, via `index`. */
function matchTokens(
  tokens: readonly ReplyEvidenceReferenceToken[],
  headerRole: "in-reply-to" | "references",
  candidateProviderMessageId: string,
  index: Map<string, Set<string>>,
): Set<string> {
  const matched = new Set<string>();
  for (const token of tokens) {
    if (
      token.providerMessageId !== candidateProviderMessageId ||
      token.headerRole !== headerRole ||
      token.parseStatus !== "valid_msgid"
    ) {
      continue;
    }
    const resolved = index.get(token.rawToken);
    if (resolved) {
      for (const id of resolved) matched.add(id);
    }
  }
  return matched;
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
  const messageIdIndex = buildCreatorSentMessageIdIndex(creatorSentMessages, referenceTokens);
  const byProviderMessageId = new Map(sorted.map((m) => [m.providerMessageId, m]));

  const results = new Map<string, RelationResult>();

  for (const candidate of sorted) {
    if (candidate.providerSent) continue;

    // The creator-sent touch with the greatest internal_date STRICTLY
    // before this candidate — independent of reference-token evidence.
    let latestPreceding: ReplyEvidenceMessage | null = null;
    for (const sent of creatorSentMessages) {
      if (sent.internalDateMs >= candidate.internalDateMs) continue;
      if (!latestPreceding || sent.internalDateMs > latestPreceding.internalDateMs) {
        latestPreceding = sent;
      }
    }
    const latestPrecedingId = latestPreceding?.providerMessageId ?? null;

    const directMatches = matchTokens(
      referenceTokens,
      "in-reply-to",
      candidate.providerMessageId,
      messageIdIndex,
    );
    if (directMatches.size === 1) {
      const referencedId = [...directMatches][0]!;
      results.set(candidate.providerMessageId, {
        relationStatus: "direct_in_reply_to",
        referencedCreatorSentProviderMessageId: referencedId,
        latestPrecedingCreatorSentProviderMessageId: latestPrecedingId,
        chronologyConflict: isChronologyConflict(byProviderMessageId, referencedId, candidate),
      });
      continue;
    }
    if (directMatches.size > 1) {
      results.set(candidate.providerMessageId, {
        relationStatus: "ambiguous_reference",
        referencedCreatorSentProviderMessageId: null,
        latestPrecedingCreatorSentProviderMessageId: latestPrecedingId,
        chronologyConflict: false,
      });
      continue;
    }

    const referencesMatches = matchTokens(
      referenceTokens,
      "references",
      candidate.providerMessageId,
      messageIdIndex,
    );
    if (referencesMatches.size === 1) {
      const referencedId = [...referencesMatches][0]!;
      results.set(candidate.providerMessageId, {
        relationStatus: "references_chain",
        referencedCreatorSentProviderMessageId: referencedId,
        latestPrecedingCreatorSentProviderMessageId: latestPrecedingId,
        chronologyConflict: isChronologyConflict(byProviderMessageId, referencedId, candidate),
      });
      continue;
    }
    if (referencesMatches.size > 1) {
      results.set(candidate.providerMessageId, {
        relationStatus: "ambiguous_reference",
        referencedCreatorSentProviderMessageId: null,
        latestPrecedingCreatorSentProviderMessageId: latestPrecedingId,
        chronologyConflict: false,
      });
      continue;
    }

    if (latestPreceding) {
      results.set(candidate.providerMessageId, {
        relationStatus: "thread_sequence_only",
        referencedCreatorSentProviderMessageId: null,
        latestPrecedingCreatorSentProviderMessageId: latestPrecedingId,
        chronologyConflict: false,
      });
      continue;
    }

    results.set(candidate.providerMessageId, {
      relationStatus: "no_preceding_creator_sent",
      referencedCreatorSentProviderMessageId: null,
      latestPrecedingCreatorSentProviderMessageId: null,
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
