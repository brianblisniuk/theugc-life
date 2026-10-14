/**
 * DEC-DEL account deletion (D151–D155) against real Postgres.
 *
 * A creator schedules erasure 30 days out. The hard delete removes that
 * creator's personal rows and does not touch the other creator. Stored
 * identifier-free counters are left as they are. A positive credit balance
 * is reversed; a zero balance does not invent a ledger row.
 */
import { Client } from "pg";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { B02_REQUESTED_SCOPES } from "@/lib/gmail/contract";
import { adminQuery, hasTestDb, queryAs, setupDatabase, teardownDatabase } from "../db/harness";
import { endTxPool, openSession } from "../db/tx";

const d = describe.skipIf(!hasTestDb);

const USER_A = "a1510000-0000-0000-0000-000000000001";
const USER_B = "a1510000-0000-0000-0000-000000000002";
const USER_STAFF = "a1510000-0000-0000-0000-000000000003";
const USER_EMPTY = "a1510000-0000-0000-0000-000000000004";
const DEST = "a1511000-0000-0000-0000-000000000001";
const HOTEL = "a1512000-0000-0000-0000-000000000001";
const EMAIL_A = "ada-deletion@example.invalid";
const EMAIL_B = "blair-deletion@example.invalid";

let tokenA = "";
let tokenB = "";
let startingBalance = 0;

interface Clock {
  result: string;
  deletion_requested_at?: string;
  delete_after?: string;
}

async function commitAs(
  role: "authenticated" | "service_role",
  userId: string | null,
  sql: string,
) {
  const client = await openSession(role, userId);
  try {
    const res = await client.query(sql);
    await client.query("commit");
    return res.rows as { r: Clock }[];
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

/** The test shim does not give service_role schema usage. Hosted Supabase does. */
async function asServiceRole<T>(sql: string, params: unknown[] = []): Promise<T[]> {
  await adminQuery("grant usage on schema public to service_role");
  const client = await openSession("service_role", null);
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

async function creatorId(userId: string): Promise<string> {
  const rows = await adminQuery<{ id: string }>(
    "select id from public.creator_profiles where user_id = $1",
    [userId],
  );
  return rows[0]!.id;
}

async function balance(userId: string): Promise<number> {
  const rows = await adminQuery<{ n: number }>(
    "select coalesce(sum(delta), 0)::int as n from public.credit_ledger where user_id = $1",
    [userId],
  );
  return rows[0]!.n;
}

async function uuidHits(userId: string): Promise<{ total: number; where: string[] }> {
  const cols = await adminQuery<{ schema: string; table: string; column: string }>(
    `select n.nspname as schema, c.relname as "table", a.attname as "column"
       from pg_attribute a
       join pg_class c on c.oid = a.attrelid
       join pg_namespace n on n.oid = c.relnamespace
       join pg_type t on t.oid = a.atttypid
      where a.attnum > 0
        and not a.attisdropped
        and c.relkind = 'r'
        and n.nspname in ('public', 'private', 'auth')
        and t.typname = 'uuid'
      order by 1, 2, 3`,
  );
  let total = 0;
  const where: string[] = [];
  for (const col of cols) {
    if (!/^[a-z_][a-z0-9_]*$/.test(col.schema + col.table + col.column)) continue;
    const rows = await adminQuery<{ n: number }>(
      `select count(*)::int as n from ${col.schema}.${col.table} where ${col.column} = $1`,
      [userId],
    );
    const n = rows[0]!.n;
    if (n > 0) {
      total += n;
      where.push(`${col.schema}.${col.table}.${col.column}:${n}`);
    }
  }
  return { total, where };
}

async function attachMailbox(userId: string, label: string): Promise<void> {
  const client = new Client({ connectionString: process.env.TEST_DATABASE_URL });
  await client.connect();
  const scopes = [...B02_REQUESTED_SCOPES];
  try {
    await client.query("begin");
    const account = await client.query<{ id: string }>(
      `insert into public.mail_accounts
         (user_id, provider, provider_account_subject, email_address, connection_state)
       values ($1, 'gmail', $2, $3, 'pending_authorization')
       returning id`,
      [userId, `sub-${label}`, `${label}@example.invalid`],
    );
    const mailAccountId = account.rows[0]!.id;
    await client.query(
      `update public.mail_accounts
          set connection_state = 'connected', connected_at = now(), granted_scopes = $2
        where id = $1`,
      [mailAccountId, scopes],
    );
    const receipt = await client.query<{ id: string; event_seq: string }>(
      `insert into public.mail_account_consent_receipts
         (mail_account_id, user_id, consent_kind, decision, policy_version, consent_text_digest,
          granted_scopes_at_decision, decided_by_user_id, decided_at, receipt_digest)
       values ($1, $2, 'private_gmail_processing', 'granted', 'p/1', $3, $4, $2, now(), $5)
       returning id, event_seq`,
      [mailAccountId, userId, "a".repeat(64), scopes, "b".repeat(64)],
    );
    await client.query(
      `insert into public.mail_account_consents
         (mail_account_id, user_id, consent_kind, state, current_receipt_id, current_event_seq)
       values ($1, $2, 'private_gmail_processing', 'granted', $3, $4)`,
      [mailAccountId, userId, receipt.rows[0]!.id, receipt.rows[0]!.event_seq],
    );
    await client.query(
      `insert into private.gmail_oauth_credentials
         (mail_account_id, user_id, refresh_token_ciphertext, refresh_token_iv,
          refresh_token_auth_tag, encryption_key_version)
       values ($1, $2, 'ct', 'iv', 'tag', 'v1')`,
      [mailAccountId, userId],
    );
    await client.query(
      `insert into private.gmail_raw_messages
         (mail_account_id, user_id, provider_message_id, provider_thread_id, internal_date,
          sanitized_payload, payload_sha256)
       values ($1, $2, 'm1', 't1', now(), '{}'::jsonb, $3)`,
      [mailAccountId, userId, "e".repeat(64)],
    );
    await client.query(
      `insert into private.gmail_sync_runs
         (user_id, mail_account_id, mode, window_start_at, window_end_at)
       values ($1, $2, 'history_list', now() - interval '1 day', now())`,
      [userId, mailAccountId],
    );
    await client.query("commit");
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    throw error;
  } finally {
    await client.end();
  }
}

d("DEC-DEL account deletion", () => {
  beforeAll(async () => {
    await setupDatabase();
    await adminQuery(
      `insert into auth.users (id, email) values
         ($1, $2), ($3, $4), ($5, $6)`,
      [USER_A, EMAIL_A, USER_B, EMAIL_B, USER_STAFF, "staff-deletion@example.invalid"],
    );
    await adminQuery("update public.users set role = 'admin' where id = $1", [USER_STAFF]);
    startingBalance = await balance(USER_A);
    if (startingBalance <= 0 || (await balance(USER_B)) !== startingBalance) {
      throw new Error("signup grant did not land on both creators");
    }
    await adminQuery("insert into public.users (id, email, role) values ($1, $2, 'creator')", [
      USER_EMPTY,
      "empty-deletion@example.invalid",
    ]);
    await adminQuery(
      "insert into public.destinations (id, name, slug, type) values ($1, 'Deletion Bay', 'deletion-bay', 'city')",
      [DEST],
    );
    await adminQuery(
      "insert into public.hotels (id, name, slug, destination_id) values ($1, 'Deletion Hotel', 'deletion-hotel', $2)",
      [HOTEL, DEST],
    );
    await adminQuery(
      "update public.creator_profiles set display_name = $2, bio = $3 where user_id = $1",
      [USER_A, "Ada Secret", "private bio a"],
    );
    await adminQuery("update public.creator_profiles set display_name = $2 where user_id = $1", [
      USER_B,
      "Blair Stays",
    ]);
    const creatorA = await creatorId(USER_A);
    const creatorB = await creatorId(USER_B);
    await adminQuery("insert into public.pipeline_items (creator_id, hotel_id) values ($1, $2)", [
      creatorA,
      HOTEL,
    ]);
    await adminQuery("insert into public.pipeline_items (creator_id, hotel_id) values ($1, $2)", [
      creatorB,
      HOTEL,
    ]);
    await adminQuery(
      `insert into public.pitch_drafts (creator_id, hotel_id, subject, body, origin)
       values ($1, $2, 'Hello', 'A draft body', 'assistant')`,
      [creatorA, HOTEL],
    );
    await adminQuery(
      `insert into public.pitch_drafts (creator_id, hotel_id, subject, body, origin)
       values ($1, $2, 'Hello', 'B draft body', 'assistant')`,
      [creatorB, HOTEL],
    );
    await adminQuery(
      `insert into public.ai_usage
         (request_id, user_id, task, model, input_tokens, output_tokens, estimated_cost_micros, status)
       values ($1, $2, 'compose_pitch', 'claude-sonnet-5-5', 10, 20, 30, 'completed')`,
      ["a1513000-0000-0000-0000-000000000001", USER_A],
    );
    await adminQuery(
      `insert into public.ai_usage
         (request_id, user_id, task, model, input_tokens, output_tokens, estimated_cost_micros, status)
       values ($1, $2, 'compose_pitch', 'claude-sonnet-5-5', 11, 21, 31, 'completed')`,
      ["a1513000-0000-0000-0000-000000000002", USER_B],
    );
    const ledgerA = await adminQuery<{ id: string }>(
      "select id from public.credit_ledger where user_id = $1 and reason = 'free_grant'",
      [USER_A],
    );
    const ledgerB = await adminQuery<{ id: string }>(
      "select id from public.credit_ledger where user_id = $1 and reason = 'free_grant'",
      [USER_B],
    );
    await adminQuery(
      "insert into public.contact_unlocks (user_id, hotel_id, ledger_id) values ($1, $2, $3)",
      [USER_A, HOTEL, ledgerA[0]!.id],
    );
    await adminQuery(
      "insert into public.contact_unlocks (user_id, hotel_id, ledger_id) values ($1, $2, $3)",
      [USER_B, HOTEL, ledgerB[0]!.id],
    );
    await adminQuery(
      `insert into private.intelligence_facts
         (owner_user_id, fact_type, provenance_class, source_family, canonical_hotel_id,
          evidence_kind, evidence_id, network_eligible, counts_as_sample)
       values ($1, 'pitch_sent', 'creator_confirmed', 'manual', $2, 'outreach_event', $3, true, true)`,
      [USER_A, HOTEL, "a1514000-0000-0000-0000-000000000001"],
    );
    await adminQuery(
      `insert into private.intelligence_facts
         (owner_user_id, fact_type, provenance_class, source_family, canonical_hotel_id,
          evidence_kind, evidence_id, network_eligible, counts_as_sample)
       values ($1, 'pitch_sent', 'creator_confirmed', 'manual', $2, 'outreach_event', $3, true, true)`,
      [USER_B, HOTEL, "a1514000-0000-0000-0000-000000000002"],
    );
    await adminQuery(
      `insert into public.hotel_intelligence (hotel_id, pitch_count, reply_count, positive_reply_count)
       values ($1, 4, 2, 1)`,
      [HOTEL],
    );
    await attachMailbox(USER_A, "ada-mailbox");
    await attachMailbox(USER_B, "blair-mailbox");
    const createdA = await commitAs(
      "authenticated",
      USER_A,
      "select public.create_creator_share_link(null) as r",
    );
    const createdB = await commitAs(
      "authenticated",
      USER_B,
      "select public.create_creator_share_link(null) as r",
    );
    tokenA = String((createdA[0]!.r as Clock & { token?: string }).token ?? "");
    tokenB = String((createdB[0]!.r as Clock & { token?: string }).token ?? "");
    if (!tokenA || !tokenB) {
      throw new Error("share link setup did not return a token");
    }
  }, 60_000);

  afterAll(async () => {
    await endTxPool();
    await teardownDatabase();
  });

  it("refuses anon, a staff role, a missing phrase, and another creator's rows", async () => {
    const anon = await queryAs(
      { role: "anon" },
      "select public.request_own_account_deletion('DELETE')",
    );
    expect(anon.error?.message ?? "").toMatch(/permission denied/i);

    const staff = await commitAs(
      "authenticated",
      USER_STAFF,
      "select public.request_own_account_deletion('DELETE') as r",
    );
    expect(staff[0]!.r.result).toBe("not_creator");
    const staffClock = await adminQuery<{ deletion_requested_at: string | null }>(
      "select deletion_requested_at from public.users where id = $1",
      [USER_STAFF],
    );
    expect(staffClock[0]!.deletion_requested_at).toBeNull();

    const wrong = await commitAs(
      "authenticated",
      USER_A,
      "select public.request_own_account_deletion('delete') as r",
    );
    expect(wrong[0]!.r.result).toBe("confirmation_required");
    const still = await adminQuery<{ deletion_requested_at: string | null }>(
      "select deletion_requested_at from public.users where id = $1",
      [USER_A],
    );
    expect(still[0]!.deletion_requested_at).toBeNull();
    expect(await balance(USER_B)).toBe(startingBalance);
  });

  it("schedules A for exactly 30 days and does not invent a reversal at zero", async () => {
    const emptyBefore = await adminQuery<{ n: number }>(
      "select count(*)::int as n from public.credit_ledger where user_id = $1",
      [USER_EMPTY],
    );
    expect(emptyBefore[0]!.n).toBe(0);
    const empty = await commitAs(
      "authenticated",
      USER_EMPTY,
      "select public.request_own_account_deletion('DELETE') as r",
    );
    expect(empty[0]!.r.result).toBe("scheduled");
    const emptyAfter = await adminQuery<{ n: number }>(
      "select count(*)::int as n from public.credit_ledger where user_id = $1",
      [USER_EMPTY],
    );
    expect(emptyAfter[0]!.n).toBe(0);

    expect(await balance(USER_A)).toBe(startingBalance);
    const scheduled = await commitAs(
      "authenticated",
      USER_A,
      "select public.request_own_account_deletion('DELETE') as r",
    );
    expect(scheduled[0]!.r.result).toBe("scheduled");
    const exact = await adminQuery<{ exact: boolean }>(
      `select delete_after = deletion_requested_at + interval '30 days' as exact
         from public.users where id = $1`,
      [USER_A],
    );
    expect(exact[0]!.exact).toBe(true);
    expect(await balance(USER_A)).toBe(0);
    expect(await balance(USER_B)).toBe(startingBalance);

    const again = await commitAs(
      "authenticated",
      USER_A,
      "select public.request_own_account_deletion('NO') as r",
    );
    expect(again[0]!.r.result).toBe("already_scheduled");
    expect(String(again[0]!.r.delete_after)).toBe(String(scheduled[0]!.r.delete_after));

    const own = await commitAs(
      "authenticated",
      USER_A,
      "select public.read_own_account_deletion() as r",
    );
    expect(own[0]!.r.result).toBe("scheduled");
    const otherRead = await commitAs(
      "authenticated",
      USER_B,
      "select public.read_own_account_deletion() as r",
    );
    expect(otherRead[0]!.r.result).toBe("none");

    const mailbox = await adminQuery<{ connection_state: string; n: number; sync: string }>(
      `select m.connection_state,
              (select count(*)::int from private.gmail_oauth_credentials c where c.user_id = m.user_id) as n,
              (select s.status from private.gmail_sync_runs s where s.user_id = m.user_id) as sync
         from public.mail_accounts m
        where m.user_id = $1`,
      [USER_A],
    );
    expect(mailbox[0]!.connection_state).toBe("deletion_pending");
    expect(mailbox[0]!.n).toBe(0);
    expect(mailbox[0]!.sync).toBe("cancelled_connection_stopped");
    const raw = await adminQuery<{ n: number }>(
      "select count(*)::int as n from private.gmail_raw_messages where user_id = $1",
      [USER_A],
    );
    expect(raw[0]!.n).toBe(1);

    const drafts = await adminQuery<{ n: number }>(
      `select count(*)::int as n
         from public.pitch_drafts d
         join public.creator_profiles p on p.id = d.creator_id
        where p.user_id = $1 and d.origin = 'assistant'`,
      [USER_A],
    );
    expect(drafts[0]!.n).toBe(0);
    const bDrafts = await adminQuery<{ n: number }>(
      `select count(*)::int as n
         from public.pitch_drafts d
         join public.creator_profiles p on p.id = d.creator_id
        where p.user_id = $1`,
      [USER_B],
    );
    expect(bDrafts[0]!.n).toBe(1);

    const bMailbox = await adminQuery<{ connection_state: string; n: number }>(
      `select m.connection_state,
              (select count(*)::int from private.gmail_oauth_credentials c where c.mail_account_id = m.id) as n
         from public.mail_accounts m
        where m.user_id = $1`,
      [USER_B],
    );
    expect(bMailbox[0]!.connection_state).toBe("connected");
    expect(bMailbox[0]!.n).toBe(1);

    const revoked = await queryAs<{ r: { result: string } }>(
      { role: "anon" },
      "select public.read_creator_share_profile($1) as r",
      [tokenA],
    );
    expect(revoked.rows[0]!.r.result).toBe("not_found");
    const stillB = await queryAs<{ r: { result: string } }>(
      { role: "anon" },
      "select public.read_creator_share_profile($1) as r",
      [tokenB],
    );
    expect(stillB.rows[0]!.r.result).not.toBe("not_found");

    const moved = await queryAs(
      { role: "authenticated", sub: USER_A },
      "update public.users set delete_after = now() where id = $1",
      [USER_A],
    );
    expect(moved.error?.message ?? "").toMatch(
      /not authorized to change the account deletion schedule/i,
    );

    const timezone = await queryAs(
      { role: "authenticated", sub: USER_A },
      "update public.users set timezone = 'UTC' where id = $1 returning timezone",
      [USER_A],
    );
    expect(timezone.error).toBeNull();

    await expect(
      adminQuery(
        `update public.users
            set delete_after = deletion_requested_at + interval '31 days'
          where id = $1`,
        [USER_A],
      ),
    ).rejects.toThrow(/users_deletion_clock_window/);

    const early = await asServiceRole<{ r: Clock }>(
      "select public.erase_creator_account($1) as r",
      [USER_A],
    );
    expect(early[0]!.r.result).toBe("not_due");
    const denied = await queryAs(
      { role: "authenticated", sub: USER_A },
      `select public.erase_creator_account('${USER_B}'::uuid)`,
    );
    expect(denied.error?.message ?? "").toMatch(/permission denied/i);
    expect(await uuidHits(USER_A)).toMatchObject({ total: expect.any(Number) });
    expect((await uuidHits(USER_A)).total).toBeGreaterThan(0);
  });

  it("erases A when the deadline has arrived and leaves B and the stored counters", async () => {
    const before = await adminQuery<{ pitch_count: number; reply_count: number }>(
      "select pitch_count, reply_count from public.hotel_intelligence where hotel_id = $1",
      [HOTEL],
    );
    await adminQuery(
      `update public.users
          set deletion_requested_at = now() - interval '30 days',
              delete_after = now() - interval '1 second'
        where id = $1`,
      [USER_A],
    );
    const erased = await asServiceRole<{ r: Clock }>(
      "select public.erase_creator_account($1) as r",
      [USER_A],
    );
    expect(erased[0]!.r.result).toBe("erased");

    const hits = await uuidHits(USER_A);
    expect(hits.where, hits.where.join(", ")).toEqual([]);
    expect(hits.total).toBe(0);

    const emails = await adminQuery<{ n: number }>(
      `select (
          (select count(*) from public.users where email = $1)
          + (select count(*) from auth.users where email = $1)
          + (select count(*) from public.mail_accounts where email_address = $2)
          + (select count(*) from public.creator_profiles where display_name = 'Ada Secret')
        )::int as n`,
      [EMAIL_A, "ada-mailbox@example.invalid"],
    );
    expect(emails[0]!.n).toBe(0);

    expect(await balance(USER_B)).toBe(startingBalance);
    const bUser = await adminQuery<{ email: string }>(
      "select email from public.users where id = $1",
      [USER_B],
    );
    expect(bUser[0]!.email).toBe(EMAIL_B);
    const bProfile = await adminQuery<{ display_name: string }>(
      "select display_name from public.creator_profiles where user_id = $1",
      [USER_B],
    );
    expect(bProfile[0]!.display_name).toBe("Blair Stays");
    const bFacts = await adminQuery<{ n: number }>(
      "select count(*)::int as n from private.intelligence_facts where owner_user_id = $1",
      [USER_B],
    );
    expect(bFacts[0]!.n).toBe(1);
    const bRaw = await adminQuery<{ n: number }>(
      "select count(*)::int as n from private.gmail_raw_messages where user_id = $1",
      [USER_B],
    );
    expect(bRaw[0]!.n).toBe(1);
    const bUnlocks = await adminQuery<{ n: number }>(
      "select count(*)::int as n from public.contact_unlocks where user_id = $1",
      [USER_B],
    );
    expect(bUnlocks[0]!.n).toBe(1);
    const bUsage = await adminQuery<{ n: number }>(
      "select count(*)::int as n from public.ai_usage where user_id = $1",
      [USER_B],
    );
    expect(bUsage[0]!.n).toBe(1);

    const after = await adminQuery<{ pitch_count: number; reply_count: number }>(
      "select pitch_count, reply_count from public.hotel_intelligence where hotel_id = $1",
      [HOTEL],
    );
    expect(after[0]).toEqual(before[0]);

    const hotel = await adminQuery<{ id: string }>("select id from public.hotels where id = $1", [
      HOTEL,
    ]);
    expect(hotel).toHaveLength(1);

    const staff = await adminQuery<{ role: string }>(
      "select role from public.users where id = $1",
      [USER_STAFF],
    );
    expect(staff[0]!.role).toBe("admin");

    await expect(
      adminQuery("delete from public.credit_ledger where user_id = $1", [USER_B]),
    ).rejects.toThrow(/append-only/);

    await adminQuery(
      `update public.users
          set deletion_requested_at = now() - interval '30 days',
              delete_after = now() - interval '1 second'
        where id = $1`,
      [USER_EMPTY],
    );
    const due = await asServiceRole<{ r: { result: string; erased: number } }>(
      "select public.erase_due_creator_accounts() as r",
    );
    expect(due[0]!.r).toMatchObject({ result: "ok", erased: 1 });
    const emptyGone = await adminQuery<{ n: number }>(
      "select count(*)::int as n from public.users where id = $1",
      [USER_EMPTY],
    );
    expect(emptyGone[0]!.n).toBe(0);
    const bStill = await adminQuery<{ n: number }>(
      "select count(*)::int as n from public.users where id = $1",
      [USER_B],
    );
    expect(bStill[0]!.n).toBe(1);
  });
});
