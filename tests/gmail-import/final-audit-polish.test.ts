import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { buildSentWindowQuery } from "@/lib/gmail/import/read-adapter.server";
import type { RawMessage, RawThread } from "@/lib/gmail/import/sanitizer";
import { runImportUntilIdle } from "@/lib/gmail/import/worker.server";

import { createFakeGmailRead, textMessage } from "./fake-gmail-read";
import { connectedMailbox, importDeps, rawMessages, rpc, runRow, threadRows } from "./harness";

/**
 * FINAL B03 AUDIT POLISH
 *
 * Amendment #4 already proves that exact SENT-root candidacy is scoped to a
 * run's fixed window. This regression makes the mailbox dimension explicit too:
 * the SAME Gmail thread on the SAME mail_account may be filtered out in one run
 * and accepted in a later run whose explicit window now includes the SENT.
 *
 * That matters because `(mail_account_id, provider_message_id)` is the durable
 * raw identity, while candidacy is intentionally a property of each import run.
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

const labelled = (
  init: { id: string; threadId: string; internalDateMs: number },
  labelIds: string[],
): RawMessage => ({ ...textMessage(init), labelIds });

async function startRunOnMailbox(input: {
  userId: string;
  mailAccountId: string;
  windowStartAt: Date;
}) {
  const started = await rpc(client).rpc("gmail_historical_import_start", {
    p_user_id: input.userId,
    p_mail_account_id: input.mailAccountId,
    p_window_start_at: input.windowStartAt.toISOString(),
  });
  const runId = (started.data as { run_id: string }).run_id;
  const row = await runRow(client, runId);
  return {
    runId,
    startMs: new Date(row.window_start_at).getTime(),
    endMs: new Date(row.window_end_at).getTime(),
  };
}

async function importSingleThread(input: {
  userId: string;
  runId: string;
  thread: RawThread;
}) {
  const gmail = createFakeGmailRead({
    pages: [
      {
        candidates: [{ messageId: "provisional", threadId: input.thread.id! }],
        nextPageToken: null,
      },
    ],
    threads: { [input.thread.id!]: input.thread },
  });

  return runImportUntilIdle(
    { userId: input.userId, runId: input.runId, maxSteps: 10 },
    importDeps(client, { gmail }),
  );
}

d("B03 final audit polish", () => {
  it("re-evaluates the same provider thread on the same mailbox against each run's exact window", async () => {
    const mailbox = await connectedMailbox(client, "b03-final-same-mailbox");
    const firstWindowStartAt = new Date(Date.now() - 30 * DAY);

    const first = await startRunOnMailbox({
      userId: mailbox.userId,
      mailAccountId: mailbox.mailAccountId,
      windowStartAt: firstWindowStartAt,
    });

    // The creator's SENT is 500 ms BEFORE run one's exact start while the reply
    // is 100 ms inside it. The deliberately widened provider `after:` still
    // offers the SENT, so this is a real provisional candidate whose exact local
    // proof must reject the thread for run one.
    const sentAt = first.startMs - 500;
    const replyAt = first.startMs + 100;
    const firstQuery = buildSentWindowQuery(first.startMs, first.endMs);
    const afterSeconds = Number(/after:(\d+)/.exec(firstQuery)![1]);
    expect(sentAt).toBeGreaterThan(afterSeconds * 1000);

    const thread: RawThread = {
      id: "t-same-mailbox-window",
      messages: [
        labelled(
          { id: "m-sent", threadId: "t-same-mailbox-window", internalDateMs: sentAt },
          ["SENT"],
        ),
        labelled(
          { id: "m-reply", threadId: "t-same-mailbox-window", internalDateMs: replyAt },
          ["INBOX"],
        ),
      ],
    };

    const firstOutcome = await importSingleThread({
      userId: mailbox.userId,
      runId: first.runId,
      thread,
    });
    expect(firstOutcome).toEqual({ result: "finished", status: "completed" });
    expect((await threadRows(client, first.runId))[0].status).toBe("filtered_out");
    expect(await rawMessages(client, mailbox.mailAccountId)).toHaveLength(0);

    // SAME mailbox, NEW run, deliberately wider exact window. No reconnect and
    // no new provider identity: only the run's window changes. The SENT and reply
    // are now both inside [start,end), so the same thread must qualify.
    const second = await startRunOnMailbox({
      userId: mailbox.userId,
      mailAccountId: mailbox.mailAccountId,
      windowStartAt: new Date(first.startMs - 1000),
    });
    expect(second.runId).not.toBe(first.runId);
    expect(second.startMs).toBeLessThanOrEqual(sentAt);
    expect(second.endMs).toBeGreaterThan(replyAt);

    const secondOutcome = await importSingleThread({
      userId: mailbox.userId,
      runId: second.runId,
      thread,
    });
    expect(secondOutcome).toEqual({ result: "finished", status: "completed" });
    expect((await threadRows(client, second.runId))[0].status).toBe("complete");
    expect(
      (await rawMessages(client, mailbox.mailAccountId)).map((row) => row.provider_message_id).sort(),
    ).toEqual(["m-reply", "m-sent"]);
  });
});
