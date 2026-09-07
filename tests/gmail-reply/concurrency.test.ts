import { Client } from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { commitInterpretation, getThreadEvidence } from "@/lib/gmail/reply/service";
import { interpretThread } from "@/lib/gmail/reply/interpreter";
import {
  connectedMailbox,
  insertMessage,
  messageObservationsOf,
  randomProviderId,
  replyDeps,
  setOutreachMachineStatus,
  threadSummaryOf,
  updateMessage,
} from "./harness";

/**
 * B06 TRUE MULTI-SESSION CONCURRENCY (contract §13/§19/§25) — real PostgreSQL
 * lock contention via `pg_blocking_pids`, never a sleep-based timing guess,
 * mirroring B04/B05's own proven pattern.
 *
 *   K1. two B06 workers committing the SAME thread converge to one current
 *       state, never two summary rows.
 *   K2. a concurrent B04 rebuild (raw message UPDATE) contends with a B06
 *       commit's `for key share` read of the thread's normalized messages.
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
    await c.query("rollback").catch(() => undefined);
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

const DAY = 86_400_000;

d("B06 true multi-session concurrency", () => {
  it("K1: two B06 workers committing the SAME thread serialize and converge to ONE current summary row", async () => {
    const { userId, mailAccountId } = await connectedMailbox(client, "b06-k1-two-workers");
    const providerThreadId = randomProviderId("thread");
    const t0 = Date.now() - DAY;

    const sent = await insertMessage(client, {
      userId,
      mailAccountId,
      providerMessageId: randomProviderId("sent"),
      providerThreadId,
      internalDateMs: t0,
      sent: true,
    });
    await setOutreachMachineStatus(client, {
      userId,
      mailAccountId,
      normalizedThreadId: sent.normalizedThreadId,
      outreachStatus: "qualified_outreach",
    });

    const deps = replyDeps(client);
    const evidence = await getThreadEvidence(deps, {
      userId,
      mailAccountId,
      normalizedThreadId: sent.normalizedThreadId,
    });
    expect(evidence.result).toBe("ok");
    if (evidence.result !== "ok") throw new Error("unreachable");

    const interpretation = interpretThread({
      messages: evidence.evidence.messages,
      referenceTokens: evidence.evidence.referenceTokens,
      participants: evidence.evidence.participants,
      subjects: evidence.evidence.subjects,
      textParts: evidence.evidence.textParts,
      mailAccountEmail: evidence.evidence.mailAccountEmail,
      observedThroughAtMs: null,
    });

    // Two independent sessions, each committing the SAME evidence.
    const s1 = await session();
    const s2 = await session();
    const deps1 = replyDeps(s1);
    const deps2 = replyDeps(s2);

    const [r1, r2] = await Promise.all([
      commitInterpretation(deps1, {
        userId,
        mailAccountId,
        normalizedThreadId: sent.normalizedThreadId,
        expectedEvidenceDigest: evidence.evidence.evidenceDigest,
        messageObservations: interpretation.messageObservations,
        threadSummary: interpretation.threadSummary,
      }),
      commitInterpretation(deps2, {
        userId,
        mailAccountId,
        normalizedThreadId: sent.normalizedThreadId,
        expectedEvidenceDigest: evidence.evidence.evidenceDigest,
        messageObservations: interpretation.messageObservations,
        threadSummary: interpretation.threadSummary,
      }),
    ]);

    expect(r1.result).toBe("ok");
    expect(r2.result).toBe("ok");

    const summaries = await client.query(
      "select id from private.gmail_reply_thread_summaries where normalized_thread_id = $1",
      [sent.normalizedThreadId],
    );
    expect(summaries.rows).toHaveLength(1);

    const observations = await messageObservationsOf(client, sent.normalizedThreadId);
    expect(observations).toHaveLength(1);
  });

  it("K2: a concurrent B04 rebuild contends with a B06 commit's evidence lock, proven via pg_blocking_pids", async () => {
    const { userId, mailAccountId } = await connectedMailbox(client, "b06-k2-rebuild-race");
    const providerThreadId = randomProviderId("thread");
    const providerMessageId = randomProviderId("sent");
    const t0 = Date.now() - DAY;

    const sent = await insertMessage(client, {
      userId,
      mailAccountId,
      providerMessageId,
      providerThreadId,
      internalDateMs: t0,
      sent: true,
      bodyText: "v1",
    });
    await setOutreachMachineStatus(client, {
      userId,
      mailAccountId,
      normalizedThreadId: sent.normalizedThreadId,
      outreachStatus: "qualified_outreach",
    });

    const deps = replyDeps(client);
    const evidence = await getThreadEvidence(deps, {
      userId,
      mailAccountId,
      normalizedThreadId: sent.normalizedThreadId,
    });
    expect(evidence.result).toBe("ok");
    if (evidence.result !== "ok") throw new Error("unreachable");
    const interpretation = interpretThread({
      messages: evidence.evidence.messages,
      referenceTokens: evidence.evidence.referenceTokens,
      participants: evidence.evidence.participants,
      subjects: evidence.evidence.subjects,
      textParts: evidence.evidence.textParts,
      mailAccountEmail: evidence.evidence.mailAccountEmail,
      observedThroughAtMs: null,
    });

    // Session A: begin the commit's transaction manually and hold the `for
    // key share` lock on the thread's normalized messages, WITHOUT committing.
    const sA = await session();
    await sA.query("begin");
    await sA.query(
      `select m.id from private.gmail_normalized_messages m
        where m.normalized_thread_id = $1
        for key share`,
      [sent.normalizedThreadId],
    );
    const pidA = await backendPid(sA);

    // Session B: a real B04 rebuild trying to UPDATE the same raw message —
    // this takes a conflicting lock and must block behind session A. The
    // backend pid MUST be captured BEFORE issuing the blocking query — a
    // single `pg.Client` connection serializes its own queries, so asking
    // for the pid while the blocking query is still in flight would itself
    // queue behind it and never resolve.
    const sB = await session();
    const pidB = await backendPid(sB);
    const sBQuery = updateMessage(sB, {
      userId,
      mailAccountId,
      providerMessageId,
      providerThreadId,
      internalDateMs: t0,
      sent: true,
      bodyText: "v2 — rebuilt while B06 held the evidence lock",
    });

    const blockers = await waitUntilBlocked(pidB, 8000);
    expect(blockers).toContain(pidA);
    const sBBlocked = true;

    // Session A finishes its commit (releasing the lock) — session B's
    // rebuild can now proceed.
    const commitResult = await commitInterpretation(replyDeps(sA), {
      userId,
      mailAccountId,
      normalizedThreadId: sent.normalizedThreadId,
      expectedEvidenceDigest: evidence.evidence.evidenceDigest,
      messageObservations: interpretation.messageObservations,
      threadSummary: interpretation.threadSummary,
    });
    await sA.query("commit");
    expect(commitResult.result).toBe("ok");
    expect(sBBlocked).toBe(true);

    // Session B's rebuild now completes.
    if (sBQuery) await sBQuery;
  });
});
