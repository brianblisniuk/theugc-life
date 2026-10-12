import { Client } from "pg";

import type { CommercialDeps } from "@/lib/gmail/commercial/service";
import { interpretOneThread as interpretReply } from "@/lib/gmail/reply/service";
import { createRpcClient } from "../gmail/rpc-harness";
import {
  connectedMailbox,
  insertMessage,
  randomProviderId,
  replyDeps,
  setOutreachMachineStatus,
  startDeletion,
} from "../gmail-reply/harness";

export { connectedMailbox, insertMessage, randomProviderId, startDeletion };

const HOUR = 3_600_000;
const DAY = 86_400_000;

export function commercialDeps(client: Client): CommercialDeps {
  return { db: createRpcClient(client) as unknown as CommercialDeps["db"] };
}

export async function asCreator<T>(
  client: Client,
  userId: string,
  run: () => PromiseLike<T>,
): Promise<T> {
  await client.query("select set_config('request.jwt.claims', $1, false)", [
    JSON.stringify({ sub: userId, role: "authenticated" }),
  ]);
  try {
    return await run();
  } finally {
    await client.query("select set_config('request.jwt.claims', '{}', false)");
  }
}

/** Creator-sent touch plus one qualifying human reply, then B06 and B07. */
export async function interpretedThread(client: Client, label: string, replyBody: string) {
  const { userId, mailAccountId } = await connectedMailbox(client, label);
  const providerThreadId = randomProviderId("thread");
  const sentId = randomProviderId("sent");
  const replyId = randomProviderId("reply");
  const sentMid = `<${randomProviderId("mid")}@creator.example>`;
  const t0 = Date.now() - 30 * DAY;

  const sent = await insertMessage(client, {
    userId,
    mailAccountId,
    providerMessageId: sentId,
    providerThreadId,
    internalDateMs: t0,
    sent: true,
    messageId: sentMid,
    subject: "Collaboration idea",
    bodyText: "I would love to collaborate with your hotel.",
  });
  await setOutreachMachineStatus(client, {
    userId,
    mailAccountId,
    normalizedThreadId: sent.normalizedThreadId,
    outreachStatus: "qualified_outreach",
  });
  await insertMessage(client, {
    userId,
    mailAccountId,
    providerMessageId: replyId,
    providerThreadId,
    internalDateMs: t0 + 4 * HOUR,
    sent: false,
    from: "manager@hotel.example",
    inReplyTo: sentMid,
    subject: "Re: Collaboration idea",
    bodyText: replyBody,
  });

  const reply = await interpretReply(replyDeps(client), {
    userId,
    mailAccountId,
    normalizedThreadId: sent.normalizedThreadId,
  });
  if (reply.result !== "ok") {
    throw new Error(`B06 interpret failed: ${JSON.stringify(reply)}`);
  }

  return {
    userId,
    mailAccountId,
    providerThreadId,
    sentId,
    replyId,
    normalizedThreadId: sent.normalizedThreadId,
    t0,
  };
}

export async function attemptCount(client: Client, mailAccountId: string): Promise<number> {
  const res = await client.query(
    "select count(*)::int as n from private.gmail_commercial_message_attempts where mail_account_id = $1",
    [mailAccountId],
  );
  return res.rows[0].n as number;
}

/** Drop every Gmail-derived layer except B07, so the B07 absence trigger is the only one left. */
export async function clearLayersExceptB07(client: Client, mailAccountId: string): Promise<void> {
  const tables = [
    "gmail_reply_message_observations",
    "gmail_reply_thread_summaries",
    "gmail_outreach_observed_recipients",
    "gmail_outreach_target_observations",
    "gmail_outreach_creator_decisions",
    "gmail_outreach_thread_signals",
    "gmail_outreach_target_scope_signals",
    "gmail_historical_import_threads",
    "gmail_historical_import_runs",
    "gmail_raw_messages",
    "gmail_normalized_threads",
  ];
  for (const table of tables) {
    await client.query(`delete from private.${table} where mail_account_id = $1`, [mailAccountId]);
  }
}
