import { describe, expect, it, vi } from "vitest";

import type { ImportDeps } from "@/lib/gmail/import/worker.server";
import { runStoredGmailPipeline } from "@/lib/gmail/sync/pipeline";

const THREAD_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const THREAD_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

describe("stored Gmail pipeline isolates one thread", () => {
  it("refreshes the next thread when one inbox refresh fails", async () => {
    const refreshed: string[] = [];
    const db = {
      rpc: vi.fn(async (name: string, args: Record<string, unknown>) => {
        if (name === "gmail_normalize_list_candidates") {
          return { data: { candidates: [] }, error: null };
        }
        if (name === "gmail_outreach_current_catalog_epoch") {
          return { data: 1, error: null };
        }
        if (name === "gmail_outreach_list_candidates" || name === "gmail_reply_list_candidates") {
          return { data: { result: "ok", candidates: [] }, error: null };
        }
        if (name === "gmail_incremental_sync_list_pipeline_threads") {
          return {
            data: {
              result: "ok",
              threads: [
                { normalized_thread_id: THREAD_A },
                { normalized_thread_id: THREAD_B },
              ],
            },
            error: null,
          };
        }
        if (
          name === "gmail_commercial_get_thread_evidence" ||
          name === "gmail_commercial_commit_interpretation"
        ) {
          return { data: { result: "not_eligible" }, error: null };
        }
        if (name === "refresh_pipeline_inbox_suggestions") {
          refreshed.push(String(args.p_normalized_thread_id));
          if (args.p_normalized_thread_id === THREAD_A) {
            return { data: null, error: { message: "decline suggestion cannot be superseded" } };
          }
          return { data: { result: "no_binding" }, error: null };
        }
        return { data: { result: "ok" }, error: null };
      }),
    };

    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const piped = await runStoredGmailPipeline(db as unknown as ImportDeps["db"], {
        userId: "11111111-1111-4111-8111-111111111111",
        mailAccountId: "22222222-2222-4222-8222-222222222222",
      });
      expect(piped.completed).toBe(true);
      expect(refreshed).toEqual([THREAD_A, THREAD_B]);
    } finally {
      error.mockRestore();
    }
  });

  it("returns incomplete when commercial interpretation throws", async () => {
    let commercialCalls = 0;
    const db = {
      rpc: vi.fn(async (name: string) => {
        if (name === "gmail_normalize_list_candidates") {
          return { data: { candidates: [] }, error: null };
        }
        if (name === "gmail_outreach_current_catalog_epoch") {
          return { data: 1, error: null };
        }
        if (name === "gmail_outreach_list_candidates" || name === "gmail_reply_list_candidates") {
          return { data: { result: "ok", candidates: [] }, error: null };
        }
        if (name === "gmail_incremental_sync_list_pipeline_threads") {
          return {
            data: { result: "ok", threads: [{ normalized_thread_id: THREAD_A }] },
            error: null,
          };
        }
        if (name === "gmail_commercial_get_thread_evidence") {
          commercialCalls += 1;
          throw new Error("commercial down");
        }
        return { data: { result: "ok" }, error: null };
      }),
    };
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const piped = await runStoredGmailPipeline(db as unknown as ImportDeps["db"], {
        userId: "11111111-1111-4111-8111-111111111111",
        mailAccountId: "22222222-2222-4222-8222-222222222222",
      });
      expect(piped.completed).toBe(false);
      expect(commercialCalls).toBe(1);
    } finally {
      error.mockRestore();
    }
  });
});
