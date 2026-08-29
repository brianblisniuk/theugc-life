import { readFileSync } from "node:fs";
import path from "node:path";

import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { parseImportArgs, parseWindowStart } from "../../scripts/gmail-import/cli";

import { createFakeGmailRead, textMessage, thread } from "./fake-gmail-read";
import {
  connectedMailbox,
  importDeps,
  rawMessages,
  rpc,
  runRow,
  setConnectionState,
  startDeletion,
  threadRows,
} from "./harness";
import { runImportUntilIdle } from "@/lib/gmail/import/worker.server";

/**
 * B03 §36 (deletion), §21 (Disconnect is not delete), §22/§40 (no raw-content
 * surface) and §23 (the operator worker).
 *
 * B01 promised every future Gmail-derived row would be deletion-addressable.
 * B03 creates the first ones, so this is the file where that promise is either
 * kept or exposed.
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

/** A mailbox with a real, completed import behind it. */
async function importedMailbox(label: string) {
  const mailbox = await connectedMailbox(client, label);
  const started = await rpc(client).rpc("gmail_historical_import_start", {
    p_user_id: mailbox.userId,
    p_mail_account_id: mailbox.mailAccountId,
    p_window_start_at: new Date(Date.now() - 30 * DAY).toISOString(),
  });
  const runId = (started.data as { run_id: string }).run_id;
  const at = Date.now() - 5 * DAY;

  await runImportUntilIdle(
    { userId: mailbox.userId, runId },
    importDeps(client, {
      gmail: createFakeGmailRead({
        pages: [{ candidates: [{ messageId: "m1", threadId: "t1" }], nextPageToken: null }],
        threads: {
          t1: thread("t1", [textMessage({ id: "m1", threadId: "t1", internalDateMs: at })]),
        },
      }),
    }),
  );
  expect(await rawMessages(client, mailbox.mailAccountId)).toHaveLength(1);
  return { ...mailbox, runId };
}

d("B03 deletion", () => {
  it("107. Disconnect stops the work and KEEPS what was already imported", async () => {
    const run = await importedMailbox("b03-del-disconnect");
    await setConnectionState(client, run.mailAccountId, "disconnected");

    // B01 is explicit that stopping access and removing data are different acts,
    // and B02 amendment #5 made the same separation for the credential. Purging
    // history because Gmail was disconnected would delete work the human never
    // asked to lose.
    expect(await rawMessages(client, run.mailAccountId)).toHaveLength(1);
    expect(await threadRows(client, run.runId)).toHaveLength(1);
  });

  it("108-111. the purge requires the owner, an active deletion and THE current request", async () => {
    const run = await importedMailbox("b03-del-guards");
    const stranger = await connectedMailbox(client, "b03-del-stranger");
    const db = rpc(client);

    // Not deleting at all: purging Gmail content is not a maintenance operation
    // and must not be reachable as one.
    const notDeleting = await db.rpc("gmail_historical_import_purge_for_deletion", {
      p_user_id: run.userId,
      p_mail_account_id: run.mailAccountId,
      p_deletion_request_id: run.runId,
    });
    expect((notDeleting.data as { result: string }).result).toBe("not_deleting");

    const requestId = await startDeletion(client, run.mailAccountId, run.userId);

    // Wrong owner.
    const wrongOwner = await db.rpc("gmail_historical_import_purge_for_deletion", {
      p_user_id: stranger.userId,
      p_mail_account_id: run.mailAccountId,
      p_deletion_request_id: requestId,
    });
    expect((wrongOwner.data as { result: string }).result).toBe("not_found");

    // A request that is not the one this mailbox is waiting on.
    const otherRequest = await db.rpc("gmail_historical_import_purge_for_deletion", {
      p_user_id: run.userId,
      p_mail_account_id: run.mailAccountId,
      p_deletion_request_id: run.runId,
    });
    expect((otherRequest.data as { result: string }).result).toBe("stale_deletion_request");

    expect(await rawMessages(client, run.mailAccountId)).toHaveLength(1);
  });

  it("112. a request must be running — and B01 makes a finished one unreachable", async () => {
    const run = await importedMailbox("b03-del-finished");
    const requestId = await startDeletion(client, run.mailAccountId, run.userId);

    // B03 keeps a `request_not_running` guard, and it is defence in depth: B01
    // will not let a `deletion_pending` mailbox go on naming a request that has
    // finished, because the state is a present-tense claim that specific work is
    // under way. So the purge can never observe the combination it refuses.
    await client.query("begin");
    await client.query(
      "update public.mail_account_deletion_requests set status = 'completed', completed_at = now() where id = $1",
      [requestId],
    );
    await expect(client.query("commit")).rejects.toThrow(
      /is `deletion_pending` but the deletion request it names is completed/,
    );
    await client.query("rollback").catch(() => undefined);

    // The mailbox and its data are untouched by the attempt.
    expect(await rawMessages(client, run.mailAccountId)).toHaveLength(1);
  });

  it("113-114. both Gmail-data scopes purge B03 content and work", async () => {
    for (const scope of ["gmail_derived_data", "account_and_gmail_derived_data"] as const) {
      const run = await importedMailbox(`b03-del-scope-${scope.slice(0, 8)}`);
      const requestId = await startDeletion(client, run.mailAccountId, run.userId, scope);

      const res = await rpc(client).rpc("gmail_historical_import_purge_for_deletion", {
        p_user_id: run.userId,
        p_mail_account_id: run.mailAccountId,
        p_deletion_request_id: requestId,
      });
      expect([scope, (res.data as { result: string }).result]).toEqual([scope, "ok"]);
      expect(await rawMessages(client, run.mailAccountId)).toHaveLength(0);
      expect(await threadRows(client, run.runId)).toHaveLength(0);

      // 115-117. It removes B03 data and NOTHING else: the request is still
      // running, the consent history is intact, and the durable provider
      // ownership reservation is untouched. A data layer that marked its own
      // request complete would be grading its own homework.
      const request = await client.query(
        "select status from public.mail_account_deletion_requests where id = $1",
        [requestId],
      );
      expect(request.rows[0].status).toBe("in_progress");

      const receipts = await client.query(
        "select count(*)::int as n from public.mail_account_consent_receipts where mail_account_id = $1",
        [run.mailAccountId],
      );
      expect(receipts.rows[0].n).toBeGreaterThan(0);

      const ownership = await client.query(
        "select count(*)::int as n from public.mail_provider_account_owners where provider_account_subject = $1",
        [run.subject],
      );
      expect(ownership.rows[0].n).toBe(1);

      // For `gmail_derived_data` the mailbox record itself remains, exactly as
      // B01 says: removing the derived data is not retiring the connection.
      const account = await client.query(
        "select connection_state from public.mail_accounts where id = $1",
        [run.mailAccountId],
      );
      expect(account.rows[0].connection_state).toBe("deletion_pending");
    }
  });

  it("118-119. `deleted` cannot commit while B03 data survives, and can once it does not", async () => {
    const run = await importedMailbox("b03-del-invariant");
    const requestId = await startDeletion(client, run.mailAccountId, run.userId);

    // B01 defines `deleted` as an assertion that stored Gmail data was removed.
    // B03 is the layer that makes that falsifiable, so the word and the rows
    // cannot both stand.
    await client.query("begin");
    await client.query(
      "update public.mail_account_deletion_requests set status = 'completed', completed_at = now() where id = $1",
      [requestId],
    );
    await client.query(
      "update public.mail_accounts set connection_state = 'deleted' where id = $1",
      [run.mailAccountId],
    );
    await expect(client.query("commit")).rejects.toThrow(/is `deleted` while .* raw Gmail message/);

    // With the data actually gone, the same transition commits.
    await client.query("rollback").catch(() => undefined);
    const purge = await rpc(client).rpc("gmail_historical_import_purge_for_deletion", {
      p_user_id: run.userId,
      p_mail_account_id: run.mailAccountId,
      p_deletion_request_id: requestId,
    });
    expect((purge.data as { result: string }).result).toBe("ok");

    await client.query("begin");
    await client.query(
      "update public.mail_account_deletion_requests set status = 'completed', completed_at = now() where id = $1",
      [requestId],
    );
    await client.query(
      "update public.mail_accounts set connection_state = 'deleted' where id = $1",
      [run.mailAccountId],
    );
    await client.query("commit");

    const account = await client.query(
      "select connection_state from public.mail_accounts where id = $1",
      [run.mailAccountId],
    );
    expect(account.rows[0].connection_state).toBe("deleted");
  });

  it("the invariant also refuses B03 rows created UNDER an already-deleted mailbox", async () => {
    // Registered on both origins, for the reason A04.6 and B02 both paid for: an
    // invariant hung off one side is a habit of whoever writes that side.
    const run = await importedMailbox("b03-del-both-origins");
    const requestId = await startDeletion(client, run.mailAccountId, run.userId);
    await rpc(client).rpc("gmail_historical_import_purge_for_deletion", {
      p_user_id: run.userId,
      p_mail_account_id: run.mailAccountId,
      p_deletion_request_id: requestId,
    });
    await client.query("begin");
    await client.query(
      "update public.mail_account_deletion_requests set status = 'completed', completed_at = now() where id = $1",
      [requestId],
    );
    await client.query(
      "update public.mail_accounts set connection_state = 'deleted' where id = $1",
      [run.mailAccountId],
    );
    await client.query("commit");

    await expect(
      client.query(
        `insert into private.gmail_raw_messages
           (mail_account_id, user_id, provider_message_id, provider_thread_id, internal_date,
            sanitized_payload, payload_sha256)
         values ($1, $2, 'sneaky', 't', now(), '{}'::jsonb, $3)`,
        [run.mailAccountId, run.userId, "e".repeat(64)],
      ),
    ).rejects.toThrow(/is `deleted` while/);
  });

  it("120. erasing the human leaves zero B03 rows", async () => {
    const run = await importedMailbox("b03-del-erasure");
    await client.query("delete from public.users where id = $1", [run.userId]);

    for (const table of [
      "gmail_raw_messages",
      "gmail_historical_import_threads",
      "gmail_historical_import_runs",
    ]) {
      const res = await client.query(
        `select count(*)::int as n from private.${table} where user_id = $1`,
        [run.userId],
      );
      expect([table, res.rows[0].n]).toEqual([table, 0]);
    }
  });
});

d("B03 has no raw-content surface", () => {
  it("22, 40. the status RPC reports counts and never content", async () => {
    const run = await importedMailbox("b03-status");
    const status = await rpc(client).rpc("gmail_historical_import_status", {
      p_user_id: run.userId,
      p_run_id: run.runId,
    });
    const json = JSON.stringify(status.data);

    // Enough to operate a pilot; nothing that would make this a way to read
    // somebody's mail.
    expect(status.data).toMatchObject({ result: "ok", status: "completed", messages_stored: 1 });
    for (const forbidden of [
      "Synthetic subject",
      "creator@example.invalid",
      "desk@example.invalid",
      "U1lOVEhFVElDIEJPRFk",
      "t1",
      "snippet",
    ]) {
      expect(json, `status must not expose ${forbidden}`).not.toContain(forbidden);
    }
  });

  it("no application route or component reads raw Gmail messages", async () => {
    // B04 will define the product-facing private representation. B03 deliberately
    // ships none: no account-page inbox, no admin viewer, no export.
    const root = path.resolve(__dirname, "../..");
    const offenders: string[] = [];
    const { execSync } = await import("node:child_process");
    const hits = execSync(
      `grep -rln "gmail_raw_messages\\|gmail_historical_import" ${root}/src ${root}/scripts || true`,
      { encoding: "utf8" },
    )
      .split("\n")
      .filter(Boolean);
    for (const file of hits) {
      if (file.includes("/src/lib/gmail/import/")) continue;
      if (file.includes("/scripts/gmail-import/")) continue;
      offenders.push(file);
    }
    expect(offenders).toEqual([]);
  });

  it("B03 writes nothing into product or intelligence tables", async () => {
    const migration = readFileSync(
      path.resolve(__dirname, "../../supabase/migrations/0037_gmail_historical_import.sql"),
      "utf8",
    );
    // B03 is the data pipe. Interpretation — outreach, matching, outcomes,
    // aggregates — belongs to B04+, and a migration that touched those tables
    // would be quietly starting that work.
    for (const table of [
      "insert into public.hotels",
      "insert into public.hotel_contacts",
      "insert into public.pipeline_items",
      "insert into public.outreach_events",
      "insert into public.collaborations",
      "hotel_intelligence",
      "destination_intelligence",
    ]) {
      expect(migration.toLowerCase()).not.toContain(table.toLowerCase());
    }
  });
});

describe("B03 operator CLI", () => {
  it("23. requires an absolute window start and refuses a relative lookback", async () => {
    // A relative lookback resolved inside a data pipe becomes a permanent
    // product decision nobody made.
    expect(() => parseWindowStart(null)).toThrow(/absolute ISO timestamp/);
    expect(() => parseWindowStart("12 months")).toThrow(/absolute ISO timestamp/);
    expect(parseWindowStart("2024-01-01T00:00:00Z").toISOString()).toBe("2024-01-01T00:00:00.000Z");
  });

  it("parses its commands without accepting a Gmail query", async () => {
    const args = parseImportArgs([
      "work",
      "--run-id",
      "r1",
      "--user-id",
      "u1",
      "--once",
      "--q",
      "subject:secret",
    ]);
    expect(args).toMatchObject({ command: "work", runId: "r1", userId: "u1", once: true });
    // There is nowhere for a free-text Gmail query to go: the parser has no such
    // field, and the enumeration query is built entirely from the run window.
    expect(Object.keys(args)).not.toContain("q");
    expect(Object.keys(args)).not.toContain("query");
  });
});
