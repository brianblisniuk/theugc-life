/**
 * D04 against real Postgres. Gmail is not called. The reserve, limit, plan,
 * isolation, linkage, and deletion functions are the ones in migration 0089.
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

const PRO = "d0400000-0000-4000-8000-000000000001";
const FREE = "d0400000-0000-4000-8000-000000000002";
const PASS = "d0400000-0000-4000-8000-000000000003";
const MAX = "d0400000-0000-4000-8000-000000000004";
const EXPIRED = "d0400000-0000-4000-8000-000000000005";
const ADMIN = "d0400000-0000-4000-8000-000000000006";
const OTHER = "d0400000-0000-4000-8000-000000000007";
const DEL = "d0400000-0000-4000-8000-000000000008";
const DEST = "d0401000-0000-4000-8000-000000000001";
const HOTEL = "d0402000-0000-4000-8000-000000000001";
const SEND_SCOPES = [...B02_REQUESTED_SCOPES, GMAIL_SEND_SCOPE];
const RECIPIENT = "desk@hotel.example";

const mailboxes = new Map<string, string>();

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

async function connectMailbox(userId: string, label: string, scopes: string[]): Promise<string> {
  const granted = [...scopes].sort();
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
      [id, userId, "a".repeat(64), granted, receiptDigest],
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

async function unlock(userId: string): Promise<void> {
  const ledger = await adminQuery<{ id: string }>(
    "select id from public.credit_ledger where user_id = $1 and reason = 'free_grant' limit 1",
    [userId],
  );
  await adminQuery(
    "insert into public.contact_unlocks (user_id, hotel_id, ledger_id) values ($1, $2, $3)",
    [userId, HOTEL, ledger[0]!.id],
  );
}

function reserveSql(): string {
  return `select public.gmail_send_reserve(
    $1::uuid, $2::uuid, $3, 'pitch', $4, $5, $6, $7::uuid, $8::uuid, $9::uuid, null, null
  ) as r`;
}

async function reserve(input: {
  userId: string;
  key: string;
  subject?: string;
  body?: string;
  pipelineId?: string | null;
  tripId?: string | null;
  recipient?: string;
}) {
  const rows = await asService<{ r: Record<string, unknown> }>(reserveSql(), [
    input.userId,
    mailboxes.get(input.userId),
    input.key,
    input.recipient ?? RECIPIENT,
    input.subject ?? "Hello from Pro",
    input.body ?? "A pitch body",
    HOTEL,
    input.pipelineId ?? null,
    input.tripId ?? null,
  ]);
  return rows[0]!.r;
}

d("D04 Gmail send", () => {
  beforeAll(async () => {
    await setupDatabase();
    const users = [PRO, FREE, PASS, MAX, EXPIRED, ADMIN, OTHER, DEL];
    await adminQuery(
      `insert into auth.users (id, email) values
         ($1, 'd04-pro@example.invalid'),
         ($2, 'd04-free@example.invalid'),
         ($3, 'd04-pass@example.invalid'),
         ($4, 'd04-max@example.invalid'),
         ($5, 'd04-expired@example.invalid'),
         ($6, 'd04-admin@example.invalid'),
         ($7, 'd04-other@example.invalid'),
         ($8, 'd04-del@example.invalid')`,
      users,
    );
    await adminQuery("update public.users set role = 'admin' where id = $1", [ADMIN]);
    await adminQuery(
      "insert into public.destinations (id, name, slug, type) values ($1, 'Send Bay', 'send-bay', 'city')",
      [DEST],
    );
    await adminQuery(
      "insert into public.hotels (id, name, slug, destination_id) values ($1, 'Send Hotel', 'send-hotel', $2)",
      [HOTEL, DEST],
    );
    await adminQuery(
      `insert into public.hotel_contacts (hotel_id, email, status, source_type)
       values ($1, $2, 'active', 'editorial')`,
      [HOTEL, RECIPIENT],
    );
    await adminQuery(
      `insert into public.access_entitlements (user_id, access_type, status, starts_at)
       values ($1, 'pro', 'active', now()),
              ($2, 'max', 'active', now()),
              ($3, 'pro', 'active', now() - interval '10 days'),
              ($4, 'admin', 'active', now())`,
      [PRO, MAX, EXPIRED, ADMIN],
    );
    await adminQuery(
      `update public.access_entitlements
          set expires_at = now() - interval '1 day'
        where user_id = $1`,
      [EXPIRED],
    );
    await adminQuery(
      `insert into public.access_entitlements
         (user_id, access_type, destination_id, status, starts_at)
       values ($1, 'destination', $2, 'active', now())`,
      [PASS, DEST],
    );
    for (const userId of users) {
      await connectMailbox(userId, userId.replace(/-/g, ""), SEND_SCOPES);
      await unlock(userId);
    }
  });

  afterAll(async () => {
    await teardownDatabase();
  });

  it("pins search_path on the send functions and leaves the hash invoker", async () => {
    const rows = await adminQuery<{ proname: string; prosecdef: boolean; proconfig: string[] | null }>(
      `select p.proname, p.prosecdef, p.proconfig
         from pg_proc p
         join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public' and p.proname like 'gmail_send_%'
        order by p.proname`,
    );
    expect(rows.map((row) => row.proname)).toEqual([
      "gmail_send_bind_pending",
      "gmail_send_commit",
      "gmail_send_fail",
      "gmail_send_list_own",
      "gmail_send_mark_provider",
      "gmail_send_payload_hash",
      "gmail_send_purge_for_deletion",
      "gmail_send_reserve",
      "gmail_send_scope_persist",
    ]);
    for (const row of rows) {
      expect(row.proconfig ?? [], row.proname).toContain('search_path=""');
      if (row.proname === "gmail_send_payload_hash") {
        expect(row.prosecdef).toBe(false);
      } else {
        expect(row.prosecdef, row.proname).toBe(true);
      }
    }
  });

  it("refuses Free, Pass, expired Pro, and admin, and allows Pro and Max", async () => {
    const cases: [string, string, string][] = [
      [FREE, "free-key-0000000001", "plan_required"],
      [PASS, "pass-key-0000000001", "plan_required"],
      [EXPIRED, "expired-key-00000001", "plan_required"],
      [ADMIN, "admin-key-0000000001", "plan_required"],
    ];
    for (const [userId, key, code] of cases) {
      const row = await reserve({ userId, key });
      expect(row.result, userId).toBe("failed");
      expect(row.failure_code, userId).toBe(code);
      expect(row.call_provider, userId).toBe(false);
    }
    expect((await reserve({ userId: PRO, key: "pro-allow-000000001" })).result).toBe("reserved");
    expect((await reserve({ userId: MAX, key: "max-allow-000000001" })).call_provider).toBe(true);
  });

  it("a missing unlock is not_found and writes no attempt", async () => {
    await adminQuery("delete from public.contact_unlocks where user_id = $1", [FREE]);
    const row = await reserve({ userId: FREE, key: "free-noul-000000001" });
    expect(row).toMatchObject({ result: "not_found", call_provider: false });
    const attempts = await adminQuery<{ n: number }>(
      "select count(*)::int as n from private.gmail_send_attempts where idempotency_key = $1",
      ["free-noul-000000001"],
    );
    expect(attempts[0]!.n).toBe(0);
    await unlock(FREE);
  });

  it("one key has one outcome, and a different payload conflicts", async () => {
    const first = await reserve({ userId: PRO, key: "pro-idem-0000000001", subject: "First subject" });
    expect(first.result).toBe("reserved");
    const again = await reserve({ userId: PRO, key: "pro-idem-0000000001", subject: "First subject" });
    expect(again.result).toBe("in_progress");
    expect(again.call_provider).toBe(false);
    const clash = await reserve({ userId: PRO, key: "pro-idem-0000000001", subject: "Other subject" });
    expect(clash.result).toBe("idempotency_conflict");
  });

  it("enforces the 10 second gap and clamps a daily cap of 1000 to 40", async () => {
    const first = await reserve({ userId: MAX, key: "max-limit-000000001" });
    const marked = await asService<{ r: Record<string, unknown> }>(
      "select public.gmail_send_mark_provider($1::uuid, $2::uuid, 1000) as r",
      [MAX, first.attempt_id],
    );
    expect(marked[0]!.r.result).toBe("ok");
    expect(marked[0]!.r.daily_cap).toBe(40);
    const second = await reserve({ userId: MAX, key: "max-limit-000000002" });
    const blocked = await asService<{ r: Record<string, unknown> }>(
      "select public.gmail_send_mark_provider($1::uuid, $2::uuid, 20) as r",
      [MAX, second.attempt_id],
    );
    expect(blocked[0]!.r).toMatchObject({ result: "failed", failure_code: "rate_limited", call_provider: false });
    await adminQuery(
      `update private.gmail_send_attempts
          set provider_started_at = now() - interval '11 seconds'
        where id = $1`,
      [first.attempt_id],
    );
    const third = await reserve({ userId: MAX, key: "max-limit-000000003" });
    const afterGap = await asService<{ r: Record<string, unknown> }>(
      "select public.gmail_send_mark_provider($1::uuid, $2::uuid, 1) as r",
      [MAX, third.attempt_id],
    );
    expect(afterGap[0]!.r.failure_code).toBe("rate_limited");
    expect(afterGap[0]!.r.daily_cap).toBe(1);
  });

  it("does not let one creator attach another creator's pipeline item", async () => {
    const otherCreator = await creatorId(OTHER);
    const item = await adminQuery<{ id: string }>(
      "insert into public.pipeline_items (creator_id, hotel_id) values ($1, $2) returning id",
      [otherCreator, HOTEL],
    );
    const row = await reserve({
      userId: PRO,
      key: "pro-cross-0000000001",
      pipelineId: item[0]!.id,
    });
    expect(row).toMatchObject({ result: "not_found", call_provider: false });
    const attempts = await adminQuery<{ n: number }>(
      "select count(*)::int as n from private.gmail_send_attempts where idempotency_key = $1",
      ["pro-cross-0000000001"],
    );
    expect(attempts[0]!.n).toBe(0);
  });

  it("authenticated cannot reserve, and list_own returns only the caller's event without the body", async () => {
    const denied = await queryAs(
      { role: "authenticated", sub: PRO },
      "select public.gmail_send_reserve($1::uuid, $2::uuid, 'auth-key-0000000001', 'pitch', $3, 'Sub', 'Body', $4::uuid, null, null, null, null)",
      [PRO, mailboxes.get(PRO), RECIPIENT, HOTEL],
    );
    expect(denied.error?.message ?? "").toMatch(/permission denied/i);

    const creator = await creatorId(PRO);
    const trip = await adminQuery<{ id: string }>(
      `insert into public.trips (creator_id, destination_id, start_date, end_date)
       values ($1, $2, '2026-11-01', '2026-11-03') returning id`,
      [creator, DEST],
    );
    const item = await adminQuery<{ id: string }>(
      `insert into public.pipeline_items (creator_id, hotel_id, trip_id, status)
       values ($1, $2, $3, 'saved') returning id`,
      [creator, HOTEL, trip[0]!.id],
    );
    const outreachBefore = await adminQuery<{ n: number }>(
      "select count(*)::int as n from public.outreach_events where creator_id = $1",
      [creator],
    );
    const reserved = await reserve({
      userId: PRO,
      key: "pro-link-0000000001",
      pipelineId: item[0]!.id,
    });
    expect(reserved.result).toBe("reserved");
    expect(reserved.trip_id).toBe(trip[0]!.id);
    const marked = await asService<{ r: { result: string } }>(
      "select public.gmail_send_mark_provider($1::uuid, $2::uuid, 20) as r",
      [PRO, reserved.attempt_id],
    );
    expect(marked[0]!.r.result).toBe("ok");
    const committed = await asService<{ r: Record<string, string> }>(
      "select public.gmail_send_commit($1::uuid, $2::uuid, 'msg-linked-1', 'thread-linked-1') as r",
      [PRO, reserved.attempt_id],
    );
    expect(committed[0]!.r.result).toBe("sent");
    expect(committed[0]!.r.binding_status).toBe("pending_thread");
    expect(committed[0]!.r.provider_message_id).toBe("msg-linked-1");
    expect(committed[0]!.r.hotel_id).toBe(HOTEL);
    expect(committed[0]!.r.pipeline_item_id).toBe(item[0]!.id);
    expect(committed[0]!.r.trip_id).toBe(trip[0]!.id);

    const pipeline = await adminQuery<{ status: string; first_pitched_at: string | null }>(
      "select status, first_pitched_at from public.pipeline_items where id = $1",
      [item[0]!.id],
    );
    expect(pipeline[0]).toEqual({ status: "saved", first_pitched_at: null });
    const outreachAfter = await adminQuery<{ n: number }>(
      "select count(*)::int as n from public.outreach_events where creator_id = $1",
      [creator],
    );
    expect(outreachAfter[0]!.n).toBe(outreachBefore[0]!.n);

    await adminQuery(
      `insert into private.gmail_normalized_threads (user_id, mail_account_id, provider_thread_id)
       values ($1, $2, 'thread-linked-1')`,
      [PRO, mailboxes.get(PRO)],
    );
    const bound = await asService<{ r: { result: string; updated: number } }>(
      "select public.gmail_send_bind_pending($1::uuid, $2::uuid) as r",
      [PRO, mailboxes.get(PRO)],
    );
    expect(bound[0]!.r.result).toBe("ok");
    expect(bound[0]!.r.updated).toBeGreaterThan(0);
    const event = await adminQuery<{ binding_status: string }>(
      "select binding_status from private.gmail_sent_events where provider_message_id = 'msg-linked-1'",
    );
    expect(event[0]!.binding_status).toBe("bound");

    const own = await queryAs<{ r: { result: string; events: { subject: string }[] } }>(
      { role: "authenticated", sub: PRO },
      "select public.gmail_send_list_own() as r",
    );
    expect(own.error).toBeNull();
    expect(JSON.stringify(own.rows[0]!.r)).not.toContain("A pitch body");
    expect(own.rows[0]!.r.events.some((row) => row.subject === "Hello from Pro")).toBe(true);
    const other = await queryAs<{ r: { events: unknown[] } }>(
      { role: "authenticated", sub: OTHER },
      "select public.gmail_send_list_own() as r",
    );
    expect(other.rows[0]!.r.events).toEqual([]);
  });

  it("connect that asks for send writes nothing, and grant_send requires a connected mailbox", async () => {
    const digest = "a".repeat(64);
    const nonce = "b".repeat(64);
    const refused = await asService<{ r: { result: string } }>(
      `select public.gmail_oauth_begin(
         $1::uuid, $2, $3, 'ct', 'iv', 'tag', 'v1', 'connect', null,
         $4::text[], '/app/account', 600
       ) as r`,
      [PRO, digest, nonce, SEND_SCOPES],
    );
    expect(refused[0]!.r.result).toBe("scope_refused");
    const leftover = await adminQuery<{ n: number }>(
      "select count(*)::int as n from private.gmail_oauth_transactions where state_digest = $1",
      [digest],
    );
    expect(leftover[0]!.n).toBe(0);

    await adminQuery(
      `with removed as (
         delete from private.gmail_oauth_credentials where mail_account_id = $1
       )
       update public.mail_accounts
          set connection_state = 'disconnected',
              disconnected_at = now(),
              granted_scopes = '{}'
        where id = $1`,
      [mailboxes.get(DEL)],
    );
    const down = await asService<{ r: { result: string } }>(
      `select public.gmail_oauth_begin(
         $1::uuid, $2, $3, 'ct', 'iv', 'tag', 'v1', 'grant_send', $4::uuid,
         $5::text[], '/app/account', 600
       ) as r`,
      [DEL, "c".repeat(64), "d".repeat(64), mailboxes.get(DEL), SEND_SCOPES],
    );
    expect(down[0]!.r.result).toBe("not_connected");

    const ready = await asService<{ r: { result: string } }>(
      `select public.gmail_oauth_begin(
         $1::uuid, $2, $3, 'ct', 'iv', 'tag', 'v1', 'grant_send', $4::uuid,
         $5::text[], '/app/account', 600
       ) as r`,
      [PRO, "e".repeat(64), "f".repeat(64), mailboxes.get(PRO), SEND_SCOPES],
    );
    expect(ready[0]!.r.result).toBe("ok");
  });

  it("account deletion erases one creator's send rows and leaves the other's", async () => {
    await adminQuery(
      `insert into private.gmail_send_attempts
         (user_id, mail_account_id, idempotency_key, payload_sha256, kind, status, recipient, subject, body)
       values
         ($1, $2, 'del-key-00000000001', $4, 'pitch', 'sent', $5, 'Gone', 'secret-a'),
         ($3, $6, 'keep-key-0000000001', $4, 'pitch', 'sent', $5, 'Stays', 'secret-b')`,
      [
        DEL,
        mailboxes.get(DEL),
        OTHER,
        "ab".repeat(32),
        RECIPIENT,
        mailboxes.get(OTHER),
      ],
    );
    const attemptIds = await adminQuery<{ id: string; user_id: string }>(
      `select id, user_id from private.gmail_send_attempts
        where idempotency_key in ('del-key-00000000001', 'keep-key-0000000001')`,
    );
    for (const row of attemptIds) {
      await adminQuery(
        `insert into private.gmail_sent_events
           (attempt_id, user_id, mail_account_id, kind, recipient, subject,
            provider_message_id, provider_thread_id, binding_status)
         values ($1, $2, $3, 'pitch', $4, 'Sub', $5, $6, 'not_requested')`,
        [
          row.id,
          row.user_id,
          mailboxes.get(row.user_id),
          RECIPIENT,
          `msg-${row.user_id.slice(0, 8)}`,
          `thread-${row.user_id.slice(0, 8)}`,
        ],
      );
    }

    const scheduled = await commitAs<{ r: { result: string } }>(
      { role: "authenticated", sub: DEL },
      "select public.request_own_account_deletion('DELETE') as r",
    );
    expect(scheduled.error).toBeNull();
    expect(scheduled.rows[0]!.r.result).toBe("scheduled");
    await adminQuery(
      `update public.users
          set deletion_requested_at = now() - interval '30 days',
              delete_after = now() - interval '1 second'
        where id = $1`,
      [DEL],
    );
    const erased = await asService<{ r: { result: string } }>(
      "select public.erase_creator_account($1::uuid) as r",
      [DEL],
    );
    expect(erased[0]!.r.result).toBe("erased");
    const left = await adminQuery<{ user_id: string }>(
      `select user_id from private.gmail_send_attempts
        where idempotency_key in ('del-key-00000000001', 'keep-key-0000000001')`,
    );
    expect(left.map((row) => row.user_id)).toEqual([OTHER]);
    const events = await adminQuery<{ user_id: string }>(
      "select user_id from private.gmail_sent_events where subject = 'Sub'",
    );
    expect(events.map((row) => row.user_id)).toEqual([OTHER]);
  });
});
