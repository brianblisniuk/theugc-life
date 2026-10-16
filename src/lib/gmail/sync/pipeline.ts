import { interpretOneThread as interpretCommercialThread } from "@/lib/gmail/commercial/service";
import { assertCollaborationClassifier } from "@/lib/gmail/collaboration/classifier";
import { refreshGmailCollaborationSuggestions } from "@/lib/gmail/collaboration/service";
import { normalizeMailboxUntilIdle } from "@/lib/gmail/normalize/service";
import { outreachInterpretMailboxUntilIdle } from "@/lib/gmail/outreach/service";
import { interpretUntilIdle as interpretRepliesUntilIdle } from "@/lib/gmail/reply/service";
import type { ImportDeps } from "@/lib/gmail/import/worker.server";

/**
 * Hand already-stored messages to the existing local pipeline.
 * Order is the dependency order: B04, then B05 (B06's eligibility), then
 * B06, then B07. No Gmail call happens here.
 */
export async function runStoredGmailPipeline(
  db: ImportDeps["db"],
  input: { userId: string; mailAccountId: string },
): Promise<{ completed: boolean }> {
  // Refuse a non-heuristic classifier before any stored thread is interpreted.
  assertCollaborationClassifier();
  const deps = { db };
  const normalized = await normalizeMailboxUntilIdle(deps, {
    userId: input.userId,
    mailAccountId: input.mailAccountId,
    batchSize: 25,
  });
  if (!normalized.completed) return { completed: false };
  try {
    await db.rpc("gmail_send_bind_pending", {
      p_user_id: input.userId,
      p_mail_account_id: input.mailAccountId,
    });
  } catch {
    // A bind retry must not stop the rest of the stored pipeline.
    console.warn("[gmail] pending send bind skipped", {
      mail_account_id: input.mailAccountId,
    });
  }
  const outreach = await outreachInterpretMailboxUntilIdle(deps, {
    userId: input.userId,
    mailAccountId: input.mailAccountId,
    batchSize: 25,
  });
  if (!outreach.completed) return { completed: false };

  let repliesOpen = false;
  for (let pass = 0; pass < 20; pass += 1) {
    const batch = await interpretRepliesUntilIdle(deps, {
      userId: input.userId,
      mailAccountId: input.mailAccountId,
      maxThreads: 25,
    });
    if (batch.attempted === 0) {
      repliesOpen = false;
      break;
    }
    repliesOpen = batch.attempted >= 25;
  }

  const seen = new Set<string>();
  const blocked = new Set<string>();
  let commercialOpen = false;
  let failed = false;
  for (let pass = 0; pass < 20; pass += 1) {
    const { data, error } = await db.rpc("gmail_incremental_sync_list_pipeline_threads", {
      p_user_id: input.userId,
      p_mail_account_id: input.mailAccountId,
      p_limit: 25,
    });
    if (error) throw new Error(`list_pipeline_threads failed: ${error.message}`);
    const body = (data ?? {}) as {
      result?: string;
      threads?: { normalized_thread_id?: string }[];
    };
    if (body.result !== "ok") return { completed: false };
    const fresh = (body.threads ?? []).filter(
      (thread) =>
        thread.normalized_thread_id &&
        !seen.has(thread.normalized_thread_id) &&
        !blocked.has(thread.normalized_thread_id),
    );
    if (fresh.length === 0) {
      commercialOpen = false;
      break;
    }
    for (const thread of fresh) {
      const normalizedThreadId = thread.normalized_thread_id!;
      // One thread's failure must not stop the rest of this mailbox.
      // The id is remembered only after the commercial write succeeds, so a
      // throw is not treated as a finished thread.
      try {
        await interpretCommercialThread(deps, {
          userId: input.userId,
          mailAccountId: input.mailAccountId,
          normalizedThreadId,
        });
      } catch {
        console.error("[gmail] stored commercial interpretation failed for one thread", {
          mailAccountId: input.mailAccountId,
          normalizedThreadId,
        });
        blocked.add(normalizedThreadId);
        failed = true;
        continue;
      }
      seen.add(normalizedThreadId);
      try {
        const refreshed = await db.rpc("refresh_pipeline_inbox_suggestions", {
          p_user_id: input.userId,
          p_mail_account_id: input.mailAccountId,
          p_normalized_thread_id: normalizedThreadId,
        });
        if (refreshed.error) {
          console.error("[gmail] inbox suggestion refresh failed for one thread", {
            mailAccountId: input.mailAccountId,
            normalizedThreadId,
          });
        }
      } catch {
        console.error("[gmail] inbox suggestion refresh failed for one thread", {
          mailAccountId: input.mailAccountId,
          normalizedThreadId,
        });
        failed = true;
      }
      try {
        await refreshGmailCollaborationSuggestions(db, {
          userId: input.userId,
          mailAccountId: input.mailAccountId,
          normalizedThreadId,
        });
      } catch {
        console.error("[gmail] collaboration detection failed for one thread", {
          mailAccountId: input.mailAccountId,
          normalizedThreadId,
        });
        failed = true;
      }
    }
    commercialOpen = fresh.length >= 25;
  }

  return { completed: !repliesOpen && !commercialOpen && !failed };
}
