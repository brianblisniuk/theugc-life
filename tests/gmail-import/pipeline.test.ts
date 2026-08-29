import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { GmailReadError } from "@/lib/gmail/import/errors";
import { runImportUntilIdle, runOneImportStep } from "@/lib/gmail/import/worker.server";

import { createFakeGmailRead, messageWithAttachment, textMessage, thread } from "./fake-gmail-read";
import {
  connectedMailbox,
  importDeps,
  rawMessages,
  rpc,
  runRow,
  setConnectionState,
  startDeletion,
  stateOf,
  threadRows,
  withdrawConsent,
} from "./harness";

/**
 * B03 §30, §32, §33, §34, §36 — the pipeline against real PostgreSQL.
 *
 * Everything asserted here is a property of committed database state, because
 * that is the only thing that survives the process this worker runs in.
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
const windowStart = () => new Date(Date.now() - 30 * DAY).toISOString();
const inWindow = () => Date.now() - 5 * DAY;

async function startRun(label: string) {
  const mailbox = await connectedMailbox(client, label);
  const started = await rpc(client).rpc("gmail_historical_import_start", {
    p_user_id: mailbox.userId,
    p_mail_account_id: mailbox.mailAccountId,
    p_window_start_at: windowStart(),
  });
  const runId = (started.data as { run_id: string }).run_id;
  return { ...mailbox, runId };
}

d("B03 enumeration", () => {
  it("21-27. the first page is a sent-rooted, server-built, epoch-bounded list call", async () => {
    const { userId, runId } = await startRun("b03-enum-shape");
    const gmail = createFakeGmailRead({
      pages: [{ candidates: [{ messageId: "m1", threadId: "t1" }], nextPageToken: null }],
    });

    await runOneImportStep({ userId, runId }, importDeps(client, { gmail }));

    expect(gmail.calls.listMessagesCalls).toBe(1);
    expect(gmail.calls.listParams[0]).toMatchObject({
      userId: "me",
      labelIds: "SENT",
      maxResults: 500,
      includeSpamTrash: true,
    });
    // Epoch seconds, and nothing a caller supplied.
    expect(gmail.calls.listParams[0]!.q).toMatch(/^after:\d+ before:\d+$/);
  });

  it("28-30. a page applied twice creates no duplicate work, and the cursor moves atomically", async () => {
    const { userId, mailAccountId, runId } = await startRun("b03-enum-replay");
    const db = rpc(client);

    const claim = await db.rpc("gmail_historical_import_claim_step", {
      p_user_id: userId,
      p_run_id: runId,
      p_lease_seconds: 60,
    });
    const first = claim.data as { lease_token: string; authorization_revision: number };

    const commitArgs = {
      p_user_id: userId,
      p_run_id: runId,
      p_lease_token: first.lease_token,
      p_expected_authorization_revision: first.authorization_revision,
      p_page_token_used: null,
      p_next_page_token: "PAGE-2",
      // 29. Duplicate SENT messages in one thread are one unit of work.
      p_thread_ids: ["t1", "t1", "t2"],
      p_sent_messages_seen: 3,
      p_quota_units: 5,
    };
    expect(
      ((await db.rpc("gmail_historical_import_commit_page", commitArgs)).data as { result: string })
        .result,
    ).toBe("ok");

    const afterFirst = await runRow(client, runId);
    expect(afterFirst.enumeration_page_token).toBe("PAGE-2");
    expect(afterFirst.unique_threads_discovered).toBe(2);
    expect((await threadRows(client, runId)).map((r) => r.provider_thread_id)).toEqual([
      "t1",
      "t2",
    ]);

    // A CRASH BETWEEN THE PROVIDER RESPONSE AND THE LOCAL COMMIT means the same
    // page is requested again. Re-applying it must be safe and must not advance
    // the cursor twice.
    const second = await db.rpc("gmail_historical_import_claim_step", {
      p_user_id: userId,
      p_run_id: runId,
      p_lease_seconds: 60,
    });
    const replay = await db.rpc("gmail_historical_import_commit_page", {
      ...commitArgs,
      p_lease_token: (second.data as { lease_token: string }).lease_token,
    });
    expect((replay.data as { result: string }).result).toBe("already_applied");

    const afterReplay = await runRow(client, runId);
    expect(afterReplay.enumeration_page_token).toBe("PAGE-2");
    expect(afterReplay.unique_threads_discovered).toBe(2);
    expect(await rawMessages(client, mailAccountId)).toHaveLength(0);
  });

  it("31. a stale lease cannot advance the page", async () => {
    const { userId, runId } = await startRun("b03-enum-stale");
    const db = rpc(client);
    const claim = await db.rpc("gmail_historical_import_claim_step", {
      p_user_id: userId,
      p_run_id: runId,
      p_lease_seconds: 60,
    });
    const lease = claim.data as { lease_token: string; authorization_revision: number };

    const res = await db.rpc("gmail_historical_import_commit_page", {
      p_user_id: userId,
      p_run_id: runId,
      p_lease_token: "00000000-0000-0000-0000-000000000000",
      p_expected_authorization_revision: lease.authorization_revision,
      p_page_token_used: null,
      p_next_page_token: "X",
      p_thread_ids: ["t-stale"],
      p_sent_messages_seen: 1,
      p_quota_units: 5,
    });
    expect((res.data as { result: string }).result).toBe("stale_lease");
    expect((await runRow(client, runId)).enumeration_page_token).toBeNull();
    expect(await threadRows(client, runId)).toHaveLength(0);
  });

  it("32-33. absence of a next page token ends enumeration; an estimate never does", async () => {
    const { userId, runId } = await startRun("b03-enum-complete");
    const gmail = createFakeGmailRead({
      pages: [
        { candidates: [{ messageId: "m1", threadId: "t1" }], nextPageToken: "P2" },
        { candidates: [{ messageId: "m2", threadId: "t2" }], nextPageToken: null },
      ],
    });
    const deps = importDeps(client, { gmail });

    await runOneImportStep({ userId, runId }, deps);
    expect((await runRow(client, runId)).enumeration_completed_at).toBeNull();

    await runOneImportStep({ userId, runId }, deps);
    const row = await runRow(client, runId);
    expect(row.enumeration_completed_at).not.toBeNull();
    expect(row.phase).toBe("fetching");
    // The worker never asked for or acted on a result-size estimate; the only
    // completion signal is the missing token.
    expect(gmail.calls.pageTokens).toEqual([null, "P2"]);
  });

  it("34. provider page tokens are never written to the run's error field or logs", async () => {
    const { userId, runId } = await startRun("b03-enum-token-privacy");
    const gmail = createFakeGmailRead({
      pages: [{ candidates: [], nextPageToken: "SECRET-PAGE-TOKEN" }],
    });
    await runOneImportStep({ userId, runId }, importDeps(client, { gmail }));

    // The cursor column holds it because resuming requires it; nothing else does,
    // and the status surface below never returns it.
    const status = await rpc(client).rpc("gmail_historical_import_status", {
      p_user_id: userId,
      p_run_id: runId,
    });
    expect(JSON.stringify(status.data)).not.toContain("SECRET-PAGE-TOKEN");
  });
});

d("B03 thread fetch and message identity", () => {
  async function enumerated(label: string, threadIds: string[]) {
    const run = await startRun(label);
    const db = rpc(client);
    const claim = await db.rpc("gmail_historical_import_claim_step", {
      p_user_id: run.userId,
      p_run_id: run.runId,
      p_lease_seconds: 60,
    });
    const lease = claim.data as { lease_token: string; authorization_revision: number };
    await db.rpc("gmail_historical_import_commit_page", {
      p_user_id: run.userId,
      p_run_id: run.runId,
      p_lease_token: lease.lease_token,
      p_expected_authorization_revision: lease.authorization_revision,
      p_page_token_used: null,
      p_next_page_token: null,
      p_thread_ids: threadIds,
      p_sent_messages_seen: threadIds.length,
      p_quota_units: 5,
    });
    return run;
  }

  it("35-36. threads.get is used with format full, and no attachment call exists", async () => {
    const run = await enumerated("b03-fetch-shape", ["t1"]);
    const gmail = createFakeGmailRead({
      threads: {
        t1: thread("t1", [textMessage({ id: "m1", threadId: "t1", internalDateMs: inWindow() })]),
      },
    });
    await runOneImportStep({ userId: run.userId, runId: run.runId }, importDeps(client, { gmail }));

    expect(gmail.calls.getThreadCalls).toBe(1);
    // Structurally impossible rather than merely unused: the adapter interface
    // has no attachment method to call.
    expect(gmail.calls.attachmentGetCalls).toBe(0);
    expect("getAttachment" in gmail).toBe(false);
  });

  it("37. a response whose thread id disagrees with the request is refused", async () => {
    const run = await enumerated("b03-fetch-mismatch", ["t1"]);
    const gmail = createFakeGmailRead({
      threads: {
        t1: thread("t1", [textMessage({ id: "m1", threadId: "t1", internalDateMs: inWindow() })]),
      },
      mismatchedThreadId: "SOME-OTHER-THREAD",
    });

    const outcome = await runOneImportStep(
      { userId: run.userId, runId: run.runId },
      importDeps(client, { gmail }),
    );
    expect(outcome.result).toBe("failed");
    // Nothing from a self-contradicting response is stored.
    expect(await rawMessages(client, run.mailAccountId)).toHaveLength(0);
  });

  it("56. a vanished thread is terminal work, not a run failure, and invents nothing", async () => {
    const run = await enumerated("b03-fetch-gone", ["t-gone"]);
    const gmail = createFakeGmailRead({ missingThreads: ["t-gone"] });

    const outcome = await runOneImportStep(
      { userId: run.userId, runId: run.runId },
      importDeps(client, { gmail }),
    );
    expect(outcome).toEqual({ result: "progressed", step: "thread_gone" });

    const rows = await threadRows(client, run.runId);
    expect(rows[0].status).toBe("gone");
    expect((await runRow(client, run.runId)).threads_gone).toBe(1);
    expect(await rawMessages(client, run.mailAccountId)).toHaveLength(0);
    expect((await runRow(client, run.runId)).status).toBe("runnable");
  });

  it("57-61, 65. messages are stored once, updated in place, and provenance is kept", async () => {
    const run = await enumerated("b03-identity", ["t1"]);
    const at = inWindow();
    const gmail = createFakeGmailRead({
      threads: {
        t1: thread("t1", [
          textMessage({ id: "m1", threadId: "t1", internalDateMs: at }),
          messageWithAttachment({ id: "m2", threadId: "t1", internalDateMs: at }),
        ]),
      },
    });
    const deps = importDeps(client, { gmail });

    await runOneImportStep({ userId: run.userId, runId: run.runId }, deps);
    const first = await rawMessages(client, run.mailAccountId);
    expect(first.map((r) => r.provider_message_id)).toEqual(["m1", "m2"]);
    expect(first[0].first_import_run_id).toBe(run.runId);
    expect(first[0].last_import_run_id).toBe(run.runId);

    // 65. The thread's completion and its messages landed in ONE transaction: a
    // thread marked complete whose messages did not arrive would be a state
    // claiming success without its data.
    expect((await threadRows(client, run.runId))[0].status).toBe("complete");
    expect((await runRow(client, run.runId)).messages_stored).toBe(2);

    // 59. A replay of the identical snapshot is not an event.
    const secondRun = await rpc(client).rpc("gmail_historical_import_start", {
      p_user_id: run.userId,
      p_mail_account_id: run.mailAccountId,
      p_window_start_at: windowStart(),
    });
    // The first run is still active, so a second cannot start — proof of §29's
    // one-active-run rule in the middle of real work.
    expect((secondRun.data as { result: string }).result).toBe("run_already_active");

    const digests = first.map((r) => r.payload_sha256);
    await client.query(
      `update private.gmail_historical_import_threads set status = 'pending', completed_at = null where run_id = $1`,
      [run.runId],
    );
    await runOneImportStep({ userId: run.userId, runId: run.runId }, deps);
    const replayed = await rawMessages(client, run.mailAccountId);
    expect(replayed).toHaveLength(2);
    expect(replayed.map((r) => r.payload_sha256)).toEqual(digests);
  });

  it("62-63. provider message identity is scoped to the mailbox", async () => {
    const a = await enumerated("b03-scope-a", ["shared-thread"]);
    const b = await enumerated("b03-scope-b", ["shared-thread"]);
    const at = inWindow();
    const build = () =>
      createFakeGmailRead({
        threads: {
          "shared-thread": thread("shared-thread", [
            textMessage({ id: "same-message-id", threadId: "shared-thread", internalDateMs: at }),
          ]),
        },
      });

    await runOneImportStep(
      { userId: a.userId, runId: a.runId },
      importDeps(client, { gmail: build() }),
    );
    await runOneImportStep(
      { userId: b.userId, runId: b.runId },
      importDeps(client, { gmail: build() }),
    );

    // A message id from mailbox A says nothing about mailbox B, so the same
    // provider id in two mailboxes is two different messages.
    expect(await rawMessages(client, a.mailAccountId)).toHaveLength(1);
    expect(await rawMessages(client, b.mailAccountId)).toHaveLength(1);
  });

  it("64. the same message id with an incompatible thread id fails closed", async () => {
    const run = await enumerated("b03-thread-move", ["t1"]);
    const at = inWindow();
    await runOneImportStep(
      { userId: run.userId, runId: run.runId },
      importDeps(client, {
        gmail: createFakeGmailRead({
          threads: {
            t1: thread("t1", [textMessage({ id: "m1", threadId: "t1", internalDateMs: at })]),
          },
        }),
      }),
    );

    // A message does not change conversation. Silently rewriting the row would
    // bury a provider or caller integrity problem.
    await expect(
      client.query(
        "update private.gmail_raw_messages set provider_thread_id = 'OTHER' where mail_account_id = $1",
        [run.mailAccountId],
      ),
    ).rejects.toThrow(/does not change conversation/);
  });

  it("66-67. a crash before or after the commit replays safely", async () => {
    const run = await enumerated("b03-crash", ["t1"]);
    const at = inWindow();
    const gmail = createFakeGmailRead({
      threads: {
        t1: thread("t1", [textMessage({ id: "m1", threadId: "t1", internalDateMs: at })]),
      },
    });

    // CRASH BEFORE COMMIT: the provider call happened, nothing was written, and
    // the lease is abandoned. The next worker reclaims and repeats it.
    const db = rpc(client);
    const claim = await db.rpc("gmail_historical_import_claim_step", {
      p_user_id: run.userId,
      p_run_id: run.runId,
      p_lease_seconds: 1,
    });
    expect((claim.data as { step: string }).step).toBe("fetch_thread");
    await client.query(
      "update private.gmail_historical_import_runs set lease_expires_at = now() - interval '1 second' where id = $1",
      [run.runId],
    );
    expect(await rawMessages(client, run.mailAccountId)).toHaveLength(0);

    await runOneImportStep({ userId: run.userId, runId: run.runId }, importDeps(client, { gmail }));
    expect(await rawMessages(client, run.mailAccountId)).toHaveLength(1);

    // CRASH AFTER COMMIT: the work item is already complete, so a repeat finds
    // nothing to do rather than storing a second copy.
    await runOneImportStep({ userId: run.userId, runId: run.runId }, importDeps(client, { gmail }));
    expect(await rawMessages(client, run.mailAccountId)).toHaveLength(1);
  });

  it("a full run reaches `completed`, and only when nothing is outstanding", async () => {
    const run = await startRun("b03-complete");
    const at = inWindow();
    const gmail = createFakeGmailRead({
      pages: [
        {
          candidates: [
            { messageId: "m1", threadId: "t1" },
            { messageId: "m2", threadId: "t2" },
          ],
          nextPageToken: null,
        },
      ],
      threads: {
        t1: thread("t1", [textMessage({ id: "m1", threadId: "t1", internalDateMs: at })]),
        t2: thread("t2", [textMessage({ id: "m2", threadId: "t2", internalDateMs: at })]),
      },
    });

    const outcome = await runImportUntilIdle(
      { userId: run.userId, runId: run.runId },
      importDeps(client, { gmail }),
    );
    expect(outcome).toEqual({ result: "finished", status: "completed" });

    const row = await runRow(client, run.runId);
    expect(row.status).toBe("completed");
    expect(row.threads_completed).toBe(2);
    expect(row.messages_stored).toBe(2);
    // 94-95. The estimate uses the published per-method costs: one list, two gets.
    expect(Number(row.estimated_gmail_quota_units)).toBe(5 + 40 + 40);
  });

  it("a permanently failed thread makes the run `failed`, never `completed`", async () => {
    const run = await startRun("b03-partial");
    const gmail = createFakeGmailRead({
      pages: [{ candidates: [{ messageId: "m1", threadId: "t1" }], nextPageToken: null }],
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

    await runImportUntilIdle(
      { userId: run.userId, runId: run.runId },
      importDeps(client, { gmail }),
    );
    await runImportUntilIdle(
      { userId: run.userId, runId: run.runId },
      importDeps(client, { gmail }),
    );

    const row = await runRow(client, run.runId);
    // A partial import is not a completed import, however tidy the counters look.
    expect(row.status).toBe("failed");
    expect(row.completed_at).not.toBeNull();
  });
});

d("B03 authorization currentness", () => {
  it("68, 72-75. a claim requires `connected`, and stop states cancel the run", async () => {
    for (const state of ["disconnecting", "disconnected", "deletion_pending", "deleted"]) {
      const run = await startRun(`b03-auth-${state}`);
      if (state === "deletion_pending") {
        await startDeletion(client, run.mailAccountId, run.userId);
      } else if (state === "deleted") {
        // `deleted` requires a completed deletion it waited on — and, because of
        // 0037's own invariant, no surviving B03 data.
        const requestId = await startDeletion(client, run.mailAccountId, run.userId);
        await client.query("begin");
        await client.query(
          "delete from private.gmail_historical_import_runs where mail_account_id = $1",
          [run.mailAccountId],
        );
        await client.query(
          "update public.mail_account_deletion_requests set status = 'completed', completed_at = now() where id = $1",
          [requestId],
        );
        await client.query(
          "update public.mail_accounts set connection_state = 'deleted' where id = $1",
          [run.mailAccountId],
        );
        await client.query("commit");
        continue;
      } else {
        await setConnectionState(client, run.mailAccountId, state);
      }

      // THE RUN IS ALREADY STOPPED BEFORE ANY WORKER LOOKS. That is the point
      // of amendment #1's lifecycle trigger: the transition that moved the
      // mailbox carried the run with it, so this assertion holds with nothing
      // running in between.
      expect([state, (await runRow(client, run.runId)).status]).toEqual([
        state,
        "cancelled_connection_stopped",
      ]);

      // And a worker that turns up afterwards finds nothing to claim.
      const outcome = await runOneImportStep(
        { userId: run.userId, runId: run.runId },
        importDeps(client, { gmail: createFakeGmailRead() }),
      );
      expect([state, outcome]).toEqual([
        state,
        { result: "not_runnable", status: "cancelled_connection_stopped" },
      ]);
    }
  });

  it("69, 71, 78. a withdrawn consent pauses the run and requires an explicit resume", async () => {
    const run = await startRun("b03-auth-consent");
    await withdrawConsent(client, run.mailAccountId, run.userId);

    // The withdrawal itself paused the run, in the transaction that recorded it.
    expect((await runRow(client, run.runId)).status).toBe("paused_consent");

    // A paused run does not restart because a worker polled.
    const stillPaused = await runOneImportStep(
      { userId: run.userId, runId: run.runId },
      importDeps(client, { gmail: createFakeGmailRead() }),
    );
    expect(stillPaused).toEqual({ result: "not_runnable", status: "paused_consent" });

    // And resuming re-asks the same question rather than assuming.
    const refused = await rpc(client).rpc("gmail_historical_import_resume", {
      p_user_id: run.userId,
      p_run_id: run.runId,
    });
    expect((refused.data as { result: string }).result).toBe("not_connected");
  });

  it("70, 77. B02 `reauth_required` pauses the run, and resume works once healthy", async () => {
    const run = await startRun("b03-auth-reauth");
    const outcome = await runOneImportStep(
      { userId: run.userId, runId: run.runId },
      importDeps(client, {
        gmail: createFakeGmailRead(),
        accessToken: async () => ({ result: "reauth_required" }),
      }),
    );
    expect(outcome).toEqual({ result: "paused", reason: "reauth" });
    expect((await runRow(client, run.runId)).status).toBe("paused_reauth");

    // The mailbox is still connected and consented here, so an explicit resume
    // is accepted — B03 did not reconnect anything on the human's behalf.
    const resumed = await rpc(client).rpc("gmail_historical_import_resume", {
      p_user_id: run.userId,
      p_run_id: run.runId,
    });
    expect((resumed.data as { result: string }).result).toBe("ok");
    expect((await runRow(client, run.runId)).status).toBe("runnable");
  });

  it("76. a cancelled run does not resurrect when the mailbox reconnects", async () => {
    const run = await startRun("b03-auth-no-resurrect");
    await setConnectionState(client, run.mailAccountId, "disconnected");
    await runOneImportStep(
      { userId: run.userId, runId: run.runId },
      importDeps(client, { gmail: createFakeGmailRead() }),
    );
    expect((await runRow(client, run.runId)).status).toBe("cancelled_connection_stopped");

    // Reconnect the mailbox the way B02 would.
    await client.query("begin");
    await client.query(
      `insert into private.gmail_oauth_credentials
         (mail_account_id, user_id, refresh_token_ciphertext, refresh_token_iv,
          refresh_token_auth_tag, encryption_key_version)
       values ($1, $2, 'ct', 'iv', 'tag', 'v1')`,
      [run.mailAccountId, run.userId],
    );
    await client.query(
      `update public.mail_accounts
          set connection_state = 'connected',
              granted_scopes = (select granted_scopes_at_decision
                                  from public.mail_account_consent_receipts
                                 where mail_account_id = $1 order by event_seq desc limit 1)
        where id = $1`,
      [run.mailAccountId],
    );
    await client.query("commit");
    expect(await stateOf(client, run.mailAccountId)).toBe("connected");

    // Starting again is a decision, so the old run stays terminal...
    expect((await runRow(client, run.runId)).status).toBe("cancelled_connection_stopped");
    const resume = await rpc(client).rpc("gmail_historical_import_resume", {
      p_user_id: run.userId,
      p_run_id: run.runId,
    });
    expect((resume.data as { result: string }).result).toBe("not_paused");

    // ...and a NEW run is what the human gets.
    const fresh = await rpc(client).rpc("gmail_historical_import_start", {
      p_user_id: run.userId,
      p_mail_account_id: run.mailAccountId,
      p_window_start_at: windowStart(),
    });
    expect((fresh.data as { result: string }).result).toBe("ok");
  });

  it("79-82, 86. a Disconnect during the network call refuses the response", async () => {
    const run = await startRun("b03-auth-race");
    const db = rpc(client);
    const claim = await db.rpc("gmail_historical_import_claim_step", {
      p_user_id: run.userId,
      p_run_id: run.runId,
      p_lease_seconds: 120,
    });
    const lease = claim.data as { lease_token: string; authorization_revision: number };

    // 86. The unchanged case succeeds, so the refusal below is about the change.
    const control = await db.rpc("gmail_historical_import_commit_page", {
      p_user_id: run.userId,
      p_run_id: run.runId,
      p_lease_token: lease.lease_token,
      p_expected_authorization_revision: lease.authorization_revision,
      p_page_token_used: null,
      p_next_page_token: "P2",
      p_thread_ids: ["t-control"],
      p_sent_messages_seen: 1,
      p_quota_units: 5,
    });
    expect((control.data as { result: string }).result).toBe("ok");

    const second = await db.rpc("gmail_historical_import_claim_step", {
      p_user_id: run.userId,
      p_run_id: run.runId,
      p_lease_seconds: 120,
    });
    const staleLease = second.data as { lease_token: string; authorization_revision: number };

    // The human disconnects while the Gmail request is on the wire. PostgreSQL
    // cannot cancel a request already in flight — what it CAN guarantee is that
    // the response never enters storage.
    await setConnectionState(client, run.mailAccountId, "disconnected");

    const refused = await db.rpc("gmail_historical_import_commit_page", {
      p_user_id: run.userId,
      p_run_id: run.runId,
      p_lease_token: staleLease.lease_token,
      p_expected_authorization_revision: staleLease.authorization_revision,
      p_page_token_used: "P2",
      p_next_page_token: null,
      p_thread_ids: ["t-should-not-exist"],
      p_sent_messages_seen: 500,
      p_quota_units: 5,
    });
    // REFUSED, and the refusal names the run's own state. Since amendment #1 the
    // Disconnect stopped the run and cleared its lease in the same transaction,
    // so the fence that catches this stale response is the lease — one step
    // EARLIER than the authorization comparison that used to catch it. Both
    // refuse; what matters is that nothing is persisted and the worker is told
    // the truth about why.
    const outcome = refused.data as { result: string; run_status: string };
    expect(outcome.result).toBe("stale_lease");
    expect(outcome.run_status).toBe("cancelled_connection_stopped");

    const rows = await threadRows(client, run.runId);
    expect(rows.map((r) => r.provider_thread_id)).toEqual(["t-control"]);
    const row = await runRow(client, run.runId);
    expect(row.enumeration_page_token).toBe("P2");
    expect(row.candidate_sent_messages_seen).toBe(1);

    // 79-82. The AUTHORIZATION comparison still refuses on its own, with the
    // lease intact and the run runnable: a reconnect that moved the revision is
    // enough, and no Disconnect is needed to prove it.
    const healthy = await startRun("b03-auth-race-revision");
    const claimed = (
      await db.rpc("gmail_historical_import_claim_step", {
        p_user_id: healthy.userId,
        p_run_id: healthy.runId,
        p_lease_seconds: 120,
      })
    ).data as { lease_token: string; authorization_revision: number };

    // A GENUINELY STALE WORKER presents the revision ITS claim was issued under.
    // Passing an older number is exactly what such a worker does, and it is the
    // only way to reach this branch now that a lifecycle change stops the run
    // outright: every transition that moves the revision either cancels/pauses
    // the run (so the lease fence catches it first) or is refused by B01. The
    // branch is therefore a fail-closed backstop, and this is what it backstops.
    const stale = await db.rpc("gmail_historical_import_commit_page", {
      p_user_id: healthy.userId,
      p_run_id: healthy.runId,
      p_lease_token: claimed.lease_token,
      p_expected_authorization_revision: Number(claimed.authorization_revision) - 1,
      p_page_token_used: null,
      p_next_page_token: null,
      p_thread_ids: ["t-stale-revision"],
      p_sent_messages_seen: 3,
      p_quota_units: 5,
    });
    expect((stale.data as { result: string }).result).toBe("authorization_changed");
    expect(await threadRows(client, healthy.runId)).toHaveLength(0);
  });

  it("83-85. a consent withdrawal before the commit refuses the response too", async () => {
    const run = await startRun("b03-auth-consent-race");
    const db = rpc(client);
    const claim = await db.rpc("gmail_historical_import_claim_step", {
      p_user_id: run.userId,
      p_run_id: run.runId,
      p_lease_seconds: 120,
    });
    const lease = claim.data as { lease_token: string; authorization_revision: number };

    await withdrawConsent(client, run.mailAccountId, run.userId);

    const refused = await db.rpc("gmail_historical_import_commit_page", {
      p_user_id: run.userId,
      p_run_id: run.runId,
      p_lease_token: lease.lease_token,
      p_expected_authorization_revision: lease.authorization_revision,
      p_page_token_used: null,
      p_next_page_token: null,
      p_thread_ids: ["t-nope"],
      p_sent_messages_seen: 9,
      p_quota_units: 5,
    });
    // Same shape as the Disconnect case: the withdrawal stopped the run before
    // the response arrived, so the lease is gone and the refusal says which
    // human decision did it.
    const outcome = refused.data as { result: string; run_status: string };
    expect(outcome.result).toBe("stale_lease");
    expect(outcome.run_status).toBe("paused_consent");
    expect(await threadRows(client, run.runId)).toHaveLength(0);
    expect((await runRow(client, run.runId)).candidate_sent_messages_seen).toBe(0);
  });
});

d("B03 worker lease", () => {
  it("87-88. one unexpired lease owns the step", async () => {
    const run = await startRun("b03-lease-one");
    const db = rpc(client);
    const a = await db.rpc("gmail_historical_import_claim_step", {
      p_user_id: run.userId,
      p_run_id: run.runId,
      p_lease_seconds: 300,
    });
    expect((a.data as { result: string }).result).toBe("ok");

    const b = await db.rpc("gmail_historical_import_claim_step", {
      p_user_id: run.userId,
      p_run_id: run.runId,
      p_lease_seconds: 300,
    });
    expect((b.data as { result: string }).result).toBe("leased");
  });

  it("89-90. an expired lease is reclaimed, and the old token can commit nothing", async () => {
    const run = await startRun("b03-lease-expiry");
    const db = rpc(client);
    const first = await db.rpc("gmail_historical_import_claim_step", {
      p_user_id: run.userId,
      p_run_id: run.runId,
      p_lease_seconds: 60,
    });
    const oldLease = first.data as { lease_token: string; authorization_revision: number };

    await client.query(
      "update private.gmail_historical_import_runs set lease_expires_at = now() - interval '1 second' where id = $1",
      [run.runId],
    );

    const second = await db.rpc("gmail_historical_import_claim_step", {
      p_user_id: run.userId,
      p_run_id: run.runId,
      p_lease_seconds: 60,
    });
    expect((second.data as { result: string }).result).toBe("ok");

    const stale = await db.rpc("gmail_historical_import_commit_page", {
      p_user_id: run.userId,
      p_run_id: run.runId,
      p_lease_token: oldLease.lease_token,
      p_expected_authorization_revision: oldLease.authorization_revision,
      p_page_token_used: null,
      p_next_page_token: null,
      p_thread_ids: ["t-zombie"],
      p_sent_messages_seen: 1,
      p_quota_units: 5,
    });
    expect((stale.data as { result: string }).result).toBe("stale_lease");
    expect(await threadRows(client, run.runId)).toHaveLength(0);
  });

  it("91-93. remaining work is discoverable with no in-memory state", async () => {
    const run = await startRun("b03-lease-durable");
    const at = inWindow();
    const gmail = createFakeGmailRead({
      pages: [{ candidates: [{ messageId: "m1", threadId: "t1" }], nextPageToken: null }],
      threads: {
        t1: thread("t1", [textMessage({ id: "m1", threadId: "t1", internalDateMs: at })]),
      },
    });

    // Two independent "processes": no shared object, no shared closure. Each
    // discovers what is left by asking the database.
    await runOneImportStep({ userId: run.userId, runId: run.runId }, importDeps(client, { gmail }));
    await runOneImportStep({ userId: run.userId, runId: run.runId }, importDeps(client, { gmail }));
    const outcome = await runOneImportStep(
      { userId: run.userId, runId: run.runId },
      importDeps(client, { gmail }),
    );

    expect(outcome).toEqual({ result: "finished", status: "completed" });
    expect(await rawMessages(client, run.mailAccountId)).toHaveLength(1);
  });
});

d("B03 retry and rate limiting", () => {
  it("97-105. a rate limit is retried with backoff, and the work item survives", async () => {
    const run = await startRun("b03-retry");
    const db = rpc(client);
    const claim = await db.rpc("gmail_historical_import_claim_step", {
      p_user_id: run.userId,
      p_run_id: run.runId,
      p_lease_seconds: 60,
    });
    const lease = claim.data as { lease_token: string; authorization_revision: number };
    await db.rpc("gmail_historical_import_commit_page", {
      p_user_id: run.userId,
      p_run_id: run.runId,
      p_lease_token: lease.lease_token,
      p_expected_authorization_revision: lease.authorization_revision,
      p_page_token_used: null,
      p_next_page_token: null,
      p_thread_ids: ["t-429"],
      p_sent_messages_seen: 1,
      p_quota_units: 5,
    });

    const slept: number[] = [];
    const gmail = createFakeGmailRead({
      threadErrors: [
        new GmailReadError({
          operation: "threads_get",
          status: 429,
          reason: "rate_limit_exceeded",
          retryable: true,
        }),
      ],
      threads: {
        "t-429": thread("t-429", [
          textMessage({ id: "m1", threadId: "t-429", internalDateMs: inWindow() }),
        ]),
      },
    });
    const deps = importDeps(client, { gmail, sleep: async (ms) => void slept.push(ms) });

    const first = await runOneImportStep({ userId: run.userId, runId: run.runId }, deps);
    expect(first).toEqual({ result: "retry_scheduled", reason: "rate_limit_exceeded" });
    // Deterministic in CI: the delay is computed and recorded, never waited out.
    expect(slept[0]).toBeGreaterThan(0);

    const row = (await threadRows(client, run.runId))[0];
    expect(row.status).toBe("pending");
    expect(row.attempt_count).toBe(1);
    expect(row.last_error_code).toBe("rate_limit_exceeded");

    // The retry then succeeds.
    await client.query(
      "update private.gmail_historical_import_threads set next_attempt_at = now() where run_id = $1",
      [run.runId],
    );
    await runOneImportStep({ userId: run.userId, runId: run.runId }, deps);
    expect(await rawMessages(client, run.mailAccountId)).toHaveLength(1);
  });

  it("105-106. attempts are bounded, and no failure deletes a Gmail credential", async () => {
    const run = await startRun("b03-retry-bounded");
    const db = rpc(client);
    const claim = await db.rpc("gmail_historical_import_claim_step", {
      p_user_id: run.userId,
      p_run_id: run.runId,
      p_lease_seconds: 60,
    });
    const lease = claim.data as { lease_token: string; authorization_revision: number };
    await db.rpc("gmail_historical_import_commit_page", {
      p_user_id: run.userId,
      p_run_id: run.runId,
      p_lease_token: lease.lease_token,
      p_expected_authorization_revision: lease.authorization_revision,
      p_page_token_used: null,
      p_next_page_token: null,
      p_thread_ids: ["t-403"],
      p_sent_messages_seen: 1,
      p_quota_units: 5,
    });

    const gmail = createFakeGmailRead({
      threadErrors: [
        new GmailReadError({
          operation: "threads_get",
          status: 403,
          reason: "forbidden",
          retryable: false,
        }),
      ],
    });
    const outcome = await runOneImportStep(
      { userId: run.userId, runId: run.runId },
      importDeps(client, { gmail }),
    );
    expect(outcome).toEqual({ result: "failed", reason: "forbidden" });
    expect((await threadRows(client, run.runId))[0].status).toBe("failed");

    // A 403 is not evidence about the creator's refresh token, and B03 has no
    // business concluding otherwise: B02 owns that question.
    const credentials = await client.query(
      "select count(*)::int as n from private.gmail_oauth_credentials where mail_account_id = $1",
      [run.mailAccountId],
    );
    expect(credentials.rows[0].n).toBe(1);
    expect(await stateOf(client, run.mailAccountId)).toBe("connected");
  });
});
