import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { interpretUntilIdle, listCandidates } from "@/lib/gmail/reply/service";
import {
  connectedMailbox,
  insertMessage,
  randomProviderId,
  replyDeps,
  setOutreachMachineStatus,
} from "./harness";

/** B06 bounded local runner (contract §24) — no Gmail network I/O, idempotent. */

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

d("B06 bounded worker", () => {
  it("listCandidates offers an eligible unevaluated thread, and interpretUntilIdle drains it to zero remaining", async () => {
    const { userId, mailAccountId } = await connectedMailbox(client, "b06-bounded-worker");
    const sent = await insertMessage(client, {
      userId,
      mailAccountId,
      providerMessageId: randomProviderId("sent"),
      providerThreadId: randomProviderId("thread"),
      internalDateMs: Date.now() - DAY,
      sent: true,
    });
    await setOutreachMachineStatus(client, {
      userId,
      mailAccountId,
      normalizedThreadId: sent.normalizedThreadId,
      outreachStatus: "qualified_outreach",
    });

    const deps = replyDeps(client);
    const before = await listCandidates(deps, { userId, mailAccountId, limit: 10 });
    expect(before.candidates.map((c) => c.normalizedThreadId)).toContain(sent.normalizedThreadId);

    const summary = await interpretUntilIdle(deps, { userId, mailAccountId, maxThreads: 10 });
    expect(summary.committed).toBeGreaterThanOrEqual(1);

    const after = await listCandidates(deps, { userId, mailAccountId, limit: 10 });
    expect(after.candidates.map((c) => c.normalizedThreadId)).not.toContain(
      sent.normalizedThreadId,
    );
  });

  it("is idempotent: running it twice in a row commits nothing new the second time", async () => {
    const { userId, mailAccountId } = await connectedMailbox(
      client,
      "b06-bounded-worker-idempotent",
    );
    const sent = await insertMessage(client, {
      userId,
      mailAccountId,
      providerMessageId: randomProviderId("sent"),
      providerThreadId: randomProviderId("thread"),
      internalDateMs: Date.now() - DAY,
      sent: true,
    });
    await setOutreachMachineStatus(client, {
      userId,
      mailAccountId,
      normalizedThreadId: sent.normalizedThreadId,
      outreachStatus: "qualified_outreach",
    });

    const deps = replyDeps(client);
    const first = await interpretUntilIdle(deps, { userId, mailAccountId, maxThreads: 10 });
    expect(first.committed).toBe(1);

    const second = await interpretUntilIdle(deps, { userId, mailAccountId, maxThreads: 10 });
    expect(second.attempted).toBe(0);
    expect(second.committed).toBe(0);
  });
});
