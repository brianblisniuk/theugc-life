/**
 * D190. The five intelligence projections stay security_invoker = false.
 * Migration 0108 only sets security_barrier. It does not grant the base
 * relations and it does not move a premium row to an unentitled caller.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { adminQuery, hasTestDb, queryAs, setupDatabase, teardownDatabase } from "../db/harness";

const d = describe.skipIf(!hasTestDb);

const DEST = "d1900000-0000-4000-8000-000000000001";
const HOTEL_INTEL = "d1900000-0000-4000-8000-000000000010";
const HOTEL_FACT = "d1900000-0000-4000-8000-000000000011";
const HOTEL_THIN = "d1900000-0000-4000-8000-000000000012";
const PRO = "d1900000-0000-4000-8000-0000000000a1";
const FREE = "d1900000-0000-4000-8000-0000000000a2";
const FACT_USERS = [
  "d1900000-0000-4000-8000-0000000000c1",
  "d1900000-0000-4000-8000-0000000000c2",
  "d1900000-0000-4000-8000-0000000000c3",
  "d1900000-0000-4000-8000-0000000000c4",
  "d1900000-0000-4000-8000-0000000000c5",
] as const;
const THIN_USERS = [
  "d1900000-0000-4000-8000-0000000000c6",
  "d1900000-0000-4000-8000-0000000000c7",
] as const;

const VIEWS = [
  {
    name: "hotel_public_intelligence",
    columns: [
      "hotel_id",
      "hotel_slug",
      "activity_level",
      "confidence_level",
      "has_observed_collaboration",
      "recency_band",
    ],
    anonSelect: true,
    authenticatedSelect: true,
    gate: null,
  },
  {
    name: "hotel_premium_intelligence",
    columns: [
      "hotel_id",
      "hotel_slug",
      "confidence_level",
      "reply_rate",
      "reply_time_band",
      "recent_activity_band",
      "collaboration_types",
      "contributor_count",
    ],
    anonSelect: false,
    authenticatedSelect: true,
    gate: "has_premium_hotel_access",
  },
  {
    name: "network_hotel_public",
    columns: [
      "hotel_id",
      "confidence_level",
      "activity_level",
      "has_observed_collaboration",
      "recency_band",
      "freshness_band",
    ],
    anonSelect: true,
    authenticatedSelect: true,
    gate: null,
  },
  {
    name: "hotel_metric_signal_public",
    columns: [
      "hotel_id",
      "destination_id",
      "metric",
      "title",
      "layer",
      "value_label",
      "rank_key",
      "sample_basis",
      "threshold_rule",
    ],
    anonSelect: true,
    authenticatedSelect: true,
    gate: null,
  },
  {
    name: "hotel_metric_signal_premium",
    columns: [
      "hotel_id",
      "destination_id",
      "metric",
      "title",
      "layer",
      "value_label",
      "rank_key",
      "sample_basis",
      "threshold_rule",
    ],
    anonSelect: false,
    authenticatedSelect: true,
    gate: "has_premium_hotel_access",
  },
] as const;

const FORBIDDEN = [
  "owner_user_id",
  "creator_id",
  "evidence_id",
  "pipeline_item_id",
  "reply_rate_365d",
  "median_reply_hours_365d",
  "last_creator_activity_at",
  "distinct_creators_90d",
  "distinct_creators_365d",
  "pitched_cycles_365d",
  "sample_size",
  "sample_creators",
];

async function columnsOf(view: string): Promise<string[]> {
  const rows = await adminQuery<{ attname: string }>(
    `select a.attname
       from pg_attribute a
      where a.attrelid = $1::regclass
        and a.attnum > 0
        and not a.attisdropped
      order by a.attnum`,
    [`public.${view}`],
  );
  return rows.map((row) => row.attname);
}

async function profile(userId: string): Promise<string> {
  const [row] = await adminQuery<{ id: string }>(
    "select id from public.creator_profiles where user_id = $1",
    [userId],
  );
  return row!.id;
}

async function closedCycle(userId: string, hotelId: string, cycle: number): Promise<string> {
  const creatorId = await profile(userId);
  const [row] = await adminQuery<{ id: string }>(
    `insert into public.pipeline_items (creator_id, hotel_id, status, cycle_number)
     values ($1, $2, 'closed', $3)
     returning id`,
    [creatorId, hotelId, cycle],
  );
  return row!.id;
}

async function fact(input: {
  userId: string;
  hotelId: string;
  itemId: string;
  factType: "pitch_sent" | "reply_received";
  eventAt: string;
}): Promise<void> {
  await adminQuery(
    `insert into private.intelligence_facts (
       owner_user_id, fact_type, provenance_class, source_family,
       canonical_hotel_id, evidence_kind, evidence_id, value, event_at,
       network_eligible, counts_as_sample, dismissed, pipeline_item_id
     ) values (
       $1, $2, 'creator_confirmed', 'manual',
       $3, 'outreach_event', gen_random_uuid(), '{}'::jsonb, ${input.eventAt},
       true, true, false, $4
     )`,
    [input.userId, input.factType, input.hotelId, input.itemId],
  );
}

d("intelligence views stay security definer", () => {
  beforeAll(async () => {
    await setupDatabase();
    for (const id of [PRO, FREE, ...FACT_USERS, ...THIN_USERS]) {
      await adminQuery("insert into auth.users (id, email) values ($1, $2)", [
        id,
        `${id}@test.local`,
      ]);
    }
    await adminQuery(
      `insert into public.access_entitlements (user_id, access_type, status, starts_at)
       values ($1, 'pro', 'active', now() - interval '1 day')`,
      [PRO],
    );
    await adminQuery(
      "insert into public.destinations (id, name, slug, type) values ($1, 'D190 Bay', 'd190-bay', 'city')",
      [DEST],
    );
    await adminQuery(
      `insert into public.hotels
         (id, name, slug, destination_id, star_rating, latitude, longitude, active_status)
       values
         ($1, 'D190 Intel', 'd190-intel', $4, 5, 10, 20, 'active'),
         ($2, 'D190 Facts', 'd190-facts', $4, 5, 10, 20, 'active'),
         ($3, 'D190 Thin', 'd190-thin', $4, 5, 10, 20, 'active')`,
      [HOTEL_INTEL, HOTEL_FACT, HOTEL_THIN, DEST],
    );
    await adminQuery(
      `insert into public.hotel_intelligence (
         hotel_id, activity_level, confidence_level, last_creator_activity_at,
         distinct_creators_7d, distinct_creators_90d, distinct_creators_365d,
         distinct_collaboration_creators_365d, pitched_cycles_365d, replied_cycles_365d,
         distinct_pitch_creators_365d, distinct_reply_creators_365d,
         reply_rate_365d, median_reply_hours_365d, collaboration_type_creators_365d
       ) values (
         $1, 'high', 'strong', now() - interval '10 days',
         3, 3, 5,
         3, 15, 10,
         5, 5,
         0.40, 12, '{"stay": 3}'::jsonb
       )`,
      [HOTEL_INTEL],
    );

    for (const userId of FACT_USERS) {
      for (let cycle = 1; cycle <= 3; cycle += 1) {
        const itemId = await closedCycle(userId, HOTEL_FACT, cycle);
        await fact({
          userId,
          hotelId: HOTEL_FACT,
          itemId,
          factType: "pitch_sent",
          eventAt: "now() - interval '2 days'",
        });
        await fact({
          userId,
          hotelId: HOTEL_FACT,
          itemId,
          factType: "reply_received",
          eventAt: "now() - interval '1 day'",
        });
      }
    }
    for (const userId of THIN_USERS) {
      const itemId = await closedCycle(userId, HOTEL_THIN, 1);
      await fact({
        userId,
        hotelId: HOTEL_THIN,
        itemId,
        factType: "pitch_sent",
        eventAt: "now() - interval '2 days'",
      });
    }
  }, 120_000);

  afterAll(async () => {
    await teardownDatabase();
  });

  it("keeps security_invoker false, a barrier, and the published columns", async () => {
    for (const view of VIEWS) {
      const [options] = await adminQuery<{ reloptions: string[] | null }>(
        `select c.reloptions
           from pg_class c
           join pg_namespace n on n.oid = c.relnamespace
          where n.nspname = 'public' and c.relname = $1`,
        [view.name],
      );
      expect(options!.reloptions ?? [], view.name).toEqual(
        expect.arrayContaining(["security_invoker=false", "security_barrier=true"]),
      );
      expect(options!.reloptions ?? []).not.toContain("security_invoker=true");
      expect(await columnsOf(view.name)).toEqual([...view.columns]);
      for (const forbidden of FORBIDDEN) {
        expect(await columnsOf(view.name), view.name).not.toContain(forbidden);
      }

      const [priv] = await adminQuery<{
        anon_select: boolean;
        auth_select: boolean;
        anon_insert: boolean;
        auth_insert: boolean;
        service_insert: boolean;
      }>(
        `select
           has_table_privilege('anon', $1, 'SELECT') as anon_select,
           has_table_privilege('authenticated', $1, 'SELECT') as auth_select,
           has_table_privilege('anon', $1, 'INSERT') as anon_insert,
           has_table_privilege('authenticated', $1, 'INSERT') as auth_insert,
           has_table_privilege('service_role', $1, 'INSERT') as service_insert`,
        [`public.${view.name}`],
      );
      expect(priv!.anon_select, view.name).toBe(view.anonSelect);
      expect(priv!.auth_select, view.name).toBe(view.authenticatedSelect);
      expect(priv!.anon_insert, view.name).toBe(false);
      expect(priv!.auth_insert, view.name).toBe(false);
      expect(priv!.service_insert, view.name).toBe(false);

      const [def] = await adminQuery<{ def: string }>(
        "select pg_get_viewdef($1::regclass, true) as def",
        [`public.${view.name}`],
      );
      if (view.gate) expect(def!.def).toContain(view.gate);
      else expect(def!.def).not.toContain("has_premium_hotel_access");
    }

    const [publicDef] = await adminQuery<{ def: string }>(
      "select pg_get_viewdef('public.hotel_public_intelligence'::regclass, true) as def",
    );
    expect(publicDef!.def).not.toContain("reply_rate");
    expect(publicDef!.def).toContain("distinct_creators_90d");
    expect(publicDef!.def).toContain("distinct_collaboration_creators_365d");

    const [base] = await adminQuery<{
      anon_intel: boolean;
      auth_intel: boolean;
      anon_facts: boolean;
      auth_facts: boolean;
      service_facts: boolean;
      anon_basis: boolean;
      auth_basis: boolean;
      service_basis: boolean;
      anon_private: boolean;
    }>(
      `select
         has_table_privilege('anon', 'public.hotel_intelligence', 'SELECT') as anon_intel,
         has_table_privilege('authenticated', 'public.hotel_intelligence', 'SELECT') as auth_intel,
         has_table_privilege('anon', 'private.intelligence_facts', 'SELECT') as anon_facts,
         has_table_privilege('authenticated', 'private.intelligence_facts', 'SELECT') as auth_facts,
         has_table_privilege('service_role', 'private.intelligence_facts', 'SELECT') as service_facts,
         has_table_privilege('anon', 'private.hotel_metric_basis', 'SELECT') as anon_basis,
         has_table_privilege('authenticated', 'private.hotel_metric_basis', 'SELECT') as auth_basis,
         has_table_privilege('service_role', 'private.hotel_metric_basis', 'SELECT') as service_basis,
         has_schema_privilege('anon', 'private', 'USAGE') as anon_private`,
    );
    expect(base).toEqual({
      anon_intel: false,
      auth_intel: false,
      anon_facts: false,
      auth_facts: false,
      service_facts: false,
      anon_basis: false,
      auth_basis: false,
      service_basis: false,
      anon_private: false,
    });
  });

  it("shows the same public intelligence row and hides the raw table", async () => {
    const denied = await queryAs(
      { role: "anon" },
      "select * from public.hotel_intelligence where hotel_id = $1",
      [HOTEL_INTEL],
    );
    expect(denied.error?.code).toBe("42501");
    const authDenied = await queryAs(
      { role: "authenticated", sub: PRO },
      "select reply_rate_365d from public.hotel_intelligence where hotel_id = $1",
      [HOTEL_INTEL],
    );
    expect(authDenied.error?.code).toBe("42501");

    const missing = await queryAs(
      { role: "anon" },
      "select reply_rate from public.hotel_public_intelligence where hotel_id = $1",
      [HOTEL_INTEL],
    );
    expect(missing.error?.code).toBe("42703");

    const anon = await queryAs(
      { role: "anon" },
      "select * from public.hotel_public_intelligence where hotel_id = $1",
      [HOTEL_INTEL],
    );
    const free = await queryAs(
      { role: "authenticated", sub: FREE },
      "select * from public.hotel_public_intelligence where hotel_id = $1",
      [HOTEL_INTEL],
    );
    const pro = await queryAs(
      { role: "authenticated", sub: PRO },
      "select * from public.hotel_public_intelligence where hotel_id = $1",
      [HOTEL_INTEL],
    );
    for (const result of [anon, free, pro]) {
      expect(result.error).toBeNull();
      expect(result.rows).toHaveLength(1);
      expect(Object.keys(result.rows[0]!).sort()).toEqual(
        [
          "activity_level",
          "confidence_level",
          "has_observed_collaboration",
          "hotel_id",
          "hotel_slug",
          "recency_band",
        ].sort(),
      );
    }
    expect(anon.rows[0]).toEqual(free.rows[0]);
    expect(free.rows[0]).toEqual(pro.rows[0]);
    expect(anon.rows[0]).toMatchObject({
      hotel_id: HOTEL_INTEL,
      activity_level: "high",
      confidence_level: "strong",
      has_observed_collaboration: true,
      recency_band: "past_month",
    });
    expect(JSON.stringify(anon.rows[0])).not.toContain(PRO);
    expect(JSON.stringify(anon.rows[0])).not.toContain("0.40");
  });

  it("keeps premium intelligence rows behind the entitlement", async () => {
    const anon = await queryAs(
      { role: "anon" },
      "select * from public.hotel_premium_intelligence where hotel_id = $1",
      [HOTEL_INTEL],
    );
    expect(anon.error?.code).toBe("42501");

    const free = await queryAs(
      { role: "authenticated", sub: FREE },
      "select * from public.hotel_premium_intelligence where hotel_id = $1",
      [HOTEL_INTEL],
    );
    expect(free.error).toBeNull();
    expect(free.rows).toHaveLength(0);

    const pro = await queryAs(
      { role: "authenticated", sub: PRO },
      "select * from public.hotel_premium_intelligence where hotel_id = $1",
      [HOTEL_INTEL],
    );
    expect(pro.error).toBeNull();
    expect(pro.rows).toHaveLength(1);
    expect(Number(pro.rows[0]!.reply_rate)).toBeCloseTo(0.4);
    expect(pro.rows[0]).toMatchObject({
      hotel_id: HOTEL_INTEL,
      reply_time_band: "under_24h",
      recent_activity_band: "within_7_days",
      contributor_count: 5,
      collaboration_types: ["stay"],
    });
    expect(Object.keys(pro.rows[0]!)).not.toContain("owner_user_id");
    expect(Object.keys(pro.rows[0]!)).not.toContain("reply_rate_365d");
  });

  it("publishes k-anonymous network and metric rows and withholds the fact table", async () => {
    const facts = await queryAs(
      { role: "anon" },
      "select owner_user_id from private.intelligence_facts",
    );
    expect(facts.error).not.toBeNull();
    const authFacts = await queryAs(
      { role: "authenticated", sub: PRO },
      "select * from private.intelligence_facts",
    );
    expect(authFacts.error).not.toBeNull();
    const basis = await queryAs(
      { role: "authenticated", sub: PRO },
      "select * from private.hotel_metric_basis",
    );
    expect(basis.error).not.toBeNull();

    const thin = await queryAs(
      { role: "anon" },
      "select * from public.network_hotel_public where hotel_id = $1",
      [HOTEL_THIN],
    );
    expect(thin.error).toBeNull();
    expect(thin.rows).toHaveLength(0);

    const network = await queryAs(
      { role: "anon" },
      "select * from public.network_hotel_public where hotel_id = $1",
      [HOTEL_FACT],
    );
    expect(network.error).toBeNull();
    expect(network.rows).toHaveLength(1);
    expect(network.rows[0]).toMatchObject({
      hotel_id: HOTEL_FACT,
      has_observed_collaboration: null,
    });
    expect(network.rows[0]!.has_observed_collaboration).not.toBe(false);
    const packed = JSON.stringify(network.rows[0]);
    for (const userId of FACT_USERS) expect(packed).not.toContain(userId);
    expect(Object.keys(network.rows[0]!)).not.toContain("owner_user_id");
    expect(Object.keys(network.rows[0]!)).not.toContain("sample_creators");
    expect(Object.keys(network.rows[0]!)).not.toContain("sample_size");

    const publicMetric = await queryAs(
      { role: "anon" },
      "select metric, layer from public.hotel_metric_signal_public where hotel_id = $1",
      [HOTEL_FACT],
    );
    expect(publicMetric.error).toBeNull();
    expect(publicMetric.rows).toEqual([{ metric: "creator_activity", layer: "public" }]);
    const thinMetric = await queryAs(
      { role: "anon" },
      "select hotel_id from public.hotel_metric_signal_public where hotel_id = $1",
      [HOTEL_THIN],
    );
    expect(thinMetric.rows).toHaveLength(0);

    const anonPremium = await queryAs(
      { role: "anon" },
      "select metric from public.hotel_metric_signal_premium where hotel_id = $1",
      [HOTEL_FACT],
    );
    expect(anonPremium.error?.code).toBe("42501");

    const freePremium = await queryAs(
      { role: "authenticated", sub: FREE },
      "select metric from public.hotel_metric_signal_premium where hotel_id = $1 order by metric",
      [HOTEL_FACT],
    );
    expect(freePremium.error).toBeNull();
    expect(freePremium.rows).toHaveLength(0);

    const proPremium = await queryAs(
      { role: "authenticated", sub: PRO },
      "select metric from public.hotel_metric_signal_premium where hotel_id = $1 order by metric",
      [HOTEL_FACT],
    );
    expect(proPremium.error).toBeNull();
    expect(proPremium.rows.map((row) => row.metric)).toEqual(["response_rate", "response_time"]);
  });
});
