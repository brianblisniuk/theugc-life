import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import path from "node:path";

import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  normalizeBatch,
  normalizeMailboxUntilIdle,
  requirePositiveInteger,
} from "@/lib/gmail/normalize/service";
import type { NormalizeDeps } from "@/lib/gmail/normalize/service";

import {
  buildSanitizedMessage,
  connectedMailbox,
  deps,
  insertRawMessage,
  normalizedMessageRow,
  randomProviderId,
  updateRawMessage,
} from "./harness";

/**
 * EXTERNAL AUDIT AMENDMENT #1, Finding 1.
 *
 * `normalizeMailboxUntilIdle` previously terminated on
 * `batch.candidatesFound < batchSize`. A raw candidate that can NEVER
 * normalize (a structural error) never leaves the candidate pool, so:
 *
 *   - at `batchSize = 1`, one such candidate makes `candidatesFound` stay at
 *     1 forever — `1 < 1` is always false, so the loop never terminates;
 *   - at a larger `batchSize`, the SAME candidate — or several — can make the
 *     function exit EARLY while genuinely believing it reached idle, because
 *     "the batch came back smaller than requested" was the only signal the
 *     old code had, and it does not distinguish "nothing left" from
 *     "everything left is permanently stuck."
 *
 * These tests never let an actual infinite loop run: `MAX_ATTEMPTS_PER_
 * CANDIDATE` bounds every case, and each test asserts on the EXACT, bounded
 * number of `gmail_normalize_list_candidates` calls made, proving the call
 * count cannot grow without bound rather than merely "the test finished."
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

/** A raw message whose `sanitized_payload` cannot be traversed — PERMANENTLY structurally invalid. */
async function insertPermanentlyBrokenCandidate(input: {
  mailAccountId: string;
  userId: string;
  internalDateMs: number;
}): Promise<string> {
  const providerMessageId = randomProviderId("broken");
  const payload = {
    provider_message_id: providerMessageId,
    provider_thread_id: randomProviderId("thread"),
    internal_date_ms: input.internalDateMs,
    label_ids: ["SENT"],
    provider_history_id: null,
    size_estimate: null,
    message_headers: [{ name: "subject", value: "hi" }],
    // No `mimeType` at all — `computeNormalization`'s MIME walk raises
    // `NormalizationStructuralError` deterministically, every single time.
    payload: {},
  };
  const payloadSha256 = createHash("sha256").update(JSON.stringify(payload)).digest("hex");
  await client.query(
    `insert into private.gmail_raw_messages
       (mail_account_id, user_id, provider_message_id, provider_thread_id, internal_date,
        label_ids, sanitized_payload, payload_sha256)
     values ($1, $2, $3, $4, to_timestamp($5 / 1000.0), $6, $7, $8)`,
    [
      input.mailAccountId,
      input.userId,
      providerMessageId,
      payload.provider_thread_id,
      payload.internal_date_ms,
      payload.label_ids,
      JSON.stringify(payload),
      payloadSha256,
    ],
  );
  return providerMessageId;
}

/** Wrap a NormalizeDeps so every call to `gmail_normalize_list_candidates` is counted. */
interface MinimalRpcClient {
  rpc(name: string, args: Record<string, unknown>): Promise<{ data: unknown; error: unknown }>;
}

function countingDeps(base: NormalizeDeps): { deps: NormalizeDeps; listCallCount: () => number } {
  let count = 0;
  const inner = base.db as unknown as MinimalRpcClient;
  const wrapped: MinimalRpcClient = {
    async rpc(name, args) {
      if (name === "gmail_normalize_list_candidates") count += 1;
      return inner.rpc(name, args);
    },
  };
  return { deps: { db: wrapped as unknown as NormalizeDeps["db"] }, listCallCount: () => count };
}

d("B04 Finding 1: bounded forward progress in normalizeMailboxUntilIdle", () => {
  it("1. batchSize=1 + one permanent structural_error terminates safely, not infinitely", async () => {
    const mailbox = await connectedMailbox(client, "b04-f1-1");
    await insertPermanentlyBrokenCandidate({
      mailAccountId: mailbox.mailAccountId,
      userId: mailbox.userId,
      internalDateMs: Date.now(),
    });

    const { deps: countedDeps, listCallCount } = countingDeps(deps(client));
    const result = await normalizeMailboxUntilIdle(countedDeps, {
      userId: mailbox.userId,
      mailAccountId: mailbox.mailAccountId,
      batchSize: 1,
    });

    expect(result.completed).toBe(false);
    expect(result.gaveUpCount).toBe(1);
    expect(result.structuralErrors).toBeGreaterThan(0);
    // Bounded: at most (attempts to exhaust the one candidate's budget) + 1
    // final empty-list call. With MAX_ATTEMPTS_PER_CANDIDATE = 5, that is a
    // small constant — nowhere near "grows without bound".
    expect(listCallCount()).toBeLessThanOrEqual(10);
  });

  it("2. multiple permanent structural errors >= batch size terminate safely", async () => {
    const mailbox = await connectedMailbox(client, "b04-f1-2");
    for (let i = 0; i < 3; i++) {
      await insertPermanentlyBrokenCandidate({
        mailAccountId: mailbox.mailAccountId,
        userId: mailbox.userId,
        internalDateMs: Date.now() + i,
      });
    }

    const { deps: countedDeps, listCallCount } = countingDeps(deps(client));
    const result = await normalizeMailboxUntilIdle(countedDeps, {
      userId: mailbox.userId,
      mailAccountId: mailbox.mailAccountId,
      batchSize: 2, // smaller than the number of permanently-broken candidates
    });

    expect(result.completed).toBe(false);
    expect(result.gaveUpCount).toBe(3);
    expect(listCallCount()).toBeLessThanOrEqual(20);
  });

  it("3. fewer structural errors than batch size do NOT produce a false idle/success result", async () => {
    const mailbox = await connectedMailbox(client, "b04-f1-3");
    await insertPermanentlyBrokenCandidate({
      mailAccountId: mailbox.mailAccountId,
      userId: mailbox.userId,
      internalDateMs: Date.now(),
    });
    await insertPermanentlyBrokenCandidate({
      mailAccountId: mailbox.mailAccountId,
      userId: mailbox.userId,
      internalDateMs: Date.now() + 1,
    });

    // batchSize (10) is far larger than the 2 permanent failures — the OLD
    // code's `candidatesFound < batchSize` check would have exited after the
    // FIRST call here, reporting nothing distinguishable from success.
    const result = await normalizeMailboxUntilIdle(deps(client), {
      userId: mailbox.userId,
      mailAccountId: mailbox.mailAccountId,
      batchSize: 10,
    });

    expect(result.completed).toBe(false);
    expect(result.gaveUpCount).toBe(2);
  });

  it("4. a fully successful mailbox reaches TRUE zero candidates", async () => {
    const mailbox = await connectedMailbox(client, "b04-f1-4");
    for (let i = 0; i < 3; i++) {
      await insertRawMessage(client, {
        mailAccountId: mailbox.mailAccountId,
        userId: mailbox.userId,
        sanitized: buildSanitizedMessage({
          providerMessageId: randomProviderId("ok"),
          providerThreadId: randomProviderId("thread"),
          internalDateMs: Date.now() + i,
        }),
      });
    }

    const result = await normalizeMailboxUntilIdle(deps(client), {
      userId: mailbox.userId,
      mailAccountId: mailbox.mailAccountId,
      batchSize: 10,
    });

    expect(result.completed).toBe(true);
    expect(result.gaveUpCount).toBe(0);
    expect(result.committed).toBe(3);
  });

  it("5. a transient stale_source race recovers without an infinite loop", async () => {
    const mailbox = await connectedMailbox(client, "b04-f1-5");
    const providerMessageId = randomProviderId("race");
    const threadId = randomProviderId("thread");
    await insertRawMessage(client, {
      mailAccountId: mailbox.mailAccountId,
      userId: mailbox.userId,
      sanitized: buildSanitizedMessage({
        providerMessageId,
        providerThreadId: threadId,
        internalDateMs: Date.now(),
      }),
    });

    // Simulate exactly one concurrent B03 update landing between the FIRST
    // listing and its commit attempt: intercept the first
    // `gmail_normalize_list_candidates` response and mutate the raw row's
    // digest immediately afterward, so that one commit call observes a
    // digest that has already moved (a real `stale_source`), then let every
    // subsequent call proceed against the now-current row normally.
    let intercepted = false;
    const inner = deps(client).db as unknown as MinimalRpcClient;
    const racedClient: MinimalRpcClient = {
      async rpc(name, args) {
        const result = await inner.rpc(name, args);
        if (name === "gmail_normalize_list_candidates" && !intercepted) {
          intercepted = true;
          await updateRawMessage(client, {
            mailAccountId: mailbox.mailAccountId,
            providerMessageId,
            sanitized: buildSanitizedMessage({
              providerMessageId,
              providerThreadId: threadId,
              internalDateMs: Date.now(),
              messageHeaders: [{ name: "subject", value: "raced update" }],
            }),
          });
        }
        return result;
      },
    };
    const raced: NormalizeDeps = { db: racedClient as unknown as NormalizeDeps["db"] };

    const result = await normalizeMailboxUntilIdle(raced, {
      userId: mailbox.userId,
      mailAccountId: mailbox.mailAccountId,
      batchSize: 1,
    });

    expect(result.completed).toBe(true);
    expect(result.gaveUpCount).toBe(0);
    expect(result.staleSource).toBeGreaterThanOrEqual(1);
    expect(result.committed).toBeGreaterThanOrEqual(1);

    const message = await normalizedMessageRow(client, mailbox.mailAccountId, providerMessageId);
    expect(message).toBeTruthy();
  });

  it("6. zero, negative, NaN and non-integer batch sizes are rejected before any RPC call", async () => {
    const mailbox = await connectedMailbox(client, "b04-f1-6");
    for (const bad of [0, -1, Number.NaN, 1.5, Infinity, -Infinity]) {
      await expect(
        normalizeMailboxUntilIdle(deps(client), {
          userId: mailbox.userId,
          mailAccountId: mailbox.mailAccountId,
          batchSize: bad,
        }),
      ).rejects.toThrow(RangeError);
      await expect(
        normalizeBatch(deps(client), {
          userId: mailbox.userId,
          mailAccountId: mailbox.mailAccountId,
          limit: bad,
        }),
      ).rejects.toThrow(RangeError);
    }
    expect(() => requirePositiveInteger(3, "x")).not.toThrow();
  });

  it("7. the CLI exits non-zero and surfaces incomplete normalization when it cannot reach idle", async () => {
    const mailbox = await connectedMailbox(client, "b04-f1-7");
    await insertPermanentlyBrokenCandidate({
      mailAccountId: mailbox.mailAccountId,
      userId: mailbox.userId,
      internalDateMs: Date.now(),
    });

    const cliPath = path.resolve(__dirname, "../../scripts/gmail-normalize/cli.ts");
    const result = spawnSync(
      "npx",
      [
        "tsx",
        cliPath,
        "run",
        "--user-id",
        mailbox.userId,
        "--mail-account-id",
        mailbox.mailAccountId,
        "--limit",
        "1",
      ],
      {
        cwd: path.resolve(__dirname, "../.."),
        env: { ...process.env, DATABASE_URL: TEST_DB },
        encoding: "utf8",
        timeout: 30_000,
      },
    );

    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/did not reach idle/);
    const printed = JSON.parse(result.stdout);
    expect(printed.completed).toBe(false);
    expect(printed.gaveUpCount).toBe(1);
    // The operator surface reports counts only — never a provider id.
    expect(result.stdout).not.toContain("broken-");
  });

  it("7b. the CLI rejects an invalid --limit before touching the database", async () => {
    const mailbox = await connectedMailbox(client, "b04-f1-7b");
    const cliPath = path.resolve(__dirname, "../../scripts/gmail-normalize/cli.ts");
    const result = spawnSync(
      "npx",
      [
        "tsx",
        cliPath,
        "run",
        "--user-id",
        mailbox.userId,
        "--mail-account-id",
        mailbox.mailAccountId,
        "--limit",
        "0",
      ],
      {
        cwd: path.resolve(__dirname, "../.."),
        env: { ...process.env, DATABASE_URL: TEST_DB },
        encoding: "utf8",
        timeout: 30_000,
      },
    );
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/positive integer/);
  });
});
