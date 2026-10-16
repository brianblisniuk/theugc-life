/**
 * In-flight Gmail send, follow-up, and consent receipt.
 * Postgres only. Gmail is not called and no mail is sent.
 */
import { createHash } from "node:crypto";

import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  B02_REQUESTED_SCOPES,
  GMAIL_SEND_SCOPE,
  PRIVATE_PROCESSING_CONSENT_TEXT,
  PRIVATE_PROCESSING_POLICY_VERSION,
  SEND_PROCESSING_CONSENT_TEXT,
  SEND_PROCESSING_POLICY_VERSION,
} from "@/lib/gmail/contract";
import { adminQuery, commitAs, hasTestDb, setupDatabase, teardownDatabase } from "../db/harness";

const d = describe.skipIf(!hasTestDb);

const PRO = "e2e20000-0000-4000-8000-000000000001";
const OTHER = "e2e20000-0000-4000-8000-000000000002";
const CONSENT = "e2e20000-0000-4000-8000-000000000003";
const DEST = "e2e21000-0000-4000-8000-000000000001";
const HOTEL = "e2e22000-0000-4000-8000-000000000001";
const RECIPIENT = "desk@inflight-hotel.example";
const SEND_SCOPES = [...B02_REQUESTED_SCOPES, GMAIL_SEND_SCOPE];

const mailboxes = new Map<string, string>();
let threadSeq = 0;

function digest(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

async function asService<T>(sql: string, params: unknown[] = []): Promise<T[]> {
  await adminQuery("grant usage on schema public to service_role");
  try {
    const res = await commitAs<T>({ role: "service_role" }, sql, params);
    if (res.error) throw new Error(res.error.message);
    return res.rows;
  } finally {
    await adminQuery("revoke usage on schema public from service_role");
  }
}

async function connectMailbox(
  userId: string,
  label: string,
  scopes: string[],
  state = "connected",
): Promise<string> {
  const granted = [...scopes].sort();
  const client = new Client({ connectionString: process.env.TEST_DATABASE_URL });
  await client.connect();
  try {
    await client.query("begin");
    const account = await client.query<{ id: string }>(
      `insert into public.mail_accounts
         (user_id, provider, provider_account_subject, email_address, connection_state)
       values ($1, 'gmail', $2, $3, 'pending_authorization')
       returning id`,
      [userId, `sub-${label}`, `${label}@example.invalid`],
    );
    const id = account.rows[0]!.id;
    await client.query(
      `update public.mail_accounts
          set connection_state = $3, connected_at = case when $3 = 'connected' then now() else null end,
              granted_scopes = $2
        where id = $1`,
      [id, granted, state],
    );
    if (state === "connected") {
      const receiptDigest = userId.replace(/-/g, "").repeat(2).slice(0, 64);
      const receipt = await client.query<{ id: string; event_seq: string }>(
        `insert into public.mail_account_consent_receipts
           (mail_account_id, user_id, consent_kind, decision, policy_version, consent_text_digest,
            granted_scopes_at_decision, decided_by_user_id, decided_at, receipt_digest)
         values ($1, $2, 'private_gmail_processing', 'granted',
                 'gmail-private-processing/2026-10-14-send', $3, $4, $2, now(), $5)
         returning id, event_seq`,
        [id, userId, "b".repeat(64), granted, receiptDigest],
      );
      await client.query(
        `insert into public.mail_account_consents
           (mail_account_id, user_id, consent_kind, state, current_receipt_id, current_event_seq)
         values ($1, $2, 'private_gmail_processing', 'granted', $3, $4)`,
        [id, userId, receipt.rows[0]!.id, receipt.rows[0]!.event_seq],
      );
    }
    await client.query(
      `insert into private.gmail_oauth_credentials
         (mail_account_id, user_id, refresh_token_ciphertext, refresh_token_iv,
          refresh_token_auth_tag, encryption_key_version)
       values ($1, $2, 'ct', 'iv', 'tag', 'v1')`,
      [id, userId],
    );
    await client.query("commit");
    return id;
  } finally {
    await client.end();
  }
}

function businessTimezone(now = new Date()): string {
  const shift = (12 - now.getUTCHours() + 24) % 24;
  return shift === 0 ? "UTC" : `Etc/GMT-${shift}`;
}

async function attemptCount(userId: string): Promise<number> {
  const rows = await adminQuery<{ n: number }>(
    "select count(*)::int as n from private.gmail_send_attempts where user_id = $1",
    [userId],
  );
  return rows[0]!.n;
}

async function sendPitch(
  userId: string,
  mailAccountId: string,
  hotelId = HOTEL,
): Promise<{ eventId: string; attemptId: string; threadId: string }> {
  threadSeq += 1;
  const key = `inflight-pitch-${String(threadSeq).padStart(8, "0")}`;
  const threadId = `thread-e2e2-${threadSeq}`;
  const reserved = await asService<{ r: { result: string; attempt_id: string } }>(
    `select public.gmail_send_reserve(
       $1::uuid, $2::uuid, $3, 'pitch', $4, 'Hello hotel', 'A pitch body', $5::uuid, null, null, null, null
     ) as r`,
    [userId, mailAccountId, key, RECIPIENT, hotelId],
  );
  expect(reserved[0]!.r.result).toBe("queued");
  const attemptId = reserved[0]!.r.attempt_id;
  await adminQuery(
    "update private.gmail_send_attempts set status = 'reserved' where id = $1 and user_id = $2",
    [attemptId, userId],
  );
  const marked = await asService<{ r: { result: string } }>(
    "select public.gmail_send_mark_provider($1::uuid, $2::uuid, 120, 300) as r",
    [userId, attemptId],
  );
  expect(marked[0]!.r.result).toBe("ok");
  const committed = await asService<{ r: { result: string; event_id: string } }>(
    "select public.gmail_send_commit($1::uuid, $2::uuid, $3, $4) as r",
    [userId, attemptId, `msg-e2e2-${threadSeq}`, threadId],
  );
  expect(committed[0]!.r.result).toBe("sent");
  return { eventId: committed[0]!.r.event_id, attemptId, threadId };
}

async function schedule(userId: string, eventId: string) {
  return asService<{ r: Record<string, unknown> }>(
    "select public.gmail_followup_schedule($1::uuid, $2::uuid, $3, $4) as r",
    [userId, eventId, "Re: Hello hotel", "Following up on the collaboration."],
  );
}

d("Gmail in-flight send and consent", () => {
  beforeAll(async () => {
    await setupDatabase();
    await adminQuery(
      `insert into auth.users (id, email) values
         ($1, 'e2e2-pro@example.invalid'),
         ($2, 'e2e2-other@example.invalid'),
         ($3, 'e2e2-consent@example.invalid')`,
      [PRO, OTHER, CONSENT],
    );
    await adminQuery(
      "insert into public.destinations (id, name, slug, type) values ($1, 'Inflight Bay', 'inflight-bay', 'city')",
      [DEST],
    );
    await adminQuery(
      "insert into public.hotels (id, name, slug, destination_id) values ($1, 'Inflight Hotel', 'inflight-hotel', $2)",
      [HOTEL, DEST],
    );
    await adminQuery(
      `insert into public.hotel_contacts (hotel_id, email, status, source_type)
       values ($1, $2, 'active', 'editorial')`,
      [HOTEL, RECIPIENT],
    );
    await adminQuery(
      `insert into public.access_entitlements (user_id, access_type, status, starts_at)
       values ($1, 'pro', 'active', now()), ($2, 'pro', 'active', now())`,
      [PRO, OTHER],
    );
    mailboxes.set("pro", await connectMailbox(PRO, "e2e2-pro", SEND_SCOPES));
    mailboxes.set("pro-b", await connectMailbox(PRO, "e2e2-pro-b", SEND_SCOPES));
    mailboxes.set("other", await connectMailbox(OTHER, "e2e2-other", SEND_SCOPES));
    for (const userId of [PRO, OTHER]) {
      const ledger = await adminQuery<{ id: string }>(
        "select id from public.credit_ledger where user_id = $1 and reason = 'free_grant' limit 1",
        [userId],
      );
      await adminQuery(
        "insert into public.contact_unlocks (user_id, hotel_id, ledger_id) values ($1, $2, $3)",
        [userId, HOTEL, ledger[0]!.id],
      );
    }
    await adminQuery("update public.users set timezone = $2 where id = any($1::uuid[])", [
      [PRO, OTHER],
      businessTimezone(),
    ]);
  });

  afterAll(async () => {
    await teardownDatabase();
  });

  it("does not cancel or reschedule a follow-up whose attempt is unknown", async () => {
    const sent = await sendPitch(PRO, mailboxes.get("pro")!);
    const scheduled = await schedule(PRO, sent.eventId);
    expect(scheduled[0]!.r.result).toBe("scheduled");
    const followupId = String(scheduled[0]!.r.followup_id);
    await adminQuery(
      "update private.gmail_followups set earliest_send_at = now() - interval '1 minute' where id = $1",
      [followupId],
    );
    await asService("select public.gmail_followup_settle(clock_timestamp(), $1::uuid)", [PRO]);
    const linked = await adminQuery<{ send_attempt_id: string; status: string }>(
      "select send_attempt_id, status from private.gmail_followups where id = $1",
      [followupId],
    );
    expect(linked[0]!.status).toBe("queued");
    const attemptId = linked[0]!.send_attempt_id;
    await adminQuery(
      `update private.gmail_send_attempts
          set status = 'unknown', failure_code = null
        where id = $1`,
      [attemptId],
    );
    const before = await attemptCount(PRO);
    const cancelled = await asService<{ r: { result: string } }>(
      "select public.gmail_followup_cancel($1::uuid, $2::uuid) as r",
      [PRO, followupId],
    );
    expect(cancelled[0]!.r.result).toBe("in_progress");
    const still = await adminQuery<{ status: string; send_attempt_id: string | null }>(
      "select status, send_attempt_id from private.gmail_followups where id = $1",
      [followupId],
    );
    expect(still[0]).toEqual({ status: "queued", send_attempt_id: attemptId });
    expect(await attemptCount(PRO)).toBe(before);

    await adminQuery(
      `update private.gmail_followups
          set status = 'cancelled', stop_reason = 'cancelled', stopped_at = now()
        where id = $1`,
      [followupId],
    );
    const again = await schedule(PRO, sent.eventId);
    expect(again[0]!.r.result).toBe("in_progress");
    expect(await attemptCount(PRO)).toBe(before);
    await adminQuery(
      `update private.gmail_send_attempts
          set status = 'failed', failure_code = 'provider_error'
        where id = $1`,
      [attemptId],
    );
  });

  it("fails an expired provider_called row with no message id and then allows cancel", async () => {
    const sent = await sendPitch(PRO, mailboxes.get("pro")!);
    const scheduled = await schedule(PRO, sent.eventId);
    const followupId = String(scheduled[0]!.r.followup_id);
    await adminQuery(
      "update private.gmail_followups set earliest_send_at = now() - interval '1 minute' where id = $1",
      [followupId],
    );
    await asService("select public.gmail_followup_settle(clock_timestamp(), $1::uuid)", [PRO]);
    const linked = await adminQuery<{ send_attempt_id: string }>(
      "select send_attempt_id from private.gmail_followups where id = $1",
      [followupId],
    );
    const attemptId = linked[0]!.send_attempt_id;
    await adminQuery(
      `update private.gmail_send_attempts
          set status = 'provider_called',
              failure_code = null,
              provider_message_id = null,
              provider_thread_id = null,
              provider_started_at = clock_timestamp() - interval '20 minutes',
              updated_at = clock_timestamp() - interval '20 minutes'
        where id = $1`,
      [attemptId],
    );
    await asService("select public.gmail_send_claim_due(clock_timestamp(), 5, 180, 120, 300)");
    const row = await adminQuery<{ status: string; failure_code: string | null }>(
      "select status, failure_code from private.gmail_send_attempts where id = $1",
      [attemptId],
    );
    expect(row[0]).toEqual({ status: "failed", failure_code: "provider_error" });
    const cancelled = await asService<{ r: { result: string } }>(
      "select public.gmail_followup_cancel($1::uuid, $2::uuid) as r",
      [PRO, followupId],
    );
    expect(cancelled[0]!.r.result).toBe("cancelled");
  });

  it("retries only the commit when a provider message id is already stored", async () => {
    threadSeq += 1;
    const threadId = `thread-kept-${threadSeq}`;
    const reserved = await asService<{ r: { result: string; attempt_id: string } }>(
      `select public.gmail_send_reserve(
         $1::uuid, $2::uuid, $3, 'pitch', $4, 'Hello hotel', 'A pitch body', $5::uuid, null, null, null, null
       ) as r`,
      [
        PRO,
        mailboxes.get("pro"),
        `inflight-kept-${String(threadSeq).padStart(8, "0")}`,
        RECIPIENT,
        HOTEL,
      ],
    );
    expect(reserved[0]!.r.result).toBe("queued");
    const attemptId = reserved[0]!.r.attempt_id;
    await adminQuery(
      `update private.gmail_send_attempts
          set status = 'provider_called',
              failure_code = null,
              provider_message_id = 'msg-kept-e2e2',
              provider_thread_id = $2,
              provider_started_at = clock_timestamp() - interval '20 minutes',
              updated_at = clock_timestamp()
        where id = $1`,
      [attemptId, threadId],
    );
    const claimed = await asService<{
      r: { claims: { attempt_id?: string; retry_commit?: boolean; call_provider?: boolean }[] };
    }>("select public.gmail_send_claim_due(clock_timestamp(), 25, 180, 120, 300) as r");
    const claim = claimed[0]!.r.claims.find((row) => row.attempt_id === attemptId);
    expect(claim).toMatchObject({ retry_commit: true, call_provider: false });
    const blocked = await asService<{
      r: { result: string; call_provider: boolean; attempt_id?: string };
    }>(
      `select public.gmail_send_reserve(
         $1::uuid, $2::uuid, $3, 'pitch', $4, 'Hello hotel', 'A second pitch', $5::uuid, null, null, null, null
       ) as r`,
      [PRO, mailboxes.get("pro"), "inflight-second-key-01", RECIPIENT, HOTEL],
    );
    expect(blocked[0]!.r).toMatchObject({
      result: "unknown",
      call_provider: false,
      attempt_id: attemptId,
    });
    const committed = await asService<{ r: { result: string } }>(
      "select public.gmail_send_commit($1::uuid, $2::uuid, $3, $4) as r",
      [PRO, attemptId, "msg-kept-e2e2", threadId],
    );
    expect(committed[0]!.r.result).toBe("sent");
  });

  it("refuses a new send to the same recipient while an attempt is unknown", async () => {
    const sent = await sendPitch(PRO, mailboxes.get("pro")!);
    await adminQuery(
      "update private.gmail_send_attempts set status = 'unknown', failure_code = null where id = $1",
      [sent.attemptId],
    );
    const before = await attemptCount(PRO);
    const blocked = await asService<{ r: { result: string; call_provider: boolean } }>(
      `select public.gmail_send_reserve(
         $1::uuid, $2::uuid, $3, 'pitch', $4, 'Hello hotel', 'Another pitch', $5::uuid, null, null, null, null
       ) as r`,
      [PRO, mailboxes.get("pro"), "inflight-unknown-key-01", RECIPIENT, HOTEL],
    );
    expect(blocked[0]!.r).toMatchObject({ result: "unknown", call_provider: false });
    expect(await attemptCount(PRO)).toBe(before);
    const other = await asService<{ r: { result: string; call_provider: boolean } }>(
      `select public.gmail_send_reserve(
         $1::uuid, $2::uuid, $3, 'pitch', $4, 'Hello hotel', 'Other creator', $5::uuid, null, null, null, null
       ) as r`,
      [OTHER, mailboxes.get("other"), "inflight-other-key-001", RECIPIENT, HOTEL],
    );
    expect(other[0]!.r.result).toBe("queued");
    expect(other[0]!.r.call_provider).toBe(false);
    await adminQuery(
      `update private.gmail_send_attempts
          set status = 'failed', failure_code = 'provider_error'
        where id = $1`,
      [sent.attemptId],
    );
  });

  it("fails provider_called on deletion and on a reply seen in the last locked write", async () => {
    const pitch = await sendPitch(PRO, mailboxes.get("pro")!);
    try {
      await adminQuery(
        `update private.gmail_send_attempts
            set status = 'provider_called', failure_code = null,
                provider_message_id = null, provider_thread_id = null
          where id = $1`,
        [pitch.attemptId],
      );
      await adminQuery(
        `update public.users
            set deletion_requested_at = now(),
                delete_after = now() + interval '30 days'
          where id = $1`,
        [PRO],
      );
      const armed = await asService<{
        r: { result: string; failure_code?: string; call_provider: boolean };
      }>("select public.gmail_send_arm_provider($1::uuid, $2::uuid) as r", [PRO, pitch.attemptId]);
      expect(armed[0]!.r).toMatchObject({
        result: "failed",
        failure_code: "deletion_pending",
        call_provider: false,
      });
      const row = await adminQuery<{ status: string; failure_code: string | null }>(
        "select status, failure_code from private.gmail_send_attempts where id = $1",
        [pitch.attemptId],
      );
      expect(row[0]).toEqual({ status: "failed", failure_code: "deletion_pending" });
    } finally {
      await adminQuery(
        "update public.users set deletion_requested_at = null, delete_after = null where id = $1",
        [PRO],
      );
      await adminQuery(
        `update private.gmail_send_attempts
            set status = 'failed', failure_code = 'provider_error'
          where id = $1 and status in ('queued', 'reserved', 'provider_called', 'unknown')`,
        [pitch.attemptId],
      );
    }

    const follow = await sendPitch(PRO, mailboxes.get("pro")!);
    const scheduled = await schedule(PRO, follow.eventId);
    const followupId = String(scheduled[0]!.r.followup_id);
    await adminQuery(
      "update private.gmail_followups set earliest_send_at = now() - interval '1 minute' where id = $1",
      [followupId],
    );
    await asService("select public.gmail_followup_settle(clock_timestamp(), $1::uuid)", [PRO]);
    const linked = await adminQuery<{ send_attempt_id: string }>(
      "select send_attempt_id from private.gmail_followups where id = $1",
      [followupId],
    );
    const attemptId = linked[0]!.send_attempt_id;
    try {
      await adminQuery(
        `update private.gmail_send_attempts
            set status = 'provider_called', failure_code = null
          where id = $1`,
        [attemptId],
      );
      const thread = await adminQuery<{ id: string }>(
        `insert into private.gmail_normalized_threads (user_id, mail_account_id, provider_thread_id)
         values ($1, $2, $3)
         returning id`,
        [PRO, mailboxes.get("pro"), follow.threadId],
      );
      await adminQuery(
        `insert into private.gmail_reply_message_observations (
           user_id, mail_account_id, normalized_thread_id, provider_message_id, internal_date,
           last_evaluated_source_payload_sha256, response_class, relation_status, chronology_conflict,
           relation_rule_version, classification_rule_version, text_transform_version
         ) values (
           $1, $2, $3, $4, now(), $5, 'qualifying_human_reply', 'thread_sequence_only', false,
           'gmail_reply_relation_rules_v1', 'gmail_reply_classification_rules_v2',
           'gmail_reply_text_transform_v1_gmail_outreach_text_v4'
         )`,
        [PRO, mailboxes.get("pro"), thread[0]!.id, `obs-${follow.threadId}`, "ab".repeat(32)],
      );
      const stopped = await asService<{
        r: { result: string; failure_code?: string; call_provider: boolean };
      }>("select public.gmail_send_arm_provider($1::uuid, $2::uuid) as r", [PRO, attemptId]);
      expect(stopped[0]!.r).toMatchObject({
        result: "failed",
        failure_code: "followup_stopped",
        call_provider: false,
      });
    } finally {
      await adminQuery(
        `update private.gmail_send_attempts
            set status = 'failed', failure_code = 'provider_error'
          where id = $1 and status in ('queued', 'reserved', 'provider_called', 'unknown')`,
        [attemptId],
      );
    }
  });

  it("reschedules a shared provider thread onto the mailbox that owns the event", async () => {
    const first = await sendPitch(PRO, mailboxes.get("pro")!);
    const second = await sendPitch(PRO, mailboxes.get("pro-b")!);
    await adminQuery("update private.gmail_sent_events set provider_thread_id = $2 where id = $1", [
      second.eventId,
      first.threadId,
    ]);
    const onFirst = await schedule(PRO, first.eventId);
    expect(onFirst[0]!.r.result).toBe("scheduled");
    const firstId = String(onFirst[0]!.r.followup_id);
    const cancelled = await asService<{ r: { result: string } }>(
      "select public.gmail_followup_cancel($1::uuid, $2::uuid) as r",
      [PRO, firstId],
    );
    expect(cancelled[0]!.r.result).toBe("cancelled");
    const onSecond = await schedule(PRO, second.eventId);
    expect(onSecond[0]!.r.result).toBe("scheduled");
    const secondId = String(onSecond[0]!.r.followup_id);
    const rows = await adminQuery<{ id: string; mail_account_id: string; status: string }>(
      "select id, mail_account_id, status from private.gmail_followups where id = any($1::uuid[])",
      [[firstId, secondId]],
    );
    const byId = new Map(rows.map((row) => [row.id, row]));
    expect(byId.get(firstId)?.mail_account_id).toBe(mailboxes.get("pro"));
    expect(byId.get(secondId)?.mail_account_id).toBe(mailboxes.get("pro-b"));
    expect(byId.get(secondId)?.status).toBe("scheduled");
  });

  it("refuses a consent receipt that does not match the locked mailbox", async () => {
    const mailAccountId = await connectMailbox(
      CONSENT,
      "e2e2-consent",
      [...B02_REQUESTED_SCOPES],
      "consent_required",
    );
    const stale = await asService<{ r: { result: string } }>(
      "select public.gmail_grant_private_processing_consent($1::uuid, $2::uuid, $3, $4, $5) as r",
      [
        CONSENT,
        mailAccountId,
        SEND_PROCESSING_POLICY_VERSION,
        digest(SEND_PROCESSING_CONSENT_TEXT),
        "c".repeat(64),
      ],
    );
    expect(stale[0]!.r.result).toBe("consent_stale");
    const state = await adminQuery<{ connection_state: string }>(
      "select connection_state from public.mail_accounts where id = $1",
      [mailAccountId],
    );
    expect(state[0]!.connection_state).toBe("consent_required");
    const granted = await asService<{ r: { result: string } }>(
      "select public.gmail_grant_private_processing_consent($1::uuid, $2::uuid, $3, $4, $5) as r",
      [
        CONSENT,
        mailAccountId,
        PRIVATE_PROCESSING_POLICY_VERSION,
        digest(PRIVATE_PROCESSING_CONSENT_TEXT),
        "d".repeat(64),
      ],
    );
    expect(granted[0]!.r.result).toBe("connected");
  });
});
