import { Client } from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { GMAIL_NORMALIZER_VERSION } from "@/lib/gmail/normalize/contract";

import {
  buildSanitizedMessage,
  connectedMailbox,
  insertRawMessage,
  normalizedMessageRow,
  randomProviderId,
} from "./harness";

/**
 * B04 TRUE MULTI-SESSION CONCURRENCY.
 *
 * `gmail_normalize_commit_message` takes a short `for no key update` lock on
 * the EXACT raw row it is normalizing, held only for the duration of that one
 * function call. These tests prove REAL PostgreSQL lock contention with
 * `pg_blocking_pids` — never a sleep-based timing guess — for:
 *
 *   C1. two normalizers competing for the same source
 *   C2. a normalizer's source lock vs a concurrent raw source update
 *   C3. a raw source update vs a normalizer (the other ordering)
 */

const TEST_DB = process.env.TEST_DATABASE_URL;
const d = describe.skipIf(!TEST_DB);

let client: Client;
const openSessions: Client[] = [];

beforeAll(async () => {
  if (!TEST_DB) return;
  client = new Client({ connectionString: TEST_DB });
  await client.connect();
});

afterEach(async () => {
  while (openSessions.length > 0) {
    const c = openSessions.pop()!;
    await c.end().catch(() => undefined);
  }
});

afterAll(async () => {
  if (client) await client.end();
});

async function session(): Promise<Client> {
  const c = new Client({ connectionString: TEST_DB });
  await c.connect();
  openSessions.push(c);
  return c;
}

const backendPid = async (c: Client): Promise<number> =>
  Number((await c.query("select pg_backend_pid() as pid")).rows[0].pid);

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

function minimalHeaders() {
  return [{ header_name: "subject", occurrence_index: 0, global_order: 0, raw_value: "hi" }];
}

/** Issue `gmail_normalize_commit_message` as a raw query the test controls the commit point of. */
async function beginCommit(
  c: Client,
  input: {
    userId: string;
    mailAccountId: string;
    providerMessageId: string;
    expectedDigest: string;
  },
) {
  await c.query("begin");
  return c.query(
    `select public.gmail_normalize_commit_message(
       p_user_id := $1, p_mail_account_id := $2, p_provider_message_id := $3,
       p_expected_source_payload_sha256 := $4, p_normalizer_version := $5,
       p_headers := $6::jsonb, p_participants := '[]'::jsonb,
       p_reference_tokens := '[]'::jsonb, p_text_parts := '[]'::jsonb
     ) as result`,
    [
      input.userId,
      input.mailAccountId,
      input.providerMessageId,
      input.expectedDigest,
      GMAIL_NORMALIZER_VERSION,
      JSON.stringify(minimalHeaders()),
    ],
  );
}

d("B04 true multi-session concurrency", () => {
  it("C1. two normalizers competing for the same source converge to one projection", async () => {
    const mailbox = await connectedMailbox(client, "b04-conc-c1");
    const messageId = randomProviderId("msg");
    const { payloadSha256 } = await insertRawMessage(client, {
      mailAccountId: mailbox.mailAccountId,
      userId: mailbox.userId,
      sanitized: buildSanitizedMessage({
        providerMessageId: messageId,
        providerThreadId: randomProviderId("thread"),
        internalDateMs: Date.now(),
      }),
    });

    const n1 = await session();
    const n2 = await session();
    const n2Pid = await backendPid(n2);

    const p1 = beginCommit(n1, {
      userId: mailbox.userId,
      mailAccountId: mailbox.mailAccountId,
      providerMessageId: messageId,
      expectedDigest: payloadSha256,
    });

    // n1 must actually hold the row lock before n2 starts, or the race is not real.
    await new Promise((resolve) => setTimeout(resolve, 50));

    const p2 = beginCommit(n2, {
      userId: mailbox.userId,
      mailAccountId: mailbox.mailAccountId,
      providerMessageId: messageId,
      expectedDigest: payloadSha256,
    });

    const blockers = await waitUntilBlocked(n2Pid);
    expect(blockers.length).toBeGreaterThan(0);

    await p1;
    await n1.query("commit");
    const r2 = await p2;
    await n2.query("commit");

    // n2 waited for n1's lock, then re-read the raw row inside its OWN lock and
    // found a current projection already sitting there — `already_current`,
    // not `ok`, and either is a correct convergent outcome: what matters is
    // that no duplicate row was produced (checked below).
    expect(["ok", "already_current"]).toContain(r2.rows[0].result.result);

    const row = await normalizedMessageRow(client, mailbox.mailAccountId, messageId);
    expect(row).toBeTruthy();

    const dupes = await client.query(
      "select count(*)::int as n from private.gmail_normalized_messages where mail_account_id = $1 and provider_message_id = $2",
      [mailbox.mailAccountId, messageId],
    );
    expect(dupes.rows[0].n).toBe(1);

    const headerDupes = await client.query(
      "select count(*)::int as n from private.gmail_normalized_headers where normalized_message_id = $1",
      [row.id],
    );
    expect(headerDupes.rows[0].n).toBe(1); // not 2 — n2's redundant work did not double-insert
  });

  it("C2. a normalizer's source lock blocks a concurrent raw update, which then invalidates it", async () => {
    const mailbox = await connectedMailbox(client, "b04-conc-c2");
    const messageId = randomProviderId("msg");
    const threadId = randomProviderId("thread");
    const { payloadSha256 } = await insertRawMessage(client, {
      mailAccountId: mailbox.mailAccountId,
      userId: mailbox.userId,
      sanitized: buildSanitizedMessage({
        providerMessageId: messageId,
        providerThreadId: threadId,
        internalDateMs: Date.now(),
      }),
    });

    const normalizer = await session();
    const rawUpdater = await session();
    const updaterPid = await backendPid(rawUpdater);

    const commitPromise = beginCommit(normalizer, {
      userId: mailbox.userId,
      mailAccountId: mailbox.mailAccountId,
      providerMessageId: messageId,
      expectedDigest: payloadSha256,
    });
    await new Promise((resolve) => setTimeout(resolve, 50));

    await rawUpdater.query("begin");
    const updatePromise = rawUpdater.query(
      `update private.gmail_raw_messages
          set sanitized_payload = $3, payload_sha256 = $4, last_seen_at = now()
        where mail_account_id = $1 and provider_message_id = $2`,
      [
        mailbox.mailAccountId,
        messageId,
        JSON.stringify(
          buildSanitizedMessage({
            providerMessageId: messageId,
            providerThreadId: threadId,
            internalDateMs: Date.now(),
            messageHeaders: [{ name: "subject", value: "BBB" }],
          }),
        ),
        "b".repeat(64),
      ],
    );

    // PROVE REAL SERIALIZATION: the raw update genuinely waits on the normalizer's lock.
    const blockers = await waitUntilBlocked(updaterPid);
    expect(blockers.length).toBeGreaterThan(0);

    await commitPromise;
    await normalizer.query("commit"); // normalizer wins the lock first, commits AAA

    await updatePromise;
    await rawUpdater.query("commit"); // then the raw update proceeds and invalidates AAA

    // AAA must not survive: the update's own AFTER UPDATE trigger deleted it
    // before the update transaction committed.
    const row = await normalizedMessageRow(client, mailbox.mailAccountId, messageId);
    expect(row).toBeNull();
  });

  it("C3. a raw update holding the row blocks a concurrent normalizer, which then observes BBB", async () => {
    const mailbox = await connectedMailbox(client, "b04-conc-c3");
    const messageId = randomProviderId("msg");
    const threadId = randomProviderId("thread");
    const { payloadSha256: aaaSha } = await insertRawMessage(client, {
      mailAccountId: mailbox.mailAccountId,
      userId: mailbox.userId,
      sanitized: buildSanitizedMessage({
        providerMessageId: messageId,
        providerThreadId: threadId,
        internalDateMs: Date.now(),
      }),
    });

    const rawUpdater = await session();
    const normalizer = await session();
    const normalizerPid = await backendPid(normalizer);

    await rawUpdater.query("begin");
    await rawUpdater.query(
      `select mail_account_id from private.gmail_raw_messages
        where mail_account_id = $1 and provider_message_id = $2 for no key update`,
      [mailbox.mailAccountId, messageId],
    );

    // The normalizer starts AGAINST THE OLD DIGEST while the raw updater
    // already holds the row lock.
    const commitPromise = beginCommit(normalizer, {
      userId: mailbox.userId,
      mailAccountId: mailbox.mailAccountId,
      providerMessageId: messageId,
      expectedDigest: aaaSha,
    });

    const blockers = await waitUntilBlocked(normalizerPid);
    expect(blockers.length).toBeGreaterThan(0);

    const bbbSha = "c".repeat(64);
    await rawUpdater.query(
      `update private.gmail_raw_messages
          set sanitized_payload = $3, payload_sha256 = $4, last_seen_at = now()
        where mail_account_id = $1 and provider_message_id = $2`,
      [
        mailbox.mailAccountId,
        messageId,
        JSON.stringify(
          buildSanitizedMessage({
            providerMessageId: messageId,
            providerThreadId: threadId,
            internalDateMs: Date.now(),
          }),
        ),
        bbbSha,
      ],
    );
    await rawUpdater.query("commit"); // raw update wins the lock first

    const result = await commitPromise;
    await normalizer.query("commit");

    // THE NORMALIZER MUST OBSERVE THE NEW DIGEST, NOT THE OLD ONE: its
    // expected-digest CAS refuses rather than binding a projection to a
    // snapshot that no longer exists as current.
    const parsed = result.rows[0].result as { result: string; current_payload_sha256?: string };
    expect(parsed.result).toBe("stale_source");
    expect(parsed.current_payload_sha256).toBe(bbbSha);

    const row = await normalizedMessageRow(client, mailbox.mailAccountId, messageId);
    expect(row).toBeNull();
  });
});
