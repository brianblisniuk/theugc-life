import { describe, expect, it } from "vitest";

import {
  outreachInterpretMailboxUntilIdle,
  requirePositiveInteger,
  type OutreachDeps,
} from "@/lib/gmail/outreach/service";

/**
 * The bounded forward-progress worker (`outreachInterpretMailboxUntilIdle`)
 * is the identical algorithm B04's `normalizeMailboxUntilIdle` already
 * proves at the database level (a permanently-failing candidate must not
 * infinite-loop at batchSize=1, and must not falsely report idle at a larger
 * batch size). Proven here with a FAKE `deps.db` — the algorithm itself is
 * pure JS logic over RPC *outcomes*, so a mock is sufficient and much
 * faster than standing up Postgres to reproduce every one of these cases.
 */

interface FakeRpcCall {
  name: string;
  args: Record<string, unknown>;
}

function fakeDeps(input: {
  candidateThreadIds: string[];
  commitResult: (threadId: string) => { result: string; current_evidence_digest?: string };
}): { deps: OutreachDeps; calls: FakeRpcCall[] } {
  const calls: FakeRpcCall[] = [];
  // A committed ("ok") thread must stop being a candidate on the NEXT list
  // call, exactly like the real `gmail_outreach_list_candidates` query (it
  // naturally excludes a thread once a current signal row exists for it) —
  // otherwise this fake would misrepresent success as a permanent failure
  // and loop forever re-offering an already-interpreted thread.
  const committed = new Set<string>();

  const rpc = async (name: string, args: Record<string, unknown> = {}) => {
    calls.push({ name, args });

    if (name === "gmail_outreach_current_catalog_epoch") {
      return { data: 1, error: null };
    }

    if (name === "gmail_outreach_list_candidates") {
      const excluded = new Set((args.p_exclude_normalized_thread_ids as string[]) ?? []);
      const remaining = input.candidateThreadIds.filter(
        (id) => !excluded.has(id) && !committed.has(id),
      );
      const limit = args.p_limit as number;
      return {
        data: {
          result: "ok",
          candidates: remaining
            .slice(0, limit)
            .map((id) => ({ normalized_thread_id: id, provider_thread_id: id })),
        },
        error: null,
      };
    }

    if (name === "gmail_outreach_get_thread_evidence") {
      const threadId = args.p_normalized_thread_id as string;
      return {
        data: {
          result: "ok",
          normalized_thread_id: threadId,
          provider_thread_id: threadId,
          messages: [
            {
              normalized_message_id: `${threadId}-m1`,
              provider_message_id: `${threadId}-m1`,
              provider_sent: true,
              internal_date_ms: 0,
              source_payload_sha256: "a".repeat(64),
            },
          ],
          sent_text_parts: [],
          sent_recipients: [],
          subjects: [],
        },
        error: null,
      };
    }

    if (name === "gmail_outreach_commit_interpretation") {
      const threadId = args.p_normalized_thread_id as string;
      const outcome = input.commitResult(threadId);
      if (outcome.result === "ok") committed.add(threadId);
      return { data: outcome, error: null };
    }

    throw new Error(`unexpected fake rpc call: ${name}`);
  };

  const db = {
    rpc,
    from: () => ({ select: () => ({ in: () => ({}) }) }),
  } as unknown as OutreachDeps["db"];
  return { deps: { db }, calls };
}

describe("B05: bounded forward progress in outreachInterpretMailboxUntilIdle", () => {
  it("a permanently-failing candidate at batchSize=1 terminates (never an infinite loop)", async () => {
    const { deps, calls } = fakeDeps({
      candidateThreadIds: ["thread-broken"],
      commitResult: () => ({ result: "stale_source", current_evidence_digest: "b".repeat(64) }),
    });

    const result = await outreachInterpretMailboxUntilIdle(deps, {
      userId: "u1",
      mailAccountId: "a1",
      batchSize: 1,
    });

    expect(result.completed).toBe(false);
    expect(result.gaveUpCount).toBe(1);
    const listCalls = calls.filter((c) => c.name === "gmail_outreach_list_candidates").length;
    expect(listCalls).toBeLessThanOrEqual(10);
  });

  it("a permanently-failing candidate at a larger batch size does not falsely report idle", async () => {
    const { deps } = fakeDeps({
      candidateThreadIds: ["thread-broken-1", "thread-broken-2"],
      commitResult: () => ({ result: "stale_source", current_evidence_digest: "c".repeat(64) }),
    });

    const result = await outreachInterpretMailboxUntilIdle(deps, {
      userId: "u1",
      mailAccountId: "a1",
      batchSize: 10,
    });

    expect(result.completed).toBe(false);
    expect(result.gaveUpCount).toBe(2);
  });

  it("all candidates succeeding reaches true idle with zero give-ups", async () => {
    const { deps } = fakeDeps({
      candidateThreadIds: ["thread-1", "thread-2", "thread-3"],
      commitResult: () => ({ result: "ok" }),
    });

    const result = await outreachInterpretMailboxUntilIdle(deps, {
      userId: "u1",
      mailAccountId: "a1",
      batchSize: 2,
    });

    expect(result.completed).toBe(true);
    expect(result.gaveUpCount).toBe(0);
    expect(result.interpreted).toBe(3);
  });

  it("requirePositiveInteger rejects 0, negative, NaN and fractional batch sizes", async () => {
    const { deps } = fakeDeps({ candidateThreadIds: [], commitResult: () => ({ result: "ok" }) });
    for (const bad of [0, -1, NaN, 1.5]) {
      await expect(
        outreachInterpretMailboxUntilIdle(deps, {
          userId: "u1",
          mailAccountId: "a1",
          batchSize: bad,
        }),
      ).rejects.toThrow(RangeError);
    }
    expect(() => requirePositiveInteger(0, "x")).toThrow(RangeError);
  });
});
