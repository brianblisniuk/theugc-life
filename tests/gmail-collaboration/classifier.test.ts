import { afterEach, describe, expect, it } from "vitest";

import { B02_REQUESTED_SCOPES, GMAIL_SEND_SCOPE } from "@/lib/gmail/contract";
import {
  assertCollaborationClassifier,
  collaborationClassifierName,
} from "@/lib/gmail/collaboration/classifier";
import { parseCollaborationSuggestions } from "@/lib/gmail/collaboration/contract";
import { collaborationWriteMessage } from "@/lib/gmail/collaboration/display";
import { refreshCollaborationByProviderThread } from "@/lib/gmail/collaboration/queries";
import { refreshGmailCollaborationSuggestions } from "@/lib/gmail/collaboration/service";
import { runStoredGmailPipeline } from "@/lib/gmail/sync/pipeline";

afterEach(() => {
  delete process.env.GMAIL_COLLAB_CLASSIFIER;
});

describe("F01 heuristic adapter", () => {
  it("treats an unset classifier as the heuristic and refuses any other name", () => {
    expect(collaborationClassifierName(undefined)).toBe("heuristic");
    expect(collaborationClassifierName("")).toBe("heuristic");
    expect(collaborationClassifierName(" heuristic ")).toBe("heuristic");
    expect(() => collaborationClassifierName("openai")).toThrow(/not approved/);
    expect(() => assertCollaborationClassifier("vendor")).toThrow(/not approved/);
  });

  it("does not ask Gmail for a send scope", () => {
    expect(B02_REQUESTED_SCOPES).not.toContain(GMAIL_SEND_SCOPE);
  });

  it("refuses a non-heuristic classifier before the database is called", async () => {
    process.env.GMAIL_COLLAB_CLASSIFIER = "openai";
    let calls = 0;
    const db = {
      rpc: async () => {
        calls += 1;
        return { data: { result: "ok" }, error: null };
      },
    };
    await expect(
      refreshGmailCollaborationSuggestions(db, {
        userId: "00000000-0000-4000-8000-000000000001",
        mailAccountId: "00000000-0000-4000-8000-000000000002",
        normalizedThreadId: "00000000-0000-4000-8000-000000000003",
      }),
    ).rejects.toThrow(/not approved/);
    await expect(
      runStoredGmailPipeline(db as never, {
        userId: "00000000-0000-4000-8000-000000000001",
        mailAccountId: "00000000-0000-4000-8000-000000000002",
      }),
    ).rejects.toThrow(/not approved/);
    await expect(
      refreshCollaborationByProviderThread(
        "00000000-0000-4000-8000-000000000001",
        "00000000-0000-4000-8000-000000000002",
        "thread-1",
      ),
    ).rejects.toThrow(/not approved/);
    expect(calls).toBe(0);
  });

  it("hides a foreign id and a paused plan, and keeps a collaboration confirmation off the ledger", () => {
    expect(parseCollaborationSuggestions({ result: "paused", suggestions: [] })).toEqual({
      status: "paused",
    });
    expect(parseCollaborationSuggestions({ result: "not_found" })).toEqual({ status: "hidden" });
    expect(
      parseCollaborationSuggestions({
        result: "ok",
        suggestions: [{ id: "s1", kind: "collaboration" }],
      }),
    ).toEqual({
      status: "ok",
      suggestions: [{ id: "s1", kind: "collaboration" }],
    });
    expect(collaborationWriteMessage("confirmed", "collaboration")).toMatch(
      /did not create a collaboration/,
    );
    expect(collaborationWriteMessage("manual_overrides", "pitch_sent")).toMatch(/existing record/);
    expect(collaborationWriteMessage("paused", null)).toMatch(/Free/);
  });
});
