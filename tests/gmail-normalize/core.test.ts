import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { GMAIL_NORMALIZER_VERSION } from "@/lib/gmail/normalize/contract";
import { normalizeBatch, normalizeOneCandidate } from "@/lib/gmail/normalize/service.server";

import {
  buildSanitizedMessage,
  connectedMailbox,
  deps,
  headersOf,
  insertRawMessage,
  normalizedMessageRow,
  normalizedThreadRow,
  participantsOf,
  randomProviderId,
  referenceTokensOf,
  rpcRaw,
  textPartsOf,
  updateRawMessage,
} from "./harness";

/**
 * B04 CORE: identity, provenance, normalizer versioning, source-replacement
 * invalidation and exact-replay idempotency.
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

async function normalizeAll(mailAccountId: string, userId: string) {
  return normalizeBatch(deps(client), { userId, mailAccountId, limit: 100 });
}

d("B04 core: identity, provenance, versioning, replay, invalidation", () => {
  it("1. one account + one thread + one plain message normalizes", async () => {
    const mailbox = await connectedMailbox(client, "b04-core-1");
    const threadId = randomProviderId("thread");
    const messageId = randomProviderId("msg");
    const sanitized = buildSanitizedMessage({
      providerMessageId: messageId,
      providerThreadId: threadId,
      internalDateMs: Date.now(),
    });
    await insertRawMessage(client, {
      mailAccountId: mailbox.mailAccountId,
      userId: mailbox.userId,
      sanitized,
    });

    const summary = await normalizeAll(mailbox.mailAccountId, mailbox.userId);
    expect(summary.committed).toBe(1);

    const thread = await normalizedThreadRow(client, mailbox.mailAccountId, threadId);
    const message = await normalizedMessageRow(client, mailbox.mailAccountId, messageId);
    expect(thread).toBeTruthy();
    expect(message).toBeTruthy();
    expect(message.normalized_thread_id).toBe(thread.id);
  });

  it("2. one thread + multiple messages normalizes", async () => {
    const mailbox = await connectedMailbox(client, "b04-core-2");
    const threadId = randomProviderId("thread");
    const m1 = randomProviderId("msg");
    const m2 = randomProviderId("msg");
    for (const id of [m1, m2]) {
      await insertRawMessage(client, {
        mailAccountId: mailbox.mailAccountId,
        userId: mailbox.userId,
        sanitized: buildSanitizedMessage({
          providerMessageId: id,
          providerThreadId: threadId,
          internalDateMs: Date.now(),
        }),
      });
    }

    const summary = await normalizeAll(mailbox.mailAccountId, mailbox.userId);
    expect(summary.committed).toBe(2);

    const res = await client.query(
      "select count(*)::int as n from private.gmail_normalized_threads where mail_account_id = $1 and provider_thread_id = $2",
      [mailbox.mailAccountId, threadId],
    );
    expect(res.rows[0].n).toBe(1);
  });

  it("3. same provider_thread_id under two mail accounts does not collide", async () => {
    const threadId = randomProviderId("thread");
    const mailboxA = await connectedMailbox(client, "b04-core-3a");
    const mailboxB = await connectedMailbox(client, "b04-core-3b");

    for (const mailbox of [mailboxA, mailboxB]) {
      await insertRawMessage(client, {
        mailAccountId: mailbox.mailAccountId,
        userId: mailbox.userId,
        sanitized: buildSanitizedMessage({
          providerMessageId: randomProviderId("msg"),
          providerThreadId: threadId,
          internalDateMs: Date.now(),
        }),
      });
      await normalizeAll(mailbox.mailAccountId, mailbox.userId);
    }

    const threadA = await normalizedThreadRow(client, mailboxA.mailAccountId, threadId);
    const threadB = await normalizedThreadRow(client, mailboxB.mailAccountId, threadId);
    expect(threadA.id).not.toBe(threadB.id);
  });

  it("4. same provider_message_id under two mail accounts does not collide", async () => {
    const messageId = randomProviderId("msg");
    const mailboxA = await connectedMailbox(client, "b04-core-4a");
    const mailboxB = await connectedMailbox(client, "b04-core-4b");

    for (const mailbox of [mailboxA, mailboxB]) {
      await insertRawMessage(client, {
        mailAccountId: mailbox.mailAccountId,
        userId: mailbox.userId,
        sanitized: buildSanitizedMessage({
          providerMessageId: messageId,
          providerThreadId: randomProviderId("thread"),
          internalDateMs: Date.now(),
        }),
      });
      await normalizeAll(mailbox.mailAccountId, mailbox.userId);
    }

    const msgA = await normalizedMessageRow(client, mailboxA.mailAccountId, messageId);
    const msgB = await normalizedMessageRow(client, mailboxB.mailAccountId, messageId);
    expect(msgA.id).not.toBe(msgB.id);
    expect(msgA.mail_account_id).toBe(mailboxA.mailAccountId);
    expect(msgB.mail_account_id).toBe(mailboxB.mailAccountId);
  });

  it("5. cross-account normalized-message -> raw provenance is rejected", async () => {
    const mailboxA = await connectedMailbox(client, "b04-core-5a");
    const mailboxB = await connectedMailbox(client, "b04-core-5b");
    const messageId = randomProviderId("msg");
    const threadId = randomProviderId("thread");

    // A raw row exists only under mailbox A.
    await insertRawMessage(client, {
      mailAccountId: mailboxA.mailAccountId,
      userId: mailboxA.userId,
      sanitized: buildSanitizedMessage({
        providerMessageId: messageId,
        providerThreadId: threadId,
        internalDateMs: Date.now(),
      }),
    });

    // A thread row for mailbox B, so only the raw-provenance FK is under test.
    await client.query(
      `insert into private.gmail_normalized_threads (user_id, mail_account_id, provider_thread_id)
       values ($1, $2, $3)`,
      [mailboxB.userId, mailboxB.mailAccountId, threadId],
    );
    const threadB = await normalizedThreadRow(client, mailboxB.mailAccountId, threadId);

    await expect(
      client.query(
        `insert into private.gmail_normalized_messages
           (user_id, mail_account_id, normalized_thread_id, provider_message_id, internal_date,
            provider_sent, source_payload_sha256, normalizer_version)
         values ($1, $2, $3, $4, now(), true, $5, $6)`,
        [
          mailboxB.userId,
          mailboxB.mailAccountId,
          threadB.id,
          messageId,
          "a".repeat(64),
          GMAIL_NORMALIZER_VERSION,
        ],
      ),
    ).rejects.toThrow(/foreign key/i);
  });

  it("6. cross-account normalized-message -> thread provenance is rejected", async () => {
    const mailboxA = await connectedMailbox(client, "b04-core-6a");
    const mailboxB = await connectedMailbox(client, "b04-core-6b");
    const threadId = randomProviderId("thread");
    const messageId = randomProviderId("msg");

    // A thread row exists only under mailbox A.
    await client.query(
      `insert into private.gmail_normalized_threads (user_id, mail_account_id, provider_thread_id)
       values ($1, $2, $3)`,
      [mailboxA.userId, mailboxA.mailAccountId, threadId],
    );
    const threadA = await normalizedThreadRow(client, mailboxA.mailAccountId, threadId);

    // A raw row for mailbox B, so only the thread FK is under test.
    await insertRawMessage(client, {
      mailAccountId: mailboxB.mailAccountId,
      userId: mailboxB.userId,
      sanitized: buildSanitizedMessage({
        providerMessageId: messageId,
        providerThreadId: randomProviderId("thread"),
        internalDateMs: Date.now(),
      }),
    });

    await expect(
      client.query(
        `insert into private.gmail_normalized_messages
           (user_id, mail_account_id, normalized_thread_id, provider_message_id, internal_date,
            provider_sent, source_payload_sha256, normalizer_version)
         values ($1, $2, $3, $4, now(), true, $5, $6)`,
        [
          mailboxB.userId,
          mailboxB.mailAccountId,
          threadA.id,
          messageId,
          "a".repeat(64),
          GMAIL_NORMALIZER_VERSION,
        ],
      ),
    ).rejects.toThrow(/foreign key/i);
  });

  it("7-8. normalized message records exact source digest and normalizer version", async () => {
    const mailbox = await connectedMailbox(client, "b04-core-7");
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

    await normalizeAll(mailbox.mailAccountId, mailbox.userId);
    const message = await normalizedMessageRow(client, mailbox.mailAccountId, messageId);
    expect(message.source_payload_sha256).toBe(payloadSha256);
    expect(message.normalizer_version).toBe(GMAIL_NORMALIZER_VERSION);
  });

  it("9-14. exact replay produces zero duplicates and no unnecessary rewrite", async () => {
    const mailbox = await connectedMailbox(client, "b04-core-9");
    const messageId = randomProviderId("msg");
    await insertRawMessage(client, {
      mailAccountId: mailbox.mailAccountId,
      userId: mailbox.userId,
      sanitized: buildSanitizedMessage({
        providerMessageId: messageId,
        providerThreadId: randomProviderId("thread"),
        internalDateMs: Date.now(),
        messageHeaders: [
          { name: "from", value: "Alice <alice@example.com>" },
          { name: "to", value: "Bob <bob@example.com>" },
          { name: "message-id", value: "<m1@example.com>" },
        ],
      }),
    });

    const first = await normalizeAll(mailbox.mailAccountId, mailbox.userId);
    expect(first.committed).toBe(1);

    const before = await normalizedMessageRow(client, mailbox.mailAccountId, messageId);
    const beforeHeaders = await headersOf(client, before.id);
    const beforeParticipants = await participantsOf(client, before.id);
    const beforeTokens = await referenceTokensOf(client, before.id);
    const beforeParts = await textPartsOf(client, before.id);

    await new Promise((resolve) => setTimeout(resolve, 5));
    const second = await normalizeAll(mailbox.mailAccountId, mailbox.userId);
    expect(second.candidatesFound).toBe(0); // already current: not even offered as a candidate

    const after = await normalizedMessageRow(client, mailbox.mailAccountId, messageId);
    expect(after.id).toBe(before.id);
    expect(after.updated_at).toEqual(before.updated_at);
    expect(after.normalized_at).toEqual(before.normalized_at);

    expect((await headersOf(client, after.id)).length).toBe(beforeHeaders.length);
    expect((await participantsOf(client, after.id)).length).toBe(beforeParticipants.length);
    expect((await referenceTokensOf(client, after.id)).length).toBe(beforeTokens.length);
    expect((await textPartsOf(client, after.id)).length).toBe(beforeParts.length);

    // Calling the commit RPC directly with the same digest is ALSO a no-op,
    // not merely "not offered as a candidate again" by the candidate list.
    // This bypasses `gmail_normalize_list_candidates` entirely, so it is the
    // ONLY thing proving the commit function's OWN already-current
    // short-circuit, not just the listing filter upstream of it.
    const direct = await rpcRaw(client, "gmail_normalize_list_candidates", {
      p_user_id: mailbox.userId,
      p_mail_account_id: mailbox.mailAccountId,
      p_normalizer_version: "gmail_normalizer_v1",
      p_limit: 1,
      p_provider_message_id: messageId,
    });
    expect(direct.candidates).toHaveLength(0);

    const directCommit = await rpcRaw(client, "gmail_normalize_commit_message", {
      p_user_id: mailbox.userId,
      p_mail_account_id: mailbox.mailAccountId,
      p_provider_message_id: messageId,
      p_expected_source_payload_sha256: before.source_payload_sha256,
      p_normalizer_version: "gmail_normalizer_v1",
      p_headers: [],
      p_participants: [],
      p_reference_tokens: [],
      p_text_parts: [],
    });
    expect(directCommit.result).toBe("already_current");
    expect(directCommit.normalized_message_id).toBe(before.id);
    const afterDirect = await normalizedMessageRow(client, mailbox.mailAccountId, messageId);
    expect(afterDirect.id).toBe(before.id);
    expect(afterDirect.normalized_at).toEqual(before.normalized_at);
  });

  it("15-18. raw digest AAA -> BBB invalidates the old projection atomically and rebuild binds only BBB", async () => {
    const mailbox = await connectedMailbox(client, "b04-core-15");
    const messageId = randomProviderId("msg");
    const threadId = randomProviderId("thread");
    await insertRawMessage(client, {
      mailAccountId: mailbox.mailAccountId,
      userId: mailbox.userId,
      sanitized: buildSanitizedMessage({
        providerMessageId: messageId,
        providerThreadId: threadId,
        internalDateMs: Date.now(),
        messageHeaders: [{ name: "subject", value: "AAA subject" }],
      }),
    });

    await normalizeAll(mailbox.mailAccountId, mailbox.userId);
    const aaa = await normalizedMessageRow(client, mailbox.mailAccountId, messageId);
    expect(aaa.source_payload_sha256).toBeTruthy();
    const aaaHeaders = await headersOf(client, aaa.id);
    expect(aaaHeaders.some((h: { raw_value: string }) => h.raw_value === "AAA subject")).toBe(true);

    // B03-style raw update: same identity, new snapshot.
    const { payloadSha256: bbbSha } = await updateRawMessage(client, {
      mailAccountId: mailbox.mailAccountId,
      providerMessageId: messageId,
      sanitized: buildSanitizedMessage({
        providerMessageId: messageId,
        providerThreadId: threadId,
        internalDateMs: Date.now(),
        messageHeaders: [{ name: "subject", value: "BBB subject" }],
      }),
    });

    // ATOMICALLY, in the SAME transaction as the raw update: the AAA
    // projection (and every child row) is gone. No extra normalize call.
    const goneRow = await normalizedMessageRow(client, mailbox.mailAccountId, messageId);
    expect(goneRow).toBeNull();
    const orphanedHeaders = await client.query(
      "select count(*)::int as n from private.gmail_normalized_headers where normalized_message_id = $1",
      [aaa.id],
    );
    expect(orphanedHeaders.rows[0].n).toBe(0);

    // Rebuild binds only BBB.
    await normalizeAll(mailbox.mailAccountId, mailbox.userId);
    const bbb = await normalizedMessageRow(client, mailbox.mailAccountId, messageId);
    expect(bbb.id).not.toBe(aaa.id);
    expect(bbb.source_payload_sha256).toBe(bbbSha);
    const bbbHeaders = await headersOf(client, bbb.id);
    expect(bbbHeaders.some((h: { raw_value: string }) => h.raw_value === "BBB subject")).toBe(true);
    expect(bbbHeaders.some((h: { raw_value: string }) => h.raw_value === "AAA subject")).toBe(
      false,
    );
  });

  it("19. normalizer-version mismatch makes the row stale and rebuildable", async () => {
    const mailbox = await connectedMailbox(client, "b04-core-19");
    const messageId = randomProviderId("msg");
    await insertRawMessage(client, {
      mailAccountId: mailbox.mailAccountId,
      userId: mailbox.userId,
      sanitized: buildSanitizedMessage({
        providerMessageId: messageId,
        providerThreadId: randomProviderId("thread"),
        internalDateMs: Date.now(),
      }),
    });
    await normalizeAll(mailbox.mailAccountId, mailbox.userId);
    const current = await normalizedMessageRow(client, mailbox.mailAccountId, messageId);

    // Simulate a row left over from an OLDER normalizer version.
    await client.query(
      "update private.gmail_normalized_messages set normalizer_version = 'gmail_normalizer_v0' where id = $1",
      [current.id],
    );

    const candidates = await rpcRaw(client, "gmail_normalize_list_candidates", {
      p_user_id: mailbox.userId,
      p_mail_account_id: mailbox.mailAccountId,
      p_normalizer_version: "gmail_normalizer_v1",
      p_limit: 10,
      p_provider_message_id: messageId,
    });
    expect(candidates.candidates).toHaveLength(1);

    await normalizeAll(mailbox.mailAccountId, mailbox.userId);
    const rebuilt = await normalizedMessageRow(client, mailbox.mailAccountId, messageId);
    expect(rebuilt.normalizer_version).toBe("gmail_normalizer_v1");
  });

  it("23. forced mid-normalization failure leaves no mixed partial projection", async () => {
    const mailbox = await connectedMailbox(client, "b04-core-23");
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

    // A participant naming a header occurrence that does not exist on this
    // message is severe enough to fail the whole commit atomically.
    const result = await rpcRaw(client, "gmail_normalize_commit_message", {
      p_user_id: mailbox.userId,
      p_mail_account_id: mailbox.mailAccountId,
      p_provider_message_id: messageId,
      p_expected_source_payload_sha256: payloadSha256,
      p_normalizer_version: "gmail_normalizer_v1",
      p_headers: [
        { header_name: "subject", occurrence_index: 0, global_order: 0, raw_value: "hi" },
      ],
      p_participants: [
        {
          source_header_name: "from",
          source_header_occurrence_index: 0,
          header_role: "from",
          participant_order: 0,
          display_name: null,
          addr_spec: "ghost@example.com",
          local_part: "ghost",
          domain: "example.com",
          domain_lower: "example.com",
          raw_fragment: null,
          parse_status: "parsed",
        },
      ],
      p_reference_tokens: [],
      p_text_parts: [],
    }).catch((error: Error) => ({ error }));

    expect((result as { error?: Error }).error).toBeTruthy();

    const row = await normalizedMessageRow(client, mailbox.mailAccountId, messageId);
    expect(row).toBeNull();
  });
});
