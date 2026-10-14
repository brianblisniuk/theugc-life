/**
 * C02–C05 (D146–D150).
 *
 * Freshness is withheld unless three creators share a window. A network
 * payload below that floor has no counts. User A does not read User B.
 * Fit stays locked without a hotel list. Max adds detail and does not
 * reorder the list. A decision does not move the aggregate.
 */
import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { adminQuery, hasTestDb, queryAs, setupDatabase, teardownDatabase } from "../db/harness";

const d = describe.skipIf(!hasTestDb);

const C1 = "c2f50000-0000-4000-8000-000000000001";
const C2 = "c2f50000-0000-4000-8000-000000000002";
const C3 = "c2f50000-0000-4000-8000-000000000003";
const PRO = "c2f50000-0000-4000-8000-000000000011";
const MAX = "c2f50000-0000-4000-8000-000000000012";
const PASS_BALI = "c2f50000-0000-4000-8000-000000000013";
const PASS_DUBAI = "c2f50000-0000-4000-8000-000000000014";
const FREE = "c2f50000-0000-4000-8000-000000000015";
const EDITOR = "c2f50000-0000-4000-8000-000000000016";
const CREATORS = [C1, C2, C3] as const;

const BALI = "c2f50000-0000-4000-8000-0000000000a1";
const CANGGU = "c2f50000-0000-4000-8000-0000000000a2";
const DUBAI = "c2f50000-0000-4000-8000-0000000000a3";

const HIGH = "c2f50000-0000-4000-8000-000000000101";
const MID = "c2f50000-0000-4000-8000-000000000102";
const EMERGE = "c2f50000-0000-4000-8000-000000000103";
const THIN = "c2f50000-0000-4000-8000-000000000104";
const TWO = "c2f50000-0000-4000-8000-00000000010c";
const LEAK = "c2f50000-0000-4000-8000-00000000010d";
const OPEN = "c2f50000-0000-4000-8000-00000000010e";
const OLDER = "c2f50000-0000-4000-8000-000000000105";
const SPLIT = "c2f50000-0000-4000-8000-000000000106";
const PERSONAL = "c2f50000-0000-4000-8000-000000000107";
const HOME_PRO = "c2f50000-0000-4000-8000-000000000108";
const HOME_MAX = "c2f50000-0000-4000-8000-000000000109";
const HOME_PASS = "c2f50000-0000-4000-8000-00000000010a";
const CLOSED = "c2f50000-0000-4000-8000-00000000010b";

const READS = [
  "read_hotel_metric_confidence",
  "read_own_personal_aggregate",
  "read_network_aggregate",
  "read_creator_fit",
  "record_creator_fit_decision",
  "read_own_fit_decision",
] as const;

function call(userId: string | null, fn: string, params: unknown[]) {
  const claims = JSON.stringify(userId ? { sub: userId } : {});
  const args = params.map((_, index) => `$${index + 2}`).join(", ");
  return adminQuery<{ body: Record<string, unknown> }>(
    `with cfg as (select set_config('request.jwt.claims', $1, true))
     select ${fn}(${args}) as body from cfg`,
    [claims, ...params],
  );
}

async function hotel(id: string, name: string, destination: string, status = "active") {
  await adminQuery(
    `insert into public.hotels
       (id, name, slug, destination_id, star_rating, latitude, longitude, active_status)
     values ($1, $2, $3, $4, 5, -8.4, 115.1, $5)`,
    [id, name, `c2f5-${id.slice(-4)}`, destination, status],
  );
}

async function fact(input: {
  userId: string;
  hotelId: string;
  factType: string;
  at: string;
  family?: "manual" | "gmail";
  mailAccountId?: string;
  value?: Record<string, unknown>;
  dismissed?: boolean;
  provenance?: "creator_confirmed" | "machine";
  eligible?: boolean;
  sample?: boolean;
}) {
  const family = input.family ?? "manual";
  const provenance = input.provenance ?? "creator_confirmed";
  await adminQuery(
    `insert into private.intelligence_facts (
       owner_user_id, fact_type, provenance_class, source_family,
       canonical_hotel_id, evidence_kind, evidence_id, value, event_at,
       mail_account_id, network_eligible, counts_as_sample, dismissed
     ) values (
       $1, $2, $3, $4,
       $5, $6, $7, $8::jsonb, $9::timestamptz,
       $10, $11, $12, $13
     )`,
    [
      input.userId,
      input.factType,
      provenance,
      family,
      input.hotelId,
      family === "gmail" ? "gmail_confirmation" : input.factType === "collaboration_type_observed" ? "collaboration" : "outreach_event",
      randomUUID(),
      JSON.stringify(input.value ?? {}),
      input.at,
      input.mailAccountId ?? null,
      input.eligible ?? provenance === "creator_confirmed",
      input.sample ?? (provenance === "creator_confirmed" && !input.dismissed),
      input.dismissed ?? false,
    ],
  );
}

async function samples(hotelId: string, perCreator: number, at: string, users: readonly string[] = CREATORS) {
  for (const userId of users) {
    for (let index = 0; index < perCreator; index += 1) {
      await fact({ userId, hotelId, factType: "pitch_sent", at });
    }
  }
}

d("freshness, aggregates, and creator fit", () => {
  beforeAll(async () => {
    await setupDatabase();
    const people = [...CREATORS, PRO, MAX, PASS_BALI, PASS_DUBAI, FREE, EDITOR];
    for (const id of people) {
      await adminQuery("insert into auth.users (id, email) values ($1, $2)", [id, `${id}@test.local`]);
    }
    await adminQuery("update public.users set role = 'editor' where id = $1", [EDITOR]);
    await adminQuery(
      `insert into public.destinations (id, name, slug, type) values
         ($1, 'Bali', 'c2f5-bali', 'island'),
         ($2, 'Dubai', 'c2f5-dubai', 'city')`,
      [BALI, DUBAI],
    );
    await adminQuery(
      `insert into public.destinations (id, name, slug, type, parent_destination_id)
       values ($1, 'Canggu', 'c2f5-canggu', 'area', $2)`,
      [CANGGU, BALI],
    );
    await hotel(HIGH, "High Fit", CANGGU);
    await hotel(MID, "Mid Fit", CANGGU);
    await hotel(EMERGE, "Emerging Fit", CANGGU);
    await hotel(THIN, "Thin Type", CANGGU);
    await hotel(TWO, "Two Creators", CANGGU);
    await hotel(LEAK, "Caller Counted", CANGGU);
    await hotel(OPEN, "Three Others", CANGGU);
    await hotel(OLDER, "Older Activity", BALI);
    await hotel(SPLIT, "Split Window", BALI);
    await hotel(PERSONAL, "Personal Hotel", BALI);
    await hotel(HOME_PRO, "Pro Home", BALI);
    await hotel(HOME_MAX, "Max Home", CANGGU);
    await hotel(HOME_PASS, "Pass Home", BALI);
    await hotel(CLOSED, "Closed Hotel", CANGGU, "closed");

    await adminQuery(
      `insert into public.access_entitlements (user_id, access_type, status, starts_at)
       values ($1, 'pro', 'active', now()),
              ($2, 'max', 'active', now())`,
      [PRO, MAX],
    );
    await adminQuery(
      `insert into public.access_entitlements
         (user_id, access_type, destination_id, status, starts_at)
       values ($1, 'destination', $2, 'active', now()),
              ($3, 'destination', $4, 'active', now())`,
      [PASS_BALI, BALI, PASS_DUBAI, DUBAI],
    );

    const now = new Date().toISOString();
    const old = new Date(Date.now() - 120 * 24 * 60 * 60 * 1000).toISOString();
    await samples(HIGH, 17, now);
    await samples(MID, 5, now);
    await samples(EMERGE, 2, now);
    await samples(THIN, 5, now);
    await samples(TWO, 10, now, [C1, C2]);
    await samples(OLDER, 5, old);
    await samples(SPLIT, 5, old, [C2, C3]);
    await samples(SPLIT, 5, now, [C1]);

    for (const id of [HIGH, MID, EMERGE]) {
      for (const userId of CREATORS) {
        await fact({
          userId,
          hotelId: id,
          factType: "collaboration_type_observed",
          at: now,
          value: { collaboration_type: "stay" },
        });
      }
    }
    await fact({
      userId: C1,
      hotelId: THIN,
      factType: "collaboration_type_observed",
      at: now,
      value: { collaboration_type: "stay" },
    });
    await samples(LEAK, 2, now, [C1, C2, PRO]);
    await samples(OPEN, 2, now, [C1, C2, C3]);
    for (const userId of [C1, C2, PRO]) {
      await fact({
        userId,
        hotelId: LEAK,
        factType: "collaboration_type_observed",
        at: now,
        value: { collaboration_type: "stay" },
      });
    }
    await fact({
      userId: PRO,
      hotelId: LEAK,
      factType: "collaboration_type_observed",
      at: now,
      value: { collaboration_type: "stay" },
    });
    await fact({
      userId: C3,
      hotelId: LEAK,
      factType: "collaboration_type_observed",
      at: now,
      value: { collaboration_type: "stay" },
      dismissed: true,
      eligible: false,
      sample: false,
    });
    for (const userId of [C1, C2, C3, PRO]) {
      await fact({
        userId,
        hotelId: OPEN,
        factType: "collaboration_type_observed",
        at: now,
        value: { collaboration_type: "stay" },
      });
    }
    await fact({
      userId: PRO,
      hotelId: HOME_PRO,
      factType: "collaboration_type_observed",
      at: now,
      value: { collaboration_type: "stay" },
    });
    await fact({
      userId: MAX,
      hotelId: HOME_MAX,
      factType: "collaboration_type_observed",
      at: now,
      value: { collaboration_type: "stay" },
    });
    await fact({
      userId: PASS_BALI,
      hotelId: HOME_PASS,
      factType: "collaboration_type_observed",
      at: now,
      value: { collaboration_type: "stay" },
    });

    const [machineBox] = await adminQuery<{ id: string }>(
      `insert into public.mail_accounts
         (user_id, provider, provider_account_subject, email_address, connection_state)
       values ($1, 'gmail', 'c2f5-machine', 'machine@example.invalid', 'pending_authorization')
       returning id`,
      [C1],
    );
    await adminQuery(
      `insert into private.intelligence_facts (
         owner_user_id, fact_type, provenance_class, source_family,
         canonical_hotel_id, evidence_kind, evidence_id, value, event_at,
         mail_account_id, network_eligible, counts_as_sample, dismissed
       ) values (
         $1, 'gmail_thread_commercial_state', 'machine', 'gmail',
         $2, 'gmail_thread_attempt', $3, '{}'::jsonb, $4::timestamptz,
         $5, false, false, false
       )`,
      [C1, THIN, randomUUID(), now, machineBox!.id],
    );
    await fact({
      userId: C3,
      hotelId: THIN,
      factType: "pitch_sent",
      at: now,
      dismissed: true,
      eligible: false,
      sample: false,
    });

    const [mailbox] = await adminQuery<{ id: string }>(
      `insert into public.mail_accounts
         (user_id, provider, provider_account_subject, email_address, connection_state)
       values ($1, 'gmail', 'c2f5-pro', 'pro@example.invalid', 'pending_authorization')
       returning id`,
      [PRO],
    );
    await fact({ userId: PRO, hotelId: PERSONAL, factType: "pitch_sent", at: now });
    await fact({
      userId: PRO,
      hotelId: PERSONAL,
      factType: "reply_received",
      at: now,
      family: "gmail",
      mailAccountId: mailbox!.id,
    });
    await samples(PERSONAL, 4, now, [C1]);
  }, 120_000);

  afterAll(async () => {
    await teardownDatabase();
  });

  it("pins search_path and keeps the private objects unreadable", async () => {
    const rows = await adminQuery<{ proname: string; prosecdef: boolean; cfg: string }>(
      `select p.proname, p.prosecdef, coalesce(array_to_string(p.proconfig, ','), '') as cfg
         from pg_proc p
         join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public' and p.proname = any($1::text[])`,
      [READS],
    );
    expect(rows).toHaveLength(READS.length);
    for (const row of rows) {
      expect(row.prosecdef, row.proname).toBe(true);
      expect(row.cfg, row.proname).toContain('search_path=""');
    }

    const denied = await queryAs(
      { role: "authenticated", sub: PRO },
      "select * from private.creator_fit_decisions",
    );
    expect(denied.error).not.toBeNull();
    const anonPersonal = await queryAs(
      { role: "anon", sub: null },
      "select public.read_own_personal_aggregate($1)",
      [PERSONAL],
    );
    expect(anonPersonal.error).not.toBeNull();
    const anonFit = await queryAs(
      { role: "anon", sub: null },
      "select public.read_creator_fit($1)",
      [BALI],
    );
    expect(anonFit.error).not.toBeNull();
  });

  it("withholds freshness unless three creators share a moderate window", async () => {
    const [emerging] = await call(FREE, "public.read_hotel_metric_confidence", [EMERGE]);
    const activity = (emerging!.body.metrics as Array<Record<string, unknown>>).find(
      (metric) => metric.metric === "creator_activity",
    );
    expect(activity).toMatchObject({
      state: "available",
      confidence_level: "emerging",
      freshness_band: null,
    });
    const reply = (emerging!.body.metrics as Array<Record<string, unknown>>).find(
      (metric) => metric.metric === "response_rate",
    );
    expect(reply).toMatchObject({ state: "locked", confidence_level: null, freshness_band: null });
    expect(JSON.stringify(emerging!.body)).not.toContain("%");
    expect(JSON.stringify(emerging!.body)).not.toContain(C1);

    const [recent] = await call(PRO, "public.read_hotel_metric_confidence", [MID]);
    const recentActivity = (recent!.body.metrics as Array<Record<string, unknown>>).find(
      (metric) => metric.metric === "creator_activity",
    );
    expect(recentActivity).toMatchObject({
      state: "available",
      confidence_level: "moderate",
      freshness_band: "past_month",
    });

    const [older] = await call(null, "public.read_hotel_metric_confidence", [OLDER]);
    const olderActivity = (older!.body.metrics as Array<Record<string, unknown>>).find(
      (metric) => metric.metric === "creator_activity",
    );
    expect(olderActivity).toMatchObject({ confidence_level: "moderate", freshness_band: "older" });

    const [split] = await call(FREE, "public.read_hotel_metric_confidence", [SPLIT]);
    const splitActivity = (split!.body.metrics as Array<Record<string, unknown>>).find(
      (metric) => metric.metric === "creator_activity",
    );
    expect(splitActivity).toMatchObject({ confidence_level: "moderate", freshness_band: null });

    const [closed] = await call(PRO, "public.read_hotel_metric_confidence", [CLOSED]);
    expect(closed!.body).toEqual({ result: "not_found" });
  });

  it("keeps a thin network empty and personal counts on the caller", async () => {
    const [two] = await call(PRO, "public.read_network_aggregate", [TWO]);
    expect(two!.body).toEqual({ result: "insufficient" });
    expect(JSON.stringify(two!.body)).not.toContain(C1);
    const [thin] = await call(PRO, "public.read_network_aggregate", [THIN]);
    expect(JSON.stringify(thin!.body)).not.toContain(C1);
    expect(JSON.stringify(thin!.body)).not.toMatch(/sample_size|creator_id/);

    const [closed] = await call(null, "public.read_network_aggregate", [CLOSED]);
    expect(closed!.body).toEqual({ result: "not_found" });

    const [anon] = await call(null, "public.read_network_aggregate", [MID]);
    expect(anon!.body).not.toHaveProperty("response_rate");
    expect(anon!.body.result).toBe("ok");

    const [pro] = await call(PRO, "public.read_network_aggregate", [MID]);
    expect(pro!.body).toHaveProperty("response_rate", null);
    expect(pro!.body).toHaveProperty("response_time", null);
    expect(JSON.stringify(pro!.body)).not.toContain(C1);

    const [own] = await call(PRO, "public.read_own_personal_aggregate", [PERSONAL]);
    expect(own!.body).toMatchObject({ result: "ok", manual_events: 1, gmail_events: 1 });
    expect(JSON.stringify(own!.body)).not.toContain(C1);

    const [other] = await call(C1, "public.read_own_personal_aggregate", [PERSONAL]);
    expect(other!.body).toMatchObject({ result: "ok", manual_events: 4, gmail_events: 0 });
    expect(JSON.stringify(other!.body)).not.toContain(PRO);

    const [missing] = await call(null, "public.read_own_personal_aggregate", [PERSONAL]);
    expect(missing!.body).toEqual({ result: "not_found" });
  });

  it("matches fit without a prior, and Max detail does not reorder it", async () => {
    const [free] = await call(FREE, "public.read_creator_fit", [BALI]);
    expect(free!.body.result).toBe("locked");
    expect(free!.body).not.toHaveProperty("hotels");

    const [dubai] = await call(PASS_DUBAI, "public.read_creator_fit", [BALI]);
    expect(dubai!.body.result).toBe("locked");
    expect(dubai!.body).not.toHaveProperty("hotels");

    const [editor] = await call(EDITOR, "public.read_creator_fit", [BALI]);
    expect(editor!.body).toMatchObject({
      result: "ok",
      detailed: false,
      prior_applied: false,
      prior_reason: "no_proven_lift",
      hotels: [],
    });

    const [pro] = await call(PRO, "public.read_creator_fit", [BALI]);
    const [max] = await call(MAX, "public.read_creator_fit", [BALI]);
    const proHotels = pro!.body.hotels as Array<Record<string, unknown>>;
    const maxHotels = max!.body.hotels as Array<Record<string, unknown>>;
    expect(pro!.body).toMatchObject({ detailed: false, prior_applied: false, prior_reason: "no_proven_lift" });
    expect(max!.body.detailed).toBe(true);
    expect(proHotels.map((hotel) => hotel.hotel_id)).toEqual([HIGH, MID, EMERGE, OPEN]);
    expect(maxHotels.map((hotel) => hotel.hotel_id)).toEqual([HIGH, MID, EMERGE, LEAK, OPEN]);
    expect(proHotels[0]).not.toHaveProperty("rank");
    expect(proHotels[0]).not.toHaveProperty("confidence_level");
    expect(maxHotels.map((hotel) => hotel.rank)).toEqual([1, 2, 3, 4, 5]);
    expect(maxHotels[0]).toMatchObject({ confidence_level: "strong", freshness_band: "past_month" });
    expect(maxHotels[2]).toMatchObject({ confidence_level: "emerging", freshness_band: null });
    expect(JSON.stringify(pro!.body)).not.toContain(C1);
    expect(JSON.stringify(pro!.body)).not.toContain(PRO);
    expect(proHotels.some((hotel) => hotel.hotel_id === THIN)).toBe(false);
    expect(proHotels.some((hotel) => hotel.hotel_id === LEAK)).toBe(false);
    expect(maxHotels.find((hotel) => hotel.hotel_id === LEAK)).toMatchObject({ matched_type: "stay" });
    expect(proHotels.find((hotel) => hotel.hotel_id === OPEN)).toMatchObject({ matched_type: "stay" });

    const [pass] = await call(PASS_BALI, "public.read_creator_fit", [CANGGU]);
    const passHotels = pass!.body.hotels as Array<Record<string, unknown>>;
    expect(passHotels.map((hotel) => hotel.hotel_id)).toEqual([HIGH, MID, EMERGE, LEAK, OPEN]);
  });

  it("does not let the caller complete the three-creator type floor", async () => {
    const [pro] = await call(PRO, "public.read_creator_fit", [BALI]);
    const proIds = (pro!.body.hotels as Array<Record<string, unknown>>).map((hotel) => hotel.hotel_id);
    expect(proIds).not.toContain(LEAK);
    expect(proIds).toContain(OPEN);

    const [max] = await call(MAX, "public.read_creator_fit", [BALI]);
    const maxIds = (max!.body.hotels as Array<Record<string, unknown>>).map((hotel) => hotel.hotel_id);
    expect(maxIds).toContain(LEAK);
    expect(maxIds.indexOf(HIGH)).toBeLessThan(maxIds.indexOf(LEAK));
    expect(maxIds.indexOf(LEAK)).toBeLessThan(maxIds.indexOf(OPEN));

    const [hidden] = await call(PRO, "public.record_creator_fit_decision", [LEAK, "pursue"]);
    expect(hidden!.body).toEqual({ result: "not_visible" });
    const saved = await adminQuery<{ n: number }>(
      "select count(*)::integer as n from private.creator_fit_decisions where hotel_id = $1",
      [LEAK],
    );
    expect(saved[0]?.n).toBe(0);
  });

  it("stores a fit decision for the caller and leaves the aggregate alone", async () => {
    const [before] = await call(PRO, "public.read_network_aggregate", [HIGH]);
    const [hidden] = await call(PRO, "public.record_creator_fit_decision", [HOME_PRO, "pursue"]);
    expect(hidden!.body).toEqual({ result: "not_visible" });
    const [bad] = await call(PRO, "public.record_creator_fit_decision", [HIGH, "maybe"]);
    expect(bad!.body).toEqual({ result: "invalid_input" });

    const [saved] = await call(PRO, "public.record_creator_fit_decision", [HIGH, "pursue"]);
    expect(saved!.body).toEqual({ result: "ok", decision: "pursue" });
    const [again] = await call(PRO, "public.record_creator_fit_decision", [HIGH, "skip"]);
    expect(again!.body).toEqual({ result: "ok", decision: "skip" });

    const [own] = await call(PRO, "public.read_own_fit_decision", [HIGH]);
    expect(own!.body).toEqual({ result: "ok", decision: "skip" });
    const [stranger] = await call(MAX, "public.read_own_fit_decision", [HIGH]);
    expect(stranger!.body).toEqual({ result: "ok", decision: null });
    const [after] = await call(PRO, "public.read_network_aggregate", [HIGH]);
    expect(after!.body).toEqual(before!.body);

    const rows = await adminQuery<{ decision: string }>(
      `select decision from private.creator_fit_decisions
        where creator_user_id = $1 and hotel_id = $2
        order by created_at, id`,
      [PRO, HIGH],
    );
    expect(rows.map((row) => row.decision)).toEqual(["pursue", "skip"]);
  });
});
