/**
 * Hunter budget and lookup cache against Postgres.
 * No test in this file calls Hunter. Each rolled-back statement is one
 * transaction so the claims can see each other. Rows that must survive a
 * commit are deleted before the test returns.
 */
import { describe, expect, it } from "vitest";

import {
  adminQuery,
  commitAs,
  hasTestDb,
  queryAs,
  setupDatabase,
  type AsResult,
} from "../db/harness";

const d = describe.skipIf(!hasTestDb);

const USER_A = "c1800000-0000-4000-8000-00000000000a";
const USER_B = "c1800000-0000-4000-8000-00000000000b";

/**
 * The local harness does not grant service_role USAGE on schema public.
 * Hosted Supabase does. Grant it for one statement, then revoke it, the same
 * way the Gmail send tests reach a service-role function.
 */
async function asService<T>(
  sql: string,
  params: unknown[] = [],
  commit = false,
): Promise<AsResult<T>> {
  await adminQuery("grant usage on schema public to service_role");
  try {
    const run = commit ? commitAs<T> : queryAs<T>;
    return await run({ role: "service_role" }, sql, params);
  } finally {
    await adminQuery("revoke usage on schema public from service_role");
  }
}

d("Hunter lookup cache and monthly budget", () => {
  it("lets neither creator read the cache, and keeps verifications off the search bucket", async () => {
    await setupDatabase();
    for (const id of [USER_A, USER_B]) {
      await adminQuery(
        "insert into auth.users (id, email) values ($1, $2) on conflict (id) do nothing",
        [id, `${id}@test.local`],
      );
    }

    for (const userId of [USER_A, USER_B]) {
      const lookups = await queryAs(
        { role: "authenticated", sub: userId },
        "select cache_key from public.contact_provider_lookups",
      );
      const budget = await queryAs(
        { role: "authenticated", sub: userId },
        "select month_key from public.contact_provider_budget",
      );
      const claim = await queryAs(
        { role: "authenticated", sub: userId },
        "select public.claim_contact_provider_lookup('domain:hotel.test')",
      );
      expect(lookups.error, userId).not.toBeNull();
      expect(budget.error, userId).not.toBeNull();
      expect(claim.error, userId).not.toBeNull();
    }

    const anon = await queryAs({ role: "anon" }, "select * from public.contact_provider_budget");
    expect(anon.error).not.toBeNull();

    const filled = await asService<{ reserved: number; last: string }>(
      `select count(*) filter (where n <= 50 and outcome = 'reserved')::int as reserved,
              max(outcome) filter (where n = 51) as last
         from (
           select g.n,
                  public.apply_contact_provider_budget('search', 'reserve')->>'outcome' as outcome
             from generate_series(1, 51) as g(n)
         ) reserves`,
    );
    expect(filled.error).toBeNull();
    expect(filled.rows[0]).toEqual({ reserved: 50, last: "exhausted" });

    const verification = await asService<{ result: { outcome: string; used: number } }>(
      `select public.apply_contact_provider_budget('verification', 'reserve') as result`,
      [],
      true,
    );
    expect(verification.error).toBeNull();
    expect(verification.rows[0]?.result).toEqual({ outcome: "reserved", used: 1 });
    try {
      const counters = await adminQuery<{ searches_used: number; verifications_used: number }>(
        `select searches_used, verifications_used
           from public.contact_provider_budget`,
      );
      expect(counters).toEqual([{ searches_used: 0, verifications_used: 1 }]);
    } finally {
      await adminQuery("delete from public.contact_provider_budget");
    }
  });

  it("reuses one domain and does not replace a stored address", async () => {
    await setupDatabase();
    const hit = await asService<{
      first: string;
      second: string;
      email: string;
    }>(
      `with claimed as (
         select public.claim_contact_provider_lookup('domain:casa.test') as result
       ),
       second as (
         select public.claim_contact_provider_lookup('domain:casa.test') as result
           from claimed
       ),
       done as (
         select public.complete_contact_provider_lookup(
           'domain:casa.test',
           'found',
           'ada@casa.test',
           '{"provider":"hunter","status":"found"}'::jsonb
         )
           from second
       ),
       replaced as (
         select public.complete_contact_provider_lookup(
           'domain:casa.test',
           'found',
           'other@casa.test',
           '{"provider":"hunter","status":"found"}'::jsonb
         )
           from done
       ),
       hit as (
         select public.claim_contact_provider_lookup('domain:casa.test') as result
           from replaced
       ),
       abandoned as (
         select public.abandon_contact_provider_lookup('domain:casa.test')
           from hit
       )
       select (select result->>'outcome' from claimed) as first,
              (select result->>'outcome' from second) as second,
              (select result->>'email' from hit) as email
         from abandoned`,
      [],
      true,
    );
    expect(hit.error).toBeNull();
    expect(hit.rows[0]).toEqual({
      first: "claimed",
      second: "pending",
      email: "ada@casa.test",
    });
    try {
      const stored = await adminQuery<{ status: string; email: string }>(
        `select status, email
           from public.contact_provider_lookups
          where cache_key = 'domain:casa.test'`,
      );
      expect(stored).toEqual([{ status: "found", email: "ada@casa.test" }]);
    } finally {
      await adminQuery(
        "delete from public.contact_provider_lookups where cache_key = 'domain:casa.test'",
      );
    }
  });

  it("reclaims a stale pending row and releases a search that was not counted", async () => {
    await setupDatabase();
    const claimed = await asService(
      "select public.claim_contact_provider_lookup('domain:stale.test')",
      [],
      true,
    );
    expect(claimed.error).toBeNull();
    try {
      await adminQuery(`
        alter table public.contact_provider_lookups
          disable trigger contact_provider_lookups_set_updated_at;
        update public.contact_provider_lookups
           set updated_at = now() - interval '3 minutes'
         where cache_key = 'domain:stale.test';
        alter table public.contact_provider_lookups
          enable trigger contact_provider_lookups_set_updated_at;
      `);
      const again = await asService<{ outcome: string }>(
        `select public.claim_contact_provider_lookup('domain:stale.test')->>'outcome' as outcome`,
      );
      expect(again.error).toBeNull();
      expect(again.rows[0]?.outcome).toBe("claimed");
    } finally {
      await adminQuery(
        "delete from public.contact_provider_lookups where cache_key = 'domain:stale.test'",
      );
    }

    const released = await asService<{ reserved_used: number; released_used: number }>(
      `with reserved as (
         select public.apply_contact_provider_budget('search', 'reserve') as result
       ),
       released as (
         select public.apply_contact_provider_budget('search', 'release') as result
           from reserved
       )
       select (select (result->>'used')::int from reserved) as reserved_used,
              (select (result->>'used')::int from released) as released_used`,
    );
    expect(released.error).toBeNull();
    expect(released.rows[0]).toEqual({ reserved_used: 1, released_used: 0 });
  });

  it("trims and dates with pg_catalog even when the session shadows btrim and to_char", async () => {
    await setupDatabase();
    const trimmed = await asService(
      `do $do$
       begin
         execute $fn$
           create function pg_temp.btrim(text) returns text
           language plpgsql as $body$
           begin
             raise exception 'shadow btrim';
           end;
           $body$
         $fn$;
         execute $fn$
           create function pg_temp.to_char(timestamp, text) returns text
           language plpgsql as $body$
           begin
             raise exception 'shadow to_char';
           end;
           $body$
         $fn$;
         perform public.claim_contact_provider_lookup('domain:trim.test');
         perform public.complete_contact_provider_lookup(
           'domain:trim.test',
           'found',
           '  ada@trim.test  ',
           '{"provider":"hunter","status":"found"}'::jsonb
         );
         if (
           select email
             from public.contact_provider_lookups
            where cache_key = 'domain:trim.test'
         ) is distinct from 'ada@trim.test' then
           raise exception 'email was not trimmed by pg_catalog.btrim';
         end if;
         if public.apply_contact_provider_budget('verification', 'reserve')->>'outcome'
            is distinct from 'reserved' then
           raise exception 'budget month was not formatted by pg_catalog.to_char';
         end if;
       end
       $do$`,
    );
    expect(trimmed.error).toBeNull();
  });
});
