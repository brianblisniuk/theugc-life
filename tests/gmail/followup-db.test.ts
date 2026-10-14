/**
 * D05 follow-ups against Postgres. Gmail is not called.
 */
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { B02_REQUESTED_SCOPES, GMAIL_SEND_SCOPE } from "@/lib/gmail/contract";
import {
  adminQuery,
  commitAs,
  hasTestDb,
  queryAs,
  setupDatabase,
  teardownDatabase,
} from "../db/harness";

const d = describe.skipIf(!hasTestDb);

const PRO = "d0500000-0000-4000-8000-000000000001";
const OTHER = "d0500000-0000-4000-8000-000000000002";
const FREE = "d0500000-0000-4000-8000-000000000003";
const DEST = "d0501000-0000-4000-8000-000000000001";
const HOTEL = "d0502000-0000-4000-8000-000000000001";
const RECIPIENT = "desk@hotel.example";
const SEND_SCOPES = [...B02_REQUESTED_SCOPES, GMAIL_SEND_SCOPE];
const mailboxes = new Map<string, string>();
let threadSeq = 0;

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

async function creatorId(userId: string): Promise<string> {
  const rows = await adminQuery<{ id: string }>(
    "select id from public.creator_profiles where user_id = $1",
    [userId],
  );
  return rows[0]!.id;
}

async function connectMailbox(userId: string, label: string): Promise<string> {
  const granted = [...SEND_SCOPES].sort();
  const receiptDigest = userId.replace(/-/g, "").repeat(2).slice(0, 64);
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
          set connection_state = 'connected', connected_at = now(), granted_scopes = $2
        where id = $1`,
      [id, granted],
    );
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
    await client.query(
      `insert into private.gmail_oauth_credentials
         (mail_account_id, user_id, refresh_token_ciphertext, refresh_token_iv,
          refresh_token_auth_tag, encryption_key_version)
       values ($1, $2, 'ct', 'iv', 'tag', 'v1')`,
      [id, userId],
    );
    await client.query("commit");
    mailboxes.set(userId, id);
    return id;
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    throw error;
  } finally {
    await client.end();
  }
}

function businessTimezone(now = new Date()): string {
  const shift = (12 - now.getUTCHours() + 24) % 24;
  return shift === 0 ? "UTC" : `Etc/GMT-${shift}`;
}

async function claimDue() {
  const rows = await asService<{
    r: {
      result: string;
      claims: {
        attempt_id?: string;
        recipient?: string;
        provider_thread_id?: string;
        user_id?: string;
      }[];
    };
  }>("select public.gmail_send_claim_due(clock_timestamp(), 25, 180, 120, 300) as r");
  return rows[0]!.r;
}

async function clearQueue(userId: string): Promise<void> {
  await adminQuery(
    `update private.gmail_send_attempts
        set status = 'failed', failure_code = 'provider_error'
      where user_id = $1 and status in ('queued', 'reserved')`,
    [userId],
  );
  await adminQuery("delete from private.gmail_send_schedule where user_id = $1", [userId]);
}

async function sendPitch(
  userId: string,
): Promise<{ eventId: string; attemptId: string; threadId: string }> {
  await clearQueue(userId);
  threadSeq += 1;
  const key = `fu-pitch-${String(threadSeq).padStart(12, "0")}`;
  const threadId = `thread-d05-${threadSeq}`;
  const reserved = await asService<{ r: { result: string; attempt_id: string } }>(
    `select public.gmail_send_reserve(
       $1::uuid, $2::uuid, $3, 'pitch', $4, 'Hello hotel', 'A pitch body', $5::uuid, null, null, null, null
     ) as r`,
    [userId, mailboxes.get(userId), key, RECIPIENT, HOTEL],
  );
  expect(reserved[0]!.r.result).toBe("queued");
  const claimed = await claimDue();
  expect(claimed.claims.some((row) => row.attempt_id === reserved[0]!.r.attempt_id)).toBe(true);
  const marked = await asService<{ r: { result: string } }>(
    "select public.gmail_send_mark_provider($1::uuid, $2::uuid, 120, 300) as r",
    [userId, reserved[0]!.r.attempt_id],
  );
  expect(marked[0]!.r.result).toBe("ok");
  const committed = await asService<{ r: { result: string; event_id: string } }>(
    "select public.gmail_send_commit($1::uuid, $2::uuid, $3, $4) as r",
    [userId, reserved[0]!.r.attempt_id, `msg-d05-${threadSeq}`, threadId],
  );
  expect(committed[0]!.r.result).toBe("sent");
  await clearQueue(userId);
  return { eventId: committed[0]!.r.event_id, attemptId: reserved[0]!.r.attempt_id, threadId };
}

async function schedule(
  userId: string,
  eventId: string,
  body = "Following up on the collaboration.\nSecond line.",
  delayDays?: number | null,
) {
  if (delayDays === undefined) {
    return asService<{ r: Record<string, unknown> }>(
      "select public.gmail_followup_schedule($1::uuid, $2::uuid, $3, $4) as r",
      [userId, eventId, "Re: Hello hotel", body],
    );
  }
  return asService<{ r: Record<string, unknown> }>(
    "select public.gmail_followup_schedule($1::uuid, $2::uuid, $3, $4, $5::integer) as r",
    [userId, eventId, "Re: Hello hotel", body, delayDays],
  );
}

async function creditSnapshot(userId: string): Promise<{ n: number; balance: number }> {
  const rows = await adminQuery<{ n: number; balance: number }>(
    `select count(*)::int as n, coalesce(sum(delta), 0)::int as balance
       from public.credit_ledger where user_id = $1`,
    [userId],
  );
  return rows[0]!;
}

async function noteReply(userId: string, threadId: string, responseClass: string): Promise<void> {
  const thread = await adminQuery<{ id: string }>(
    `insert into private.gmail_normalized_threads (user_id, mail_account_id, provider_thread_id)
     values ($1, $2, $3)
     on conflict (mail_account_id, provider_thread_id) do update set updated_at = now()
     returning id`,
    [userId, mailboxes.get(userId), threadId],
  );
  await adminQuery(
    `insert into private.gmail_reply_message_observations (
       user_id, mail_account_id, normalized_thread_id, provider_message_id, internal_date,
       last_evaluated_source_payload_sha256, response_class, relation_status, chronology_conflict,
       relation_rule_version, classification_rule_version, text_transform_version
     ) values (
       $1, $2, $3, $4, now(), $5, $6, 'thread_sequence_only', false,
       'gmail_reply_relation_rules_v1', 'gmail_reply_classification_rules_v2',
       'gmail_reply_text_transform_v1_gmail_outreach_text_v4'
     )`,
    [
      userId,
      mailboxes.get(userId),
      thread[0]!.id,
      `obs-${responseClass}-${threadId}`,
      "ab".repeat(32),
      responseClass,
    ],
  );
}

d("D05 follow-ups", () => {
  beforeAll(async () => {
    await setupDatabase();
    await adminQuery(
      `insert into auth.users (id, email) values
         ($1, 'd05-pro@example.invalid'),
         ($2, 'd05-other@example.invalid'),
         ($3, 'd05-free@example.invalid')`,
      [PRO, OTHER, FREE],
    );
    await adminQuery(
      "insert into public.destinations (id, name, slug, type) values ($1, 'Follow Bay', 'follow-bay', 'city')",
      [DEST],
    );
    await adminQuery(
      "insert into public.hotels (id, name, slug, destination_id) values ($1, 'Follow Hotel', 'follow-hotel', $2)",
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
    for (const userId of [PRO, OTHER, FREE]) {
      await connectMailbox(userId, userId.slice(-8));
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
      [PRO, OTHER, FREE],
      businessTimezone(),
    ]);
  });

  afterAll(async () => {
    await teardownDatabase();
  });

  it("pins follow-up functions and keeps the table private", async () => {
    const fns = await adminQuery<{
      proname: string;
      prosecdef: boolean;
      proconfig: string[] | null;
    }>(
      `select p.proname, p.prosecdef, p.proconfig
         from pg_proc p
         join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public' and p.proname like 'gmail_followup_%'
        order by p.proname`,
    );
    expect(fns.map((row) => row.proname)).toEqual([
      "gmail_followup_block_send",
      "gmail_followup_cancel",
      "gmail_followup_earliest",
      "gmail_followup_list_for_hotel",
      "gmail_followup_schedule",
      "gmail_followup_settle",
    ]);
    for (const row of fns) {
      expect(row.prosecdef, row.proname).toBe(true);
      expect(row.proconfig ?? [], row.proname).toContain('search_path=""');
    }
    const table = await adminQuery<{ relrowsecurity: boolean; relforcerowsecurity: boolean }>(
      `select c.relrowsecurity, c.relforcerowsecurity
         from pg_class c
         join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'private' and c.relname = 'gmail_followups'`,
    );
    expect(table[0]!.relrowsecurity).toBe(true);
    const grants = await adminQuery<{ role: string; allowed: boolean }>(
      `select role, has_table_privilege(role, 'private.gmail_followups', 'select') as allowed
         from (values ('anon'), ('authenticated'), ('service_role'), ('public')) as roles(role)`,
    );
    expect(grants.every((row) => row.allowed === false)).toBe(true);
    const deletes = await adminQuery<{ attname: string; confdeltype: string }>(
      `select a.attname, c.confdeltype
         from pg_constraint c
         join pg_class t on t.oid = c.conrelid
         join pg_namespace n on n.oid = t.relnamespace
         join pg_attribute a on a.attrelid = t.oid and a.attnum = any (c.conkey)
        where n.nspname = 'private' and t.relname = 'gmail_followups' and c.contype = 'f'
          and a.attname in ('user_id', 'source_event_id')`,
    );
    expect(deletes).toEqual(
      expect.arrayContaining([
        { attname: "user_id", confdeltype: "c" },
        { attname: "source_event_id", confdeltype: "c" },
      ]),
    );
  });

  it("adds whole days and rejects a delay outside 1 to 30", async () => {
    const rows = await asService<{
      three: string;
      saturday: string;
      thirty: string;
      zero: string | null;
      too_many: string | null;
    }>(
      `select public.gmail_followup_earliest('2026-10-13 15:00:00+00', 3) as three,
              public.gmail_followup_earliest('2026-10-16 17:00:00+00', 1) as saturday,
              public.gmail_followup_earliest('2026-10-16 17:00:00+00', 30) as thirty,
              public.gmail_followup_earliest('2026-10-16 17:00:00+00', 0) as zero,
              public.gmail_followup_earliest('2026-10-16 17:00:00+00', 31) as too_many`,
    );
    expect(new Date(rows[0]!.three).toISOString()).toBe("2026-10-16T15:00:00.000Z");
    expect(new Date(rows[0]!.saturday).toISOString()).toBe("2026-10-17T17:00:00.000Z");
    expect(new Date(rows[0]!.thirty).toISOString()).toBe("2026-11-15T17:00:00.000Z");
    expect(rows[0]!.zero).toBeNull();
    expect(rows[0]!.too_many).toBeNull();
  });

  it("stores the creator's text for the original recipient and refuses everyone else", async () => {
    const sent = await sendPitch(PRO);
    try {
      await adminQuery("update public.users set timezone = 'UTC' where id = $1", [PRO]);
      await adminQuery(
        "update private.gmail_sent_events set sent_at = '2026-10-13 15:00:00+00' where id = $1",
        [sent.eventId],
      );
      const body = "Following up on the collaboration.\nSecond line.";
      const scheduled = await schedule(PRO, sent.eventId, body);
      expect(scheduled[0]!.r.result).toBe("scheduled");
      expect(scheduled[0]!.r.recipient).toBe(RECIPIENT);
      expect(scheduled[0]!.r.delay_days).toBe(3);
      expect(new Date(String(scheduled[0]!.r.earliest_send_at)).toISOString()).toBe(
        "2026-10-16T15:00:00.000Z",
      );
      const stored = await adminQuery<{
        subject: string;
        body: string;
        recipient: string;
        status: string;
      }>("select subject, body, recipient, status from private.gmail_followups where id = $1", [
        scheduled[0]!.r.followup_id,
      ]);
      expect(stored[0]).toEqual({
        subject: "Re: Hello hotel",
        body,
        recipient: RECIPIENT,
        status: "scheduled",
      });

      const again = await schedule(PRO, sent.eventId, body);
      expect(again[0]!.r.result).toBe("already_scheduled");
      const conflict = await schedule(
        PRO,
        sent.eventId,
        "A different follow-up about the collaboration.",
      );
      expect(conflict[0]!.r.result).toBe("text_conflict");

      const other = await schedule(OTHER, sent.eventId, body);
      expect(other[0]!.r.result).toBe("not_found");
      const otherRows = await adminQuery<{ n: number }>(
        "select count(*)::int as n from private.gmail_followups where user_id = $1",
        [OTHER],
      );
      expect(otherRows[0]!.n).toBe(0);

      const denied = await queryAs(
        { role: "authenticated", sub: PRO },
        "select public.gmail_followup_schedule($1::uuid, $2::uuid, 'Subject', 'Following up')",
        [PRO, sent.eventId],
      );
      expect(denied.error?.message ?? "").toMatch(/permission denied/i);

      const listed = await asService<{
        r: { threads: { event_id: string; next: { state: string } }[] };
      }>("select public.gmail_followup_list_for_hotel($1::uuid, $2::uuid) as r", [PRO, HOTEL]);
      expect(listed[0]!.r.threads.some((thread) => thread.event_id === sent.eventId)).toBe(true);
      const hidden = await asService<{ r: { threads: unknown[] } }>(
        "select public.gmail_followup_list_for_hotel($1::uuid, $2::uuid) as r",
        [OTHER, HOTEL],
      );
      expect(hidden[0]!.r.threads).toEqual([]);

      const kind = await asService<{ r: { result: string } }>(
        `select public.gmail_send_reserve(
         $1::uuid, $2::uuid, 'fu-kind-000000000001', 'follow_up', $3, 'Sub', 'Body', $4::uuid, null, null, null, $5
       ) as r`,
        [PRO, mailboxes.get(PRO), RECIPIENT, HOTEL, sent.threadId],
      );
      expect(kind[0]!.r.result).toBe("invalid_input");
    } finally {
      await adminQuery(
        "update private.gmail_followups set earliest_send_at = '2099-01-04 09:00:00+00' where user_id = $1 and status = 'scheduled'",
        [PRO],
      );
      await adminQuery("update public.users set timezone = $2 where id = $1", [
        PRO,
        businessTimezone(),
      ]);
    }
  });

  it("stores a chosen delay, defaults the second follow-up to five days, and spends no credits", async () => {
    const sent = await sendPitch(PRO);
    await adminQuery("update public.users set timezone = $2 where id = $1", [
      PRO,
      businessTimezone(),
    ]);
    await adminQuery(
      "update private.gmail_sent_events set sent_at = '2026-10-13 15:00:00+00' where id = $1",
      [sent.eventId],
    );
    const body = "A custom wait on the collaboration.";
    const before = await creditSnapshot(PRO);
    const scheduled = await schedule(PRO, sent.eventId, body, 7);
    expect(scheduled[0]!.r).toMatchObject({ result: "scheduled", sequence: 1, delay_days: 7 });
    expect(new Date(String(scheduled[0]!.r.earliest_send_at)).toISOString()).toBe(
      "2026-10-20T15:00:00.000Z",
    );
    expect(await creditSnapshot(PRO)).toEqual(before);

    const same = await schedule(PRO, sent.eventId, body, 7);
    expect(same[0]!.r.result).toBe("already_scheduled");
    const moved = await schedule(PRO, sent.eventId, body, 9);
    expect(moved[0]!.r.result).toBe("text_conflict");
    const kept = await adminQuery<{ delay_days: number }>(
      "select delay_days from private.gmail_followups where id = $1",
      [scheduled[0]!.r.followup_id],
    );
    expect(kept[0]!.delay_days).toBe(7);

    const low = await schedule(PRO, sent.eventId, "Another delay on the collaboration.", 0);
    const high = await schedule(PRO, sent.eventId, "Another delay on the collaboration.", 31);
    expect(low[0]!.r.result).toBe("invalid_input");
    expect(high[0]!.r.result).toBe("invalid_input");
    await expect(
      asService(
        "select public.gmail_followup_schedule($1::uuid, $2::uuid, 'Re: Hello hotel', $3, 1.5) as r",
        [PRO, sent.eventId, body],
      ),
    ).rejects.toThrow();
    const rows = await adminQuery<{ n: number }>(
      "select count(*)::int as n from private.gmail_followups where provider_thread_id = $1",
      [sent.threadId],
    );
    expect(rows[0]!.n).toBe(1);
    await expect(
      adminQuery("update private.gmail_followups set delay_days = 0 where id = $1", [
        scheduled[0]!.r.followup_id,
      ]),
    ).rejects.toThrow(/gmail_followups_delay_check/);
    await expect(
      adminQuery("update private.gmail_followups set delay_days = 31 where id = $1", [
        scheduled[0]!.r.followup_id,
      ]),
    ).rejects.toThrow(/gmail_followups_delay_check/);

    await adminQuery(
      "update private.gmail_followups set earliest_send_at = clock_timestamp() - interval '1 minute' where id = $1",
      [scheduled[0]!.r.followup_id],
    );
    await clearQueue(PRO);
    const settled = await asService<{ r: { enqueued: number } }>(
      "select public.gmail_followup_settle(clock_timestamp(), $1::uuid) as r",
      [PRO],
    );
    expect(settled[0]!.r.enqueued).toBe(1);
    const claimed = await claimDue();
    const attempt = claimed.claims.find((row) => row.provider_thread_id === sent.threadId);
    expect(attempt?.attempt_id).toBeTruthy();
    const marked = await asService<{ r: { result: string } }>(
      "select public.gmail_send_mark_provider($1::uuid, $2::uuid, 120, 300) as r",
      [PRO, attempt!.attempt_id],
    );
    expect(marked[0]!.r.result).toBe("ok");
    const committed = await asService<{ r: { result: string } }>(
      "select public.gmail_send_commit($1::uuid, $2::uuid, $3, $4) as r",
      [PRO, attempt!.attempt_id, `msg-fu2-${sent.threadId}`, sent.threadId],
    );
    expect(committed[0]!.r.result).toBe("sent");
    await adminQuery(
      "update private.gmail_sent_events set sent_at = '2026-10-20 15:00:00+00' where attempt_id = $1",
      [attempt!.attempt_id],
    );
    await clearQueue(PRO);

    const secondBody = "The second follow-up on the collaboration.";
    const second = await schedule(PRO, sent.eventId, secondBody);
    expect(second[0]!.r).toMatchObject({ result: "scheduled", sequence: 2, delay_days: 5 });
    expect(new Date(String(second[0]!.r.earliest_send_at)).toISOString()).toBe(
      "2026-10-25T15:00:00.000Z",
    );
    const cancelled = await asService<{ r: { result: string } }>(
      "select public.gmail_followup_cancel($1::uuid, $2::uuid) as r",
      [PRO, second[0]!.r.followup_id],
    );
    expect(cancelled[0]!.r.result).toBe("cancelled");
    const custom = await schedule(PRO, sent.eventId, secondBody, 12);
    expect(custom[0]!.r).toMatchObject({ result: "scheduled", sequence: 2, delay_days: 12 });
    expect(new Date(String(custom[0]!.r.earliest_send_at)).toISOString()).toBe(
      "2026-11-01T15:00:00.000Z",
    );
    const edge = await schedule(PRO, sent.eventId, "A one-day follow-up on the collaboration.", 1);
    expect(edge[0]!.r.result).toBe("text_conflict");
    await adminQuery(
      "update private.gmail_followups set earliest_send_at = '2099-01-04 09:00:00+00' where id = $1",
      [custom[0]!.r.followup_id],
    );
    expect(await creditSnapshot(PRO)).toEqual(before);
  });

  it("refuses Free and an invalid contact, and does not write a row", async () => {
    const sent = await sendPitch(PRO);
    const freeEvent = await adminQuery<{ id: string }>(
      `insert into private.gmail_send_attempts
         (user_id, mail_account_id, idempotency_key, payload_sha256, kind, status,
          recipient, subject, body, provider_started_at)
       values ($1, $2, 'fu-free-0000000001', $3, 'pitch', 'sent', $4, 'Hello', 'Body', now())
       returning id`,
      [FREE, mailboxes.get(FREE), "cd".repeat(32), RECIPIENT],
    );
    const freeSent = await adminQuery<{ id: string }>(
      `insert into private.gmail_sent_events
         (attempt_id, user_id, mail_account_id, kind, hotel_id, recipient, subject,
          provider_message_id, provider_thread_id, binding_status)
       values ($1, $2, $3, 'pitch', $4, $5, 'Hello', 'msg-free-d05', 'thread-free-d05', 'not_requested')
       returning id`,
      [freeEvent[0]!.id, FREE, mailboxes.get(FREE), HOTEL, RECIPIENT],
    );
    const free = await schedule(FREE, freeSent[0]!.id);
    expect(free[0]!.r.result).toBe("plan_required");
    const freeRows = await adminQuery<{ n: number }>(
      "select count(*)::int as n from private.gmail_followups where user_id = $1",
      [FREE],
    );
    expect(freeRows[0]!.n).toBe(0);

    await adminQuery("update public.hotel_contacts set status = 'invalid' where hotel_id = $1", [
      HOTEL,
    ]);
    const rejected = await schedule(PRO, sent.eventId);
    expect(rejected[0]!.r.result).toBe("recipient_rejected");
    await adminQuery("update public.hotel_contacts set status = 'active' where hotel_id = $1", [
      HOTEL,
    ]);
  });

  it("enqueues through the send queue and stops before a reply, bounce, close, or cancel", async () => {
    const creator = await creatorId(PRO);
    const item = await adminQuery<{ id: string }>(
      "insert into public.pipeline_items (creator_id, hotel_id, status) values ($1, $2, 'pitched') returning id",
      [creator, HOTEL],
    );
    const sent = await sendPitch(PRO);
    await adminQuery("update private.gmail_sent_events set pipeline_item_id = $2 where id = $1", [
      sent.eventId,
      item[0]!.id,
    ]);
    const scheduled = await schedule(PRO, sent.eventId);
    expect(scheduled[0]!.r.result).toBe("scheduled");
    const followupId = String(scheduled[0]!.r.followup_id);
    const before = await adminQuery<{ status: string }>(
      "select status from public.pipeline_items where id = $1",
      [item[0]!.id],
    );
    const outreachBefore = await adminQuery<{ n: number }>(
      "select count(*)::int as n from public.outreach_events where creator_id = $1",
      [creator],
    );

    await adminQuery(
      "update private.gmail_followups set earliest_send_at = clock_timestamp() - interval '1 minute' where id = $1",
      [followupId],
    );
    await noteReply(PRO, sent.threadId, "automated_response");
    const still = await asService<{ r: { stopped: number; enqueued: number } }>(
      "select public.gmail_followup_settle(clock_timestamp(), $1::uuid) as r",
      [PRO],
    );
    expect(still[0]!.r.stopped).toBe(0);
    expect(still[0]!.r.enqueued).toBe(1);
    const queued = await adminQuery<{
      status: string;
      kind: string;
      recipient: string;
      thread: string;
    }>(
      `select f.status, a.kind, a.recipient, a.provider_thread_hint as thread
         from private.gmail_followups f
         join private.gmail_send_attempts a on a.id = f.send_attempt_id
        where f.id = $1`,
      [followupId],
    );
    expect(queued[0]).toEqual({
      status: "queued",
      kind: "follow_up",
      recipient: RECIPIENT,
      thread: sent.threadId,
    });

    await noteReply(PRO, sent.threadId, "qualifying_human_reply");
    const claimed = await claimDue();
    expect(claimed.claims.some((row) => row.provider_thread_id === sent.threadId)).toBe(false);
    const stopped = await adminQuery<{ status: string; stop_reason: string }>(
      "select status, stop_reason from private.gmail_followups where id = $1",
      [followupId],
    );
    expect(stopped[0]).toEqual({ status: "stopped", stop_reason: "hotel_replied" });
    const after = await adminQuery<{ status: string }>(
      "select status from public.pipeline_items where id = $1",
      [item[0]!.id],
    );
    expect(after[0]!.status).toBe(before[0]!.status);
    expect(after[0]!.status).toBe("pitched");
    const outreachAfter = await adminQuery<{ n: number }>(
      "select count(*)::int as n from public.outreach_events where creator_id = $1",
      [creator],
    );
    expect(outreachAfter[0]!.n).toBe(outreachBefore[0]!.n);

    const afterReply = await schedule(PRO, sent.eventId, "Another follow-up on the collaboration.");
    expect(afterReply[0]!.r).toMatchObject({ result: "stopped", stop_reason: "hotel_replied" });
  });

  it("stops a reserved follow-up when the pipeline is won and when the creator cancels", async () => {
    const creator = await creatorId(PRO);
    await adminQuery(
      "update public.pipeline_items set status = 'closed' where creator_id = $1 and status <> 'closed'",
      [creator],
    );
    const won = await adminQuery<{ id: string }>(
      `insert into public.pipeline_items (creator_id, hotel_id, status)
       values ($1, $2, 'pitched') returning id`,
      [creator, HOTEL],
    );
    const sent = await sendPitch(PRO);
    await adminQuery("update private.gmail_sent_events set pipeline_item_id = $2 where id = $1", [
      sent.eventId,
      won[0]!.id,
    ]);
    const scheduled = await schedule(PRO, sent.eventId, "Following up before the deal closes.");
    const followupId = String(scheduled[0]!.r.followup_id);
    await adminQuery(
      "update private.gmail_followups set earliest_send_at = clock_timestamp() - interval '1 minute' where id = $1",
      [followupId],
    );
    await clearQueue(PRO);
    const claimed = await claimDue();
    const attempt = claimed.claims.find((row) => row.provider_thread_id === sent.threadId);
    expect(attempt?.recipient).toBe(RECIPIENT);
    await adminQuery("update public.pipeline_items set status = 'won' where id = $1", [won[0]!.id]);
    const blocked = await asService<{ r: { result: string; stop_reason: string } }>(
      "select public.gmail_followup_block_send($1::uuid, $2::uuid) as r",
      [PRO, attempt!.attempt_id],
    );
    expect(blocked[0]!.r).toMatchObject({ result: "stopped", stop_reason: "pipeline_closed" });
    const marked = await asService<{ r: { result: string; call_provider: boolean } }>(
      "select public.gmail_send_mark_provider($1::uuid, $2::uuid, 120, 300) as r",
      [PRO, attempt!.attempt_id],
    );
    expect(marked[0]!.r.call_provider).toBe(false);

    await adminQuery("update public.pipeline_items set status = 'closed' where id = $1", [
      won[0]!.id,
    ]);
    const fresh = await sendPitch(PRO);
    const second = await schedule(PRO, fresh.eventId, "One more follow-up on the collaboration.");
    expect(second[0]!.r.result).toBe("scheduled");
    const cancelled = await asService<{ r: { result: string } }>(
      "select public.gmail_followup_cancel($1::uuid, $2::uuid) as r",
      [PRO, second[0]!.r.followup_id],
    );
    expect(cancelled[0]!.r.result).toBe("cancelled");
    const replaced = await schedule(
      PRO,
      fresh.eventId,
      "The replacement follow-up on the collaboration.",
    );
    expect(replaced[0]!.r).toMatchObject({ result: "scheduled", sequence: 1 });

    await adminQuery(
      `insert into private.gmail_send_bounces (attempt_id, user_id) values ($1, $2)`,
      [fresh.attemptId, PRO],
    );
    const bounced = await asService<{ r: { stopped: number } }>(
      "select public.gmail_followup_settle(clock_timestamp(), $1::uuid) as r",
      [PRO],
    );
    expect(bounced[0]!.r.stopped).toBeGreaterThan(0);
    const reason = await adminQuery<{ stop_reason: string }>(
      "select stop_reason from private.gmail_followups where id = $1",
      [replaced[0]!.r.followup_id],
    );
    expect(reason[0]!.stop_reason).toBe("bounced");
  });

  it("deletes the follow-up with the sent pitch", async () => {
    const sent = await sendPitch(PRO);
    const scheduled = await schedule(
      PRO,
      sent.eventId,
      "This row should disappear with the pitch.",
    );
    expect(scheduled[0]!.r.result).toBe("scheduled");
    await adminQuery("delete from private.gmail_sent_events where id = $1", [sent.eventId]);
    const left = await adminQuery<{ n: number }>(
      "select count(*)::int as n from private.gmail_followups where id = $1",
      [scheduled[0]!.r.followup_id],
    );
    expect(left[0]!.n).toBe(0);
  });
});
