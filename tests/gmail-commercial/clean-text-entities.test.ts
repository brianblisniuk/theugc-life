import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { buildClassifierInputForMessage } from "@/lib/gmail/outreach/text-transform";
import { setupDatabase } from "../db/harness";

/**
 * private.gmail_commercial_classifier_clean_text must decode the same HTML
 * entities as src/lib/gmail/outreach/text-transform.ts, including mixed case.
 * 0045 used case-sensitive replace(). 0048 makes the SQL case-insensitive.
 */

const TEST_DB = process.env.TEST_DATABASE_URL;
const d = describe.skipIf(!TEST_DB);

let client: Client;

beforeAll(async () => {
  if (!TEST_DB) return;
  await setupDatabase();
  client = new Client({ connectionString: TEST_DB });
  await client.connect();
});

afterAll(async () => {
  if (client) await client.end();
});

function typescriptClean(html: string): string | null {
  return buildClassifierInputForMessage([
    {
      normalizedMessageId: "00000000-0000-0000-0000-000000000001",
      partPath: [0],
      mimeType: "text/html",
      decodeStatus: "decoded",
      decodedText: html,
    },
  ]).cleanText;
}

async function sqlClean(html: string, isHtml: boolean): Promise<string | null> {
  const res = await client.query<{ t: string | null }>(
    "select private.gmail_commercial_classifier_clean_text($1, $2) as t",
    [html, isHtml],
  );
  return res.rows[0]!.t;
}

d("B07.1 classifier clean text entities", () => {
  it("decodes nbsp, amp, lt, and gt without regard to case", async () => {
    const samples = [
      "Stay&nbsp;ok &amp; booked &lt;a&gt;",
      "Stay&NBSP;ok &AMP; booked &LT;a&GT;",
      "Stay&NbSp;ok &AmP; booked &Lt;a&gT;",
    ];
    const expected = "Stay ok & booked <a>";
    for (const html of samples) {
      expect(typescriptClean(html)).toBe(expected);
      expect(await sqlClean(html, true)).toBe(expected);
    }
  });

  it("leaves those entities untouched in plain text", async () => {
    const plain = "Stay&NBSP;ok &AMP; booked";
    expect(await sqlClean(plain, false)).toBe(plain);
  });
});
