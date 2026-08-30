import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { GmailReadError } from "@/lib/gmail/import/errors";
import { buildSentWindowQuery } from "@/lib/gmail/import/read-adapter.server";
import { runImportUntilIdle } from "@/lib/gmail/import/worker.server";

import { createFakeGmailRead, messageWithAttachment, textMessage } from "./fake-gmail-read";
import {
  connectedMailbox,
  importDeps,
  rawMessages,
  rpc,
  runRow,
  setConnectionState,
  threadRows,
} from "./harness";
import type { RawMessage, RawThread } from "@/lib/gmail/import/sanitizer";

/**
 * B03 EXTERNAL AUDIT AMENDMENT #4 — the exact sent-root boundary.
 *
 * The provider query is a deliberate SUPERSET: Gmail searches at second
 * resolution and the run's window has milliseconds in it, so `after:` is nudged
 * back and `before:` rounded up. That is right, and it is why `messages.list`
 * can legitimately offer a thread whose only SENT message lies OUTSIDE the
 * window.
 *
 * Filtering individual messages to `[start, end)` did not make such a thread
 * safe: it dropped the out-of-window SENT and KEPT the in-window inbound reply,
 * so B03 imported somebody's incoming mail from a conversation that was never a
 * candidate under its own acquisition rule. Candidacy is now re-proved exactly,
 * by the database, from the rows it is about to commit.
 *
 * Every timestamp here is positioned against the DATABASE-OWNED `window_end_at`
 * in milliseconds, so the edges are exact rather than assumed.
 */

const TEST_DB = process.env.TEST_DATABASE_URL;
const d = describe.skipIf(!TEST_DB);

let client: Client;

beforeAll(async () => {
  if (!TEST_DB) return;
  client = new Client({ connectionString: TEST_DB });
  await client.connect();
});

afterAll(async () => {
  if (client) await client.end();
});

const DAY = 86_400_000;

async function startRun(label: string, startAt = new Date(Date.now() - 30 * DAY)) {
  const mailbox = await connectedMailbox(client, label);
  const started = await rpc(client).rpc("gmail_historical_import_start", {
    p_user_id: mailbox.userId,
    p_mail_account_id: mailbox.mailAccountId,
    p_window_start_at: startAt.toISOString(),
  });
  const runId = (started.data as { run_id: string }).run_id;
  const row = await runRow(client, runId);
  return {
    ...mailbox,
    runId,
    startMs: new Date(row.window_start_at).getTime(),
    endMs: new Date(row.window_end_at).getTime(),
  };
}

const labelled = (
  init: { id: string; threadId: string; internalDateMs: number },
  labelIds: string[],
): RawMessage => ({ ...textMessage(init), labelIds });

/** Run one thread to completion and report what the database holds. */
async function importThread(
  run: { userId: string; runId: string; mailAccountId: string },
  thread: RawThread,
) {
  const gmail = createFakeGmailRead({
    pages: [
      { candidates: [{ messageId: "provisional", threadId: thread.id! }], nextPageToken: null },
    ],
    threads: { [thread.id!]: thread },
  });
  const outcome = await runImportUntilIdle(
    { userId: run.userId, runId: run.runId, maxSteps: 10 },
    importDeps(client, { gmail }),
  );
  return {
    gmail,
    outcome,
    stored: await rawMessages(client, run.mailAccountId),
    threads: await threadRows(client, run.runId),
    row: await runRow(client, run.runId),
  };
}

// ===========================================================================
// A. EXACT CANDIDACY AT THE EDGES
// ===========================================================================

d("A. a thread is a candidate only with an exact-window SENT root", () => {
  it("A1. upper edge: SENT just outside, inbound just inside → nothing persisted", async () => {
    const run = await startRun("a4-a1-upper");
    const result = await importThread(run, {
      id: "t-upper",
      messages: [
        labelled({ id: "m-inbound", threadId: "t-upper", internalDateMs: run.endMs - 250 }, [
          "INBOX",
        ]),
        labelled({ id: "m-sent", threadId: "t-upper", internalDateMs: run.endMs + 150 }, ["SENT"]),
      ],
    });

    // The SENT at end+150ms is INSIDE the provider's rounded-up `before:`, which
    // is exactly why Gmail offered this thread — and why the local proof has to
    // exist.
    const before = Number(/before:(\d+)/.exec(buildSentWindowQuery(run.startMs, run.endMs))![1]);
    expect(Math.floor((run.endMs + 150) / 1000)).toBeLessThan(before);

    expect(result.stored).toHaveLength(0);
    expect(result.threads[0].status).toBe("filtered_out");
    expect(result.row.threads_filtered_out).toBe(1);
    expect(result.row.threads_completed).toBe(0);
    expect(result.row.messages_stored).toBe(0);
  });

  it("A2. lower edge: SENT just before the start → nothing persisted", async () => {
    const run = await startRun("a4-a2-lower");
    const result = await importThread(run, {
      id: "t-lower",
      messages: [
        labelled({ id: "m-sent", threadId: "t-lower", internalDateMs: run.startMs - 200 }, [
          "SENT",
        ]),
        labelled({ id: "m-inbound", threadId: "t-lower", internalDateMs: run.startMs + 400 }, [
          "INBOX",
        ]),
      ],
    });

    // `after:` is nudged a second earlier on purpose, so this thread is offered
    // at the lower edge for the same reason.
    const after = Number(/after:(\d+)/.exec(buildSentWindowQuery(run.startMs, run.endMs))![1]);
    expect(Math.floor((run.startMs - 200) / 1000)).toBeGreaterThanOrEqual(after);

    expect(result.stored).toHaveLength(0);
    expect(result.threads[0].status).toBe("filtered_out");
    expect(result.row.threads_filtered_out).toBe(1);
  });

  it("A3. a true candidate persists the whole in-window thread, replies included", async () => {
    const run = await startRun("a4-a3-valid");
    const result = await importThread(run, {
      id: "t-valid",
      messages: [
        labelled({ id: "m-sent", threadId: "t-valid", internalDateMs: run.endMs - 600 }, ["SENT"]),
        labelled({ id: "m-reply", threadId: "t-valid", internalDateMs: run.endMs - 400 }, [
          "INBOX",
        ]),
      ],
    });

    // Once the root is proved, the inbound reply is exactly what B03 is for: a
    // conversation with the replies removed cannot say whether a hotel answered.
    expect(result.stored.map((r) => r.provider_message_id).sort()).toEqual(["m-reply", "m-sent"]);
    expect(result.threads[0].status).toBe("complete");
    expect(result.row.threads_completed).toBe(1);
    expect(result.row.threads_filtered_out).toBe(0);
  });

  it("A4. one SENT outside and one SENT inside is a candidate", async () => {
    const run = await startRun("a4-a4-mixed");
    const result = await importThread(run, {
      id: "t-mixed",
      messages: [
        labelled({ id: "m-sent-out", threadId: "t-mixed", internalDateMs: run.endMs + 100 }, [
          "SENT",
        ]),
        labelled({ id: "m-sent-in", threadId: "t-mixed", internalDateMs: run.endMs - 300 }, [
          "SENT",
        ]),
      ],
    });

    expect(result.threads[0].status).toBe("complete");
    // The out-of-window SENT is still not stored: candidacy is a property of the
    // THREAD, the window is still a property of each MESSAGE.
    expect(result.stored.map((r) => r.provider_message_id)).toEqual(["m-sent-in"]);
  });

  it("A5. inbound inside, every SENT outside → zero messages", async () => {
    const run = await startRun("a4-a5-all-out");
    const result = await importThread(run, {
      id: "t-allout",
      messages: [
        labelled({ id: "m-sent-a", threadId: "t-allout", internalDateMs: run.startMs - 300 }, [
          "SENT",
        ]),
        labelled({ id: "m-sent-b", threadId: "t-allout", internalDateMs: run.endMs + 300 }, [
          "SENT",
        ]),
        labelled({ id: "m-in-a", threadId: "t-allout", internalDateMs: run.endMs - 5000 }, [
          "INBOX",
        ]),
        labelled({ id: "m-in-b", threadId: "t-allout", internalDateMs: run.endMs - 4000 }, [
          "INBOX",
        ]),
      ],
    });

    expect(result.stored).toHaveLength(0);
    expect(result.threads[0].status).toBe("filtered_out");
  });

  it("A6-A7. the interval is half-open: start qualifies, end does not", async () => {
    const atStart = await startRun("a4-a6-start");
    const startResult = await importThread(atStart, {
      id: "t-start",
      messages: [
        labelled({ id: "m-at-start", threadId: "t-start", internalDateMs: atStart.startMs }, [
          "SENT",
        ]),
      ],
    });
    expect(startResult.threads[0].status).toBe("complete");
    expect(startResult.stored.map((r) => r.provider_message_id)).toEqual(["m-at-start"]);

    const atEnd = await startRun("a4-a7-end");
    const endResult = await importThread(atEnd, {
      id: "t-end",
      messages: [
        labelled({ id: "m-at-end", threadId: "t-end", internalDateMs: atEnd.endMs }, ["SENT"]),
        labelled({ id: "m-in", threadId: "t-end", internalDateMs: atEnd.endMs - 100 }, ["INBOX"]),
      ],
    });
    // `[start, end)`, so two adjacent windows neither overlap nor leave a gap.
    expect(endResult.threads[0].status).toBe("filtered_out");
    expect(endResult.stored).toHaveLength(0);
  });

  it("A8. a DRAFT cannot be the root, even carrying SENT-shaped fixture data", async () => {
    const run = await startRun("a4-a8-draft");
    const result = await importThread(run, {
      id: "t-draft",
      messages: [
        // A draft with SENT alongside DRAFT: nothing about it is evidence that
        // anything was sent, and it is dropped before it can be a root.
        labelled({ id: "m-draft", threadId: "t-draft", internalDateMs: run.endMs - 500 }, [
          "DRAFT",
          "SENT",
        ]),
        labelled({ id: "m-inbound", threadId: "t-draft", internalDateMs: run.endMs - 400 }, [
          "INBOX",
        ]),
      ],
    });

    expect(result.stored).toHaveLength(0);
    expect(result.threads[0].status).toBe("filtered_out");
  });

  it("A9. an in-window SENT whose BODY was omitted still establishes the root", async () => {
    const run = await startRun("a4-a9-omitted");
    const attachmentOnly = messageWithAttachment({
      id: "m-sent-file",
      threadId: "t-omitted",
      internalDateMs: run.endMs - 700,
    });
    const result = await importThread(run, {
      id: "t-omitted",
      messages: [
        { ...attachmentOnly, labelIds: ["SENT"] },
        labelled({ id: "m-reply", threadId: "t-omitted", internalDateMs: run.endMs - 600 }, [
          "INBOX",
        ]),
      ],
    });

    // Identity, date and labels survive the sanitizer even when a body does not,
    // so a privacy omission never erases the evidence that the creator wrote.
    expect(result.threads[0].status).toBe("complete");
    expect(result.stored.map((r) => r.provider_message_id).sort()).toEqual([
      "m-reply",
      "m-sent-file",
    ]);
    expect(result.row.attachment_or_nontext_parts_omitted).toBeGreaterThan(0);
  });

  it("A10. the provider search is still OUTWARD — nothing was narrowed", async () => {
    const start = Date.parse("2026-08-01T00:00:00.400Z");
    const end = Date.parse("2026-08-29T20:00:00.750Z");
    const q = buildSentWindowQuery(start, end);
    expect(q).toBe(`after:${Math.floor(start / 1000) - 1} before:${Math.ceil(end / 1000)}`);
    expect(Number(/before:(\d+)/.exec(q)![1]) * 1000).toBeGreaterThan(end);
    expect(Number(/after:(\d+)/.exec(q)![1]) * 1000).toBeLessThan(start);
  });
});

// ===========================================================================
// B. THE DECISION IS ATOMIC, DERIVED, AND REPLAY-SAFE
// ===========================================================================

d("B. atomicity and replay", () => {
  async function primeFilteredThread(label: string) {
    const run = await startRun(label);
    const result = await importThread(run, {
      id: "t-filtered",
      messages: [
        labelled({ id: "m-inbound", threadId: "t-filtered", internalDateMs: run.endMs - 200 }, [
          "INBOX",
        ]),
        labelled({ id: "m-sent", threadId: "t-filtered", internalDateMs: run.endMs + 200 }, [
          "SENT",
        ]),
      ],
    });
    expect(result.threads[0].status).toBe("filtered_out");
    return run;
  }

  it("B1. committing the same filtered thread twice is replay-safe", async () => {
    const run = await primeFilteredThread("a4-b1-replay");
    const db = rpc(client);

    // Rewind the run and the work item so the same response can be re-committed.
    // A crash between the provider answer and the commit leaves exactly this
    // shape once the lease expires.
    await client.query(
      `update private.gmail_historical_import_threads
          set status = 'pending', completed_at = null where run_id = $1`,
      [run.runId],
    );
    await client.query(
      `update private.gmail_historical_import_runs
          set status = 'runnable', phase = 'fetching', completed_at = null,
              threads_filtered_out = 0
        where id = $1`,
      [run.runId],
    );
    const claimed = (
      await db.rpc("gmail_historical_import_claim_step", {
        p_user_id: run.userId,
        p_run_id: run.runId,
        p_lease_seconds: 300,
      })
    ).data as { lease_token: string; authorization_revision: number; provider_thread_id: string };

    const res = await db.rpc("gmail_historical_import_commit_thread", {
      p_user_id: run.userId,
      p_run_id: run.runId,
      p_lease_token: claimed.lease_token,
      p_expected_authorization_revision: claimed.authorization_revision,
      p_provider_thread_id: "t-filtered",
      p_messages: [],
      p_quota_units: 40,
      p_text_parts_omitted_external: 0,
      p_attachment_or_nontext_parts_omitted: 0,
    });
    expect((res.data as { result: string }).result).toBe("filtered_out");
    expect(await rawMessages(client, run.mailAccountId)).toHaveLength(0);

    // The decision released the lease, so a replay of the very same call is
    // refused before it can decide anything a second time.
    const again = await db.rpc("gmail_historical_import_commit_thread", {
      p_user_id: run.userId,
      p_run_id: run.runId,
      p_lease_token: claimed.lease_token,
      p_expected_authorization_revision: claimed.authorization_revision,
      p_provider_thread_id: "t-filtered",
      p_messages: [],
      p_quota_units: 40,
      p_text_parts_omitted_external: 0,
      p_attachment_or_nontext_parts_omitted: 0,
    });
    expect((again.data as { result: string }).result).toBe("stale_lease");

    // And a worker that DOES hold a fresh lease meets the terminal item as a
    // replay rather than deciding it again — the counter is not double-counted
    // and no content appears.
    await client.query(
      `update private.gmail_historical_import_runs
          set lease_token = $2, lease_expires_at = now() + interval '5 minutes',
              lease_step = 'fetch_thread', lease_thread_id = 't-filtered',
              lease_authorization_revision = $3
        where id = $1`,
      [run.runId, claimed.lease_token, claimed.authorization_revision],
    );
    const replay = await db.rpc("gmail_historical_import_commit_thread", {
      p_user_id: run.userId,
      p_run_id: run.runId,
      p_lease_token: claimed.lease_token,
      p_expected_authorization_revision: claimed.authorization_revision,
      p_provider_thread_id: "t-filtered",
      p_messages: [],
      p_quota_units: 40,
      p_text_parts_omitted_external: 0,
      p_attachment_or_nontext_parts_omitted: 0,
    });
    expect((replay.data as { result: string }).result).toBe("already_applied");
    expect(await rawMessages(client, run.mailAccountId)).toHaveLength(0);
    expect((await runRow(client, run.runId)).threads_filtered_out).toBe(1);
  });

  it("B2-B3. a stale lease or a stale revision cannot mark a thread filtered_out", async () => {
    const run = await startRun("a4-b2-stale");
    const db = rpc(client);
    const first = (
      await db.rpc("gmail_historical_import_claim_step", {
        p_user_id: run.userId,
        p_run_id: run.runId,
        p_lease_seconds: 300,
      })
    ).data as { lease_token: string; authorization_revision: number };
    await db.rpc("gmail_historical_import_commit_page", {
      p_user_id: run.userId,
      p_run_id: run.runId,
      p_lease_token: first.lease_token,
      p_expected_authorization_revision: first.authorization_revision,
      p_page_token_used: null,
      p_next_page_token: null,
      p_thread_ids: ["t-stale"],
      p_sent_messages_seen: 1,
      p_quota_units: 5,
    });
    const claimed = (
      await db.rpc("gmail_historical_import_claim_step", {
        p_user_id: run.userId,
        p_run_id: run.runId,
        p_lease_seconds: 300,
      })
    ).data as { lease_token: string; authorization_revision: number };

    const commit = (over: Record<string, unknown>) =>
      db.rpc("gmail_historical_import_commit_thread", {
        p_user_id: run.userId,
        p_run_id: run.runId,
        p_lease_token: claimed.lease_token,
        p_expected_authorization_revision: claimed.authorization_revision,
        p_provider_thread_id: "t-stale",
        p_messages: [],
        p_quota_units: 40,
        p_text_parts_omitted_external: 0,
        p_attachment_or_nontext_parts_omitted: 0,
        ...over,
      });

    expect(
      (
        (await commit({ p_lease_token: "00000000-0000-0000-0000-000000000000" })).data as {
          result: string;
        }
      ).result,
    ).toBe("stale_lease");
    expect(
      (
        (
          await commit({
            p_expected_authorization_revision: Number(claimed.authorization_revision) - 1,
          })
        ).data as { result: string }
      ).result,
    ).toBe("authorization_changed");

    // Neither attempt moved the work item. A refusal is a refusal, and
    // `filtered_out` must never be a way to make one look like a decision.
    expect((await threadRows(client, run.runId))[0].status).toBe("pending");
    expect((await runRow(client, run.runId)).threads_filtered_out).toBe(0);
  });

  it("B4. a Disconnect during threads.get is a refusal, never filtered_out", async () => {
    const run = await startRun("a4-b4-disconnect");
    const gmail = createFakeGmailRead({
      pages: [{ candidates: [{ messageId: "m1", threadId: "t-disc" }], nextPageToken: null }],
      threads: {
        "t-disc": {
          id: "t-disc",
          messages: [
            // No exact-window SENT — so if the lifecycle refusal were ever
            // reported as `filtered_out`, this is where it would hide.
            labelled({ id: "m-inbound", threadId: "t-disc", internalDateMs: run.endMs - 100 }, [
              "INBOX",
            ]),
          ],
        },
      },
      onGetThread: async () => {
        await setConnectionState(client, run.mailAccountId, "disconnected");
      },
    });

    await runImportUntilIdle(
      { userId: run.userId, runId: run.runId, maxSteps: 10 },
      importDeps(client, { gmail }),
    );

    const rows = await threadRows(client, run.runId);
    expect(rows[0].status).toBe("pending");
    expect((await runRow(client, run.runId)).status).toBe("cancelled_connection_stopped");
    expect((await runRow(client, run.runId)).threads_filtered_out).toBe(0);
  });

  it("B5-B6. a crash before commit replays; a crash after it creates no content", async () => {
    const run = await startRun("a4-b5-crash");
    const thread: RawThread = {
      id: "t-crash",
      messages: [
        labelled({ id: "m-inbound", threadId: "t-crash", internalDateMs: run.endMs - 100 }, [
          "INBOX",
        ]),
        labelled({ id: "m-sent", threadId: "t-crash", internalDateMs: run.endMs + 100 }, ["SENT"]),
      ],
    };

    // B5: the process dies after the provider answered and before the commit.
    // The lease expires and the item is claimable again — nothing was stored,
    // and nothing was decided.
    const crashing = createFakeGmailRead({
      pages: [{ candidates: [{ messageId: "m1", threadId: "t-crash" }], nextPageToken: null }],
      threads: { "t-crash": thread },
      onGetThread: async () => {
        throw new GmailReadError({
          operation: "threads_get",
          status: 503,
          reason: "service_unavailable",
          retryable: true,
        });
      },
    });
    await runImportUntilIdle(
      { userId: run.userId, runId: run.runId, maxSteps: 10 },
      importDeps(client, { gmail: crashing }),
    );
    expect((await threadRows(client, run.runId))[0].status).toBe("pending");
    expect(await rawMessages(client, run.mailAccountId)).toHaveLength(0);

    // B6: the replay reaches the commit, decides `filtered_out`, and a further
    // replay cannot turn that into content.
    await client.query(
      "update private.gmail_historical_import_threads set next_attempt_at = now() where run_id = $1",
      [run.runId],
    );
    const clean = createFakeGmailRead({
      pages: [{ candidates: [{ messageId: "m1", threadId: "t-crash" }], nextPageToken: null }],
      threads: { "t-crash": thread },
    });
    await runImportUntilIdle(
      { userId: run.userId, runId: run.runId, maxSteps: 10 },
      importDeps(client, { gmail: clean }),
    );
    expect((await threadRows(client, run.runId))[0].status).toBe("filtered_out");
    expect(await rawMessages(client, run.mailAccountId)).toHaveLength(0);

    await runImportUntilIdle(
      { userId: run.userId, runId: run.runId, maxSteps: 10 },
      importDeps(client, { gmail: clean }),
    );
    expect(await rawMessages(client, run.mailAccountId)).toHaveLength(0);
    expect((await runRow(client, run.runId)).threads_filtered_out).toBe(1);
  });
});

// ===========================================================================
// C. COMPLETION, FAILURE AND THE OTHER TERMINAL STATES
// ===========================================================================

d("C. filtered_out is terminal, and it is not an error", () => {
  async function runWithThreads(label: string, threads: Record<string, RawThread>) {
    const run = await startRun(label);
    const gmail = createFakeGmailRead({
      pages: [
        {
          candidates: Object.keys(threads).map((id) => ({ messageId: `p-${id}`, threadId: id })),
          nextPageToken: null,
        },
      ],
      threads,
    });
    const outcome = await runImportUntilIdle(
      { userId: run.userId, runId: run.runId, maxSteps: 30 },
      importDeps(client, { gmail }),
    );
    return { run, outcome, row: await runRow(client, run.runId) };
  }

  it("C1. one true candidate plus one filtered_out still completes", async () => {
    const run = await startRun("a4-c1-mixed");
    const gmail = createFakeGmailRead({
      pages: [
        {
          candidates: [
            { messageId: "p1", threadId: "t-good" },
            { messageId: "p2", threadId: "t-edge" },
          ],
          nextPageToken: null,
        },
      ],
      threads: {
        "t-good": {
          id: "t-good",
          messages: [
            labelled({ id: "m-good", threadId: "t-good", internalDateMs: run.endMs - 900 }, [
              "SENT",
            ]),
          ],
        },
        "t-edge": {
          id: "t-edge",
          messages: [
            labelled({ id: "m-edge-in", threadId: "t-edge", internalDateMs: run.endMs - 100 }, [
              "INBOX",
            ]),
            labelled({ id: "m-edge-sent", threadId: "t-edge", internalDateMs: run.endMs + 100 }, [
              "SENT",
            ]),
          ],
        },
      },
    });

    const outcome = await runImportUntilIdle(
      { userId: run.userId, runId: run.runId, maxSteps: 30 },
      importDeps(client, { gmail }),
    );
    expect(outcome).toEqual({ result: "finished", status: "completed" });

    const row = await runRow(client, run.runId);
    expect(row.status).toBe("completed");
    expect(row.threads_completed).toBe(1);
    expect(row.threads_filtered_out).toBe(1);
    expect(
      (await rawMessages(client, run.mailAccountId)).map((r) => r.provider_message_id),
    ).toEqual(["m-good"]);
  });

  it("C2. every provisional candidate filtered_out still COMPLETES, with zero messages", async () => {
    const run = await startRun("a4-c2-all-filtered");
    const gmail = createFakeGmailRead({
      pages: [
        {
          candidates: [
            { messageId: "p1", threadId: "t-e1" },
            { messageId: "p2", threadId: "t-e2" },
          ],
          nextPageToken: null,
        },
      ],
      threads: {
        "t-e1": {
          id: "t-e1",
          messages: [
            labelled({ id: "m1", threadId: "t-e1", internalDateMs: run.endMs + 100 }, ["SENT"]),
          ],
        },
        "t-e2": {
          id: "t-e2",
          messages: [
            labelled({ id: "m2", threadId: "t-e2", internalDateMs: run.startMs - 100 }, ["SENT"]),
          ],
        },
      },
    });

    const outcome = await runImportUntilIdle(
      { userId: run.userId, runId: run.runId, maxSteps: 30 },
      importDeps(client, { gmail }),
    );
    // "We completed the exact sent-rooted import and none of Google's
    // provisional edge candidates qualified" is a true and useful outcome. It is
    // not a failure, and it is not an empty mailbox either.
    expect(outcome).toEqual({ result: "finished", status: "completed" });
    const row = await runRow(client, run.runId);
    expect(row.status).toBe("completed");
    expect(row.threads_filtered_out).toBe(2);
    expect(row.threads_completed).toBe(0);
    expect(row.messages_stored).toBe(0);
    expect(await rawMessages(client, run.mailAccountId)).toHaveLength(0);
  });

  it("C3. filtered_out is NOT a failed thread", async () => {
    const { run } = await runWithThreads("a4-c3-not-failed", {
      "t-f": {
        id: "t-f",
        messages: [
          { id: "x", threadId: "t-f", labelIds: ["INBOX"], internalDate: "1", payload: {} },
        ],
      },
    });
    const status = await rpc(client).rpc("gmail_historical_import_status", {
      p_user_id: run.userId,
      p_run_id: run.runId,
    });
    expect(status.data).toMatchObject({
      status: "completed",
      threads_failed: 0,
      threads_filtered_out: 1,
      threads_completed: 0,
    });
  });

  it("C4. a real terminal thread failure still fails the run immediately", async () => {
    const run = await startRun("a4-c4-failure");
    const gmail = createFakeGmailRead({
      pages: [{ candidates: [{ messageId: "p", threadId: "t-fail" }], nextPageToken: null }],
      threads: {},
      threadErrors: [
        new GmailReadError({
          operation: "threads_get",
          status: 400,
          reason: "bad_request",
          retryable: false,
        }),
      ],
    });
    const outcome = await runImportUntilIdle(
      { userId: run.userId, runId: run.runId, maxSteps: 20 },
      importDeps(client, { gmail }),
    );
    expect(outcome).toEqual({ result: "failed", reason: "bad_request" });
    const row = await runRow(client, run.runId);
    expect(row.status).toBe("failed");
    expect(row.threads_filtered_out).toBe(0);
  });

  it("C5. `gone` stays semantically separate from `filtered_out`", async () => {
    const run = await startRun("a4-c5-gone");
    const gmail = createFakeGmailRead({
      pages: [{ candidates: [{ messageId: "p", threadId: "t-gone" }], nextPageToken: null }],
      missingThreads: ["t-gone"],
    });
    await runImportUntilIdle(
      { userId: run.userId, runId: run.runId, maxSteps: 20 },
      importDeps(client, { gmail }),
    );

    const rows = await threadRows(client, run.runId);
    // `gone`: Gmail no longer has the thread. `filtered_out`: Gmail has it and
    // it was never an exact candidate. Two different facts, two different words,
    // two different counters.
    expect(rows[0].status).toBe("gone");
    const row = await runRow(client, run.runId);
    expect(row.threads_gone).toBe(1);
    expect(row.threads_filtered_out).toBe(0);
    expect(row.status).toBe("completed");
  });

  it("C6. candidacy is judged against THAT run's window, not a previous one", async () => {
    const first = await startRun("a4-c6-window", new Date(Date.now() - 30 * DAY));
    const sentAt = first.endMs + 200; // outside run one
    const thread: RawThread = {
      id: "t-window",
      messages: [
        labelled({ id: "m-sent", threadId: "t-window", internalDateMs: sentAt }, ["SENT"]),
        labelled({ id: "m-reply", threadId: "t-window", internalDateMs: sentAt + 100 }, ["INBOX"]),
      ],
    };

    const one = await importThread(first, thread);
    expect(one.threads[0].status).toBe("filtered_out");
    expect(one.stored).toHaveLength(0);

    // Wait until "now" is past those timestamps, then start a NEW run whose
    // database-owned end is later. The same provider thread is re-evaluated
    // against the window it is being imported under.
    await new Promise((resolve) => setTimeout(resolve, 400));
    const second = await startRun("a4-c6-window-2", new Date(Date.now() - 30 * DAY));
    // Re-run on the same mailbox: a terminal run no longer holds the index.
    expect(second.endMs).toBeGreaterThan(sentAt + 100);

    const two = await importThread(
      { userId: second.userId, runId: second.runId, mailAccountId: second.mailAccountId },
      thread,
    );
    expect(two.threads[0].status).toBe("complete");
    expect(two.stored.map((r) => r.provider_message_id).sort()).toEqual(["m-reply", "m-sent"]);
  });
});
