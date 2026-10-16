/**
 * E2E-4 SQL regressions against local Postgres.
 *
 * Anon cannot read creator_profiles. Public cards still come from
 * read_public_creator_card. Pending deletion blocks new share links and
 * positive credit grants, and a refund of an already-applied payment still
 * runs. Usernames reject a lookalike. Private Gmail tables have RLS and no
 * policy. Security definers do not keep pg_temp on the search path.
 */
import { Client } from "pg";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  adminQuery,
  commitAs,
  hasTestDb,
  queryAs,
  setupDatabase,
  teardownDatabase,
} from "../db/harness";

const d = describe.skipIf(!hasTestDb);

const CREDIT = "e2e4c000-0000-4000-8000-000000000001";
const REFUND = "e2e4c000-0000-4000-8000-000000000002";
const SHARE = "e2e4c000-0000-4000-8000-000000000003";
const ROTATE = "e2e4c000-0000-4000-8000-000000000004";
const CARD = "e2e4c000-0000-4000-8000-000000000005";

const PRIVATE_TABLES = [
  "gmail_historical_import_runs",
  "gmail_historical_import_threads",
  "gmail_normalized_headers",
  "gmail_normalized_messages",
  "gmail_normalized_participants",
  "gmail_normalized_reference_tokens",
  "gmail_normalized_text_parts",
  "gmail_normalized_threads",
  "gmail_oauth_credentials",
  "gmail_oauth_transactions",
  "gmail_outreach_catalog_epoch_lock",
  "gmail_outreach_creator_decision_events",
  "gmail_outreach_creator_decisions",
  "gmail_outreach_observed_recipient_canonical_links",
  "gmail_outreach_observed_recipients",
  "gmail_outreach_target_canonical_links",
  "gmail_outreach_target_confirmations",
  "gmail_outreach_target_contact_candidates",
  "gmail_outreach_target_contact_confirmed_members",
  "gmail_outreach_target_contact_signals",
  "gmail_outreach_target_observations",
  "gmail_outreach_target_scope_signals",
  "gmail_outreach_thread_signals",
  "gmail_raw_messages",
  "gmail_reply_message_observations",
  "gmail_reply_thread_summaries",
];

const DIGEST_DEFINERS = [
  "gmail_outreach_commit_interpretation",
  "gmail_outreach_list_candidates",
  "gmail_reply_commit_interpretation",
  "gmail_reply_get_thread_evidence",
  "gmail_reply_list_candidates",
];

async function makeUser(id: string) {
  await adminQuery("insert into auth.users (id, email) values ($1, $2)", [id, `${id}@e2e4.test`]);
}

async function freeGrantCount(userId: string): Promise<number> {
  const rows = await adminQuery<{ n: number }>(
    `select count(*)::int as n from public.credit_ledger
      where user_id = $1 and reason = 'free_grant'`,
    [userId],
  );
  return rows[0]!.n;
}

async function balanceOf(userId: string): Promise<number> {
  const rows = await adminQuery<{ n: number }>(
    "select coalesce(sum(delta), 0)::int as n from public.credit_ledger where user_id = $1",
    [userId],
  );
  return rows[0]!.n;
}

async function unrevokedLinks(userId: string): Promise<number> {
  const rows = await adminQuery<{ n: number }>(
    `select count(*)::int as n
       from public.creator_share_links l
       join public.creator_profiles cp on cp.id = l.creator_id
      where cp.user_id = $1 and l.revoked_at is null`,
    [userId],
  );
  return rows[0]!.n;
}

async function checkout(userId: string, link: string) {
  const created = await commitAs<{ result: string; checkout_id: string; amount_usd: number }>(
    { role: "authenticated", sub: userId },
    `select r->>'result' as result,
            r->>'checkout_id' as checkout_id,
            (r->>'amount_usd')::int as amount_usd
       from (select public.create_own_rebill_checkout('pack_50') as r) s`,
  );
  expect(created.error).toBeNull();
  expect(created.rows[0]?.result).toBe("created");
  const attached = await adminQuery<{ result: string }>(
    "select public.attach_own_rebill_checkout_link($1::uuid, $2)->>'result' as result",
    [created.rows[0]!.checkout_id, link],
  );
  expect(attached[0]?.result).toBe("attached");
  return created.rows[0]!;
}

function payment(input: {
  logId: string;
  paymentId: string;
  status: string;
  amount: number;
  checkoutId?: string;
  linkId?: string;
}) {
  return {
    logId: input.logId,
    event: "payment.updated",
    userId: "00000000-0000-4000-8000-000000000099",
    payment: {
      id: input.paymentId,
      status: input.status,
      amount: input.amount,
      currency: "USD",
      checkoutId: input.checkoutId,
      paymentLinkId: input.linkId,
    },
  };
}

async function apply(event: Record<string, unknown>): Promise<string> {
  const rows = await adminQuery<{ result: string }>(
    "select public.apply_rebill_event($1::jsonb)->>'result' as result",
    [JSON.stringify(event)],
  );
  return rows[0]!.result;
}

async function scheduleDeletion(userId: string) {
  const scheduled = await commitAs<{ r: { result: string } }>(
    { role: "authenticated", sub: userId },
    "select public.request_own_account_deletion('DELETE') as r",
  );
  expect(scheduled.error).toBeNull();
  expect(scheduled.rows[0]?.r.result).toBe("scheduled");
}

d("e2e4 sql hardening", () => {
  beforeAll(async () => {
    await setupDatabase();
    for (const id of [CREDIT, REFUND, SHARE, ROTATE, CARD]) await makeUser(id);
  }, 120_000);

  afterAll(async () => {
    await teardownDatabase();
  });

  it("does not grant a pack or a new weekly credit while deletion is pending", async () => {
    const row = await checkout(CREDIT, "pl_e2e4pack");
    await scheduleDeletion(CREDIT);
    const before = await balanceOf(CREDIT);
    expect(
      await apply(
        payment({
          logId: "log_e2e4_pack",
          paymentId: "pay_e2e4pack",
          status: "approved",
          amount: row.amount_usd,
          checkoutId: row.checkout_id,
          linkId: "pl_e2e4pack",
        }),
      ),
    ).toBe("deletion_pending");
    expect(await balanceOf(CREDIT)).toBe(before);

    const grants = await freeGrantCount(CREDIT);
    await adminQuery(
      "update public.users set created_at = now() - interval '8 days' where id = $1",
      [CREDIT],
    );
    const refreshed = await commitAs<{ n: number | null }>(
      { role: "authenticated", sub: CREDIT },
      "select public.ensure_own_credit_grants() as n",
    );
    expect(refreshed.error).toBeNull();
    expect(await freeGrantCount(CREDIT)).toBe(grants);
  });

  it("still refunds an applied pack after deletion is requested", async () => {
    const row = await checkout(REFUND, "pl_e2e4refund");
    expect(
      await apply(
        payment({
          logId: "log_e2e4_refund_pay",
          paymentId: "pay_e2e4refund",
          status: "approved",
          amount: row.amount_usd,
          checkoutId: row.checkout_id,
          linkId: "pl_e2e4refund",
        }),
      ),
    ).toBe("applied");
    const before = await balanceOf(REFUND);
    expect(before).toBeGreaterThan(0);
    await adminQuery(
      `update public.users
          set deletion_requested_at = now(),
              delete_after = now() + interval '30 days'
        where id = $1`,
      [REFUND],
    );
    expect(
      await apply({
        logId: "log_e2e4_refund",
        event: "payment.updated",
        userId: CREDIT,
        payment: {
          id: "pay_e2e4refund",
          status: "refunded",
          amount: row.amount_usd,
          currency: "USD",
        },
      }),
    ).toBe("revoked");
    expect(await balanceOf(REFUND)).toBeLessThan(before);
  });

  it("does not issue a share link while deletion is pending", async () => {
    const created = await commitAs<{ r: { result: string; token?: string } }>(
      { role: "authenticated", sub: ROTATE },
      "select public.create_creator_share_link(null) as r",
    );
    expect(created.rows[0]?.r.result).toBe("created");
    expect(await unrevokedLinks(ROTATE)).toBe(1);
    await scheduleDeletion(ROTATE);
    const afterSchedule = await unrevokedLinks(ROTATE);
    const rotated = await commitAs<{ r: { result: string; token?: string } }>(
      { role: "authenticated", sub: ROTATE },
      "select public.rotate_creator_share_link(null) as r",
    );
    expect(rotated.rows[0]?.r.result).toBe("deletion_pending");
    expect(rotated.rows[0]?.r.token ?? null).toBeNull();
    expect(await unrevokedLinks(ROTATE)).toBe(afterSchedule);

    await scheduleDeletion(SHARE);
    const blocked = await commitAs<{ r: { result: string; token?: string } }>(
      { role: "authenticated", sub: SHARE },
      "select public.create_creator_share_link(null) as r",
    );
    expect(blocked.rows[0]?.r.result).toBe("deletion_pending");
    expect(await unrevokedLinks(SHARE)).toBe(0);
  });

  it("revokes anon select and keeps the public card function", async () => {
    const [profile] = await adminQuery<{ id: string }>(
      "select id from public.creator_profiles where user_id = $1",
      [CARD],
    );
    await adminQuery(
      `update public.creator_profiles
          set username = 'e2e4_card', display_name = 'E2E Card', public_profile_enabled = true
        where id = $1`,
      [profile!.id],
    );
    const anon = await queryAs(
      { role: "anon" },
      "select user_id from public.creator_profiles where user_id = $1",
      [CARD],
    );
    expect(anon.error?.code).toBe("42501");
    const card = await queryAs<{ r: Record<string, unknown> | null }>(
      { role: "anon" },
      "select public.read_public_creator_card('e2e4_card') as r",
    );
    expect(card.error).toBeNull();
    const packed = JSON.stringify(card.rows[0]?.r);
    expect(packed).toContain("E2E Card");
    expect(packed).not.toContain(CARD);
    expect(packed).not.toContain(profile!.id);
    expect(packed).not.toContain("user_id");
  });

  it("rejects a unicode lookalike username and accepts the form alphabet", async () => {
    const [profile] = await adminQuery<{ id: string }>(
      "select id from public.creator_profiles where user_id = $1",
      [CARD],
    );
    let rejected = false;
    try {
      await adminQuery("update public.creator_profiles set username = $2 where id = $1", [
        profile!.id,
        "аda_look",
      ]);
    } catch (error) {
      rejected = (error as { code?: string }).code === "23514";
    }
    expect(rejected).toBe(true);
    let short = false;
    try {
      await adminQuery("update public.creator_profiles set username = 'ab' where id = $1", [
        profile!.id,
      ]);
    } catch (error) {
      short = (error as { code?: string }).code === "23514";
    }
    expect(short).toBe(true);
    await adminQuery("update public.creator_profiles set username = 'Ada_Name' where id = $1", [
      profile!.id,
    ]);
    const stored = await adminQuery<{ username: string }>(
      "select username::text as username from public.creator_profiles where id = $1",
      [profile!.id],
    );
    expect(stored[0]!.username.toLowerCase()).toBe("ada_name");
  });

  it("enables RLS without forcing it, and a client grant still returns no rows", async () => {
    const rows = await adminQuery<{
      relname: string;
      rls: boolean;
      forced: boolean;
      policies: number;
    }>(
      `select c.relname,
              c.relrowsecurity as rls,
              c.relforcerowsecurity as forced,
              (select count(*)::int from pg_policy pol where pol.polrelid = c.oid) as policies
         from pg_class c
         join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'private' and c.relkind = 'r'
          and c.relname = any($1::text[])
        order by c.relname`,
      [PRIVATE_TABLES],
    );
    expect(rows.map((row) => row.relname)).toEqual(PRIVATE_TABLES);
    for (const row of rows) {
      expect(row.rls, row.relname).toBe(true);
      expect(row.forced, row.relname).toBe(false);
      expect(row.policies, row.relname).toBe(0);
    }

    const client = new Client({ connectionString: process.env.TEST_DATABASE_URL });
    await client.connect();
    try {
      await client.query("begin");
      await client.query(
        "grant select on table private.gmail_outreach_catalog_epoch_lock to authenticated",
      );
      await client.query("set local role authenticated");
      const visible = await client.query(
        "select current_epoch from private.gmail_outreach_catalog_epoch_lock",
      );
      expect(visible.rows).toEqual([]);
      await client.query("rollback");
    } finally {
      await client.end();
    }
  });

  it("pins security definers off pg_temp and qualifies digest", async () => {
    const leftover = await adminQuery<{ nspname: string; proname: string }>(
      `select n.nspname, p.proname
         from pg_proc p
         join pg_namespace n on n.oid = p.pronamespace
        where p.prosecdef
          and n.nspname in ('public', 'private')
          and exists (
            select 1 from unnest(coalesce(p.proconfig, array[]::text[])) cfg
             where cfg like '%pg_temp%'
          )`,
    );
    expect(leftover).toEqual([]);

    const digest = await adminQuery<{ proname: string; def: string }>(
      `select p.proname, pg_get_functiondef(p.oid) as def
         from pg_proc p
         join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public' and p.proname = any($1::text[])
        order by p.proname`,
      [DIGEST_DEFINERS],
    );
    expect(digest.map((row) => row.proname)).toEqual([...DIGEST_DEFINERS].sort());
    for (const row of digest) {
      expect(row.def, row.proname).toContain("public.digest(");
      expect(row.def, row.proname).not.toMatch(/(?<![\w.])digest\s*\(/);
    }

    const helpers = await adminQuery<{ proname: string; def: string; cfg: string }>(
      `select p.proname, pg_get_functiondef(p.oid) as def,
              coalesce(array_to_string(p.proconfig, ','), '') as cfg
         from pg_proc p
         join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'private'
          and p.proname in (
            'gmail_reply_routing_context_digest',
            'gmail_reply_thread_summary_is_stale'
          )
        order by p.proname`,
    );
    expect(helpers).toHaveLength(2);
    for (const row of helpers) {
      expect(row.def, row.proname).toContain("public.digest(");
      expect(row.def, row.proname).not.toMatch(/(?<![\w.])digest\s*\(/);
      expect(row.cfg, row.proname).toBe("");
    }

    const bind = await adminQuery<{
      cfg: string;
      anon: boolean;
      auth: boolean;
      svc: boolean;
      def: string;
    }>(
      `select coalesce(array_to_string(p.proconfig, ','), '') as cfg,
              has_function_privilege('anon', p.oid, 'EXECUTE') as anon,
              has_function_privilege('authenticated', p.oid, 'EXECUTE') as auth,
              has_function_privilege('service_role', p.oid, 'EXECUTE') as svc,
              pg_get_functiondef(p.oid) as def
         from pg_proc p
         join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public' and p.proname = 'gmail_credential_bind_ciphertext'`,
    );
    expect(bind[0]?.cfg).toBe('search_path=""');
    expect(bind[0]?.anon).toBe(false);
    expect(bind[0]?.auth).toBe(false);
    expect(bind[0]?.svc).toBe(true);
    expect(bind[0]?.def).not.toContain("nextval");
    expect(bind[0]?.def).toContain("refresh_token_ciphertext = p_expected_ciphertext");
  });
});
