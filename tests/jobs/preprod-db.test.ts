/**
 * PREPROD-1 against Postgres.
 *
 * User A has a pending deletion. User B does not. The annual refresh grants
 * one period and does not grant it again. Erasure of a due account is
 * idempotent and leaves the stored hotel counters.
 */
import { Client } from "pg";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { B02_REQUESTED_SCOPES, SEND_INCREMENTAL_SCOPES } from "@/lib/gmail/contract";
import { adminQuery, hasTestDb, queryAs, setupDatabase, teardownDatabase } from "../db/harness";
import { openSession } from "../db/tx";

const d = describe.skipIf(!hasTestDb);

const USER_A = "d178a000-0000-4000-8000-000000000001";
const USER_B = "d178b000-0000-4000-8000-000000000002";
const ANNUAL = "d178c000-0000-4000-8000-000000000003";
const MONTHLY = "d178d000-0000-4000-8000-000000000004";
const SKIP = "d178e000-0000-4000-8000-000000000005";
const DUE = "d178f000-0000-4000-8000-000000000006";
const DEST = "d1781000-0000-4000-8000-000000000001";
const HOTEL = "d1782000-0000-4000-8000-000000000001";

const READ_SCOPES = [...B02_REQUESTED_SCOPES];
const SEND_SCOPES = [...SEND_INCREMENTAL_SCOPES];

async function makeUser(id: string) {
  await adminQuery("insert into auth.users (id, email) values ($1, $2)", [
    id,
    `${id}@preprod.test`,
  ]);
}

async function planGrants(userId: string): Promise<number> {
  const rows = await adminQuery<{ n: number }>(
    `select count(*)::int as n from public.credit_ledger
      where user_id = $1 and reason = 'plan_grant'`,
    [userId],
  );
  return rows[0]!.n;
}

async function asService<T>(sub: string | null, sql: string, params: unknown[] = []): Promise<T[]> {
  await adminQuery("grant usage on schema public to service_role");
  const client = await openSession("service_role", sub);
  try {
    const res = await client.query(sql, params);
    await client.query("commit");
    return res.rows as T[];
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    throw error;
  } finally {
    client.release();
    await adminQuery("revoke usage on schema public from service_role");
  }
}

async function mailbox(userId: string, label: string, scopes: string[]): Promise<string> {
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
      `insert into private.gmail_oauth_credentials
         (mail_account_id, user_id, refresh_token_ciphertext, refresh_token_iv,
          refresh_token_auth_tag, encryption_key_version)
       values ($1, $2, 'ct', 'iv', 'tag', 'v1')`,
      [id, userId],
    );
    await client.query(
      `update public.mail_accounts
          set connection_state = 'connected', connected_at = now(), granted_scopes = $2
        where id = $1`,
      [id, scopes],
    );
    const receipt = await client.query<{ id: string; event_seq: string }>(
      `insert into public.mail_account_consent_receipts
         (mail_account_id, user_id, consent_kind, decision, policy_version, consent_text_digest,
          granted_scopes_at_decision, decided_by_user_id, decided_at, receipt_digest)
       values ($1, $2, 'private_gmail_processing', 'granted', 'p/1', $3, $4, $2, now(), $5)
       returning id, event_seq`,
      [id, userId, "a".repeat(64), scopes, "b".repeat(64)],
    );
    await client.query(
      `insert into public.mail_account_consents
         (mail_account_id, user_id, consent_kind, state, current_receipt_id, current_event_seq)
       values ($1, $2, 'private_gmail_processing', 'granted', $3, $4)`,
      [id, userId, receipt.rows[0]!.id, receipt.rows[0]!.event_seq],
    );
    await client.query(
      `insert into private.gmail_historical_import_runs
         (user_id, mail_account_id, window_start_at, window_end_at, status, phase, completed_at)
       values ($1, $2, now() - interval '30 days', now() - interval '1 day', 'completed', 'finished', now())`,
      [userId, id],
    );
    await client.query("commit");
    return id;
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    throw error;
  } finally {
    await client.end();
  }
}

d("preprod jobs", () => {
  let mailA = "";
  let mailB = "";

  beforeAll(async () => {
    await setupDatabase();
    await makeUser(USER_A);
    await makeUser(USER_B);
    await makeUser(ANNUAL);
    await makeUser(MONTHLY);
    await makeUser(SKIP);
    await makeUser(DUE);
    await adminQuery(
      "insert into public.destinations (id, name, slug, type) values ($1, 'Preprod Bay', 'preprod-bay', 'city')",
      [DEST],
    );
    await adminQuery(
      "insert into public.hotels (id, name, slug, destination_id) values ($1, 'Preprod Hotel', 'preprod-hotel', $2)",
      [HOTEL, DEST],
    );
    await adminQuery(
      `insert into public.hotel_intelligence (hotel_id, pitch_count, reply_count, positive_reply_count)
       values ($1, 4, 2, 1)`,
      [HOTEL],
    );
    await adminQuery(
      `insert into public.access_entitlements
         (user_id, access_type, status, starts_at, source, source_reference)
       values
         ($1, 'pro', 'active', now(), 'test', 'preprod-a'),
         ($2, 'pro', 'active', now(), 'test', 'preprod-b')`,
      [USER_A, USER_B],
    );
    mailA = await mailbox(USER_A, "preprod-a", SEND_SCOPES);
    mailB = await mailbox(USER_B, "preprod-b", SEND_SCOPES);
    await adminQuery(
      `update public.users
          set deletion_requested_at = now(),
              delete_after = now() + interval '30 days'
        where id = $1`,
      [USER_A],
    );
  }, 120_000);

  afterAll(async () => {
    await teardownDatabase();
  });

  it("refuses Gmail for A and still allows B", async () => {
    const connectA = await adminQuery<{ r: { result: string } }>(
      `select public.gmail_oauth_begin(
         $1::uuid, $2, $3, 'ct', 'iv', 'tag', 'v1', 'connect', null,
         $4::text[], '/app/account', 600
       ) as r`,
      [USER_A, "a".repeat(64), "b".repeat(64), READ_SCOPES],
    );
    expect(connectA[0]!.r.result).toBe("deletion_pending");

    const reconnectA = await adminQuery<{ r: { result: string } }>(
      `select public.gmail_oauth_begin(
         $1::uuid, $2, $3, 'ct', 'iv', 'tag', 'v1', 'reconnect', $4::uuid,
         $5::text[], '/app/account', 600
       ) as r`,
      [USER_A, "c".repeat(64), "d".repeat(64), mailA, READ_SCOPES],
    );
    expect(reconnectA[0]!.r.result).toBe("deletion_pending");

    const grantA = await adminQuery<{ r: { result: string } }>(
      `select public.gmail_oauth_begin(
         $1::uuid, $2, $3, 'ct', 'iv', 'tag', 'v1', 'grant_send', $4::uuid,
         $5::text[], '/app/account', 600
       ) as r`,
      [USER_A, "e".repeat(64), "1".repeat(64), mailA, SEND_SCOPES],
    );
    expect(grantA[0]!.r.result).toBe("deletion_pending");

    const transactionsA = await adminQuery<{ n: number }>(
      "select count(*)::int as n from private.gmail_oauth_transactions where user_id = $1",
      [USER_A],
    );
    expect(transactionsA[0]!.n).toBe(0);

    const connectB = await adminQuery<{ r: { result: string } }>(
      `select public.gmail_oauth_begin(
         $1::uuid, $2, $3, 'ct', 'iv', 'tag', 'v1', 'connect', null,
         $4::text[], '/app/account', 600
       ) as r`,
      [USER_B, "f".repeat(64), "0".repeat(64), READ_SCOPES],
    );
    expect(connectB[0]!.r.result).toBe("ok");

    await expect(
      adminQuery(
        `update private.gmail_oauth_credentials
            set refresh_token_ciphertext = 'replaced'
          where mail_account_id = $1`,
        [mailA],
      ),
    ).rejects.toThrow(/gmail is blocked while account deletion is pending/);

    await adminQuery(
      `update private.gmail_oauth_credentials
          set refresh_token_ciphertext = 'replaced'
        where mail_account_id = $1`,
      [mailB],
    );

    await expect(
      adminQuery(
        `insert into private.gmail_oauth_transactions
           (user_id, state_digest, nonce_digest, code_verifier_ciphertext, code_verifier_iv,
            code_verifier_auth_tag, encryption_key_version, purpose, requested_scopes, expires_at)
         values ($1, $2, $3, 'ct', 'iv', 'tag', 'v1', 'connect', $4, now() + interval '10 minutes')`,
        [USER_A, "9".repeat(64), "8".repeat(64), READ_SCOPES],
      ),
    ).rejects.toThrow(/gmail is blocked while account deletion is pending/);

    const reserveA = await adminQuery<{ r: { result: string; call_provider: boolean } }>(
      `select public.gmail_send_reserve(
         $1::uuid, $2::uuid, 'preprod-key-000001', 'pitch', 'desk@hotel.example',
         'Hello', 'A pitch body', $3::uuid, null, null, null, null
       ) as r`,
      [USER_A, mailA, HOTEL],
    );
    expect(reserveA[0]!.r).toMatchObject({ result: "deletion_pending", call_provider: false });
    const attemptsA = await adminQuery<{ n: number }>(
      "select count(*)::int as n from private.gmail_send_attempts where user_id = $1",
      [USER_A],
    );
    expect(attemptsA[0]!.n).toBe(0);

    const reserveB = await adminQuery<{ r: { result: string } }>(
      `select public.gmail_send_reserve(
         $1::uuid, $2::uuid, 'preprod-key-000002', 'pitch', 'desk@hotel.example',
         'Hello', 'B pitch body', $3::uuid, null, null, null, null
       ) as r`,
      [USER_B, mailB, HOTEL],
    );
    expect(reserveB[0]!.r.result).not.toBe("deletion_pending");

    const loginA = await adminQuery<{ r: { result: string; mailboxes_marked: number } }>(
      "select public.gmail_incremental_sync_request_login($1) as r",
      [USER_A],
    );
    expect(loginA[0]!.r).toMatchObject({ result: "deletion_pending", mailboxes_marked: 0 });
    const cursorsA = await adminQuery<{ n: number }>(
      "select count(*)::int as n from private.gmail_sync_cursors where user_id = $1",
      [USER_A],
    );
    expect(cursorsA[0]!.n).toBe(0);

    const claimA = await adminQuery<{ r: { result: string } }>(
      "select public.gmail_incremental_sync_claim_step($1, $2, 60) as r",
      [USER_A, mailA],
    );
    expect(claimA[0]!.r.result).toBe("deletion_pending");
    const claimB = await adminQuery<{ r: { result: string } }>(
      "select public.gmail_incremental_sync_claim_step($1, $2, 60) as r",
      [USER_B, mailB],
    );
    expect(claimB[0]!.r.result).not.toBe("deletion_pending");

    const due = await adminQuery<{ r: { accounts: { user_id: string }[] } }>(
      "select public.gmail_incremental_sync_list_due(100) as r",
    );
    const dueUsers = due[0]!.r.accounts.map((row) => row.user_id);
    expect(dueUsers).not.toContain(USER_A);
    expect(dueUsers).toContain(USER_B);

    const holdA = await adminQuery<{ r: string | null }>(
      "select private.gmail_followup_hold($1, $2) as r",
      [USER_A, mailA],
    );
    const holdB = await adminQuery<{ r: string | null }>(
      "select private.gmail_followup_hold($1, $2) as r",
      [USER_B, mailB],
    );
    expect(holdA[0]!.r).toBe("mailbox");
    expect(holdB[0]!.r).toBeNull();

    const blocked = await queryAs(
      { role: "authenticated", sub: USER_B },
      "select public.account_gmail_blocked($1::uuid)",
      [USER_A],
    );
    expect(blocked.error?.message ?? "").toMatch(/permission denied/i);
    const blockedService = await queryAs(
      { role: "service_role", sub: null },
      "select public.account_gmail_blocked($1::uuid)",
      [USER_B],
    );
    expect(blockedService.error?.message ?? "").toMatch(/permission denied/i);
  });

  it("refreshes an annual window once and skips a monthly plan and a pending deletion", async () => {
    await adminQuery(
      `insert into public.subscriptions
         (user_id, provider, provider_subscription_id, plan_code, status, billing_interval, price_paid, currency)
       values
         ($1, 'stub', 'preprod-year', 'pro', 'active', 'year', 240, 'USD'),
         ($2, 'stub', 'preprod-month', 'pro', 'active', 'month', 20, 'USD'),
         ($3, 'stub', 'preprod-year-deleting', 'pro', 'active', 'year', 240, 'USD')`,
      [ANNUAL, MONTHLY, SKIP],
    );
    await adminQuery(
      `insert into public.access_entitlements
         (user_id, access_type, status, starts_at, expires_at, source, source_reference)
       values
         ($1, 'pro', 'active', now() - interval '31 days', now() + interval '300 days', 'rebill', 'preprod-year-ent'),
         ($2, 'pro', 'active', now() - interval '31 days', now() + interval '300 days', 'rebill', 'preprod-month-ent'),
         ($3, 'pro', 'active', now() - interval '31 days', now() + interval '300 days', 'rebill', 'preprod-skip-ent')`,
      [ANNUAL, MONTHLY, SKIP],
    );
    await adminQuery(
      `update public.users
          set deletion_requested_at = now(),
              delete_after = now() + interval '30 days'
        where id = $1`,
      [SKIP],
    );

    const denied = await asService<{ r: { result: string; users: number } }>(
      ANNUAL,
      "select public.refresh_annual_credit_periods() as r",
    );
    expect(denied[0]!.r).toMatchObject({ result: "forbidden", users: 0 });
    expect(await planGrants(ANNUAL)).toBe(0);

    const clientDenied = await queryAs(
      { role: "authenticated", sub: ANNUAL },
      "select public.refresh_annual_credit_periods()",
    );
    expect(clientDenied.error?.message ?? "").toMatch(/permission denied/i);

    const first = await adminQuery<{ r: { result: string; users: number } }>(
      "select public.refresh_annual_credit_periods() as r",
    );
    expect(first[0]!.r).toEqual({ result: "ok", users: 1 });
    expect(await planGrants(ANNUAL)).toBe(1);
    expect(await planGrants(MONTHLY)).toBe(0);
    expect(await planGrants(SKIP)).toBe(0);

    const second = await adminQuery<{ r: { result: string; users: number } }>(
      "select public.refresh_annual_credit_periods() as r",
    );
    expect(second[0]!.r).toEqual({ result: "ok", users: 1 });
    expect(await planGrants(ANNUAL)).toBe(1);
  });

  it("erases a due account once and keeps the anonymized counters and user B", async () => {
    const others = await adminQuery<{ n: number }>(
      `select count(*)::int as n from public.users
        where role = 'creator' and delete_after is not null and delete_after <= now()
          and id <> $1`,
      [DUE],
    );
    expect(others[0]!.n).toBe(0);

    const before = await adminQuery<{ pitch_count: number; reply_count: number }>(
      "select pitch_count, reply_count from public.hotel_intelligence where hotel_id = $1",
      [HOTEL],
    );
    await adminQuery(
      `update public.users
          set deletion_requested_at = now() - interval '30 days',
              delete_after = now() - interval '1 second'
        where id = $1`,
      [DUE],
    );
    const first = await adminQuery<{ r: { result: string; erased: number } }>(
      "select public.erase_due_creator_accounts() as r",
    );
    expect(first[0]!.r).toEqual({ result: "ok", erased: 1 });
    const second = await adminQuery<{ r: { result: string; erased: number } }>(
      "select public.erase_due_creator_accounts() as r",
    );
    expect(second[0]!.r).toEqual({ result: "ok", erased: 0 });

    const after = await adminQuery<{ pitch_count: number; reply_count: number }>(
      "select pitch_count, reply_count from public.hotel_intelligence where hotel_id = $1",
      [HOTEL],
    );
    expect(after).toEqual(before);
    const stillB = await adminQuery<{ email: string }>(
      "select email from public.users where id = $1",
      [USER_B],
    );
    expect(stillB[0]!.email).toBe(`${USER_B}@preprod.test`);
    const gone = await adminQuery<{ n: number }>(
      "select count(*)::int as n from public.users where id = $1",
      [DUE],
    );
    expect(gone[0]!.n).toBe(0);
  });
});
