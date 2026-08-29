import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { GmailReadError } from "@/lib/gmail/import/errors";
import { buildSentWindowQuery } from "@/lib/gmail/import/read-adapter.server";
import { sanitizeMessage, sanitizeThread } from "@/lib/gmail/import/sanitizer";
import { runImportUntilIdle, runOneImportStep } from "@/lib/gmail/import/worker.server";

import { createFakeGmailRead, textMessage, thread } from "./fake-gmail-read";
import {
  connectedMailbox,
  importDeps,
  rawMessages,
  rpc,
  runRow,
  setConnectionState,
  startDeletion,
  threadRows,
  withdrawConsent,
} from "./harness";

/**
 * B03 EXTERNAL AUDIT AMENDMENT #1.
 *
 * Five defects, every one of them reproduced as real committed state on real
 * PostgreSQL before it was fixed, and every one of them asserted here against
 * the fix:
 *
 *   A  enumeration retries were neither bounded nor durable
 *   B  a human lifecycle decision only existed if a worker happened to observe it
 *   C  failure and completion paths escaped the authorization fence
 *   D  a fractional window end made the provider query narrower than the window
 *   E  message headers overwrote MIME structural headers on single-part mail
 *
 * plus two smaller ones found alongside them: a `Content-Disposition` could
 * smuggle a filename past the attachment guard, and a malformed provider
 * response read as a successful empty result.
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
  return { ...mailbox, runId: (started.data as { run_id: string }).run_id };
}

async function claim(userId: string, runId: string, leaseSeconds = 300) {
  const res = await rpc(client).rpc("gmail_historical_import_claim_step", {
    p_user_id: userId,
    p_run_id: runId,
    p_lease_seconds: leaseSeconds,
  });
  return res.data as {
    result: string;
    step?: string;
    lease_token?: string;
    authorization_revision?: number;
    provider_thread_id?: string;
    attempt_count?: number;
    next_attempt_at?: string;
    status?: string;
  };
}

/** A rate limit, as the classifier would produce it. */
const rateLimit = (operation: "messages_list" | "threads_get") =>
  new GmailReadError({ operation, status: 429, reason: "rate_limit_exceeded", retryable: true });

/** A permanent, fixed-request failure: retrying reaches the same answer. */
const badRequest = (operation: "messages_list" | "threads_get") =>
  new GmailReadError({ operation, status: 400, reason: "bad_request", retryable: false });

/** Put the mailbox back the way B02 would after a real reconnection. */
async function reconnect(mailAccountId: string, userId: string) {
  await client.query("begin");
  await client.query(
    `update public.mail_accounts
        set connection_state = 'connected', connected_at = now(), disconnected_at = null,
            granted_scopes = (select granted_scopes_at_decision
                                from public.mail_account_consent_receipts
                               where mail_account_id = $1 and decision = 'granted'
                               order by event_seq desc limit 1)
      where id = $1`,
    [mailAccountId],
  );
  await client.query(
    `insert into private.gmail_oauth_credentials
       (mail_account_id, user_id, refresh_token_ciphertext, refresh_token_iv,
        refresh_token_auth_tag, encryption_key_version)
     values ($1, $2, 'ct2', 'iv2', 'tag2', 'v1')
     on conflict (mail_account_id) do nothing`,
    [mailAccountId, userId],
  );
  await client.query("commit");
}

// ===========================================================================
// A. ENUMERATION RETRIES ARE BOUNDED AND DURABLE
// ===========================================================================

d("A. enumeration retry budget", () => {
  it("A1. one messages.list rate limit is a DURABLE attempt against the run", async () => {
    const run = await startRun("a1-list-429");
    const gmail = createFakeGmailRead({ listErrors: [rateLimit("messages_list")] });

    const outcome = await runOneImportStep(
      { userId: run.userId, runId: run.runId },
      importDeps(client, { gmail }),
    );
    expect(outcome).toEqual({ result: "retry_scheduled", reason: "rate_limit_exceeded" });

    // There is no work-item row for a listing page, so the count HAS to be on
    // the run. Before this amendment nothing anywhere was incremented.
    const row = await runRow(client, run.runId);
    expect(row.enumeration_attempt_count).toBe(1);
    expect(row.enumeration_next_attempt_at).not.toBeNull();
    expect(row.status).toBe("runnable");
    expect(row.lease_token).toBeNull();
  });

  it("A2. the count and the schedule survive the process that made them", async () => {
    const run = await startRun("a2-restart");
    await runOneImportStep(
      { userId: run.userId, runId: run.runId },
      importDeps(client, {
        gmail: createFakeGmailRead({ listErrors: [rateLimit("messages_list")] }),
      }),
    );

    // A different worker, a different process, no shared memory: the ONLY thing
    // carried across is what the database holds.
    const fresh = new Client({ connectionString: TEST_DB });
    await fresh.connect();
    try {
      const res = await fresh.query(
        `select enumeration_attempt_count, enumeration_next_attempt_at
           from private.gmail_historical_import_runs where id = $1`,
        [run.runId],
      );
      expect(res.rows[0].enumeration_attempt_count).toBe(1);
      expect(res.rows[0].enumeration_next_attempt_at).not.toBeNull();
    } finally {
      await fresh.end();
    }
  });

  it("A3. a retry before its time is refused, and no provider call is made", async () => {
    const run = await startRun("a3-backoff");
    await runOneImportStep(
      { userId: run.userId, runId: run.runId },
      importDeps(client, {
        gmail: createFakeGmailRead({ listErrors: [rateLimit("messages_list")] }),
      }),
    );

    // Push the schedule well into the future so the assertion is not a race.
    await client.query(
      `update private.gmail_historical_import_runs
          set enumeration_next_attempt_at = now() + interval '10 minutes' where id = $1`,
      [run.runId],
    );

    const gmail = createFakeGmailRead({
      pages: [{ candidates: [{ messageId: "m", threadId: "t" }], nextPageToken: null }],
    });
    const outcome = await runOneImportStep(
      { userId: run.userId, runId: run.runId },
      importDeps(client, { gmail }),
    );
    expect(outcome.result).toBe("waiting");
    // The backoff is enforced by the CLAIM, so the worker never gets a lease and
    // never reaches Google. A delay implemented as a sleep in a process would
    // have been skipped entirely by a fresh process.
    expect(gmail.calls.listMessagesCalls).toBe(0);
  });

  it("A4. five retryable list failures END the run instead of retrying forever", async () => {
    const run = await startRun("a4-exhausted");
    const gmail = createFakeGmailRead({
      listErrors: [
        rateLimit("messages_list"),
        rateLimit("messages_list"),
        rateLimit("messages_list"),
        rateLimit("messages_list"),
        rateLimit("messages_list"),
        rateLimit("messages_list"),
      ],
    });
    const deps = importDeps(client, { gmail });

    for (let attempt = 0; attempt < 5; attempt += 1) {
      await client.query(
        "update private.gmail_historical_import_runs set enumeration_next_attempt_at = null where id = $1",
        [run.runId],
      );
      await runOneImportStep({ userId: run.userId, runId: run.runId }, deps);
    }

    const row = await runRow(client, run.runId);
    expect(row.enumeration_attempt_count).toBe(5);
    expect(row.status).toBe("failed");
    expect(row.phase).toBe("finished");
    expect(row.completed_at).not.toBeNull();
    expect(row.last_error_code).toBe("rate_limit_exceeded");
    expect(row.lease_token).toBeNull();
    // Five provider calls, not six: the run is terminal and claims nothing more.
    expect(gmail.calls.listMessagesCalls).toBe(5);

    const after = await claim(run.userId, run.runId);
    expect(after.result).toBe("not_runnable");
  });

  it("A5. a permanent fixed-request error fails the run on the FIRST attempt", async () => {
    const run = await startRun("a5-list-400");
    const gmail = createFakeGmailRead({ listErrors: [badRequest("messages_list")] });

    const outcome = await runOneImportStep(
      { userId: run.userId, runId: run.runId },
      importDeps(client, { gmail }),
    );
    expect(outcome).toEqual({ result: "failed", reason: "bad_request" });

    const row = await runRow(client, run.runId);
    // Retrying a request that is wrong four more times reaches the same answer
    // four times more slowly.
    expect(row.status).toBe("failed");
    expect(row.enumeration_attempt_count).toBe(1);
    expect(row.completed_at).not.toBeNull();
  });

  it("A6-A7. a successful page resets the budget, so each page gets its own", async () => {
    const run = await startRun("a6-reset");
    const gmail = createFakeGmailRead({
      listErrors: [rateLimit("messages_list")],
      pages: [
        { candidates: [{ messageId: "m1", threadId: "t1" }], nextPageToken: "P2" },
        { candidates: [{ messageId: "m2", threadId: "t2" }], nextPageToken: null },
      ],
    });
    const deps = importDeps(client, { gmail });

    await runOneImportStep({ userId: run.userId, runId: run.runId }, deps);
    expect((await runRow(client, run.runId)).enumeration_attempt_count).toBe(1);

    await client.query(
      "update private.gmail_historical_import_runs set enumeration_next_attempt_at = null where id = $1",
      [run.runId],
    );
    await runOneImportStep({ userId: run.userId, runId: run.runId }, deps);

    // PAGE ONE LANDED. The next page is a different provider operation and its
    // budget starts again — otherwise a long, healthy enumeration could
    // accumulate its way into `failed` one unlucky page at a time.
    const afterPage = await runRow(client, run.runId);
    expect(afterPage.enumeration_page_token).toBe("P2");
    expect(afterPage.enumeration_attempt_count).toBe(0);
    expect(afterPage.enumeration_next_attempt_at).toBeNull();

    await runOneImportStep({ userId: run.userId, runId: run.runId }, deps);
    const done = await runRow(client, run.runId);
    expect(done.enumeration_completed_at).not.toBeNull();
    expect(done.unique_threads_discovered).toBe(2);
  });

  it("A8. `runImportUntilIdle` terminates rather than spinning on a dead page", async () => {
    const run = await startRun("a8-no-spin");
    const gmail = createFakeGmailRead({
      listErrors: Array.from({ length: 50 }, () => rateLimit("messages_list")),
    });

    const outcome = await runImportUntilIdle(
      { userId: run.userId, runId: run.runId, maxSteps: 50 },
      importDeps(client, { gmail }),
    );
    // It makes ONE provider call and then stops, because the next claim hits the
    // durable backoff and answers `waiting`. Before this amendment there was no
    // schedule to hit and the loop would have spent all fifty errors.
    expect(outcome.result).toBe("waiting");
    expect(gmail.calls.listMessagesCalls).toBe(1);
  });
});

// ===========================================================================
// B. A HUMAN DECISION IS DURABLE, NOT OBSERVED
// ===========================================================================
//
// Every test here changes the mailbox with NO WORKER RUNNING, and asserts the
// run moved anyway. That is the whole property: a person's decision cannot
// depend on whether something happened to be polling at that moment.

d("B. mailbox lifecycle carries the run", () => {
  it("B1-B3. Disconnect then Reconnect between polls leaves the run cancelled", async () => {
    const run = await startRun("b1-disconnect");

    await setConnectionState(client, run.mailAccountId, "disconnected");
    const stopped = await runRow(client, run.runId);
    expect(stopped.status).toBe("cancelled_connection_stopped");
    expect(stopped.last_error_code).toBe("connection_stopped");
    expect(stopped.completed_at).not.toBeNull();
    expect(stopped.lease_token).toBeNull();

    await reconnect(run.mailAccountId, run.userId);

    // B1. Reconnecting answers "may we read your mail again". It does not answer
    // "please resume the import you stopped".
    expect((await runRow(client, run.runId)).status).toBe("cancelled_connection_stopped");
    expect((await claim(run.userId, run.runId)).result).toBe("not_runnable");

    // B2. And it cannot be resumed: cancelled is terminal.
    const resumed = await rpc(client).rpc("gmail_historical_import_resume", {
      p_user_id: run.userId,
      p_run_id: run.runId,
    });
    expect((resumed.data as { result: string }).result).toBe("not_paused");

    // B3. Starting again is a NEW run, which is a decision somebody makes.
    const fresh = await rpc(client).rpc("gmail_historical_import_start", {
      p_user_id: run.userId,
      p_mail_account_id: run.mailAccountId,
      p_window_start_at: windowStart(),
    });
    const started = fresh.data as { result: string; run_id: string };
    expect(started.result).toBe("ok");
    expect(started.run_id).not.toBe(run.runId);
  });

  it("B4-B6. a consent withdrawal pauses immediately; regranting does not resume", async () => {
    const run = await startRun("b4-consent");

    await withdrawConsent(client, run.mailAccountId, run.userId);
    const paused = await runRow(client, run.runId);
    expect(paused.status).toBe("paused_consent");
    expect(paused.last_error_code).toBe("consent_missing");

    // B5. The human answers the permission question again. The mailbox is
    // healthy; the import is still stopped, because nobody asked for it back.
    await client.query("begin");
    const receipt = await client.query(
      `insert into public.mail_account_consent_receipts
         (mail_account_id, user_id, consent_kind, decision, policy_version, consent_text_digest,
          granted_scopes_at_decision, decided_by_user_id, decided_at, receipt_digest)
       values ($1, $2, 'private_gmail_processing', 'granted', 'p/1', $3,
               (select granted_scopes from public.mail_accounts where id = $1), $2, now(), $4)
       returning id, event_seq`,
      [run.mailAccountId, run.userId, "a".repeat(64), "c".repeat(64)],
    );
    await client.query(
      `update public.mail_account_consents
          set state = 'granted', current_receipt_id = $2, current_event_seq = $3
        where mail_account_id = $1 and consent_kind = 'private_gmail_processing'`,
      [run.mailAccountId, receipt.rows[0].id, receipt.rows[0].event_seq],
    );
    await client.query(
      "update public.mail_accounts set connection_state = 'connected' where id = $1",
      [run.mailAccountId],
    );
    await client.query("commit");

    expect((await runRow(client, run.runId)).status).toBe("paused_consent");
    expect((await claim(run.userId, run.runId)).result).toBe("not_runnable");

    // B6. An EXPLICIT resume, and only then.
    const resumed = await rpc(client).rpc("gmail_historical_import_resume", {
      p_user_id: run.userId,
      p_run_id: run.runId,
    });
    expect((resumed.data as { result: string }).result).toBe("ok");
    expect((await runRow(client, run.runId)).status).toBe("runnable");
  });

  it("B7-B8. reauth_required pauses immediately and survives a reconnection", async () => {
    const run = await startRun("b7-reauth");

    await setConnectionState(client, run.mailAccountId, "reauth_required");
    expect((await runRow(client, run.runId)).status).toBe("paused_reauth");

    await reconnect(run.mailAccountId, run.userId);
    expect((await runRow(client, run.runId)).status).toBe("paused_reauth");
    expect((await claim(run.userId, run.runId)).result).toBe("not_runnable");

    const resumed = await rpc(client).rpc("gmail_historical_import_resume", {
      p_user_id: run.userId,
      p_run_id: run.runId,
    });
    expect((resumed.data as { result: string }).result).toBe("ok");
  });

  it("B9-B10. a deletion cancels the run, and imported mail is NOT deleted by it", async () => {
    const run = await startRun("b9-deletion");

    // Give the run something imported, so "cancel" and "delete" are visibly
    // different acts rather than indistinguishable ones.
    const gmail = createFakeGmailRead({
      pages: [{ candidates: [{ messageId: "m1", threadId: "t1" }], nextPageToken: null }],
      threads: {
        t1: thread("t1", [textMessage({ id: "m1", threadId: "t1", internalDateMs: inWindow() })]),
      },
    });
    await runOneImportStep({ userId: run.userId, runId: run.runId }, importDeps(client, { gmail }));
    await runOneImportStep({ userId: run.userId, runId: run.runId }, importDeps(client, { gmail }));
    expect(await rawMessages(client, run.mailAccountId)).toHaveLength(1);

    await startDeletion(client, run.mailAccountId, run.userId);

    expect((await runRow(client, run.runId)).status).toBe("cancelled_connection_stopped");
    // B10. Stopping access is not erasing data. The purge is a separate,
    // explicit act with its own RPC and its own authorization.
    expect(await rawMessages(client, run.mailAccountId)).toHaveLength(1);
  });

  it("the trigger is idempotent and never rewrites a terminal run", async () => {
    const run = await startRun("b-terminal");
    await client.query(
      `update private.gmail_historical_import_runs
          set status = 'completed', phase = 'finished', completed_at = now(),
              enumeration_completed_at = now()
        where id = $1`,
      [run.runId],
    );

    await setConnectionState(client, run.mailAccountId, "disconnected");
    await setConnectionState(client, run.mailAccountId, "disconnected");

    // A `completed` import does not become `cancelled` because the person later
    // disconnected: it says something true about history that already happened.
    expect((await runRow(client, run.runId)).status).toBe("completed");
  });
});

// ===========================================================================
// C. EVERY CLAIM-DERIVED RESULT NAMES ITS REVISION
// ===========================================================================

d("C. the fence covers failure and completion too", () => {
  it("C1. a stale 404 does NOT mark work gone under a newer lifecycle", async () => {
    const run = await startRun("c1-gone");
    const db = rpc(client);

    const first = await claim(run.userId, run.runId);
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
    const claimed = await claim(run.userId, run.runId);

    // The threads.get is in flight. The human disconnects and reconnects.
    await setConnectionState(client, run.mailAccountId, "disconnected");
    await reconnect(run.mailAccountId, run.userId);

    const gone = await db.rpc("gmail_historical_import_record_thread_gone", {
      p_user_id: run.userId,
      p_run_id: run.runId,
      p_lease_token: claimed.lease_token,
      p_expected_authorization_revision: claimed.authorization_revision,
      p_provider_thread_id: claimed.provider_thread_id,
      p_quota_units: 40,
    });
    expect((gone.data as { result: string }).result).not.toBe("ok");
    const rows = await threadRows(client, run.runId);
    expect(rows[0].status).toBe("pending");
    expect(rows[0].completed_at).toBeNull();
  });

  it("C1b. a NULL revision is refused outright — there is no wildcard", async () => {
    const run = await startRun("c1b-null-revision");
    const db = rpc(client);
    const first = await claim(run.userId, run.runId);
    await db.rpc("gmail_historical_import_commit_page", {
      p_user_id: run.userId,
      p_run_id: run.runId,
      p_lease_token: first.lease_token,
      p_expected_authorization_revision: first.authorization_revision,
      p_page_token_used: null,
      p_next_page_token: null,
      p_thread_ids: ["t-null"],
      p_sent_messages_seen: 1,
      p_quota_units: 5,
    });
    const claimed = await claim(run.userId, run.runId);

    // Nothing about the mailbox changed. The call is refused purely because it
    // declined to name the revision it was made under — "compare against
    // whatever is current" is exactly the comparison that lets a stale response
    // through, so it is not offered.
    const gone = await db.rpc("gmail_historical_import_record_thread_gone", {
      p_user_id: run.userId,
      p_run_id: run.runId,
      p_lease_token: claimed.lease_token,
      p_expected_authorization_revision: null,
      p_provider_thread_id: claimed.provider_thread_id,
      p_quota_units: 40,
    });
    expect((gone.data as { result: string }).result).toBe("authorization_revision_required");
    expect((await threadRows(client, run.runId))[0].status).toBe("pending");
  });

  it("C2. a stale 429 records no attempt under a newer lifecycle", async () => {
    const run = await startRun("c2-retry");
    const db = rpc(client);
    const claimed = await claim(run.userId, run.runId);

    await setConnectionState(client, run.mailAccountId, "disconnected");
    await reconnect(run.mailAccountId, run.userId);

    const res = await db.rpc("gmail_historical_import_record_retry", {
      p_user_id: run.userId,
      p_run_id: run.runId,
      p_lease_token: claimed.lease_token,
      p_expected_authorization_revision: claimed.authorization_revision,
      p_provider_thread_id: null,
      p_error_code: "rate_limit_exceeded",
      p_retry_after_seconds: 1,
      p_quota_units: 5,
      p_max_attempts: 5,
    });
    expect((res.data as { result: string }).result).not.toBe("ok");

    const row = await runRow(client, run.runId);
    // An attempt count is a durable claim that we asked Google something under a
    // particular authorization. A stale response does not get to make it.
    expect(row.enumeration_attempt_count).toBe(0);
    expect(row.enumeration_next_attempt_at).toBeNull();
  });

  it("C3. a stale permanent error does not fail work under a newer lifecycle", async () => {
    const run = await startRun("c3-permanent");
    const db = rpc(client);
    const first = await claim(run.userId, run.runId);
    await db.rpc("gmail_historical_import_commit_page", {
      p_user_id: run.userId,
      p_run_id: run.runId,
      p_lease_token: first.lease_token,
      p_expected_authorization_revision: first.authorization_revision,
      p_page_token_used: null,
      p_next_page_token: null,
      p_thread_ids: ["t-perm"],
      p_sent_messages_seen: 1,
      p_quota_units: 5,
    });
    const claimed = await claim(run.userId, run.runId);

    await setConnectionState(client, run.mailAccountId, "disconnected");
    await reconnect(run.mailAccountId, run.userId);

    const res = await db.rpc("gmail_historical_import_record_retry", {
      p_user_id: run.userId,
      p_run_id: run.runId,
      p_lease_token: claimed.lease_token,
      p_expected_authorization_revision: claimed.authorization_revision,
      p_provider_thread_id: claimed.provider_thread_id,
      p_error_code: "bad_request",
      p_retry_after_seconds: 0,
      p_quota_units: 40,
      p_max_attempts: 1,
    });
    expect((res.data as { result: string }).result).not.toBe("ok");
    const rows = await threadRows(client, run.runId);
    expect(rows[0].status).toBe("pending");
    expect(rows[0].attempt_count).toBe(0);
  });

  it("C4. a lease for one thread cannot record a failure against another", async () => {
    const run = await startRun("c4-thread-binding");
    const db = rpc(client);
    const first = await claim(run.userId, run.runId);
    await db.rpc("gmail_historical_import_commit_page", {
      p_user_id: run.userId,
      p_run_id: run.runId,
      p_lease_token: first.lease_token,
      p_expected_authorization_revision: first.authorization_revision,
      p_page_token_used: null,
      p_next_page_token: null,
      p_thread_ids: ["t-A", "t-B"],
      p_sent_messages_seen: 2,
      p_quota_units: 5,
    });
    const claimed = await claim(run.userId, run.runId);
    const other = claimed.provider_thread_id === "t-A" ? "t-B" : "t-A";

    const res = await db.rpc("gmail_historical_import_record_retry", {
      p_user_id: run.userId,
      p_run_id: run.runId,
      p_lease_token: claimed.lease_token,
      p_expected_authorization_revision: claimed.authorization_revision,
      p_provider_thread_id: other,
      p_error_code: "rate_limit_exceeded",
      p_retry_after_seconds: 1,
      p_quota_units: 40,
      p_max_attempts: 5,
    });
    expect((res.data as { result: string }).result).toBe("stale_lease");

    const rows = await threadRows(client, run.runId);
    // Neither item moved: not the one that was claimed, and certainly not the
    // one the caller named. A valid token is permission for ONE thread.
    for (const row of rows) {
      expect([row.provider_thread_id, row.attempt_count, row.status]).toEqual([
        row.provider_thread_id,
        0,
        "pending",
      ]);
    }
  });

  it("C5. a Disconnect before the completion commit means the run is NOT completed", async () => {
    const run = await startRun("c5-completion");
    const db = rpc(client);
    const first = await claim(run.userId, run.runId);
    await db.rpc("gmail_historical_import_commit_page", {
      p_user_id: run.userId,
      p_run_id: run.runId,
      p_lease_token: first.lease_token,
      p_expected_authorization_revision: first.authorization_revision,
      p_page_token_used: null,
      p_next_page_token: null,
      p_thread_ids: [],
      p_sent_messages_seen: 0,
      p_quota_units: 5,
    });

    const claimed = await claim(run.userId, run.runId);
    expect(claimed.step).toBe("complete_run");

    // No Gmail call happens for this step, and the window is still not zero —
    // what changes inside it is a human decision.
    await setConnectionState(client, run.mailAccountId, "disconnected");

    const res = await db.rpc("gmail_historical_import_commit_completion", {
      p_user_id: run.userId,
      p_run_id: run.runId,
      p_lease_token: claimed.lease_token,
      p_expected_authorization_revision: claimed.authorization_revision,
    });
    expect((res.data as { result: string }).result).not.toBe("ok");
    expect((await runRow(client, run.runId)).status).toBe("cancelled_connection_stopped");
  });

  it("C6-C8. the worker reads the semantic result and never reports a phantom mutation", async () => {
    const run = await startRun("c6-semantic");
    const db = rpc(client);
    const first = await claim(run.userId, run.runId);
    await db.rpc("gmail_historical_import_commit_page", {
      p_user_id: run.userId,
      p_run_id: run.runId,
      p_lease_token: first.lease_token,
      p_expected_authorization_revision: first.authorization_revision,
      p_page_token_used: null,
      p_next_page_token: null,
      p_thread_ids: ["t-vanish"],
      p_sent_messages_seen: 1,
      p_quota_units: 5,
    });

    // C6/C7. The thread is gone AND the mailbox is disconnected the instant the
    // worker starts the step — the fake disconnects inside the provider call, so
    // the response genuinely arrives after the decision.
    const gmail = createFakeGmailRead({
      missingThreads: ["t-vanish"],
      onGetThread: async () => {
        await setConnectionState(client, run.mailAccountId, "disconnected");
      },
    });

    const outcome = await runOneImportStep(
      { userId: run.userId, runId: run.runId },
      importDeps(client, { gmail }),
    );

    // C8. NOT `progressed`. Nothing was marked gone, and the worker says so.
    expect(outcome.result).not.toBe("progressed");
    expect(outcome).toEqual({ result: "cancelled", connectionState: "disconnected" });
    expect((await threadRows(client, run.runId))[0].status).toBe("pending");
  });
});

// ===========================================================================
// D. THE PROVIDER QUERY IS A SUPERSET OF THE LOCAL WINDOW
// ===========================================================================

describe("D. second-resolution search rounding", () => {
  const parse = (q: string) => {
    const after = Number(/after:(\d+)/.exec(q)![1]);
    const before = Number(/before:(\d+)/.exec(q)![1]);
    return { after, before };
  };

  it("D1. whole seconds produce the query shape they always did", () => {
    const start = Date.parse("2026-08-01T00:00:00.000Z");
    const end = Date.parse("2026-08-29T20:00:00.000Z");
    const { after, before } = parse(buildSentWindowQuery(start, end));
    expect(after).toBe(start / 1000 - 1);
    expect(before).toBe(end / 1000);
  });

  it("D2. a fractional end rounds UP to the next second", () => {
    const end = Date.parse("2026-08-29T20:00:00.750Z");
    const { before } = parse(buildSentWindowQuery(Date.parse("2026-08-01T00:00:00Z"), end));
    // Flooring here is what made the request narrower than the window it served.
    expect(before).toBe(Math.ceil(end / 1000));
    expect(before * 1000).toBeGreaterThan(end);
  });

  it("D3. a message inside the window but not on a second boundary is offerable", () => {
    const end = Date.parse("2026-08-29T20:00:00.750Z");
    const message = Date.parse("2026-08-29T20:00:00.500Z");
    const { before } = parse(buildSentWindowQuery(Date.parse("2026-08-01T00:00:00Z"), end));

    expect(message).toBeLessThan(end); // inside the authoritative local window
    expect(Math.floor(message / 1000)).toBeLessThan(before); // and Gmail is asked for it

    // The local filter is what actually decides, and it keeps this one.
    const kept = sanitizeThread(
      thread("t-d3", [textMessage({ id: "d3", threadId: "t-d3", internalDateMs: message })]),
      { startMs: Date.parse("2026-08-01T00:00:00Z"), endMs: end },
    );
    expect(kept.messages).toHaveLength(1);
  });

  it("D4. the extra second the query buys is removed by the local filter", () => {
    const end = Date.parse("2026-08-29T20:00:00.750Z");
    const message = Date.parse("2026-08-29T20:00:00.900Z");
    const { before } = parse(buildSentWindowQuery(Date.parse("2026-08-01T00:00:00Z"), end));

    // Gmail MAY offer it — overfetching by under a second is the price…
    expect(Math.floor(message / 1000)).toBeLessThan(before);
    // …and the exact local comparison is what refuses to store it.
    const kept = sanitizeThread(
      thread("t-d4", [textMessage({ id: "d4", threadId: "t-d4", internalDateMs: message })]),
      { startMs: Date.parse("2026-08-01T00:00:00Z"), endMs: end },
    );
    expect(kept.messages).toHaveLength(0);
  });

  it("D5. a fractional start still widens, never narrows", () => {
    const start = Date.parse("2026-08-01T00:00:00.400Z");
    const { after } = parse(buildSentWindowQuery(start, Date.parse("2026-08-29T20:00:00Z")));
    expect(after * 1000).toBeLessThan(start);
  });
});

// ===========================================================================
// E. MESSAGE HEADERS AND MIME PART HEADERS ARE DIFFERENT FACTS
// ===========================================================================

describe("E. single-part MIME structure survives", () => {
  const singlePart = (mimeType: string) => ({
    id: "e-1",
    threadId: "t-e",
    labelIds: ["SENT"],
    internalDate: String(Date.parse("2026-08-10T09:00:00Z")),
    payload: {
      mimeType,
      headers: [
        { name: "From", value: "Creator <creator@example.invalid>" },
        { name: "To", value: "hotel@example.invalid" },
        { name: "Subject", value: "Collaboration" },
        { name: "Content-Type", value: `${mimeType}; charset=ISO-8859-1` },
        { name: "Content-Transfer-Encoding", value: "quoted-printable" },
      ],
      body: { size: 5, data: "aGVsbG8" },
    },
  });

  it("E1. a real single-part text/plain keeps BOTH header namespaces", () => {
    const sanitized = sanitizeMessage(singlePart("text/plain"))!;
    // Gmail's top-level MessagePart is the message AND its only MIME part.
    // Overloading one `headers` property meant the second fact destroyed the
    // first for the commonest shape of email there is.
    expect(sanitized.message.messageHeaders.subject).toBe("Collaboration");
    expect(sanitized.message.messageHeaders.from).toBe("Creator <creator@example.invalid>");
    expect(sanitized.message.payload.headers!["content-type"]).toBe(
      "text/plain; charset=ISO-8859-1",
    );
    expect(sanitized.message.payload.headers!["content-transfer-encoding"]).toBe(
      "quoted-printable",
    );
    expect(sanitized.message.payload.body!.data).toBe("aGVsbG8");
  });

  it("E2. the same holds for text/html", () => {
    const sanitized = sanitizeMessage(singlePart("text/html"))!;
    expect(sanitized.message.messageHeaders.subject).toBe("Collaboration");
    expect(sanitized.message.payload.headers!["content-type"]).toBe(
      "text/html; charset=ISO-8859-1",
    );
  });

  it("E3. a multipart root keeps its own structure and its children keep theirs", () => {
    const sanitized = sanitizeMessage({
      id: "e-3",
      threadId: "t-e3",
      labelIds: ["SENT"],
      internalDate: String(Date.parse("2026-08-10T09:00:00Z")),
      payload: {
        mimeType: "multipart/alternative",
        headers: [
          { name: "Subject", value: "Two ways to read it" },
          { name: "Content-Type", value: 'multipart/alternative; boundary="000abc"' },
        ],
        parts: [
          {
            mimeType: "text/plain",
            headers: [
              { name: "Content-Type", value: "text/plain; charset=UTF-8" },
              { name: "Content-Transfer-Encoding", value: "base64" },
            ],
            body: { size: 3, data: "YWJj" },
          },
          {
            mimeType: "text/html",
            headers: [{ name: "Content-Type", value: "text/html; charset=UTF-8" }],
            body: { size: 4, data: "PGI+" },
          },
        ],
      },
    })!;

    expect(sanitized.message.messageHeaders.subject).toBe("Two ways to read it");
    // A `boundary=` parameter is structure, not a filename, and it survives.
    expect(sanitized.message.payload.headers!["content-type"]).toBe(
      'multipart/alternative; boundary="000abc"',
    );
    expect(sanitized.message.payload.parts![0]!.headers!["content-transfer-encoding"]).toBe(
      "base64",
    );
    expect(sanitized.message.payload.parts![1]!.headers!["content-type"]).toBe(
      "text/html; charset=UTF-8",
    );
  });

  it("E4. the digest is deterministic across the separated shape", () => {
    const a = sanitizeMessage(singlePart("text/plain"))!;
    const b = sanitizeMessage(singlePart("text/plain"))!;
    const json = (m: typeof a) => JSON.stringify(m.message);
    expect(json(a)).toBe(json(b));
    // And the message headers are actually IN the hashed snapshot: a digest that
    // ignored them could not tell a rewritten subject from an unchanged message.
    expect(json(a)).toContain("Collaboration");
  });
});

// ===========================================================================
// Content-Disposition may not smuggle a filename
// ===========================================================================

describe("a filename is never persisted, wherever the provider put it", () => {
  const namedPart = (headers: { name: string; value: string }[]) => ({
    id: "f-1",
    threadId: "t-f",
    labelIds: ["SENT"],
    internalDate: String(Date.parse("2026-08-10T09:00:00Z")),
    payload: {
      mimeType: "multipart/mixed",
      headers: [{ name: "Subject", value: "s" }],
      parts: [
        {
          mimeType: "text/plain",
          // Gmail did NOT duplicate the name here. That is a provider
          // formatting choice, and it must not decide our privacy posture.
          filename: "",
          headers,
          body: { size: 3, data: "YWJj" },
        },
      ],
    },
  });

  const withDisposition = (disposition: string) =>
    namedPart([
      { name: "Content-Type", value: "text/plain" },
      { name: "Content-Disposition", value: disposition },
    ]);

  for (const disposition of [
    'inline; filename="private-name.txt"',
    "INLINE; FILENAME=private-name.txt",
    "attachment; filename=private-name.txt",
    'inline;filename ="private-name.txt"',
  ]) {
    it(`refuses body and filename for: ${disposition}`, () => {
      const sanitized = sanitizeMessage(withDisposition(disposition))!;
      const json = JSON.stringify(sanitized.message);
      expect(json).not.toContain("private-name.txt");
      // The body went with it: a named part is a file, whatever its MIME type.
      expect(json).not.toContain("YWJj");
      expect(sanitized.message.payload.parts![0]!.contentOmitted).toBe(true);
      expect(sanitized.attachmentOrNonTextOmitted).toBe(1);
    });
  }

  it("a name= parameter on Content-Type is a filename too", () => {
    const sanitized = sanitizeMessage(
      namedPart([{ name: "Content-Type", value: 'text/plain; name="private-name.txt"' }]),
    )!;
    const json = JSON.stringify(sanitized.message);
    expect(json).not.toContain("private-name.txt");
    expect(json).not.toContain("YWJj");
  });

  it("`boundary=` is not a filename and multipart structure is kept", () => {
    const sanitized = sanitizeMessage({
      id: "f-2",
      threadId: "t-f2",
      labelIds: ["SENT"],
      internalDate: String(Date.parse("2026-08-10T09:00:00Z")),
      payload: {
        mimeType: "multipart/mixed",
        headers: [{ name: "Content-Type", value: "multipart/mixed; boundary=--x--" }],
        parts: [],
      },
    })!;
    expect(sanitized.message.payload.headers!["content-type"]).toBe(
      "multipart/mixed; boundary=--x--",
    );
  });
});

// ===========================================================================
// F. A MALFORMED PROVIDER RESPONSE IS NOT AN EMPTY MAILBOX
// ===========================================================================

d("F. malformed provider responses fail closed", () => {
  /**
   * The production adapter, driven through a stubbed `fetch`. The parsing that
   * decides "is this a real answer" lives in the adapter, so a fake that returns
   * pre-parsed objects could never exercise it.
   */
  async function listWith(body: unknown, ok = true) {
    const { gmailHistoricalReadAdapter } = await import("@/lib/gmail/import/read-adapter.server");
    const original = globalThis.fetch;
    globalThis.fetch = (async () =>
      ({
        ok,
        status: ok ? 200 : 500,
        json: async () => {
          if (body === "INVALID_JSON") throw new SyntaxError("bad json");
          return body;
        },
      }) as unknown as Response) as typeof fetch;
    try {
      return await gmailHistoricalReadAdapter.listSentMessages({
        accessToken: "t",
        windowStartMs: 1_700_000_000_000,
        windowEndMs: 1_700_003_600_000,
        pageToken: null,
      });
    } finally {
      globalThis.fetch = original;
    }
  }

  it("F1. a 200 whose body will not parse is malformed, not empty", async () => {
    await expect(listWith("INVALID_JSON")).rejects.toMatchObject({
      reason: "malformed_response",
      retryable: false,
    });
    await expect(listWith(null)).rejects.toMatchObject({ reason: "malformed_response" });
  });

  it("F2. `messages` present but not a list is malformed", async () => {
    await expect(listWith({ messages: "nope" })).rejects.toMatchObject({
      reason: "malformed_response",
    });
    // An ABSENT `messages` is legitimate — Gmail omits the key on an empty page.
    await expect(listWith({})).resolves.toMatchObject({ candidates: [], nextPageToken: null });
  });

  it("F3-F4. one candidate missing an id fails the WHOLE page", async () => {
    await expect(
      listWith({ messages: [{ id: "a", threadId: "t" }, { threadId: "t2" }] }),
    ).rejects.toMatchObject({ reason: "malformed_response" });
    await expect(
      listWith({ messages: [{ id: "a", threadId: "t" }, { id: "b" }] }),
    ).rejects.toMatchObject({ reason: "malformed_response" });
    // Silently dropping the bad entry would shrink the candidate set with
    // nothing downstream able to tell.
  });

  it("F5. a malformed nextPageToken is never read as `no more pages`", async () => {
    await expect(listWith({ messages: [], nextPageToken: 42 })).rejects.toMatchObject({
      reason: "malformed_response",
    });
    await expect(listWith({ messages: [], nextPageToken: "" })).rejects.toMatchObject({
      reason: "malformed_response",
    });
  });

  for (const [label, broken] of [
    ["F6. a non-draft message with no id", { threadId: "t-m", internalDate: "1770000000000" }],
    ["F7. a non-draft message with no threadId", { id: "m-x", internalDate: "1770000000000" }],
    ["F8. an unparsable internalDate", { id: "m-x", threadId: "t-m", internalDate: "yesterday" }],
  ] as const) {
    it(`${label} fails the thread rather than vanishing`, () => {
      expect(() =>
        sanitizeThread(
          { id: "t-m", messages: [{ ...broken, labelIds: ["SENT"] }] },
          {
            startMs: 0,
            endMs: Date.now() + DAY,
          },
        ),
      ).toThrow(/malformed_response/);
    });
  }

  it("a DRAFT with no identity is still just a draft, and is dropped", () => {
    const result = sanitizeThread(
      { id: "t-draft", messages: [{ labelIds: ["DRAFT"], internalDate: "x" }] },
      { startMs: 0, endMs: Date.now() + DAY },
    );
    // Drafts leave before identity is ever needed: nothing about them is stored,
    // so nothing about them can be malformed.
    expect(result.draftsDropped).toBe(1);
    expect(result.messages).toHaveLength(0);
  });

  it("F9-F10. a malformed thread stores nothing and the run never says `completed`", async () => {
    const run = await startRun("f9-malformed");
    const gmail = createFakeGmailRead({
      pages: [{ candidates: [{ messageId: "m1", threadId: "t1" }], nextPageToken: null }],
      threads: {
        t1: {
          id: "t1",
          messages: [
            { id: "", threadId: "t1", labelIds: ["SENT"], internalDate: String(inWindow()) },
          ],
        },
      },
    });

    await runImportUntilIdle(
      { userId: run.userId, runId: run.runId, maxSteps: 20 },
      importDeps(client, { gmail }),
    );
    await runImportUntilIdle(
      { userId: run.userId, runId: run.runId, maxSteps: 20 },
      importDeps(client, { gmail }),
    );

    expect(await rawMessages(client, run.mailAccountId)).toHaveLength(0);
    const rows = await threadRows(client, run.runId);
    expect(rows[0].status).toBe("failed");
    expect(rows[0].last_error_code).toBe("malformed_response");

    const row = await runRow(client, run.runId);
    expect(row.status).not.toBe("completed");
    expect(row.threads_completed).toBe(0);
  });
});
