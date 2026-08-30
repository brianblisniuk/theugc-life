import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { GmailReadError } from "@/lib/gmail/import/errors";
import { sanitizeMessage } from "@/lib/gmail/import/sanitizer";
import { runImportUntilIdle } from "@/lib/gmail/import/worker.server";

import { createFakeGmailRead } from "./fake-gmail-read";
import {
  connectedMailbox,
  headerValues,
  importDeps,
  rawMessages,
  rpc,
  runRow,
  threadRows,
} from "./harness";

/**
 * B03 EXTERNAL AUDIT AMENDMENT #3.
 *
 *   A  the preflight was not linearizable against a concurrent lifecycle change
 *   B  MIME safety decisions looked only at the FIRST header occurrence
 *   C  the MIME filename filter was applied to RFC message-header values
 *   D  a terminal thread failure left the run `runnable` in the database
 *
 * A and D were reproduced as real committed state on real PostgreSQL, B and C as
 * real observed behaviour of the sanitizer, before any of them was fixed.
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

async function startRun(label: string) {
  const mailbox = await connectedMailbox(client, label);
  const started = await rpc(client).rpc("gmail_historical_import_start", {
    p_user_id: mailbox.userId,
    p_mail_account_id: mailbox.mailAccountId,
    p_window_start_at: windowStart(),
  });
  return { ...mailbox, runId: (started.data as { run_id: string }).run_id };
}

async function session(): Promise<Client> {
  const c = new Client({ connectionString: TEST_DB });
  await c.connect();
  return c;
}

/**
 * Wait until a given backend is actually WAITING ON A LOCK.
 *
 * This is what makes the concurrency tests deterministic rather than timing
 * guesses: the assertion is not "we slept and hoped", it is "PostgreSQL reports
 * that this session is blocked, and here is the session blocking it".
 */
async function waitUntilBlocked(pid: number, timeoutMs = 10_000): Promise<number[]> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const res = await client.query("select pg_blocking_pids($1) as blockers", [pid]);
    const blockers: number[] = res.rows[0].blockers ?? [];
    if (blockers.length > 0) return blockers;
    if (Date.now() > deadline) throw new Error(`backend ${pid} never blocked`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

const backendPid = async (c: Client): Promise<number> =>
  Number((await c.query("select pg_backend_pid() as pid")).rows[0].pid);

/** The Disconnect, as a transaction we control the commit point of. */
async function beginDisconnect(c: Client, mailAccountId: string) {
  await c.query("begin");
  await c.query("delete from private.gmail_oauth_credentials where mail_account_id = $1", [
    mailAccountId,
  ]);
  await c.query(
    `update public.mail_accounts
        set connection_state = 'disconnected', disconnected_at = now(), granted_scopes = '{}'
      where id = $1`,
    [mailAccountId],
  );
}

async function claimStep(userId: string, runId: string) {
  const res = await rpc(client).rpc("gmail_historical_import_claim_step", {
    p_user_id: userId,
    p_run_id: runId,
    p_lease_seconds: 300,
  });
  return res.data as { lease_token: string; authorization_revision: number; step: string };
}

// ===========================================================================
// A. THE PREFLIGHT IS A REAL SERIALIZATION POINT
// ===========================================================================
//
// Two real PostgreSQL sessions, with PostgreSQL itself reporting who is blocked
// on whom. A sequential test can only show that the preflight reads the current
// row; it cannot show that the read is ORDERED against a concurrent lifecycle
// change, and an unlocked read under READ COMMITTED is not.

d("A. preflight linearization against a concurrent lifecycle change", () => {
  it("A1. the Disconnect wins: the preflight WAITS, then refuses", async () => {
    const run = await startRun("a3-a1-disconnect-first");
    const claimed = await claimStep(run.userId, run.runId);

    const disconnect = await session();
    const validator = await session();
    try {
      // The lifecycle trigger has already cancelled the run inside this
      // transaction. It is simply not committed yet.
      await beginDisconnect(disconnect, run.mailAccountId);

      const validatorPid = await backendPid(validator);
      const pending = validator.query(
        `select public.gmail_historical_import_validate_claim(
                  p_user_id := $1, p_run_id := $2, p_lease_token := $3,
                  p_expected_authorization_revision := $4,
                  p_expected_step := $5, p_expected_provider_thread_id := null) as value`,
        [run.userId, run.runId, claimed.lease_token, claimed.authorization_revision, claimed.step],
      );

      // PostgreSQL says so: the preflight is blocked, and the Disconnect is what
      // is blocking it. Before this amendment it answered `ok` immediately, from
      // a snapshot that predated the Disconnect.
      const blockers = await waitUntilBlocked(validatorPid);
      expect(blockers).toContain(await backendPid(disconnect));

      await disconnect.query("commit");

      const result = (await pending).rows[0].value as { result: string; run_status: string };
      expect(result.result).not.toBe("ok");
      expect(result.run_status).toBe("cancelled_connection_stopped");
    } finally {
      await disconnect.query("rollback").catch(() => undefined);
      await disconnect.end();
      await validator.end();
    }
  });

  it("A1b. and the WORKER makes zero provider calls in that interleaving", async () => {
    const run = await startRun("a3-a1b-worker");
    const disconnect = await session();
    const workerDb = await session();
    const gmail = createFakeGmailRead({
      pages: [{ candidates: [{ messageId: "m1", threadId: "t1" }], nextPageToken: null }],
    });

    try {
      // The worker claims, then is caught by the preflight while a Disconnect is
      // mid-flight. It must not reach Google at all.
      const claimed = await claimStep(run.userId, run.runId);
      void claimed;
      await beginDisconnect(disconnect, run.mailAccountId);

      const workerPid = await backendPid(workerDb);
      const stepping = runImportUntilIdle(
        { userId: run.userId, runId: run.runId, maxSteps: 3 },
        importDeps(workerDb, { gmail }),
      );

      await waitUntilBlocked(workerPid);
      await disconnect.query("commit");
      await stepping;

      expect(gmail.calls.listMessagesCalls).toBe(0);
      expect(gmail.calls.getThreadCalls).toBe(0);
      expect((await runRow(client, run.runId)).status).toBe("cancelled_connection_stopped");
    } finally {
      await disconnect.query("rollback").catch(() => undefined);
      await disconnect.end();
      await workerDb.end();
    }
  });

  it("A2. the validator wins: it owns the run row and the Disconnect waits", async () => {
    const run = await startRun("a3-a2-validator-first");
    const claimed = await claimStep(run.userId, run.runId);

    const validator = await session();
    const disconnect = await session();
    try {
      // An explicit transaction here holds the lock the RPC takes, so the
      // ownership is observable. In production the RPC runs in autocommit and
      // the lock lives only for that statement.
      await validator.query("begin");
      const validated = await validator.query(
        `select public.gmail_historical_import_validate_claim(
                  p_user_id := $1, p_run_id := $2, p_lease_token := $3,
                  p_expected_authorization_revision := $4,
                  p_expected_step := $5, p_expected_provider_thread_id := null) as value`,
        [run.userId, run.runId, claimed.lease_token, claimed.authorization_revision, claimed.step],
      );
      expect((validated.rows[0].value as { result: string }).result).toBe("ok");

      const disconnectPid = await backendPid(disconnect);
      const pending = (async () => {
        await disconnect.query("begin");
        await disconnect.query(
          "delete from private.gmail_oauth_credentials where mail_account_id = $1",
          [run.mailAccountId],
        );
        await disconnect.query(
          `update public.mail_accounts
              set connection_state = 'disconnected', disconnected_at = now(), granted_scopes = '{}'
            where id = $1`,
          [run.mailAccountId],
        );
        await disconnect.query("commit");
      })();

      // The Disconnect blocks at the lifecycle trigger's update of the SAME run
      // row. That contention is the serialization point: the two operations are
      // ordered rather than merely observing each other.
      const blockers = await waitUntilBlocked(disconnectPid);
      expect(blockers).toContain(await backendPid(validator));

      await validator.query("commit");
      await pending;

      // From that point the operation is in flight, and the run stops.
      expect((await runRow(client, run.runId)).status).toBe("cancelled_connection_stopped");
    } finally {
      await validator.query("rollback").catch(() => undefined);
      await validator.end();
      await disconnect.end();
    }
  });

  it("A3. the same ordering holds for a consent withdrawal", async () => {
    const run = await startRun("a3-a3-consent");
    const claimed = await claimStep(run.userId, run.runId);

    const withdraw = await session();
    const validator = await session();
    try {
      await withdraw.query("begin");
      const receipt = await withdraw.query(
        `insert into public.mail_account_consent_receipts
           (mail_account_id, user_id, consent_kind, decision, policy_version, consent_text_digest,
            granted_scopes_at_decision, decided_by_user_id, decided_at, receipt_digest)
         values ($1, $2, 'private_gmail_processing', 'withdrawn', 'p/1', $3,
                 (select granted_scopes from public.mail_accounts where id = $1), $2, now(), $4)
         returning id, event_seq`,
        [run.mailAccountId, run.userId, "a".repeat(64), "e".repeat(64)],
      );
      await withdraw.query(
        `update public.mail_account_consents
            set state = 'withdrawn', current_receipt_id = $2, current_event_seq = $3
          where mail_account_id = $1 and consent_kind = 'private_gmail_processing'`,
        [run.mailAccountId, receipt.rows[0].id, receipt.rows[0].event_seq],
      );
      await withdraw.query(
        "update public.mail_accounts set connection_state = 'consent_required' where id = $1",
        [run.mailAccountId],
      );

      const validatorPid = await backendPid(validator);
      const pending = validator.query(
        `select public.gmail_historical_import_validate_claim(
                  p_user_id := $1, p_run_id := $2, p_lease_token := $3,
                  p_expected_authorization_revision := $4,
                  p_expected_step := $5, p_expected_provider_thread_id := null) as value`,
        [run.userId, run.runId, claimed.lease_token, claimed.authorization_revision, claimed.step],
      );

      const blockers = await waitUntilBlocked(validatorPid);
      expect(blockers).toContain(await backendPid(withdraw));

      await withdraw.query("commit");

      const result = (await pending).rows[0].value as { result: string; run_status: string };
      expect(result.result).not.toBe("ok");
      expect(result.run_status).toBe("paused_consent");
    } finally {
      await withdraw.query("rollback").catch(() => undefined);
      await withdraw.end();
      await validator.end();
    }
  });

  it("no lock is held across the provider call", async () => {
    const run = await startRun("a3-no-lock-across-google");
    const workerDb = await session();
    let blockedDuringCall: number[] = [];
    const gmail = createFakeGmailRead({
      pages: [{ candidates: [{ messageId: "m1", threadId: "t1" }], nextPageToken: null }],
      // WHILE the provider call is in progress, a Disconnect must be able to
      // proceed. If the validator held its lock across Google, this would hang.
      onList: async () => {
        const other = await session();
        try {
          const pid = await backendPid(other);
          await beginDisconnect(other, run.mailAccountId);
          await other.query("commit");
          const res = await client.query("select pg_blocking_pids($1) as b", [pid]);
          blockedDuringCall = res.rows[0].b ?? [];
        } finally {
          await other.end();
        }
      },
    });

    try {
      await runImportUntilIdle(
        { userId: run.userId, runId: run.runId, maxSteps: 3 },
        importDeps(workerDb, { gmail }),
      );
      expect(gmail.calls.listMessagesCalls).toBe(1);
      expect(blockedDuringCall).toEqual([]);
      // The read happened — it was in flight — and the result was refused.
      expect((await runRow(client, run.runId)).status).toBe("cancelled_connection_stopped");
      expect(await threadRows(client, run.runId)).toHaveLength(0);
    } finally {
      await workerDb.end();
    }
  });
});

// ===========================================================================
// B. MIME SAFETY READS EVERY OCCURRENCE
// ===========================================================================

describe("B. a safety decision may not be made on the first header alone", () => {
  const part = (headers: { name: string; value: string }[]) =>
    sanitizeMessage({
      id: "m",
      threadId: "t",
      labelIds: ["SENT"],
      internalDate: String(Date.now() - DAY),
      payload: {
        mimeType: "multipart/mixed",
        headers: [{ name: "Subject", value: "s" }],
        parts: [
          {
            mimeType: "text/plain",
            filename: "",
            headers,
            body: { size: 13, data: "UFJJVkFURS1CWVRFUw" },
          },
        ],
      },
    })!;

  const refused = (sanitized: ReturnType<typeof part>) => {
    const json = JSON.stringify(sanitized.message);
    expect(json).not.toContain("UFJJVkFURS1CWVRFUw");
    expect(json).not.toContain("private");
    const node = sanitized.message.payload.parts![0]!;
    expect(node.body).toBeUndefined();
    expect(node.contentOmitted).toBe(true);
    expect(sanitized.attachmentOrNonTextOmitted).toBe(1);
  };

  it("B1. inline THEN attachment with an RFC 2231 filename", () => {
    refused(
      part([
        { name: "Content-Disposition", value: "inline" },
        { name: "Content-Disposition", value: "attachment; filename*=UTF-8''private.pdf" },
      ]),
    );
  });

  it("B2. inline THEN a bare attachment, with no filename anywhere", () => {
    // No name to find; the disposition alone is the sender saying "this is a
    // file", and contradictory headers resolve towards the conservative answer.
    refused(
      part([
        { name: "Content-Disposition", value: "inline" },
        { name: "Content-Disposition", value: "attachment" },
      ]),
    );
  });

  it("B3. an ordinary Content-Type THEN one carrying a name parameter", () => {
    refused(
      part([
        { name: "Content-Type", value: "text/plain" },
        { name: "Content-Type", value: "text/plain; name*=UTF-8''private.txt" },
      ]),
    );
  });

  it("B4. the position of the named occurrence changes nothing", () => {
    const first = part([
      { name: "Content-Disposition", value: 'attachment; filename="private.pdf"' },
      { name: "Content-Disposition", value: "inline" },
    ]);
    const second = part([
      { name: "Content-Disposition", value: "inline" },
      { name: "Content-Disposition", value: 'attachment; filename="private.pdf"' },
    ]);
    refused(first);
    refused(second);
    // Identical privacy outcome, and identical stored structure.
    expect(JSON.stringify(first.message)).toBe(JSON.stringify(second.message));
  });

  it("B5. three occurrences with only the LAST one named", () => {
    refused(
      part([
        { name: "Content-Disposition", value: "inline" },
        { name: "Content-Disposition", value: "inline; creation-date=x" },
        {
          name: "Content-Disposition",
          value: "inline; filename*0*=UTF-8''priv; filename*1*=ate.pdf",
        },
      ]),
    );
  });

  it("an ordinary duplicated Content-Type still keeps the body and both headers", () => {
    // The conservative rule must not swallow legitimate duplication.
    const sanitized = part([
      { name: "Content-Type", value: "text/plain; charset=UTF-8" },
      { name: "Content-Type", value: "text/plain; charset=ISO-8859-1" },
    ]);
    const node = sanitized.message.payload.parts![0]!;
    expect(node.body?.data).toBe("UFJJVkFURS1CWVRFUw");
    expect(headerValues(node.headers, "content-type")).toEqual([
      "text/plain; charset=UTF-8",
      "text/plain; charset=ISO-8859-1",
    ]);
  });
});

// ===========================================================================
// C. THE MIME NAME FILTER BELONGS TO MIME HEADERS ONLY
// ===========================================================================

describe("C. an approved message header is not a MIME parameter", () => {
  const withHeaders = (headers: { name: string; value: string }[]) =>
    sanitizeMessage({
      id: "m",
      threadId: "t",
      labelIds: ["SENT"],
      internalDate: String(Date.now() - DAY),
      payload: {
        mimeType: "text/plain",
        headers,
        body: { size: 1, data: "YQ" },
      },
    })!;

  it("C1. `Subject: filename=proposal.pdf` survives verbatim", () => {
    // A subject line is content a human wrote. `filename=` inside it is not a
    // MIME parameter, and discarding it applied a privacy rule to the wrong
    // namespace — losing the subject and protecting nothing.
    const sanitized = withHeaders([{ name: "Subject", value: "filename=proposal.pdf" }]);
    expect(headerValues(sanitized.message.messageHeaders, "subject")).toEqual([
      "filename=proposal.pdf",
    ]);
  });

  it("C2. `Subject: name=Alice` survives verbatim", () => {
    const sanitized = withHeaders([{ name: "Subject", value: "name=Alice" }]);
    expect(headerValues(sanitized.message.messageHeaders, "subject")).toEqual(["name=Alice"]);
  });

  it("C3. two `To` fields survive, including one containing a literal name=", () => {
    const sanitized = withHeaders([
      { name: "To", value: "name=Alice <alice@example.invalid>" },
      { name: "To", value: "bob@example.invalid" },
    ]);
    expect(headerValues(sanitized.message.messageHeaders, "to")).toEqual([
      "name=Alice <alice@example.invalid>",
      "bob@example.invalid",
    ]);
  });

  it("C4-C5. the filter still removes filename-bearing STRUCTURAL headers", () => {
    const sanitized = sanitizeMessage({
      id: "m",
      threadId: "t",
      labelIds: ["SENT"],
      internalDate: String(Date.now() - DAY),
      payload: {
        mimeType: "multipart/mixed",
        headers: [{ name: "Subject", value: "filename=still-a-subject.pdf" }],
        parts: [
          {
            mimeType: "text/plain",
            headers: [
              { name: "Content-Disposition", value: "inline; filename*=UTF-8''gone.txt" },
              { name: "Content-Type", value: "text/plain; name*=UTF-8''gone.txt" },
              { name: "Content-Transfer-Encoding", value: "base64" },
            ],
            body: { size: 3, data: "YWJj" },
          },
        ],
      },
    })!;

    const json = JSON.stringify(sanitized.message);
    expect(json).not.toContain("gone.txt");
    // The subject is untouched by the MIME rule…
    expect(json).toContain("filename=still-a-subject.pdf");
    // …and the structural header that carried no name is still kept.
    const node = sanitized.message.payload.parts![0]!;
    expect(headerValues(node.headers, "content-transfer-encoding")).toEqual(["base64"]);
    expect(headerValues(node.headers, "content-disposition")).toEqual([]);
    expect(headerValues(node.headers, "content-type")).toEqual([]);
    // The part was named, so its body went too.
    expect(node.body).toBeUndefined();
  });
});

// ===========================================================================
// D. A TERMINAL THREAD FAILURE IS DURABLE AT RUN LEVEL
// ===========================================================================

d("D. the database says what the worker says", () => {
  const permanent = () =>
    new GmailReadError({
      operation: "threads_get",
      status: 400,
      reason: "bad_request",
      retryable: false,
    });

  async function runWithFailingThread(label: string, errors: GmailReadError[]) {
    const run = await startRun(label);
    const gmail = createFakeGmailRead({
      pages: [{ candidates: [{ messageId: "m1", threadId: "t1" }], nextPageToken: null }],
      threads: {},
      threadErrors: errors,
    });
    const outcome = await runImportUntilIdle(
      { userId: run.userId, runId: run.runId, maxSteps: 20 },
      importDeps(client, { gmail }),
    );
    return { run, gmail, outcome };
  }

  it("D1-D2. ONE work invocation, and the run is durably failed", async () => {
    const { run, outcome } = await runWithFailingThread("a3-d1", [permanent()]);

    expect(outcome).toEqual({ result: "failed", reason: "bad_request" });

    const row = await runRow(client, run.runId);
    // Before this amendment the worker said `failed` and the database said
    // `runnable` — the run still holding the one-active-run index for a mailbox
    // nobody was importing, its real status recoverable only by running `work`
    // again so a later step could notice.
    expect(row.status).toBe("failed");
    expect(row.phase).toBe("finished");
    expect(row.completed_at).not.toBeNull();
    expect(row.lease_token).toBeNull();
    expect(row.last_error_code).toBe("bad_request");

    const threads = await threadRows(client, run.runId);
    expect(threads[0].status).toBe("failed");
    expect(threads[0].completed_at).not.toBeNull();
    expect(await rawMessages(client, run.mailAccountId)).toHaveLength(0);
  });

  it("D3. the status RPC reports it immediately", async () => {
    const { run } = await runWithFailingThread("a3-d3", [permanent()]);
    const status = await rpc(client).rpc("gmail_historical_import_status", {
      p_user_id: run.userId,
      p_run_id: run.runId,
    });
    expect(status.data).toMatchObject({ result: "ok", status: "failed", threads_failed: 1 });
  });

  it("D4-D5. the next claim is not_runnable, with no second `work` needed", async () => {
    const { run, gmail } = await runWithFailingThread("a3-d4", [permanent()]);
    const callsAfterFirstRun = gmail.calls.getThreadCalls;

    const claim = await rpc(client).rpc("gmail_historical_import_claim_step", {
      p_user_id: run.userId,
      p_run_id: run.runId,
      p_lease_seconds: 300,
    });
    expect(claim.data).toMatchObject({ result: "not_runnable", status: "failed" });

    // And a second `work` command changes nothing: the truth was already
    // written the moment it became true.
    const second = await runImportUntilIdle(
      { userId: run.userId, runId: run.runId, maxSteps: 20 },
      importDeps(client, { gmail }),
    );
    expect(second).toEqual({ result: "not_runnable", status: "failed" });
    expect(gmail.calls.getThreadCalls).toBe(callsAfterFirstRun);
    expect((await runRow(client, run.runId)).status).toBe("failed");

    // A NEW run may be started explicitly, because the failed one is terminal
    // and no longer holds the active-run index.
    const fresh = await rpc(client).rpc("gmail_historical_import_start", {
      p_user_id: run.userId,
      p_mail_account_id: run.mailAccountId,
      p_window_start_at: windowStart(),
    });
    expect((fresh.data as { result: string }).result).toBe("ok");
  });

  it("D6-D7. attempts 1..4 keep the run runnable; attempt 5 fails both atomically", async () => {
    const run = await startRun("a3-d6");
    const db = rpc(client);
    const first = await claimStep(run.userId, run.runId);
    await db.rpc("gmail_historical_import_commit_page", {
      p_user_id: run.userId,
      p_run_id: run.runId,
      p_lease_token: first.lease_token,
      p_expected_authorization_revision: first.authorization_revision,
      p_page_token_used: null,
      p_next_page_token: null,
      p_thread_ids: ["t-retry"],
      p_sent_messages_seen: 1,
      p_quota_units: 5,
    });

    for (let attempt = 1; attempt <= 5; attempt += 1) {
      await client.query(
        "update private.gmail_historical_import_threads set next_attempt_at = now() where run_id = $1",
        [run.runId],
      );
      const claimed = await claimStep(run.userId, run.runId);
      const res = await db.rpc("gmail_historical_import_record_retry", {
        p_user_id: run.userId,
        p_run_id: run.runId,
        p_lease_token: claimed.lease_token,
        p_expected_authorization_revision: claimed.authorization_revision,
        p_provider_thread_id: "t-retry",
        p_error_code: "rate_limit_exceeded",
        p_retry_after_seconds: 0,
        p_quota_units: 40,
        p_max_attempts: 5,
      });
      const outcome = res.data as { thread_failed: boolean; run_failed: boolean };
      const row = await runRow(client, run.runId);
      const thread = (await threadRows(client, run.runId))[0];

      if (attempt < 5) {
        expect([attempt, outcome.thread_failed, outcome.run_failed]).toEqual([
          attempt,
          false,
          false,
        ]);
        expect([attempt, row.status, thread.status]).toEqual([attempt, "runnable", "pending"]);
      } else {
        // ONE transaction moves both. There is no window in which the work item
        // can never succeed while the run still claims it might.
        expect([attempt, outcome.thread_failed, outcome.run_failed]).toEqual([attempt, true, true]);
        expect([attempt, row.status, thread.status]).toEqual([attempt, "failed", "failed"]);
        expect(row.completed_at).not.toBeNull();
      }
    }
  });

  it("D8. enumeration failure semantics are unchanged", async () => {
    const run = await startRun("a3-d8");
    const gmail = createFakeGmailRead({
      listErrors: [
        new GmailReadError({
          operation: "messages_list",
          status: 400,
          reason: "bad_request",
          retryable: false,
        }),
      ],
    });
    const outcome = await runImportUntilIdle(
      { userId: run.userId, runId: run.runId, maxSteps: 5 },
      importDeps(client, { gmail }),
    );
    expect(outcome).toEqual({ result: "failed", reason: "bad_request" });
    const row = await runRow(client, run.runId);
    expect(row.status).toBe("failed");
    expect(row.enumeration_attempt_count).toBe(1);
  });

  it("pending siblings survive as evidence, and are unclaimable", async () => {
    const run = await startRun("a3-d-siblings");
    const db = rpc(client);
    const first = await claimStep(run.userId, run.runId);
    await db.rpc("gmail_historical_import_commit_page", {
      p_user_id: run.userId,
      p_run_id: run.runId,
      p_lease_token: first.lease_token,
      p_expected_authorization_revision: first.authorization_revision,
      p_page_token_used: null,
      p_next_page_token: null,
      p_thread_ids: ["t-a", "t-b", "t-c"],
      p_sent_messages_seen: 3,
      p_quota_units: 5,
    });

    const gmail = createFakeGmailRead({ threads: {}, threadErrors: [permanent()] });
    await runImportUntilIdle(
      { userId: run.userId, runId: run.runId, maxSteps: 20 },
      importDeps(client, { gmail }),
    );

    const rows = await threadRows(client, run.runId);
    expect(rows.filter((r) => r.status === "failed")).toHaveLength(1);
    // The work that was never done is still on the record — a failed import that
    // erased its own outstanding queue would look tidier and say less.
    expect(rows.filter((r) => r.status === "pending")).toHaveLength(2);
    expect((await runRow(client, run.runId)).status).toBe("failed");
    // Exactly one provider call: the run went terminal and stopped handing out
    // leases rather than working through the rest.
    expect(gmail.calls.getThreadCalls).toBe(1);
  });
});
