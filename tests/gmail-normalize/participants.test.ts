import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { normalizeBatch } from "@/lib/gmail/normalize/service";

import {
  buildSanitizedMessage,
  connectedMailbox,
  deps,
  normalizedMessageRow,
  participantsOf,
  randomProviderId,
  referenceTokensOf,
  insertRawMessage,
} from "./harness";

/**
 * B04 PARTICIPANTS AND REFERENCE TOKENS: syntactic parsing only.
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

async function normalizeOneMessage(input: {
  mailAccountId: string;
  userId: string;
  messageHeaders: { name: string; value: string }[];
}) {
  const messageId = randomProviderId("msg");
  await insertRawMessage(client, {
    mailAccountId: input.mailAccountId,
    userId: input.userId,
    sanitized: buildSanitizedMessage({
      providerMessageId: messageId,
      providerThreadId: randomProviderId("thread"),
      internalDateMs: Date.now(),
      messageHeaders: input.messageHeaders,
    }),
  });
  await normalizeBatch(deps(client), {
    userId: input.userId,
    mailAccountId: input.mailAccountId,
    limit: 10,
  });
  const message = await normalizedMessageRow(client, input.mailAccountId, messageId);
  return {
    participants: await participantsOf(client, message.id),
    referenceTokens: await referenceTokensOf(client, message.id),
  };
}

d("B04 participants and reference tokens", () => {
  it("24. From address parsing", async () => {
    const mailbox = await connectedMailbox(client, "b04-part-24");
    const { participants } = await normalizeOneMessage({
      mailAccountId: mailbox.mailAccountId,
      userId: mailbox.userId,
      messageHeaders: [{ name: "from", value: "Alice <alice@example.com>" }],
    });
    expect(participants).toHaveLength(1);
    expect(participants[0]).toMatchObject({
      header_role: "from",
      display_name: "Alice",
      addr_spec: "alice@example.com",
      local_part: "alice",
      domain: "example.com",
      parse_status: "parsed",
    });
  });

  it("25. Sender address parsing", async () => {
    const mailbox = await connectedMailbox(client, "b04-part-25");
    const { participants } = await normalizeOneMessage({
      mailAccountId: mailbox.mailAccountId,
      userId: mailbox.userId,
      messageHeaders: [{ name: "sender", value: "Assistant <assistant@example.com>" }],
    });
    expect(participants[0]).toMatchObject({
      header_role: "sender",
      addr_spec: "assistant@example.com",
    });
  });

  it("26. Reply-To address parsing", async () => {
    const mailbox = await connectedMailbox(client, "b04-part-26");
    const { participants } = await normalizeOneMessage({
      mailAccountId: mailbox.mailAccountId,
      userId: mailbox.userId,
      messageHeaders: [{ name: "reply-to", value: "noreply@example.com" }],
    });
    expect(participants[0]).toMatchObject({
      header_role: "reply-to",
      addr_spec: "noreply@example.com",
    });
  });

  it("27-28. To with multiple addresses; repeated To occurrences remain separate", async () => {
    const mailbox = await connectedMailbox(client, "b04-part-27");
    const { participants } = await normalizeOneMessage({
      mailAccountId: mailbox.mailAccountId,
      userId: mailbox.userId,
      messageHeaders: [
        { name: "to", value: "a@example.com, b@example.com" },
        { name: "to", value: "c@example.com" },
      ],
    });
    const toEntries = participants.filter((p: { header_role: string }) => p.header_role === "to");
    expect(toEntries).toHaveLength(3);
    expect(toEntries.map((p: { addr_spec: string }) => p.addr_spec).sort()).toEqual([
      "a@example.com",
      "b@example.com",
      "c@example.com",
    ]);
    // Two distinct source header occurrences, not merged into one.
    const distinctHeaders = new Set(
      toEntries.map((p: { source_header_id: string }) => p.source_header_id),
    );
    expect(distinctHeaders.size).toBe(2);
  });

  it("29. Cc/Bcc preservation", async () => {
    const mailbox = await connectedMailbox(client, "b04-part-29");
    const { participants } = await normalizeOneMessage({
      mailAccountId: mailbox.mailAccountId,
      userId: mailbox.userId,
      messageHeaders: [
        { name: "cc", value: "cc-person@example.com" },
        { name: "bcc", value: "bcc-person@example.com" },
      ],
    });
    expect(participants.find((p: { header_role: string }) => p.header_role === "cc")).toMatchObject(
      {
        addr_spec: "cc-person@example.com",
      },
    );
    expect(
      participants.find((p: { header_role: string }) => p.header_role === "bcc"),
    ).toMatchObject({
      addr_spec: "bcc-person@example.com",
    });
  });

  it("30. quoted comma in display name parses without comma-splitting corruption", async () => {
    const mailbox = await connectedMailbox(client, "b04-part-30");
    const { participants } = await normalizeOneMessage({
      mailAccountId: mailbox.mailAccountId,
      userId: mailbox.userId,
      messageHeaders: [{ name: "to", value: '"Smith, John" <john@example.com>' }],
    });
    expect(participants).toHaveLength(1);
    expect(participants[0]).toMatchObject({
      display_name: "Smith, John",
      addr_spec: "john@example.com",
    });
  });

  it("31. international display name remains represented", async () => {
    const mailbox = await connectedMailbox(client, "b04-part-31");
    const { participants } = await normalizeOneMessage({
      mailAccountId: mailbox.mailAccountId,
      userId: mailbox.userId,
      messageHeaders: [{ name: "from", value: "Jose Garcia <jose@example.com>" }],
    });
    expect(participants[0].display_name).toBe("Jose Garcia");

    const { participants: intl } = await normalizeOneMessage({
      mailAccountId: mailbox.mailAccountId,
      userId: mailbox.userId,
      messageHeaders: [{ name: "from", value: '"日本語 テスト" <jp@example.com>' }],
    });
    expect(intl[0].display_name).toBe("日本語 テスト");
  });

  it("32-33. malformed address header remains evidence, never zero rows", async () => {
    const mailbox = await connectedMailbox(client, "b04-part-32");
    const { participants } = await normalizeOneMessage({
      mailAccountId: mailbox.mailAccountId,
      userId: mailbox.userId,
      messageHeaders: [{ name: "from", value: "this is not an address at all!!" }],
    });
    expect(participants.length).toBeGreaterThan(0);
    expect(participants[0].parse_status).toBe("malformed");
  });

  it("a genuine empty RFC 2822 group is distinguished from ordinary malformed garbage", async () => {
    // `addressparser` represents BOTH an empty group ("Undisclosed-recipients:;")
    // and unparseable garbage text as the same {name, address:""} shape once
    // flattened naively — they must not collapse to the same parse_status.
    const mailbox = await connectedMailbox(client, "b04-part-emptygroup");
    const { participants: groupResult } = await normalizeOneMessage({
      mailAccountId: mailbox.mailAccountId,
      userId: mailbox.userId,
      messageHeaders: [{ name: "to", value: "Undisclosed-recipients:;" }],
    });
    expect(groupResult).toHaveLength(1);
    expect(groupResult[0].parse_status).toBe("empty_group");
    expect(groupResult[0].display_name).toBe("Undisclosed-recipients");
    expect(groupResult[0].addr_spec).toBeNull();

    const { participants: garbageResult } = await normalizeOneMessage({
      mailAccountId: mailbox.mailAccountId,
      userId: mailbox.userId,
      messageHeaders: [{ name: "to", value: "garbage text with no address" }],
    });
    expect(garbageResult).toHaveLength(1);
    expect(garbageResult[0].parse_status).toBe("malformed");
    expect(garbageResult[0].raw_fragment).toBe("garbage text with no address");
  });

  it("34. plus-tag address remains uncollapsed", async () => {
    const mailbox = await connectedMailbox(client, "b04-part-34");
    const { participants } = await normalizeOneMessage({
      mailAccountId: mailbox.mailAccountId,
      userId: mailbox.userId,
      messageHeaders: [{ name: "to", value: "person+tag@example.com" }],
    });
    expect(participants[0].addr_spec).toBe("person+tag@example.com");
    expect(participants[0].local_part).toBe("person+tag");
  });

  it("35. Gmail-dot-looking local part remains uncollapsed", async () => {
    const mailbox = await connectedMailbox(client, "b04-part-35");
    const { participants } = await normalizeOneMessage({
      mailAccountId: mailbox.mailAccountId,
      userId: mailbox.userId,
      messageHeaders: [{ name: "to", value: "j.o.h.n@example.com" }],
    });
    expect(participants[0].addr_spec).toBe("j.o.h.n@example.com");
    expect(participants[0].local_part).toBe("j.o.h.n");
  });

  it("36. repeated Subject occurrences remain repeated and ordered", async () => {
    const mailbox = await connectedMailbox(client, "b04-part-36");
    const messageId = randomProviderId("msg");
    await insertRawMessage(client, {
      mailAccountId: mailbox.mailAccountId,
      userId: mailbox.userId,
      sanitized: buildSanitizedMessage({
        providerMessageId: messageId,
        providerThreadId: randomProviderId("thread"),
        internalDateMs: Date.now(),
        messageHeaders: [
          { name: "subject", value: "First subject" },
          { name: "subject", value: "Second subject" },
        ],
      }),
    });
    await normalizeBatch(deps(client), {
      userId: mailbox.userId,
      mailAccountId: mailbox.mailAccountId,
      limit: 10,
    });
    const message = await normalizedMessageRow(client, mailbox.mailAccountId, messageId);
    const res = await client.query(
      "select * from private.gmail_normalized_headers where normalized_message_id = $1 and header_name = 'subject' order by occurrence_index",
      [message.id],
    );
    expect(res.rows.map((r: { raw_value: string }) => r.raw_value)).toEqual([
      "First subject",
      "Second subject",
    ]);
  });

  it("37-38. repeated Message-ID / In-Reply-To occurrences remain evidence", async () => {
    const mailbox = await connectedMailbox(client, "b04-part-37");
    const { referenceTokens } = await normalizeOneMessage({
      mailAccountId: mailbox.mailAccountId,
      userId: mailbox.userId,
      messageHeaders: [
        { name: "message-id", value: "<a@example.com>" },
        { name: "in-reply-to", value: "<b@example.com>" },
        { name: "in-reply-to", value: "<c@example.com>" },
      ],
    });
    expect(
      referenceTokens.filter((t: { header_role: string }) => t.header_role === "message-id"),
    ).toHaveLength(1);
    expect(
      referenceTokens.filter((t: { header_role: string }) => t.header_role === "in-reply-to"),
    ).toHaveLength(2);
  });

  it("39-40. References token ordering is deterministic and creates no product reply state", async () => {
    const mailbox = await connectedMailbox(client, "b04-part-39");
    const { referenceTokens } = await normalizeOneMessage({
      mailAccountId: mailbox.mailAccountId,
      userId: mailbox.userId,
      messageHeaders: [
        { name: "references", value: "<a@example.com> <b@example.com> <c@example.com>" },
      ],
    });
    const refs = referenceTokens.filter(
      (t: { header_role: string }) => t.header_role === "references",
    );
    expect(refs.map((t: { token_order: number }) => t.token_order)).toEqual([0, 1, 2]);
    expect(refs.map((t: { raw_token: string }) => t.raw_token)).toEqual([
      "<a@example.com>",
      "<b@example.com>",
      "<c@example.com>",
    ]);

    // NO product reply relationship: the column set has no parent/reply link.
    const cols = await client.query(
      `select column_name from information_schema.columns
        where table_schema = 'private' and table_name = 'gmail_normalized_reference_tokens'`,
    );
    const names = cols.rows.map((r: { column_name: string }) => r.column_name);
    expect(names).not.toContain("parent_message_id");
    expect(names).not.toContain("reply_to_normalized_message_id");
    expect(names).not.toContain("is_reply");
    expect(names).not.toContain("reply_received");
  });
});
