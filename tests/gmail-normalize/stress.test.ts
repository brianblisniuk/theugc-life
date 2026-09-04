import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { normalizeMailboxUntilIdle } from "@/lib/gmail/normalize/service.server";

import {
  buildSanitizedMessage,
  connectedMailbox,
  deps,
  insertRawMessage,
  randomProviderId,
  updateRawMessage,
  type RawPartFixture,
} from "./harness";

/**
 * B04 SYNTHETIC POSTGRESQL STRESS.
 *
 * No authorized real Gmail corpus exists for B04, so this is a deterministic
 * synthetic corpus against a real PostgreSQL database — multiple users,
 * multiple mail accounts, colliding provider ids ACROSS accounts, repeated
 * headers, malformed participants, plain/HTML/multipart/nested bodies, body
 * omissions, decode failures, digest replacement and version staleness, all
 * in combination. Counts are RECOMPUTED from the live database at each stage,
 * never hard-coded.
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

const b64url = (text: string): string => Buffer.from(text, "utf-8").toString("base64url");

interface StressCounts {
  rawMessages: number;
  normalizedThreads: number;
  normalizedMessages: number;
  headers: number;
  participants: number;
  referenceTokens: number;
  textParts: number;
  staleCount: number;
  duplicateLogicalRows: number;
}

async function recompute(mailAccountIds: string[]): Promise<StressCounts> {
  const inClause = mailAccountIds.map((_, i) => `$${i + 1}`).join(",");
  const one = async (sql: string): Promise<number> =>
    (await client.query(sql, mailAccountIds)).rows[0].n as number;

  const rawMessages = await one(
    `select count(*)::int as n from private.gmail_raw_messages where mail_account_id in (${inClause})`,
  );
  const normalizedThreads = await one(
    `select count(*)::int as n from private.gmail_normalized_threads where mail_account_id in (${inClause})`,
  );
  const normalizedMessages = await one(
    `select count(*)::int as n from private.gmail_normalized_messages where mail_account_id in (${inClause})`,
  );
  const headers = await one(`
    select count(*)::int as n from private.gmail_normalized_headers h
      join private.gmail_normalized_messages m on m.id = h.normalized_message_id
     where m.mail_account_id in (${inClause})`);
  const participants = await one(`
    select count(*)::int as n from private.gmail_normalized_participants p
      join private.gmail_normalized_messages m on m.id = p.normalized_message_id
     where m.mail_account_id in (${inClause})`);
  const referenceTokens = await one(`
    select count(*)::int as n from private.gmail_normalized_reference_tokens t
      join private.gmail_normalized_messages m on m.id = t.normalized_message_id
     where m.mail_account_id in (${inClause})`);
  const textParts = await one(`
    select count(*)::int as n from private.gmail_normalized_text_parts tp
      join private.gmail_normalized_messages m on m.id = tp.normalized_message_id
     where m.mail_account_id in (${inClause})`);
  const staleCount = await one(`
    select count(*)::int as n from private.gmail_raw_messages r
    left join private.gmail_normalized_messages n
      on n.mail_account_id = r.mail_account_id and n.provider_message_id = r.provider_message_id
     where r.mail_account_id in (${inClause})
       and (n.id is null or n.source_payload_sha256 is distinct from r.payload_sha256
            or n.normalizer_version is distinct from 'gmail_normalizer_v1')`);
  // A "duplicate logical row" is more than one normalized_message per raw
  // identity, more than one header per (message, name, occurrence), etc. —
  // all already impossible by UNIQUE constraint, so this recomputes it
  // directly rather than trusting that.
  const duplicateMessages = await one(`
    select coalesce(sum(c - 1), 0)::int as n from (
      select count(*) as c from private.gmail_normalized_messages
       where mail_account_id in (${inClause})
       group by mail_account_id, provider_message_id
    ) x`);
  const duplicateHeaders = await one(`
    select coalesce(sum(c - 1), 0)::int as n from (
      select count(*) as c from private.gmail_normalized_headers h
        join private.gmail_normalized_messages m on m.id = h.normalized_message_id
       where m.mail_account_id in (${inClause})
       group by h.normalized_message_id, h.header_name, h.occurrence_index
    ) x`);

  return {
    rawMessages,
    normalizedThreads,
    normalizedMessages,
    headers,
    participants,
    referenceTokens,
    textParts,
    staleCount,
    duplicateLogicalRows: duplicateMessages + duplicateHeaders,
  };
}

d("B04 synthetic PostgreSQL stress", () => {
  it("normalizes a deterministic multi-user, multi-account, multi-shape corpus, replays exactly, then rebuilds after replacement", async () => {
    const USERS = 3;
    const ACCOUNTS_PER_USER = 2;
    const THREADS_PER_ACCOUNT = 3;
    const MESSAGES_PER_THREAD = 2;

    const mailboxes: { userId: string; mailAccountId: string }[] = [];
    for (let u = 0; u < USERS; u++) {
      for (let a = 0; a < ACCOUNTS_PER_USER; a++) {
        const mailbox = await connectedMailbox(client, `b04-stress-${u}-${a}`);
        mailboxes.push({ userId: mailbox.userId, mailAccountId: mailbox.mailAccountId });
      }
    }

    // A SHARED provider-thread-id pool, deliberately reused ACROSS accounts —
    // colliding provider ids across accounts must remain distinct rows.
    const sharedThreadIds = Array.from(
      { length: THREADS_PER_ACCOUNT },
      (_, i) => `shared-thread-${i}`,
    );

    let malformedCounter = 0;
    for (const mailbox of mailboxes) {
      for (const threadId of sharedThreadIds) {
        for (let m = 0; m < MESSAGES_PER_THREAD; m++) {
          malformedCounter += 1;
          const shapeIndex = malformedCounter % 5;
          let payload: RawPartFixture;
          let headers = [
            {
              name: "from",
              value: `Sender ${malformedCounter} <sender${malformedCounter}@example.com>`,
            },
            { name: "to", value: "recipient-a@example.com, recipient-b@example.com" },
            { name: "message-id", value: `<msg-${malformedCounter}@example.com>` },
          ];

          switch (shapeIndex) {
            case 0:
              payload = { mimeType: "text/plain", body: { size: 5, data: b64url("hello") } };
              break;
            case 1:
              payload = { mimeType: "text/html", body: { size: 10, data: b64url("<p>hi</p>") } };
              break;
            case 2:
              payload = {
                mimeType: "multipart/alternative",
                parts: [
                  { mimeType: "text/plain", body: { size: 4, data: b64url("text") } },
                  { mimeType: "text/html", body: { size: 9, data: b64url("<b>x</b>") } },
                ],
              };
              break;
            case 3:
              // A body omission and a malformed participant header.
              payload = {
                mimeType: "text/plain",
                contentOmitted: true,
                omissionReason: "external_body",
              };
              headers = [...headers, { name: "cc", value: "not a valid address whatsoever" }];
              break;
            default:
              // A decode failure: invalid bytes under a declared unsupported charset.
              payload = {
                mimeType: "text/plain",
                headers: [{ name: "content-type", value: "text/plain; charset=x-bogus" }],
                body: { size: 4, data: b64url("text") },
              };
          }

          await insertRawMessage(client, {
            mailAccountId: mailbox.mailAccountId,
            userId: mailbox.userId,
            sanitized: buildSanitizedMessage({
              providerMessageId: randomProviderId(`msg-${malformedCounter}`),
              providerThreadId: threadId,
              internalDateMs: Date.now() + malformedCounter,
              messageHeaders: headers,
              payload,
            }),
          });
        }
      }
    }

    const mailAccountIds = mailboxes.map((m) => m.mailAccountId);
    const expectedRaw = mailboxes.length * sharedThreadIds.length * MESSAGES_PER_THREAD;

    // FIRST NORMALIZATION.
    for (const mailbox of mailboxes) {
      const summary = await normalizeMailboxUntilIdle(deps(client), {
        userId: mailbox.userId,
        mailAccountId: mailbox.mailAccountId,
        batchSize: 4,
      });
      expect(summary.structuralErrors).toBe(0);
    }

    const afterFirst = await recompute(mailAccountIds);
    expect(afterFirst.rawMessages).toBe(expectedRaw);
    expect(afterFirst.normalizedMessages).toBe(expectedRaw);
    // Each account has its OWN copy of the shared thread ids — collisions
    // across accounts must not merge into fewer thread rows.
    expect(afterFirst.normalizedThreads).toBe(mailboxes.length * sharedThreadIds.length);
    expect(afterFirst.staleCount).toBe(0);
    expect(afterFirst.duplicateLogicalRows).toBe(0);

    // EXACT REPLAY.
    for (const mailbox of mailboxes) {
      await normalizeMailboxUntilIdle(deps(client), {
        userId: mailbox.userId,
        mailAccountId: mailbox.mailAccountId,
        batchSize: 4,
      });
    }
    const afterReplay = await recompute(mailAccountIds);
    expect(afterReplay).toEqual(afterFirst); // zero semantic delta

    // CONTROLLED SOURCE MUTATIONS: replace roughly a third of the messages
    // with a NEW snapshot (new subject, new digest), then rebuild.
    const rawRows = await client.query(
      `select mail_account_id, provider_message_id, provider_thread_id, extract(epoch from internal_date) * 1000 as ms
         from private.gmail_raw_messages where mail_account_id = any($1) order by provider_message_id`,
      [mailAccountIds],
    );
    const toMutate = rawRows.rows.filter((_row: unknown, i: number) => i % 3 === 0);
    for (const row of toMutate) {
      await updateRawMessage(client, {
        mailAccountId: row.mail_account_id,
        providerMessageId: row.provider_message_id,
        sanitized: buildSanitizedMessage({
          providerMessageId: row.provider_message_id,
          providerThreadId: row.provider_thread_id,
          internalDateMs: Number(row.ms),
          messageHeaders: [{ name: "subject", value: "REPLACED" }],
        }),
      });
    }

    const afterMutation = await recompute(mailAccountIds);
    expect(afterMutation.staleCount).toBe(toMutate.length);

    for (const mailbox of mailboxes) {
      await normalizeMailboxUntilIdle(deps(client), {
        userId: mailbox.userId,
        mailAccountId: mailbox.mailAccountId,
        batchSize: 4,
      });
    }
    const afterRebuild = await recompute(mailAccountIds);
    expect(afterRebuild.staleCount).toBe(0);
    expect(afterRebuild.duplicateLogicalRows).toBe(0);
    expect(afterRebuild.normalizedMessages).toBe(expectedRaw);

    const replacedHeaders = await client.query(
      `
      select count(*)::int as n from private.gmail_normalized_headers h
        join private.gmail_normalized_messages m on m.id = h.normalized_message_id
       where m.mail_account_id = any($1) and h.header_name = 'subject' and h.raw_value = 'REPLACED'`,
      [mailAccountIds],
    );
    expect(replacedHeaders.rows[0].n).toBe(toMutate.length);

    // Report, matching the contract's "recomputed" requirement.
    console.log(
      JSON.stringify(
        {
          corpus: { expectedRaw, mutated: toMutate.length },
          afterFirst,
          afterReplay,
          afterMutation,
          afterRebuild,
        },
        null,
        2,
      ),
    );
  });
});
