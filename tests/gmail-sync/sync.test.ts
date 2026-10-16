import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { GmailReadError } from "@/lib/gmail/import/errors";
import { normalizeMailboxUntilIdle } from "@/lib/gmail/normalize/service";
import { runStoredGmailPipeline } from "@/lib/gmail/sync/pipeline";
import { runAccountSync, syncDeps } from "@/lib/gmail/sync/worker";
import { syncOnCreatorLogin } from "@/lib/gmail/sync/on-login";
import { setupDatabase } from "../db/harness";
import { draftMessage, textMessage, thread } from "../gmail-import/fake-gmail-read";
import { setConnectionState } from "../gmail-import/harness";

import { createFakeIncremental } from "./fake-incremental";
import {
  completedImport,
  cursorOf,
  depsFor,
  dueCursor,
  mailbox,
  rawCount,
  rpc,
  SCOPES,
} from "./harness";

const TEST_DB = process.env.TEST_DATABASE_URL;
const d = describe.skipIf(!TEST_DB);

let client: Client;
const recent = () => Date.now() - 60 * 60 * 1000;
const old = () => Date.now() - 10 * 24 * 60 * 60 * 1000;

beforeAll(async () => {
  if (!TEST_DB) return;
  await setupDatabase();
  client = new Client({ connectionString: TEST_DB });
  await client.connect();
});

afterAll(async () => {
  if (client) await client.end();
});

async function ready(label: string, historyId: string | null) {
  const mail = await mailbox(client, label);
  const imported = await completedImport(client, mail);
  await dueCursor(client, mail, imported.horizon, historyId);
  return { mail, imported };
}

d("B08 incremental sync", () => {
  it("does not call Gmail when no completed historical import exists", async () => {
    const mail = await mailbox(client, "b08-no-horizon");
    const gmail = createFakeIncremental();
    const outcome = await runAccountSync(mail, depsFor(client, gmail));
    expect(outcome.result).toBe("no_historical_horizon");
    expect(outcome.gmailCalls).toBe(0);
    expect(gmail.calls.historyStarts).toEqual([]);
    expect(gmail.calls.sentCalls).toBe(0);
  });

  it("refuses to sync while a historical import is still active", async () => {
    const mail = await mailbox(client, "b08-active-import");
    await client.query(
      `insert into private.gmail_historical_import_runs
         (user_id, mail_account_id, window_start_at, window_end_at, status, phase)
       values ($1, $2, now() - interval '10 days', now(), 'runnable', 'enumerating')`,
      [mail.userId, mail.mailAccountId],
    );
    const gmail = createFakeIncremental();
    const outcome = await runAccountSync(mail, depsFor(client, gmail));
    expect(outcome.result).toBe("historical_import_active");
    expect(outcome.gmailCalls).toBe(0);
  });

  it("stores an in-window sent message and its reply once, then waits 15 minutes", async () => {
    const { mail } = await ready("b08-happy", "100");
    const sent = textMessage({ id: "m-sent", threadId: "t-sent", internalDateMs: recent() });
    const reply = textMessage({
      id: "m-reply",
      threadId: "t-sent",
      internalDateMs: recent() + 1000,
      labelIds: ["INBOX"],
    });
    const gmail = createFakeIncremental({
      historyPages: [
        {
          historyId: "150",
          nextPageToken: null,
          threads: [{ providerThreadId: "t-sent", labelIds: ["SENT"] }],
        },
      ],
      threads: { "t-sent": thread("t-sent", [sent, reply]) },
    });
    let pipelined = 0;
    const outcome = await runAccountSync(
      mail,
      depsFor(client, gmail, async () => {
        pipelined += 1;
        return { completed: true };
      }),
    );
    expect(outcome.result).toBe("not_due");
    expect(pipelined).toBe(1);
    expect(gmail.calls.historyStarts).toEqual(["100"]);
    expect(await rawCount(client, mail.mailAccountId)).toBe(2);

    const again = await runAccountSync(mail, depsFor(client, gmail));
    expect(again.result).toBe("not_due");
    expect(again.gmailCalls).toBe(0);
    expect(await rawCount(client, mail.mailAccountId)).toBe(2);

    await client.query(
      "update private.gmail_sync_cursors set next_sync_at = now() where mail_account_id = $1",
      [mail.mailAccountId],
    );
    const replay = createFakeIncremental({
      historyPages: [
        {
          historyId: "160",
          nextPageToken: null,
          threads: [{ providerThreadId: "t-sent", labelIds: ["SENT"] }],
        },
      ],
      threads: { "t-sent": thread("t-sent", [sent, reply]) },
    });
    await runAccountSync(mail, depsFor(client, replay));
    expect(await rawCount(client, mail.mailAccountId)).toBe(2);
    expect(replay.calls.historyStarts).toEqual(["150"]);
  });

  it("filters an inbound-only thread and stores nothing from it", async () => {
    const { mail } = await ready("b08-inbound", "100");
    const gmail = createFakeIncremental({
      historyPages: [
        {
          historyId: "151",
          nextPageToken: null,
          threads: [{ providerThreadId: "t-news", labelIds: ["INBOX"] }],
        },
      ],
    });
    const outcome = await runAccountSync(mail, depsFor(client, gmail));
    expect(outcome.result).toBe("not_due");
    expect(gmail.calls.threadIds).toEqual([]);
    expect(await rawCount(client, mail.mailAccountId)).toBe(0);
    const filtered = await client.query<{ n: number }>(
      `select count(*)::int as n from private.gmail_sync_threads
        where mail_account_id = $1 and status = 'filtered_out'`,
      [mail.mailAccountId],
    );
    expect(filtered.rows[0]!.n).toBe(1);
  });

  it("does not treat a sent message outside both windows as a new root", async () => {
    const { mail } = await ready("b08-outside", "100");
    const outside = textMessage({
      id: "m-old-sent",
      threadId: "t-old",
      internalDateMs: old(),
    });
    const gmail = createFakeIncremental({
      historyPages: [
        {
          historyId: "152",
          nextPageToken: null,
          threads: [{ providerThreadId: "t-old", labelIds: ["SENT"] }],
        },
      ],
      threads: { "t-old": thread("t-old", [outside]) },
    });
    await runAccountSync(mail, depsFor(client, gmail));
    expect(gmail.calls.threadIds).toEqual(["t-old"]);
    expect(await rawCount(client, mail.mailAccountId)).toBe(0);
  });

  it("stores a reply on a thread whose sent root was already imported", async () => {
    const { mail } = await ready("b08-known-reply", "100");
    await client.query(
      `insert into private.gmail_raw_messages
         (mail_account_id, user_id, provider_message_id, provider_thread_id, internal_date,
          label_ids, sanitized_payload, payload_sha256)
       values ($1, $2, 'm-root', 't-known', now() - interval '10 days',
               '{SENT}', '{}'::jsonb, $3)`,
      [mail.mailAccountId, mail.userId, "a".repeat(64)],
    );
    const reply = textMessage({
      id: "m-known-reply",
      threadId: "t-known",
      internalDateMs: recent(),
      labelIds: ["INBOX"],
    });
    const gmail = createFakeIncremental({
      historyPages: [
        {
          historyId: "153",
          nextPageToken: null,
          threads: [{ providerThreadId: "t-known", labelIds: ["INBOX"] }],
        },
      ],
      threads: { "t-known": thread("t-known", [reply]) },
    });
    await runAccountSync(mail, depsFor(client, gmail));
    const ids = await client.query<{ provider_message_id: string }>(
      `select provider_message_id from private.gmail_raw_messages
        where mail_account_id = $1 order by provider_message_id`,
      [mail.mailAccountId],
    );
    expect(ids.rows.map((row) => row.provider_message_id)).toEqual(["m-known-reply", "m-root"]);
  });

  it("drops drafts and does not store them", async () => {
    const { mail } = await ready("b08-draft", "100");
    const sent = textMessage({ id: "m-real", threadId: "t-draft", internalDateMs: recent() });
    const draft = draftMessage({ id: "m-draft", threadId: "t-draft", internalDateMs: recent() });
    const gmail = createFakeIncremental({
      historyPages: [
        {
          historyId: "154",
          nextPageToken: null,
          threads: [{ providerThreadId: "t-draft", labelIds: ["SENT"] }],
        },
      ],
      threads: { "t-draft": thread("t-draft", [sent, draft]) },
    });
    await runAccountSync(mail, depsFor(client, gmail));
    const ids = await client.query<{ provider_message_id: string }>(
      "select provider_message_id from private.gmail_raw_messages where mail_account_id = $1",
      [mail.mailAccountId],
    );
    expect(ids.rows.map((row) => row.provider_message_id)).toEqual(["m-real"]);
  });

  it("switches to a bounded re-scan when history.list returns 404", async () => {
    const { mail } = await ready("b08-404", "100");
    const sent = textMessage({ id: "m-after-404", threadId: "t-404", internalDateMs: recent() });
    const gmail = createFakeIncremental({
      historyErrors: [
        new GmailReadError({
          operation: "history_list",
          status: 404,
          reason: "history_id_expired",
          retryable: false,
        }),
      ],
      sentThreadIds: ["t-404"],
      threads: { "t-404": thread("t-404", [sent]) },
      profileHistoryId: "777",
    });
    const outcome = await runAccountSync(mail, depsFor(client, gmail));
    expect(outcome.result).toBe("not_due");
    expect(gmail.calls.historyStarts).toEqual(["100"]);
    expect(gmail.calls.order).toEqual(["history", "profile", "sent", "thread"]);
    expect(gmail.calls.sentCalls).toBe(1);
    expect(gmail.calls.profileCalls).toBe(1);
    const cursor = await cursorOf(client, mail.mailAccountId);
    expect(cursor.history_id).toBe("777");
    expect(await rawCount(client, mail.mailAccountId)).toBe(1);
    const mode = await client.query<{ mode: string }>(
      `select mode from private.gmail_sync_runs
        where mail_account_id = $1 and status = 'completed'`,
      [mail.mailAccountId],
    );
    expect(mode.rows[0]!.mode).toBe("bounded_rescan");
  });

  async function mailArrivingDuringRescan(
    label: string,
    prepare: () => Promise<{ userId: string; mailAccountId: string }>,
    historyErrors: GmailReadError[] | undefined,
    firstOrder: string[],
  ) {
    const mail = await prepare();
    const threads: Record<string, ReturnType<typeof thread>> = {};
    let gapMs = 0;
    const gmail = createFakeIncremental({
      historyErrors,
      sentThreadIds: ["t-during"],
      profileHistoryId: "100",
      profileHistoryIdAfterScan: "900",
      threads,
      historyByStart: {
        "100": {
          historyId: "150",
          nextPageToken: null,
          threads: [{ providerThreadId: "t-during", labelIds: ["SENT"] }],
        },
      },
      beforeGetThread: async (threadId) => {
        if (gapMs === 0) {
          const run = await client.query<{ window_end_at: Date }>(
            `select window_end_at from private.gmail_sync_runs
              where mail_account_id = $1 and status = 'runnable'`,
            [mail.mailAccountId],
          );
          gapMs = run.rows[0]!.window_end_at.getTime() + 1;
        }
        threads[threadId] = thread(threadId, [
          textMessage({
            id: "m-during",
            threadId,
            internalDateMs: gapMs,
            labelIds: ["SENT"],
          }),
        ]);
      },
    });

    const first = await runAccountSync(mail, depsFor(client, gmail));
    expect(first.result).toBe("not_due");
    expect(gmail.calls.order).toEqual(firstOrder);
    expect(gmail.calls.profileCalls).toBe(1);
    expect((await cursorOf(client, mail.mailAccountId)).history_id).toBe("100");
    expect(await rawCount(client, mail.mailAccountId)).toBe(0);
    const duringSnap = await client.query<{ snapshot_sent_message_ids: string[] }>(
      `select snapshot_sent_message_ids from private.gmail_sync_threads
        where mail_account_id = $1 and provider_thread_id = 't-during'`,
      [mail.mailAccountId],
    );
    expect(duringSnap.rows[0]?.snapshot_sent_message_ids ?? []).not.toContain("m-during");

    await client.query("select pg_sleep(0.05)");
    await client.query(
      "update private.gmail_sync_cursors set next_sync_at = now() where mail_account_id = $1",
      [mail.mailAccountId],
    );
    const second = await runAccountSync(mail, depsFor(client, gmail));
    expect(second.result).toBe("not_due");
    expect(gmail.calls.profileCalls).toBe(1);
    expect(gmail.calls.historyStarts.at(-1)).toBe("100");
    const ids = await client.query<{ provider_message_id: string }>(
      `select provider_message_id from private.gmail_raw_messages
        where mail_account_id = $1 order by provider_message_id`,
      [mail.mailAccountId],
    );
    expect(ids.rows.map((row) => row.provider_message_id)).toEqual(["m-during"]);
  }

  it("picks up mail that arrives during the first bounded re-scan on the next poll", async () => {
    await mailArrivingDuringRescan(
      "b08-gap-first",
      async () => {
        const mail = await mailbox(client, "b08-gap-first");
        await completedImport(client, mail);
        return mail;
      },
      undefined,
      ["profile", "sent", "thread"],
    );
  });

  async function messageInsideSnapshotAfterClaimWindow(input: {
    label: string;
    historyId: string | null;
    snapshotHistoryId: string;
    place: "profile" | "history";
    offsetMs?: number;
    /** Place the message on the exclusive `before:` second of the search window. */
    atExclusiveBeforeSecond?: boolean;
  }) {
    const { mail, imported } = await ready(input.label, input.historyId);
    const threads: Record<string, ReturnType<typeof thread>> = {};
    const placed = { internalDateMs: 0 };
    const placeMessage = async () => {
      if (placed.internalDateMs !== 0) return;
      const run = await client.query<{ window_end_at: Date }>(
        `select window_end_at from private.gmail_sync_runs
          where mail_account_id = $1 and status = 'runnable'`,
        [mail.mailAccountId],
      );
      // Later than the claim window by enough that the snapshot commit's own
      // clock cannot catch it. The message already exists when the snapshot
      // is taken.
      placed.internalDateMs = run.rows[0]!.window_end_at.getTime() + (input.offsetMs ?? 5_000);
      threads["t-snap"] = thread("t-snap", [
        textMessage({
          id: "m-snap",
          threadId: "t-snap",
          internalDateMs: placed.internalDateMs,
          historyId: input.place === "profile" ? input.snapshotHistoryId : "9001",
          labelIds: ["SENT"],
        }),
      ]);
    };
    const gmail = createFakeIncremental({
      sentThreadIds: input.place === "profile" ? ["t-snap"] : [],
      profileHistoryId: input.snapshotHistoryId,
      profileHistoryIdAfterScan: "9000",
      threads,
      historyPages:
        input.place === "history"
          ? [
              {
                historyId: input.snapshotHistoryId,
                nextPageToken: null,
                threads: [
                  {
                    providerThreadId: "t-snap",
                    labelIds: ["SENT"],
                    messageIds: ["m-snap"],
                  },
                ],
              },
            ]
          : undefined,
      beforeGetProfile:
        input.place === "profile" && !input.atExclusiveBeforeSecond ? placeMessage : undefined,
      beforeListHistory: input.place === "history" ? placeMessage : undefined,
      beforeListSent: input.atExclusiveBeforeSecond
        ? async ({ windowEndMs }) => {
            const exclusiveSecond = Math.ceil(windowEndMs / 1000);
            placed.internalDateMs = Math.max(windowEndMs + 1, exclusiveSecond * 1000);
            if (Math.floor(placed.internalDateMs / 1000) !== exclusiveSecond) {
              throw new Error("fixture missed the exclusive before second");
            }
            threads["t-snap"] = thread("t-snap", [
              textMessage({
                id: "m-snap",
                threadId: "t-snap",
                internalDateMs: placed.internalDateMs,
                historyId: input.snapshotHistoryId,
                labelIds: ["SENT"],
              }),
            ]);
          }
        : undefined,
    });

    const first = await runAccountSync(mail, depsFor(client, gmail));
    expect(first.result).toBe("not_due");
    expect(gmail.calls.threadIds).toContain("t-snap");
    expect(await rawCount(client, mail.mailAccountId)).toBe(1);
    const ids = await client.query<{ provider_message_id: string }>(
      `select provider_message_id from private.gmail_raw_messages
        where mail_account_id = $1 order by provider_message_id`,
      [mail.mailAccountId],
    );
    expect(ids.rows.map((row) => row.provider_message_id)).toEqual(["m-snap"]);
    const cursor = await cursorOf(client, mail.mailAccountId);
    expect(cursor.history_id).toBe(input.snapshotHistoryId);
    expect(cursor.horizon_end_at.getTime()).toBeGreaterThan(imported.horizon.getTime());

    await client.query(
      "update private.gmail_sync_cursors set next_sync_at = now() where mail_account_id = $1",
      [mail.mailAccountId],
    );
    const second = createFakeIncremental({
      historyByStart: {
        [input.snapshotHistoryId]: {
          historyId: input.snapshotHistoryId,
          nextPageToken: null,
          threads: [],
        },
      },
    });
    const again = await runAccountSync(mail, depsFor(client, second));
    expect(again.result).toBe("not_due");
    expect(second.calls.historyStarts.at(-1)).toBe(input.snapshotHistoryId);
    expect(await rawCount(client, mail.mailAccountId)).toBe(1);
  }

  it("stores sent mail that is inside the profile snapshot and after the claim window", async () => {
    await messageInsideSnapshotAfterClaimWindow({
      label: "b08-snap-profile",
      historyId: null,
      snapshotHistoryId: "500",
      place: "profile",
      offsetMs: 5_000,
    });
  });

  it("stores sent mail inside the profile snapshot when its second equals the exclusive before bound", async () => {
    await messageInsideSnapshotAfterClaimWindow({
      label: "b08-snap-profile-bound",
      historyId: null,
      snapshotHistoryId: "500",
      place: "profile",
      atExclusiveBeforeSecond: true,
    });
  });

  it("stores a profile-snapshot sent message that has no historyId and is dated after the window", async () => {
    const { mail, imported } = await ready("b08-bare-history", null);
    const threads: Record<string, ReturnType<typeof thread>> = {};
    const placed = { internalDateMs: 0 };
    const gmail = createFakeIncremental({
      sentThreadIds: ["t-bare"],
      profileHistoryId: "500",
      profileHistoryIdAfterScan: "9000",
      threads,
      beforeGetProfile: async () => {
        if (placed.internalDateMs !== 0) return;
        const run = await client.query<{ window_end_at: Date }>(
          `select window_end_at from private.gmail_sync_runs
            where mail_account_id = $1 and status = 'runnable'`,
          [mail.mailAccountId],
        );
        placed.internalDateMs = run.rows[0]!.window_end_at.getTime() + 5_000;
        const message = textMessage({
          id: "m-bare",
          threadId: "t-bare",
          internalDateMs: placed.internalDateMs,
          labelIds: ["SENT"],
        });
        delete message.historyId;
        threads["t-bare"] = thread("t-bare", [message]);
      },
    });

    const first = await runAccountSync(mail, depsFor(client, gmail));
    expect(first.result).toBe("not_due");
    expect(gmail.calls.order.slice(0, 3)).toEqual(["profile", "sent", "thread"]);
    expect(gmail.calls.threadIds).toEqual(["t-bare"]);
    expect(await rawCount(client, mail.mailAccountId)).toBe(1);
    const ids = await client.query<{ provider_message_id: string }>(
      `select provider_message_id from private.gmail_raw_messages
        where mail_account_id = $1`,
      [mail.mailAccountId],
    );
    expect(ids.rows.map((row) => row.provider_message_id)).toEqual(["m-bare"]);
    const snap = await client.query<{
      status: string;
      snapshot_sent_message_ids: string[];
    }>(
      `select status, snapshot_sent_message_ids from private.gmail_sync_threads
        where mail_account_id = $1 and provider_thread_id = 't-bare'`,
      [mail.mailAccountId],
    );
    expect(snap.rows[0]?.status).toBe("complete");
    expect(snap.rows[0]?.snapshot_sent_message_ids).toEqual(["m-bare"]);
    const cursor = await cursorOf(client, mail.mailAccountId);
    expect(cursor.history_id).toBe("500");
    expect(cursor.horizon_end_at.getTime()).toBeGreaterThan(imported.horizon.getTime());

    await client.query(
      "update private.gmail_sync_cursors set next_sync_at = now() where mail_account_id = $1",
      [mail.mailAccountId],
    );
    const second = createFakeIncremental({
      historyByStart: {
        "500": { historyId: "500", nextPageToken: null, threads: [] },
      },
    });
    const again = await runAccountSync(mail, depsFor(client, second));
    expect(again.result).toBe("not_due");
    expect(second.calls.historyStarts).toEqual(["500"]);
    expect(await rawCount(client, mail.mailAccountId)).toBe(1);
    expect((await cursorOf(client, mail.mailAccountId)).history_id).toBe("500");
  });

  it("stores sent mail that is inside the history.list snapshot and after the claim window", async () => {
    await messageInsideSnapshotAfterClaimWindow({
      label: "b08-snap-history",
      historyId: "100",
      snapshotHistoryId: "700",
      place: "history",
    });
  });

  it("advances the cursor when a history.list sent message is dated before the window", async () => {
    const { mail, imported } = await ready("b08-early-history", "100");
    const gmail = createFakeIncremental({
      historyPages: [
        {
          historyId: "180",
          nextPageToken: null,
          threads: [{ providerThreadId: "t-early", labelIds: ["SENT"], messageIds: ["m-early"] }],
        },
      ],
      threads: {
        "t-early": thread("t-early", [
          textMessage({
            id: "m-early",
            threadId: "t-early",
            internalDateMs: imported.horizon.getTime() - 1000,
            historyId: "180",
            labelIds: ["SENT"],
          }),
        ]),
      },
    });
    const first = await runAccountSync(mail, depsFor(client, gmail));
    expect(first.result).toBe("not_due");
    expect(gmail.calls.threadIds).toEqual(["t-early"]);
    expect(await rawCount(client, mail.mailAccountId)).toBe(0);
    const cursor = await cursorOf(client, mail.mailAccountId);
    expect(cursor.history_id).toBe("180");
    expect(cursor.horizon_end_at.getTime()).toBeGreaterThan(imported.horizon.getTime());

    await client.query(
      `update private.gmail_sync_cursors
          set next_sync_at = now(), pipeline_pending = false
        where mail_account_id = $1`,
      [mail.mailAccountId],
    );
    const again = await runAccountSync(
      mail,
      depsFor(
        client,
        createFakeIncremental({
          historyByStart: {
            "180": { historyId: "180", nextPageToken: null, threads: [] },
          },
        }),
      ),
    );
    expect(again.result).toBe("not_due");
    expect((await cursorOf(client, mail.mailAccountId)).history_id).toBe("180");
    expect(await rawCount(client, mail.mailAccountId)).toBe(0);
  });

  it("does not advance history_id past a snapshot sent message this run did not store", async () => {
    const { mail, imported } = await ready("b08-withhold", "100");
    const db = rpc(client);
    const claim = await db.rpc("gmail_incremental_sync_claim_step", {
      p_user_id: mail.userId,
      p_mail_account_id: mail.mailAccountId,
      p_lease_seconds: 30,
    });
    const body = claim.data as {
      result: string;
      run_id: string;
      lease_token: string;
      authorization_revision: number;
      step: string;
    };
    expect(body.result).toBe("ok");
    expect(body.step).toBe("enumerate_history");
    const page = await db.rpc("gmail_incremental_sync_commit_history_page", {
      p_user_id: mail.userId,
      p_run_id: body.run_id,
      p_lease_token: body.lease_token,
      p_expected_authorization_revision: body.authorization_revision,
      p_page_token_used: null,
      p_next_page_token: null,
      p_history_id: "700",
      p_threads: [
        {
          provider_thread_id: "t-lost",
          messages: [{ provider_message_id: "m-lost", label_ids: ["SENT"] }],
        },
      ],
      p_quota_units: 2,
    });
    expect((page.data as { result: string }).result).toBe("ok");

    const fetchClaim = await db.rpc("gmail_incremental_sync_claim_step", {
      p_user_id: mail.userId,
      p_mail_account_id: mail.mailAccountId,
      p_lease_seconds: 30,
    });
    const fetchBody = fetchClaim.data as {
      result: string;
      step: string;
      run_id: string;
      lease_token: string;
      authorization_revision: number;
      provider_thread_id: string;
    };
    expect(fetchBody.result).toBe("ok");
    expect(fetchBody.step).toBe("fetch_thread");
    expect(fetchBody.provider_thread_id).toBe("t-lost");
    const dropped = await db.rpc("gmail_incremental_sync_commit_thread", {
      p_user_id: mail.userId,
      p_run_id: fetchBody.run_id,
      p_lease_token: fetchBody.lease_token,
      p_expected_authorization_revision: fetchBody.authorization_revision,
      p_provider_thread_id: "t-lost",
      p_messages: [],
      p_quota_units: 40,
    });
    expect((dropped.data as { result: string }).result).toBe("filtered_out");

    const doneClaim = await db.rpc("gmail_incremental_sync_claim_step", {
      p_user_id: mail.userId,
      p_mail_account_id: mail.mailAccountId,
      p_lease_seconds: 30,
    });
    const doneBody = doneClaim.data as {
      result: string;
      step: string;
      run_id: string;
      lease_token: string;
      authorization_revision: number;
    };
    expect(doneBody.step).toBe("complete_run");
    const done = await db.rpc("gmail_incremental_sync_commit_completion", {
      p_user_id: mail.userId,
      p_run_id: doneBody.run_id,
      p_lease_token: doneBody.lease_token,
      p_expected_authorization_revision: doneBody.authorization_revision,
    });
    expect((done.data as { result: string; history_id_advanced: boolean }).result).toBe("ok");
    expect((done.data as { history_id_advanced: boolean }).history_id_advanced).toBe(false);
    const cursor = await cursorOf(client, mail.mailAccountId);
    expect(cursor.history_id).toBe("100");
    expect(cursor.horizon_end_at.getTime()).toBe(imported.horizon.getTime());
    expect(await rawCount(client, mail.mailAccountId)).toBe(0);
  });

  it("does not advance history_id when threads.get is gone for an unstored sent id", async () => {
    const { mail } = await ready("b08-gone-sent", "100");
    const gmail = createFakeIncremental({
      historyPages: [
        {
          historyId: "250",
          nextPageToken: null,
          threads: [{ providerThreadId: "t-gone", labelIds: ["SENT"], messageIds: ["m-gone"] }],
        },
      ],
      missingThreads: ["t-gone"],
    });
    const outcome = await runAccountSync(mail, depsFor(client, gmail));
    expect(outcome.result).toBe("not_due");
    expect(gmail.calls.threadIds).toContain("t-gone");
    expect(await rawCount(client, mail.mailAccountId)).toBe(0);
    const thread = await client.query<{ status: string; snapshot_sent_message_ids: string[] }>(
      `select status, snapshot_sent_message_ids
         from private.gmail_sync_threads
        where mail_account_id = $1 and provider_thread_id = 't-gone'`,
      [mail.mailAccountId],
    );
    expect(thread.rows[0]?.status).toBe("gone");
    expect(thread.rows[0]?.snapshot_sent_message_ids).toContain("m-gone");
    expect((await cursorOf(client, mail.mailAccountId)).history_id).toBe("100");
  });

  it("picks up mail that arrives during a historyId 404 re-scan on the next poll", async () => {
    await mailArrivingDuringRescan(
      "b08-gap-404",
      async () => (await ready("b08-gap-404", "55")).mail,
      [
        new GmailReadError({
          operation: "history_list",
          status: 404,
          reason: "history_id_expired",
          retryable: false,
        }),
      ],
      ["history", "profile", "sent", "thread"],
    );
  });

  it("re-fetches an already stored sent thread during a bounded re-scan", async () => {
    const mail = await mailbox(client, "b08-rescan-known");
    const imported = await completedImport(client, mail);
    await client.query(
      `insert into private.gmail_raw_messages
         (mail_account_id, user_id, provider_message_id, provider_thread_id, internal_date,
          label_ids, sanitized_payload, payload_sha256)
       values ($1, $2, 'm-stored', 't-stored', now() - interval '10 days',
               '{SENT}', '{}'::jsonb, $3)`,
      [mail.mailAccountId, mail.userId, "b".repeat(64)],
    );
    const reply = textMessage({
      id: "m-stored-reply",
      threadId: "t-stored",
      internalDateMs: recent(),
      labelIds: ["INBOX"],
    });
    const gmail = createFakeIncremental({
      sentThreadIds: [],
      threads: { "t-stored": thread("t-stored", [reply]) },
      profileHistoryId: "801",
    });
    const outcome = await runAccountSync(mail, depsFor(client, gmail));
    expect(outcome.result).toBe("not_due");
    expect(gmail.calls.historyStarts).toEqual([]);
    expect(gmail.calls.threadIds).toContain("t-stored");
    expect(await rawCount(client, mail.mailAccountId)).toBe(2);
    const cursor = await cursorOf(client, mail.mailAccountId);
    expect(cursor.history_id).toBe("801");
    expect(cursor.horizon_end_at.getTime()).toBeGreaterThan(imported.horizon.getTime());
  });

  it("does not complete a run when history.list is malformed", async () => {
    const { mail, imported } = await ready("b08-malformed", "100");
    const gmail = createFakeIncremental({
      historyErrors: [
        new GmailReadError({
          operation: "history_list",
          status: null,
          reason: "malformed_response",
          retryable: false,
        }),
      ],
    });
    const outcome = await runAccountSync(mail, depsFor(client, gmail));
    expect(outcome.result).toBe("failed");
    const cursor = await cursorOf(client, mail.mailAccountId);
    expect(cursor.history_id).toBe("100");
    expect(cursor.horizon_end_at.getTime()).toBe(imported.horizon.getTime());
    expect(await rawCount(client, mail.mailAccountId)).toBe(0);
  });

  it("fails the run after five retryable history errors without moving the cursor", async () => {
    const { mail, imported } = await ready("b08-retry", "100");
    const gmail = createFakeIncremental({
      historyErrors: Array.from(
        { length: 5 },
        () =>
          new GmailReadError({
            operation: "history_list",
            status: 503,
            reason: "service_unavailable",
            retryable: true,
          }),
      ),
    });
    const deps = depsFor(client, gmail);
    let last = "";
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await client.query(
        `update private.gmail_sync_runs
            set next_attempt_at = now() - interval '1 second'
          where mail_account_id = $1 and status = 'runnable'`,
        [mail.mailAccountId],
      );
      last = (await runAccountSync(mail, deps)).result;
    }
    expect(last).toBe("failed");
    const cursor = await cursorOf(client, mail.mailAccountId);
    expect(cursor.history_id).toBe("100");
    expect(cursor.horizon_end_at.getTime()).toBe(imported.horizon.getTime());
    expect(cursor.next_sync_at.getTime()).toBeGreaterThan(Date.now());
  });

  it("lets one claim hold the lease so a second claim does not read Gmail", async () => {
    const { mail } = await ready("b08-lease", "100");
    const other = new Client({ connectionString: TEST_DB });
    await other.connect();
    try {
      const [first, second] = await Promise.all([
        rpc(client).rpc("gmail_incremental_sync_claim_step", {
          p_user_id: mail.userId,
          p_mail_account_id: mail.mailAccountId,
          p_lease_seconds: 120,
        }),
        rpc(other).rpc("gmail_incremental_sync_claim_step", {
          p_user_id: mail.userId,
          p_mail_account_id: mail.mailAccountId,
          p_lease_seconds: 120,
        }),
      ]);
      const results = [first.data, second.data].map((row) => (row as { result: string }).result);
      expect(results.sort()).toEqual(["leased", "ok"]);
    } finally {
      await other.end();
    }
    const gmail = createFakeIncremental();
    const outcome = await runAccountSync(mail, depsFor(client, gmail));
    expect(outcome.result).toBe("leased");
    expect(outcome.gmailCalls).toBe(0);
  });

  it("treats a replay of an earlier history page as already applied", async () => {
    const { mail } = await ready("b08-replay-page", "100");
    const db = rpc(client);
    const claim = await db.rpc("gmail_incremental_sync_claim_step", {
      p_user_id: mail.userId,
      p_mail_account_id: mail.mailAccountId,
      p_lease_seconds: 120,
    });
    const body = claim.data as {
      result: string;
      run_id: string;
      lease_token: string;
      authorization_revision: number;
    };
    expect(body.result).toBe("ok");
    const first = await db.rpc("gmail_incremental_sync_commit_history_page", {
      p_user_id: mail.userId,
      p_run_id: body.run_id,
      p_lease_token: body.lease_token,
      p_expected_authorization_revision: body.authorization_revision,
      p_page_token_used: null,
      p_next_page_token: "page-2",
      p_history_id: "110",
      p_threads: [],
      p_quota_units: 2,
    });
    expect((first.data as { result: string }).result).toBe("ok");
    const again = await db.rpc("gmail_incremental_sync_claim_step", {
      p_user_id: mail.userId,
      p_mail_account_id: mail.mailAccountId,
      p_lease_seconds: 120,
    });
    const live = again.data as {
      run_id: string;
      lease_token: string;
      authorization_revision: number;
    };
    const replay = await db.rpc("gmail_incremental_sync_commit_history_page", {
      p_user_id: mail.userId,
      p_run_id: live.run_id,
      p_lease_token: live.lease_token,
      p_expected_authorization_revision: live.authorization_revision,
      p_page_token_used: null,
      p_next_page_token: "page-2",
      p_history_id: "110",
      p_threads: [],
      p_quota_units: 2,
    });
    expect((replay.data as { result: string }).result).toBe("already_applied");
  });

  it("does not sync a disconnected mailbox, and a reconnect starts a new run", async () => {
    const { mail } = await ready("b08-disconnect", "100");
    const claim = await rpc(client).rpc("gmail_incremental_sync_claim_step", {
      p_user_id: mail.userId,
      p_mail_account_id: mail.mailAccountId,
      p_lease_seconds: 30,
    });
    expect((claim.data as { result: string }).result).toBe("ok");
    await setConnectionState(client, mail.mailAccountId, "disconnected");
    const gmail = createFakeIncremental();
    const stopped = await runAccountSync(mail, depsFor(client, gmail));
    expect(stopped.result).toBe("not_connected");
    expect(stopped.gmailCalls).toBe(0);
    const cancelled = await client.query<{ status: string }>(
      "select status from private.gmail_sync_runs where mail_account_id = $1",
      [mail.mailAccountId],
    );
    expect(cancelled.rows.map((row) => row.status)).toEqual(["cancelled_connection_stopped"]);
    expect((await cursorOf(client, mail.mailAccountId)).history_id).toBe("100");

    await client.query("begin");
    await client.query(
      `insert into private.gmail_oauth_credentials
         (mail_account_id, user_id, refresh_token_ciphertext, refresh_token_iv,
          refresh_token_auth_tag, encryption_key_version)
       values ($1, $2, 'ct', 'iv', 'tag', 'v1')`,
      [mail.mailAccountId, mail.userId],
    );
    await client.query(
      `update public.mail_accounts
          set connection_state = 'connected', granted_scopes = $2, disconnected_at = null
        where id = $1`,
      [mail.mailAccountId, SCOPES],
    );
    await client.query("commit");
    const resumed = await client.query<{ status: string }>(
      `select status from private.gmail_sync_runs
        where mail_account_id = $1 and status = 'cancelled_connection_stopped'`,
      [mail.mailAccountId],
    );
    expect(resumed.rows).toHaveLength(1);

    const next = createFakeIncremental({
      historyPages: [{ historyId: "180", nextPageToken: null, threads: [] }],
    });
    const outcome = await runAccountSync(mail, depsFor(client, next));
    expect(outcome.result).toBe("not_due");
    expect(next.calls.historyStarts).toEqual(["100"]);
    expect(next.calls.sentCalls).toBe(0);
    const runs = await client.query<{ status: string }>(
      "select status from private.gmail_sync_runs where mail_account_id = $1 order by created_at",
      [mail.mailAccountId],
    );
    expect(runs.rows.map((row) => row.status)).toEqual([
      "cancelled_connection_stopped",
      "completed",
    ]);
  });

  it("makes a login request due inside the 15-minute window, and only for that user", async () => {
    const owner = await ready("b08-login-owner", "100");
    const other = await ready("b08-login-other", "100");
    await client.query(
      `update private.gmail_sync_cursors
          set next_sync_at = now() + interval '10 minutes'
        where mail_account_id = any($1::uuid[])`,
      [[owner.mail.mailAccountId, other.mail.mailAccountId]],
    );
    const gmail = createFakeIncremental({
      historyPages: [{ historyId: "190", nextPageToken: null, threads: [] }],
    });
    const quiet = await runAccountSync(owner.mail, depsFor(client, gmail));
    expect(quiet.result).toBe("not_due");
    expect(quiet.gmailCalls).toBe(0);

    await client.query(
      `insert into public.access_entitlements
         (user_id, access_type, status, starts_at, source, source_reference)
       values ($1, 'pro', 'active', now(), 'test', $2)`,
      [owner.mail.userId, `b08-login-pro-${owner.mail.userId}`],
    );
    await syncOnCreatorLogin(owner.mail.userId, depsFor(client, gmail));
    const ownerRuns = await client.query<{ n: number }>(
      `select count(*)::int as n from private.gmail_sync_runs
        where mail_account_id = $1 and status = 'completed'`,
      [owner.mail.mailAccountId],
    );
    const otherRuns = await client.query<{ n: number }>(
      "select count(*)::int as n from private.gmail_sync_runs where mail_account_id = $1",
      [other.mail.mailAccountId],
    );
    expect(ownerRuns.rows[0]!.n).toBe(1);
    expect(otherRuns.rows[0]!.n).toBe(0);
    expect(gmail.calls.historyStarts).toEqual(["100"]);
  });

  it("pauses Free Gmail sync at login and on the due list without deleting mailbox data", async () => {
    const free = await ready("b08-free-pause", "100");
    const paid = await ready("b08-paid-due", "100");
    await client.query(
      `insert into public.access_entitlements
         (user_id, access_type, status, starts_at, source, source_reference)
       values ($1, 'pro', 'active', now(), 'test', $2)`,
      [paid.mail.userId, `b08-due-pro-${paid.mail.userId}`],
    );
    await client.query(
      `update private.gmail_sync_cursors
          set login_sync_requested = true, next_sync_at = now() - interval '1 minute'
        where mail_account_id = $1`,
      [free.mail.mailAccountId],
    );

    const snapshot = async (mailAccountId: string) => {
      const counts = await client.query<{
        accounts: number;
        creds: number;
        cursors: number;
        messages: number;
        runs: number;
      }>(
        `select
           (select count(*)::int from public.mail_accounts where id = $1) as accounts,
           (select count(*)::int from private.gmail_oauth_credentials where mail_account_id = $1) as creds,
           (select count(*)::int from private.gmail_sync_cursors where mail_account_id = $1) as cursors,
           (select count(*)::int from private.gmail_raw_messages where mail_account_id = $1) as messages,
           (select count(*)::int from private.gmail_sync_runs where mail_account_id = $1) as runs`,
        [mailAccountId],
      );
      const state = await client.query<{ connection_state: string }>(
        "select connection_state from public.mail_accounts where id = $1",
        [mailAccountId],
      );
      return { ...counts.rows[0]!, connection_state: state.rows[0]!.connection_state };
    };

    const before = await snapshot(free.mail.mailAccountId);
    const gmail = createFakeIncremental();
    await syncOnCreatorLogin(free.mail.userId, depsFor(client, gmail));
    expect(gmail.calls.historyStarts).toEqual([]);
    expect(await snapshot(free.mail.mailAccountId)).toEqual(before);

    const requested = await client.query<{
      result: { result: string; mailboxes_marked: number; mail_account_ids: string[] };
    }>("select public.gmail_incremental_sync_request_login($1) as result", [free.mail.userId]);
    expect(requested.rows[0]!.result).toMatchObject({
      result: "ok",
      mailboxes_marked: 0,
      mail_account_ids: [],
    });
    const cursor = await cursorOf(client, free.mail.mailAccountId);
    expect(cursor.login_sync_requested).toBe(true);

    const listed = await client.query<{
      result: { accounts: { mail_account_id: string }[] };
    }>("select public.gmail_incremental_sync_list_due(100) as result");
    const dueIds = listed.rows[0]!.result.accounts.map((row) => row.mail_account_id);
    expect(dueIds).toContain(paid.mail.mailAccountId);
    expect(dueIds).not.toContain(free.mail.mailAccountId);
    expect(await snapshot(free.mail.mailAccountId)).toEqual(before);
  });

  it("advances B06 only for the thread this sync fetched", async () => {
    const { mail, imported } = await ready("b08-horizon", "100");
    await client.query(
      `insert into private.gmail_historical_import_threads
         (run_id, user_id, mail_account_id, provider_thread_id, status, completed_at)
       values ($1, $2, $3, 't-unfetched', 'complete', now())`,
      [imported.runId, mail.userId, mail.mailAccountId],
    );
    const sent = textMessage({ id: "m-fetched", threadId: "t-fetched", internalDateMs: recent() });
    const gmail = createFakeIncremental({
      historyPages: [
        {
          historyId: "210",
          nextPageToken: null,
          threads: [{ providerThreadId: "t-fetched", labelIds: ["SENT"] }],
        },
      ],
      threads: { "t-fetched": thread("t-fetched", [sent]) },
    });
    await runAccountSync(mail, depsFor(client, gmail));
    const fetched = await client.query<{ at: Date }>(
      "select private.gmail_reply_observed_through_at($1, 't-fetched') as at",
      [mail.mailAccountId],
    );
    const unfetched = await client.query<{ at: Date }>(
      "select private.gmail_reply_observed_through_at($1, 't-unfetched') as at",
      [mail.mailAccountId],
    );
    const run = await client.query<{ window_end_at: Date }>(
      `select window_end_at from private.gmail_sync_runs
        where mail_account_id = $1 and status = 'completed'`,
      [mail.mailAccountId],
    );
    expect(fetched.rows[0]!.at.getTime()).toBe(run.rows[0]!.window_end_at.getTime());
    expect(unfetched.rows[0]!.at.getTime()).toBe(imported.horizon.getTime());
  });

  it("hands a newly stored message to normalization and the stored pipeline", async () => {
    const { mail } = await ready("b08-pipeline", "100");
    const sent = textMessage({ id: "m-norm", threadId: "t-norm", internalDateMs: recent() });
    const gmail = createFakeIncremental({
      historyPages: [
        {
          historyId: "220",
          nextPageToken: null,
          threads: [{ providerThreadId: "t-norm", labelIds: ["SENT"] }],
        },
      ],
      threads: { "t-norm": thread("t-norm", [sent]) },
    });
    const db = rpc(client);
    await runAccountSync(
      mail,
      syncDeps({
        db,
        gmail,
        accessToken: async () => ({ result: "ok", accessToken: "fake-token" }),
        runPipeline: async (input) => {
          await normalizeMailboxUntilIdle({ db }, { ...input, batchSize: 25 });
          return { completed: false };
        },
      }),
    );
    const normalized = await client.query<{ n: number }>(
      "select count(*)::int as n from private.gmail_normalized_messages where mail_account_id = $1",
      [mail.mailAccountId],
    );
    expect(normalized.rows[0]!.n).toBe(1);
    expect((await cursorOf(client, mail.mailAccountId)).pipeline_pending).toBe(true);

    const piped = await runStoredGmailPipeline(db, mail);
    expect(piped.completed).toBe(true);
    const marked = await runAccountSync(
      mail,
      depsFor(client, createFakeIncremental(), async () => ({ completed: true })),
    );
    expect(marked.gmailCalls).toBe(0);
    expect((await cursorOf(client, mail.mailAccountId)).pipeline_pending).toBe(false);
  });

  it("leases the pipeline so login and the worker cannot both insert a commercial attempt", async () => {
    const { mail } = await ready("b08-pipeline-lease", "100");
    const sent = textMessage({ id: "m-lease", threadId: "t-lease", internalDateMs: recent() });
    const gmail = createFakeIncremental({
      historyPages: [
        {
          historyId: "230",
          nextPageToken: null,
          threads: [{ providerThreadId: "t-lease", labelIds: ["SENT"] }],
        },
      ],
      threads: { "t-lease": thread("t-lease", [sent]) },
    });
    const db = rpc(client);
    let entries = 0;
    let nestedResult = "";
    // One row per pipeline entry. Two workers that both pass the commercial
    // "already current" check each insert, because attempts are not unique.
    const insertAttempt = async (digest: string) => {
      await client.query("begin");
      try {
        await client.query("select set_config('b07.machine_writer', 'on', true)");
        await client.query(
          `insert into private.gmail_commercial_thread_attempts
             (user_id, mail_account_id, provider_thread_id, input_digest, schema_version,
              transform_version, engine_kind, rule_version, compensation_structure, evidence_strength)
           values ($1, $2, 't-lease', $3, 'v1', 'v1', 'rules', 'rules_v1', 'unknown',
                   'insufficient_evidence')`,
          [mail.userId, mail.mailAccountId, digest],
        );
        await client.query("commit");
      } catch (error) {
        await client.query("rollback");
        throw error;
      }
    };
    const outcome = await runAccountSync(
      mail,
      syncDeps({
        db,
        gmail,
        accessToken: async () => ({ result: "ok", accessToken: "fake-token" }),
        runPipeline: async () => {
          const nested = await runAccountSync(
            mail,
            syncDeps({
              db,
              gmail: createFakeIncremental(),
              accessToken: async () => ({ result: "ok", accessToken: "fake-token" }),
              runPipeline: async () => {
                entries += 1;
                await insertAttempt("a".repeat(64));
                return { completed: true };
              },
            }),
          );
          nestedResult = nested.result;
          entries += 1;
          await insertAttempt("b".repeat(64));
          return { completed: true };
        },
      }),
    );

    expect(nestedResult).toBe("leased");
    expect(entries).toBe(1);
    expect(outcome.result).toBe("not_due");
    const attempts = await client.query<{ n: number }>(
      `select count(*)::int as n from private.gmail_commercial_thread_attempts
        where mail_account_id = $1`,
      [mail.mailAccountId],
    );
    expect(attempts.rows[0]!.n).toBe(1);
  });

  it("renews the pipeline lease so a second worker cannot enter after the original lease expires", async () => {
    const { mail } = await ready("b08-pipeline-renew", "100");
    const gmail = createFakeIncremental({
      historyPages: [{ historyId: "240", nextPageToken: null, threads: [] }],
    });
    const other = new Client({ connectionString: TEST_DB });
    await other.connect();
    let nestedResult = "";
    try {
      const outcome = await runAccountSync(
        mail,
        syncDeps({
          db: rpc(client),
          gmail,
          accessToken: async () => ({ result: "ok", accessToken: "fake-token" }),
          leaseSeconds: 1,
          runPipeline: async () => {
            await new Promise((resolve) => setTimeout(resolve, 1500));
            const nested = await runAccountSync(
              mail,
              syncDeps({
                db: rpc(other),
                gmail: createFakeIncremental(),
                accessToken: async () => ({ result: "ok", accessToken: "fake-token" }),
                runPipeline: async () => {
                  throw new Error("second worker entered the pipeline");
                },
              }),
            );
            nestedResult = nested.result;
            return { completed: true };
          },
        }),
      );
      expect(nestedResult).toBe("leased");
      expect(outcome.result).toBe("not_due");
    } finally {
      await other.end();
    }
  });

  it("resumes a reauth pause when the mailbox is connected again", async () => {
    const { mail } = await ready("b08-reauth", "100");
    await rpc(client).rpc("gmail_incremental_sync_claim_step", {
      p_user_id: mail.userId,
      p_mail_account_id: mail.mailAccountId,
      p_lease_seconds: 30,
    });
    await setConnectionState(client, mail.mailAccountId, "reauth_required");
    const paused = await client.query<{ status: string }>(
      "select status from private.gmail_sync_runs where mail_account_id = $1",
      [mail.mailAccountId],
    );
    expect(paused.rows[0]!.status).toBe("paused_reauth");
    await client.query("begin");
    await client.query(
      `insert into private.gmail_oauth_credentials
         (mail_account_id, user_id, refresh_token_ciphertext, refresh_token_iv,
          refresh_token_auth_tag, encryption_key_version)
       values ($1, $2, 'ct', 'iv', 'tag', 'v1')`,
      [mail.mailAccountId, mail.userId],
    );
    await client.query(
      `update public.mail_accounts
          set connection_state = 'connected', granted_scopes = $2
        where id = $1`,
      [mail.mailAccountId, SCOPES],
    );
    await client.query("commit");
    const resumed = await client.query<{ status: string }>(
      "select status from private.gmail_sync_runs where mail_account_id = $1",
      [mail.mailAccountId],
    );
    expect(resumed.rows[0]!.status).toBe("runnable");
  });

  it("pauses a revoked token and a retry does not open another run or store mail", async () => {
    const { mail } = await ready("e05-revoked-retry", "100");
    const deps = () =>
      syncDeps({
        db: rpc(client),
        gmail: createFakeIncremental(),
        accessToken: async () => ({ result: "reauth_required" }),
        runPipeline: async () => ({ completed: true }),
      });
    const paused = await runAccountSync(mail, deps());
    expect(paused.result).toBe("paused");
    const runsOf = async () => {
      const rows = await client.query<{ n: number }>(
        "select count(*)::int as n from private.gmail_sync_runs where mail_account_id = $1",
        [mail.mailAccountId],
      );
      return rows.rows[0]!.n;
    };
    const runs = await runsOf();
    const stored = await rawCount(client, mail.mailAccountId);
    expect(runs).toBeGreaterThan(0);
    const again = await runAccountSync(mail, deps());
    expect(again.result).toBe("paused");
    expect(await runsOf()).toBe(runs);
    expect(await rawCount(client, mail.mailAccountId)).toBe(stored);
  });
});
