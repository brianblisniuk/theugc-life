import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { normalizeBatch } from "@/lib/gmail/normalize/service";

import {
  buildSanitizedMessage,
  connectedMailbox,
  deps,
  insertRawMessage,
  normalizedMessageRow,
  randomProviderId,
  rpcRaw,
} from "./harness";

/**
 * B04 DIRECT DB INVARIANTS: uniqueness constraints proven by attempting to
 * violate them with a direct SQL statement, and the "rollback leaves the
 * PREVIOUS valid projection, never a mixed partial one" proof for a rebuild
 * that fails midway against an EXISTING current row.
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

async function normalizedOf(
  mailAccountId: string,
  userId: string,
  messageHeaders: { name: string; value: string }[],
) {
  const messageId = randomProviderId("msg");
  await insertRawMessage(client, {
    mailAccountId,
    userId,
    sanitized: buildSanitizedMessage({
      providerMessageId: messageId,
      providerThreadId: randomProviderId("thread"),
      internalDateMs: Date.now(),
      messageHeaders,
    }),
  });
  await normalizeBatch(deps(client), { userId, mailAccountId, limit: 10 });
  return normalizedMessageRow(client, mailAccountId, messageId);
}

d("B04 DB invariants: direct uniqueness violations", () => {
  it("7. header source order/identity cannot duplicate inside a message", async () => {
    const mailbox = await connectedMailbox(client, "b04-inv-7");
    const message = await normalizedOf(mailbox.mailAccountId, mailbox.userId, [
      { name: "subject", value: "hi" },
    ]);
    await expect(
      client.query(
        `insert into private.gmail_normalized_headers
           (normalized_message_id, header_name, occurrence_index, global_order, raw_value)
         values ($1, 'subject', 0, 99, 'duplicate occurrence')`,
        [message.id],
      ),
    ).rejects.toThrow(/duplicate key|unique/i);
  });

  it("8. participant order cannot duplicate inside one source header", async () => {
    const mailbox = await connectedMailbox(client, "b04-inv-8");
    const message = await normalizedOf(mailbox.mailAccountId, mailbox.userId, [
      { name: "to", value: "a@example.com, b@example.com" },
    ]);
    const header = await client.query(
      "select id from private.gmail_normalized_headers where normalized_message_id = $1 and header_name = 'to'",
      [message.id],
    );
    await expect(
      client.query(
        `insert into private.gmail_normalized_participants
           (normalized_message_id, source_header_id, header_role, participant_order, parse_status, addr_spec)
         values ($1, $2, 'to', 0, 'parsed', 'duplicate@example.com')`,
        [message.id, header.rows[0].id],
      ),
    ).rejects.toThrow(/duplicate key|unique/i);
  });

  it("9. reference token order cannot duplicate inside one source header", async () => {
    const mailbox = await connectedMailbox(client, "b04-inv-9");
    const message = await normalizedOf(mailbox.mailAccountId, mailbox.userId, [
      { name: "references", value: "<a@example.com> <b@example.com>" },
    ]);
    const header = await client.query(
      "select id from private.gmail_normalized_headers where normalized_message_id = $1 and header_name = 'references'",
      [message.id],
    );
    await expect(
      client.query(
        `insert into private.gmail_normalized_reference_tokens
           (normalized_message_id, source_header_id, header_role, token_order, raw_token, parse_status)
         values ($1, $2, 'references', 0, '<duplicate@example.com>', 'valid_msgid')`,
        [message.id, header.rows[0].id],
      ),
    ).rejects.toThrow(/duplicate key|unique/i);
  });

  it("10. text-part structural path cannot duplicate inside one message", async () => {
    const mailbox = await connectedMailbox(client, "b04-inv-10");
    const message = await normalizedOf(mailbox.mailAccountId, mailbox.userId, []);
    await expect(
      client.query(
        `insert into private.gmail_normalized_text_parts
           (normalized_message_id, part_path, mime_type, body_data_present, decode_status)
         values ($1, '{}', 'text/plain', false, 'body_absent')`,
        [message.id],
      ),
    ).rejects.toThrow(/duplicate key|unique/i);
  });

  it("23b. a failed REBUILD leaves the PREVIOUS valid projection intact, never a mixed partial one", async () => {
    const mailbox = await connectedMailbox(client, "b04-inv-23b");
    const messageId = randomProviderId("msg");
    const { payloadSha256 } = await insertRawMessage(client, {
      mailAccountId: mailbox.mailAccountId,
      userId: mailbox.userId,
      sanitized: buildSanitizedMessage({
        providerMessageId: messageId,
        providerThreadId: randomProviderId("thread"),
        internalDateMs: Date.now(),
        messageHeaders: [{ name: "subject", value: "original" }],
      }),
    });
    await normalizeBatch(deps(client), {
      userId: mailbox.userId,
      mailAccountId: mailbox.mailAccountId,
      limit: 10,
    });
    const original = await normalizedMessageRow(client, mailbox.mailAccountId, messageId);
    const originalHeaders = await client.query(
      "select raw_value from private.gmail_normalized_headers where normalized_message_id = $1",
      [original.id],
    );

    // Force a rebuild attempt (different declared version, so the
    // already-current short-circuit does not apply) that fails mid-write via
    // a participant naming a nonexistent header occurrence.
    await expect(
      rpcRaw(client, "gmail_normalize_commit_message", {
        p_user_id: mailbox.userId,
        p_mail_account_id: mailbox.mailAccountId,
        p_provider_message_id: messageId,
        p_expected_source_payload_sha256: payloadSha256,
        p_normalizer_version: "gmail_normalizer_v2_test",
        p_headers: [
          { header_name: "subject", occurrence_index: 0, global_order: 0, raw_value: "rebuilt" },
        ],
        p_participants: [
          {
            source_header_name: "from",
            source_header_occurrence_index: 0,
            header_role: "from",
            participant_order: 0,
            addr_spec: "ghost@example.com",
            parse_status: "parsed",
          },
        ],
        p_reference_tokens: [],
        p_text_parts: [],
      }),
    ).rejects.toThrow();

    // The ORIGINAL row must still exist, unchanged, by the SAME id — the
    // failed rebuild's delete-then-insert was rolled back as one unit.
    const after = await normalizedMessageRow(client, mailbox.mailAccountId, messageId);
    expect(after).toBeTruthy();
    expect(after.id).toBe(original.id);
    expect(after.normalizer_version).toBe("gmail_normalizer_v1");
    const afterHeaders = await client.query(
      "select raw_value from private.gmail_normalized_headers where normalized_message_id = $1",
      [after.id],
    );
    expect(afterHeaders.rows).toEqual(originalHeaders.rows);
  });

  // --- EXTERNAL AUDIT AMENDMENT #1, Finding 2 -----------------------------
  // `header_role` was previously read straight out of the caller's jsonb,
  // independently of the `source_header_name` used for the JOIN. A caller
  // could submit `source_header_name: 'from'` alongside `header_role: 'to'`
  // and have BOTH values persist, because each satisfied its own CHECK in
  // isolation. The fix derives `header_role` from the MATCHED header row's
  // own `header_name` — there is no second value left to disagree.

  it("Finding 2 (participants): a caller-supplied header_role contradicting source_header_name is IGNORED, not persisted", async () => {
    const mailbox = await connectedMailbox(client, "b04-f2-participants");
    const messageId = randomProviderId("msg");
    const { payloadSha256 } = await insertRawMessage(client, {
      mailAccountId: mailbox.mailAccountId,
      userId: mailbox.userId,
      sanitized: buildSanitizedMessage({
        providerMessageId: messageId,
        providerThreadId: randomProviderId("thread"),
        internalDateMs: Date.now(),
        messageHeaders: [{ name: "from", value: "a@example.com" }],
      }),
    });

    const result = await rpcRaw(client, "gmail_normalize_commit_message", {
      p_user_id: mailbox.userId,
      p_mail_account_id: mailbox.mailAccountId,
      p_provider_message_id: messageId,
      p_expected_source_payload_sha256: payloadSha256,
      p_normalizer_version: "gmail_normalizer_v1",
      p_headers: [
        { header_name: "from", occurrence_index: 0, global_order: 0, raw_value: "a@example.com" },
      ],
      p_participants: [
        {
          source_header_name: "from",
          source_header_occurrence_index: 0,
          // A deliberately CONTRADICTORY role. The RPC must not persist it.
          header_role: "to",
          participant_order: 0,
          addr_spec: "a@example.com",
          parse_status: "parsed",
        },
      ],
      p_reference_tokens: [],
      p_text_parts: [],
    });
    expect(result.result).toBe("ok");

    const row = await client.query(
      `select p.header_role, h.header_name as source_header_name
         from private.gmail_normalized_participants p
         join private.gmail_normalized_headers h on h.id = p.source_header_id
        where p.normalized_message_id = $1`,
      [result.normalized_message_id],
    );
    expect(row.rows).toHaveLength(1);
    // The persisted role is the header's OWN name, never the caller's "to".
    expect(row.rows[0].header_role).toBe("from");
    expect(row.rows[0].source_header_name).toBe("from");
  });

  it("Finding 2 (reference tokens): a caller-supplied header_role contradicting source_header_name is IGNORED, not persisted", async () => {
    const mailbox = await connectedMailbox(client, "b04-f2-reftokens");
    const messageId = randomProviderId("msg");
    const { payloadSha256 } = await insertRawMessage(client, {
      mailAccountId: mailbox.mailAccountId,
      userId: mailbox.userId,
      sanitized: buildSanitizedMessage({
        providerMessageId: messageId,
        providerThreadId: randomProviderId("thread"),
        internalDateMs: Date.now(),
        messageHeaders: [{ name: "message-id", value: "<a@example.com>" }],
      }),
    });

    const result = await rpcRaw(client, "gmail_normalize_commit_message", {
      p_user_id: mailbox.userId,
      p_mail_account_id: mailbox.mailAccountId,
      p_provider_message_id: messageId,
      p_expected_source_payload_sha256: payloadSha256,
      p_normalizer_version: "gmail_normalizer_v1",
      p_headers: [
        {
          header_name: "message-id",
          occurrence_index: 0,
          global_order: 0,
          raw_value: "<a@example.com>",
        },
      ],
      p_participants: [],
      p_reference_tokens: [
        {
          source_header_name: "message-id",
          source_header_occurrence_index: 0,
          // A deliberately CONTRADICTORY role.
          header_role: "references",
          token_order: 0,
          raw_token: "<a@example.com>",
          parse_status: "valid_msgid",
        },
      ],
      p_text_parts: [],
    });
    expect(result.result).toBe("ok");

    const row = await client.query(
      `select t.header_role, h.header_name as source_header_name
         from private.gmail_normalized_reference_tokens t
         join private.gmail_normalized_headers h on h.id = t.source_header_id
        where t.normalized_message_id = $1`,
      [result.normalized_message_id],
    );
    expect(row.rows).toHaveLength(1);
    expect(row.rows[0].header_role).toBe("message-id");
    expect(row.rows[0].source_header_name).toBe("message-id");
  });

  it("Finding 2 (composite FK): a participant cannot be linked to a header belonging to a DIFFERENT message", async () => {
    const mailboxA = await connectedMailbox(client, "b04-f2-fk-a");
    const mailboxB = await connectedMailbox(client, "b04-f2-fk-b");
    const messageA = await normalizedOf(mailboxA.mailAccountId, mailboxA.userId, [
      { name: "from", value: "a@example.com" },
    ]);
    const messageB = await normalizedOf(mailboxB.mailAccountId, mailboxB.userId, [
      { name: "from", value: "b@example.com" },
    ]);
    const headerOfA = await client.query(
      "select id from private.gmail_normalized_headers where normalized_message_id = $1",
      [messageA.id],
    );

    // Attempt to attach a participant on message B to a header row that
    // actually belongs to message A. `participant_order: 5` is used (rather
    // than 0) specifically so this does NOT collide with the order-uniqueness
    // constraint on message A's own legitimate participant at order 0 — this
    // test isolates the composite FK, not the order-uniqueness invariant
    // already proven elsewhere. The plain FK on source_header_id alone would
    // have allowed this (the header row genuinely exists, just under a
    // different message); the composite FK against (id, normalized_message_id)
    // must refuse it.
    await expect(
      client.query(
        `insert into private.gmail_normalized_participants
           (normalized_message_id, source_header_id, header_role, participant_order, parse_status, addr_spec)
         values ($1, $2, 'from', 5, 'parsed', 'cross@example.com')`,
        [messageB.id, headerOfA.rows[0].id],
      ),
    ).rejects.toThrow(/foreign key/i);
  });
});
