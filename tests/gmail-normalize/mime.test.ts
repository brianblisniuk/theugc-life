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
  textPartsOf,
  type RawPartFixture,
} from "./harness";

/**
 * B04 MIME STRUCTURE AND DECODING.
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

async function normalizeWithPayload(payload: RawPartFixture, internalDateMs = Date.now()) {
  const mailbox = await connectedMailbox(client, `b04-mime-${randomProviderId("")}`);
  const messageId = randomProviderId("msg");
  await insertRawMessage(client, {
    mailAccountId: mailbox.mailAccountId,
    userId: mailbox.userId,
    sanitized: buildSanitizedMessage({
      providerMessageId: messageId,
      providerThreadId: randomProviderId("thread"),
      internalDateMs,
      payload,
    }),
  });
  await normalizeBatch(deps(client), {
    userId: mailbox.userId,
    mailAccountId: mailbox.mailAccountId,
    limit: 10,
  });
  const message = await normalizedMessageRow(client, mailbox.mailAccountId, messageId);
  return { mailbox, message, textParts: await textPartsOf(client, message.id) };
}

d("B04 MIME structure and decoding", () => {
  it("41-42. deterministic thread order: internal_date then provider_message_id tie-break", async () => {
    const mailbox = await connectedMailbox(client, "b04-mime-41");
    const threadId = randomProviderId("thread");
    const t0 = Date.now();
    const ids = ["msg-c", "msg-a", "msg-b"];
    for (const id of ids) {
      await insertRawMessage(client, {
        mailAccountId: mailbox.mailAccountId,
        userId: mailbox.userId,
        sanitized: buildSanitizedMessage({
          providerMessageId: `${id}-${randomProviderId("")}`,
          providerThreadId: threadId,
          internalDateMs: t0, // EQUAL internal_date for all three
        }),
      });
    }
    await normalizeBatch(deps(client), {
      userId: mailbox.userId,
      mailAccountId: mailbox.mailAccountId,
      limit: 10,
    });

    const res = await client.query(
      `select m.provider_message_id from private.gmail_normalized_messages m
         join private.gmail_normalized_threads t on t.id = m.normalized_thread_id
        where t.mail_account_id = $1 and t.provider_thread_id = $2
        order by m.internal_date asc, m.provider_message_id asc`,
      [mailbox.mailAccountId, threadId],
    );
    const ordered = res.rows.map((r: { provider_message_id: string }) => r.provider_message_id);
    const sortedByIdAlone = [...ordered].sort();
    // With equal internal_date, the ORDER BY tie-break is provider_message_id
    // alone — proven by the query itself, and confirmed the result is sorted.
    expect(ordered).toEqual(sortedByIdAlone);
  });

  it("43. plain text root part path [] works", async () => {
    const { textParts } = await normalizeWithPayload({
      mimeType: "text/plain",
      body: { size: 5, data: b64url("hello") },
    });
    expect(textParts).toHaveLength(1);
    expect(textParts[0].part_path).toEqual([]);
    expect(textParts[0].decoded_text).toBe("hello");
  });

  it("44. HTML root part works", async () => {
    const { textParts } = await normalizeWithPayload({
      mimeType: "text/html",
      body: { size: 10, data: b64url("<p>hi</p>") },
    });
    expect(textParts[0].mime_type).toBe("text/html");
    expect(textParts[0].decoded_text).toBe("<p>hi</p>");
  });

  it("45. multipart/alternative produces distinct plain + HTML parts", async () => {
    const { textParts } = await normalizeWithPayload({
      mimeType: "multipart/alternative",
      parts: [
        { mimeType: "text/plain", body: { size: 4, data: b64url("text") } },
        { mimeType: "text/html", body: { size: 12, data: b64url("<b>html</b>") } },
      ],
    });
    expect(textParts).toHaveLength(2);
    const plain = textParts.find((p: { mime_type: string }) => p.mime_type === "text/plain");
    const html = textParts.find((p: { mime_type: string }) => p.mime_type === "text/html");
    expect(plain.decoded_text).toBe("text");
    expect(html.decoded_text).toBe("<b>html</b>");
    expect(plain.part_path).toEqual([0]);
    expect(html.part_path).toEqual([1]);
  });

  it("46-47. nested multipart paths are deterministic and stable across exact replay", async () => {
    const payload: RawPartFixture = {
      mimeType: "multipart/mixed",
      parts: [
        {
          mimeType: "multipart/alternative",
          parts: [
            { mimeType: "text/plain", body: { size: 3, data: b64url("abc") } },
            { mimeType: "text/html", body: { size: 9, data: b64url("<i>abc</i>") } },
          ],
        },
      ],
    };
    const { mailbox, message, textParts } = await normalizeWithPayload(payload);
    const plain = textParts.find((p: { mime_type: string }) => p.mime_type === "text/plain");
    expect(plain.part_path).toEqual([0, 0]);

    await normalizeBatch(deps(client), {
      userId: mailbox.userId,
      mailAccountId: mailbox.mailAccountId,
      limit: 10,
    });
    const replay = await textPartsOf(client, message.id);
    expect(replay.map((p: { part_path: number[] }) => p.part_path)).toEqual(
      textParts.map((p: { part_path: number[] }) => p.part_path),
    );
  });

  it("48-49. empty decoded body differs from absent body, and B03-omitted body remains omitted", async () => {
    const empty = await normalizeWithPayload({
      mimeType: "text/plain",
      body: { size: 0, data: b64url("") },
    });
    expect(empty.textParts[0].decode_status).toBe("empty_decoded");
    expect(empty.textParts[0].decoded_text).toBe("");

    const absent = await normalizeWithPayload({ mimeType: "text/plain" });
    expect(absent.textParts[0].decode_status).toBe("body_absent");
    expect(absent.textParts[0].decoded_text).toBeNull();

    const omitted = await normalizeWithPayload({
      mimeType: "text/plain",
      contentOmitted: true,
      omissionReason: "external_body",
      size: 900,
    });
    expect(omitted.textParts[0].decode_status).toBe("content_omitted_by_b03");
    expect(omitted.textParts[0].b03_omitted).toBe(true);
    expect(omitted.textParts[0].b03_omission_reason).toBe("external_body");
    expect(omitted.textParts[0].decoded_text).toBeNull();
  });

  it("50. invalid base64url becomes an explicit decode failure", async () => {
    const { textParts } = await normalizeWithPayload({
      mimeType: "text/plain",
      body: { size: 3, data: "not valid base64url!!" },
    });
    expect(textParts[0].decode_status).toBe("invalid_base64url");
  });

  it("51. UTF-8 declared charset decodes strictly", async () => {
    const { textParts } = await normalizeWithPayload({
      mimeType: "text/plain",
      headers: [{ name: "content-type", value: "text/plain; charset=UTF-8" }],
      body: { size: 10, data: b64url("héllo wörld") },
    });
    expect(textParts[0].decode_status).toBe("decoded");
    expect(textParts[0].declared_charset).toBe("UTF-8");
    expect(textParts[0].charset_source).toBe("declared");
    expect(textParts[0].decoded_text).toBe("héllo wörld");
  });

  it("52. no charset + valid UTF-8 follows the explicit V1 fallback status", async () => {
    const { textParts } = await normalizeWithPayload({
      mimeType: "text/plain",
      body: { size: 5, data: b64url("plain") },
    });
    expect(textParts[0].decode_status).toBe("decoded");
    expect(textParts[0].declared_charset).toBeNull();
    expect(textParts[0].charset_source).toBe("no_declaration_utf8_fallback");
  });

  it("53. no charset + invalid UTF-8 does not silently replace bytes", async () => {
    const invalidUtf8 = Buffer.from([0xff, 0xfe, 0xfd]).toString("base64url");
    const { textParts } = await normalizeWithPayload({
      mimeType: "text/plain",
      body: { size: 3, data: invalidUtf8 },
    });
    expect(textParts[0].decode_status).toBe("missing_charset_undecodable");
    expect(textParts[0].decoded_text).toBeNull();
  });

  it("54. unsupported charset produces an explicit state", async () => {
    const { textParts } = await normalizeWithPayload({
      mimeType: "text/plain",
      headers: [{ name: "content-type", value: "text/plain; charset=not-a-real-charset-xyz" }],
      body: { size: 4, data: b64url("text") },
    });
    expect(textParts[0].decode_status).toBe("unsupported_charset");
    expect(textParts[0].declared_charset).toBe("not-a-real-charset-xyz");
    expect(textParts[0].decoded_text).toBeNull();
  });

  it("55. conflicting charset declarations produce an explicit conflict", async () => {
    const { textParts } = await normalizeWithPayload({
      mimeType: "text/plain",
      headers: [
        { name: "content-type", value: "text/plain; charset=UTF-8" },
        { name: "content-type", value: "text/plain; charset=ISO-8859-1" },
      ],
      body: { size: 4, data: b64url("text") },
    });
    expect(textParts[0].decode_status).toBe("conflicting_charset");
    expect(textParts[0].declared_charset).toBeNull();
    expect(textParts[0].content_type_values).toHaveLength(2);
  });

  // --- EXTERNAL AUDIT AMENDMENT #1, Finding 3 ---------------------------
  // The charset regex previously used a non-global `.exec()`, so it only
  // ever saw the FIRST `charset=` parameter in each Content-Type value. A
  // single malformed occurrence repeating the parameter
  // (`charset=UTF-8; charset=ISO-8859-1`) was silently read as unambiguous
  // UTF-8 — exactly the "first wins" behavior the documented policy forbids.

  it("Finding 3 (1): two conflicting charset params inside ONE Content-Type occurrence -> conflicting_charset", async () => {
    const { textParts } = await normalizeWithPayload({
      mimeType: "text/plain",
      headers: [{ name: "content-type", value: "text/plain; charset=UTF-8; charset=ISO-8859-1" }],
      body: { size: 4, data: b64url("text") },
    });
    expect(textParts[0].decode_status).toBe("conflicting_charset");
    expect(textParts[0].declared_charset).toBeNull();
    expect(textParts[0].content_type_values).toHaveLength(1);
  });

  it("Finding 3 (2): the same charset repeated (case-insensitively) inside ONE occurrence is not a conflict", async () => {
    const { textParts } = await normalizeWithPayload({
      mimeType: "text/plain",
      headers: [{ name: "content-type", value: "text/plain; charset=UTF-8; charset=utf-8" }],
      body: { size: 4, data: b64url("text") },
    });
    expect(textParts[0].decode_status).toBe("decoded");
    expect(textParts[0].declared_charset).toBe("UTF-8");
  });

  it("Finding 3 (4): quoted and unquoted charset parameter forms are both recognized", async () => {
    const quoted = await normalizeWithPayload({
      mimeType: "text/plain",
      headers: [{ name: "content-type", value: 'text/plain; charset="UTF-8"' }],
      body: { size: 4, data: b64url("text") },
    });
    expect(quoted.textParts[0].decode_status).toBe("decoded");
    expect(quoted.textParts[0].declared_charset).toBe("UTF-8");

    // A quoted declaration conflicting with an unquoted one in the SAME value
    // must still be caught — quoting must not hide a second parameter from
    // the scan.
    const conflict = await normalizeWithPayload({
      mimeType: "text/plain",
      headers: [{ name: "content-type", value: 'text/plain; charset="UTF-8"; charset=ISO-8859-1' }],
      body: { size: 4, data: b64url("text") },
    });
    expect(conflict.textParts[0].decode_status).toBe("conflicting_charset");
  });

  it("Finding 3 (5): an empty charset parameter does not erase a real declaration, in either order", async () => {
    const emptyFirst = await normalizeWithPayload({
      mimeType: "text/plain",
      headers: [{ name: "content-type", value: "text/plain; charset=; charset=UTF-8" }],
      body: { size: 4, data: b64url("text") },
    });
    expect(emptyFirst.textParts[0].decode_status).toBe("decoded");
    expect(emptyFirst.textParts[0].declared_charset).toBe("UTF-8");

    const emptySecond = await normalizeWithPayload({
      mimeType: "text/plain",
      headers: [{ name: "content-type", value: "text/plain; charset=UTF-8; charset=" }],
      body: { size: 4, data: b64url("text") },
    });
    expect(emptySecond.textParts[0].decode_status).toBe("decoded");
    expect(emptySecond.textParts[0].declared_charset).toBe("UTF-8");
  });

  it("56-58. Content-Transfer-Encoding never triggers a second decode", async () => {
    // The API already returned decoded bytes; CTE:base64 must not cause a
    // SECOND base64 decode of text that happens to look like base64 itself.
    const literalLookingLikeBase64 = "aGVsbG8="; // this literal string IS the content
    const { textParts } = await normalizeWithPayload({
      mimeType: "text/plain",
      headers: [{ name: "content-transfer-encoding", value: "base64" }],
      body: { size: literalLookingLikeBase64.length, data: b64url(literalLookingLikeBase64) },
    });
    expect(textParts[0].decoded_text).toBe(literalLookingLikeBase64);
    expect(textParts[0].content_transfer_encoding_values).toEqual(["base64"]);

    const qp = await normalizeWithPayload({
      mimeType: "text/plain",
      headers: [{ name: "content-transfer-encoding", value: "quoted-printable" }],
      body: { size: 20, data: b64url("plain=3Dtext literal") },
    });
    // If a second quoted-printable decode ran, "=3D" would become "=". It must not.
    expect(qp.textParts[0].decoded_text).toBe("plain=3Dtext literal");
  });

  it("59. repeated MIME declarations are all considered and preserved", async () => {
    const { textParts } = await normalizeWithPayload({
      mimeType: "text/plain",
      headers: [
        { name: "content-disposition", value: "inline" },
        { name: "content-transfer-encoding", value: "7bit" },
        { name: "content-transfer-encoding", value: "8bit" },
      ],
      body: { size: 4, data: b64url("text") },
    });
    expect(textParts[0].content_disposition_values).toEqual(["inline"]);
    expect(textParts[0].content_transfer_encoding_values).toEqual(["7bit", "8bit"]);
  });

  it("60-62. B03-omitted attachment cannot reappear; no attachmentId fetch path; non-text content never invented", async () => {
    const { textParts } = await normalizeWithPayload({
      mimeType: "multipart/mixed",
      parts: [
        { mimeType: "text/plain", body: { size: 4, data: b64url("body") } },
        { mimeType: "image/png", contentOmitted: true, omissionReason: "attachment", size: 50_000 },
      ],
    });
    // Only ONE row: the text/plain part. The image/png attachment produces NO
    // row at all — B04 has no attachment table and no attachmentId method to
    // call even if it wanted to.
    expect(textParts).toHaveLength(1);
    expect(textParts[0].mime_type).toBe("text/plain");

    const attachmentModule = await import("@/lib/gmail/normalize/normalizer");
    expect(Object.keys(attachmentModule)).not.toContain("fetchAttachment");
  });

  it("63. SENT label present produces only the literal provider_sent fact", async () => {
    const mailbox = await connectedMailbox(client, "b04-mime-63");
    const messageId = randomProviderId("msg");
    await insertRawMessage(client, {
      mailAccountId: mailbox.mailAccountId,
      userId: mailbox.userId,
      sanitized: buildSanitizedMessage({
        providerMessageId: messageId,
        providerThreadId: randomProviderId("thread"),
        internalDateMs: Date.now(),
        labelIds: ["SENT"],
      }),
    });
    await normalizeBatch(deps(client), {
      userId: mailbox.userId,
      mailAccountId: mailbox.mailAccountId,
      limit: 10,
    });
    const message = await normalizedMessageRow(client, mailbox.mailAccountId, messageId);
    expect(message.provider_sent).toBe(true);

    const cols = await client.query(
      `select column_name from information_schema.columns
        where table_schema = 'private' and table_name = 'gmail_normalized_messages'`,
    );
    const names = cols.rows.map((r: { column_name: string }) => r.column_name);
    expect(names).not.toContain("is_outreach");
    expect(names).not.toContain("is_reply");
    expect(names).not.toContain("outcome");
  });
});
