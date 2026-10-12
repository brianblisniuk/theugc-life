import { interpretOneThread as interpretCommercialThread } from "@/lib/gmail/commercial/service";
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
  const deps = { db };
  await normalizeMailboxUntilIdle(deps, {
    userId: input.userId,
    mailAccountId: input.mailAccountId,
    batchSize: 25,
  });
  await outreachInterpretMailboxUntilIdle(deps, {
    userId: input.userId,
    mailAccountId: input.mailAccountId,
    batchSize: 25,
  });

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
  let commercialOpen = false;
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
      (thread) => thread.normalized_thread_id && !seen.has(thread.normalized_thread_id),
    );
    if (fresh.length === 0) {
      commercialOpen = false;
      break;
    }
    for (const thread of fresh) {
      const normalizedThreadId = thread.normalized_thread_id!;
      seen.add(normalizedThreadId);
      // One thread's failure must not stop the rest of this mailbox.
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
        continue;
      }
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
      }
    }
    commercialOpen = fresh.length >= 25;
  }

  return { completed: !repliesOpen && !commercialOpen };
}
