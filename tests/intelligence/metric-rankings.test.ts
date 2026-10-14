/**
 * H01 metric rankings (D120).
 *
 * Confirmed facts only. One metric at a time. Below a floor the value is
 * "not enough data", never zero. A measured zero that clears the floor stays.
 * User A does not see User B, and a payment row cannot move the order.
 */
import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { adminQuery, hasTestDb, queryAs, setupDatabase, teardownDatabase } from "../db/harness";

const d = describe.skipIf(!hasTestDb);

const CREATORS = [
  "a0110000-0000-4000-8000-000000000001",
  "a0110000-0000-4000-8000-000000000002",
  "a0110000-0000-4000-8000-000000000003",
  "a0110000-0000-4000-8000-000000000004",
  "a0110000-0000-4000-8000-000000000005",
  "a0110000-0000-4000-8000-000000000006",
] as const;
const FREE = "a0110000-0000-4000-8000-00000000000a";
const PRO = "a0110000-0000-4000-8000-00000000000b";
const PASS_BALI = "a0110000-0000-4000-8000-00000000000c";
const PASS_DUBAI = "a0110000-0000-4000-8000-00000000000d";
const EDITOR = "a0110000-0000-4000-8000-00000000000e";

const BALI = "a01a0000-0000-4000-8000-000000000001";
const CANGGU = "a01a0000-0000-4000-8000-000000000002";
const DUBAI = "a01a0000-0000-4000-8000-000000000003";

const RATE_HIGH = "a01b0000-0000-4000-8000-000000000010";
const RATE_ZERO = "a01b0000-0000-4000-8000-000000000020";
const RATE_THIN = "a01b0000-0000-4000-8000-000000000030";
const TIME_DAY = "a01b0000-0000-4000-8000-000000000001";
const TIME_SLOW = "a01b0000-0000-4000-8000-000000000002";
const TIME_FAST = "a01b0000-0000-4000-8000-000000000003";
const TIME_THIN = "a01b0000-0000-4000-8000-000000000040";
const TIME_DOUBLE = "a01b0000-0000-4000-8000-000000000041";
const TIME_GMAIL = "a01b0000-0000-4000-8000-000000000042";
const EMERGE_LOW = "a01b0000-0000-4000-8000-000000000050";
const EMERGE_HIGH = "a01b0000-0000-4000-8000-000000000051";
const CLOSED = "a01b0000-0000-4000-8000-000000000060";
const UNPUBLISHED = "a01b0000-0000-4000-8000-000000000061";
const DUBAI_HOTEL = "a01b0000-0000-4000-8000-000000000070";
const OLD = "a01b0000-0000-4000-8000-000000000080";

const FIVE = CREATORS.slice(0, 5);
const RULE_RATE =
  "Shown when at least 15 confirmed pitches from at least 5 creators in the last 365 days. A follow-up is not another pitch. Below that, not enough data.";

function call(userId: string | null, fn: string, params: unknown[]) {
  const claims = JSON.stringify(userId ? { sub: userId } : {});
  const args = params.map((_, index) => `$${index + 2}`).join(", ");
  return adminQuery<{ body: Record<string, unknown> }>(
    `with cfg as (select set_config('request.jwt.claims', $1, true))
     select ${fn}(${args}) as body from cfg`,
    [claims, ...params],
  );
}

d("metric rankings", () => {
  const profiles = new Map<string, string>();

  beforeAll(async () => {
    await setupDatabase();
    for (const id of [...CREATORS, FREE, PRO, PASS_BALI, PASS_DUBAI, EDITOR]) {
      await adminQuery("insert into auth.users (id, email) values ($1, $2)", [
        id,
        `${id}@test.local`,
      ]);
    }
    await adminQuery("update public.users set role = 'editor' where id = $1", [EDITOR]);
    await adminQuery(
      `insert into public.destinations (id, name, slug, type) values
         ($1, 'Bali', 'h01-bali', 'island'),
         ($2, 'Dubai', 'h01-dubai', 'city')`,
      [BALI, DUBAI],
    );
    await adminQuery(
      `insert into public.destinations (id, name, slug, type, parent_destination_id)
       values ($1, 'Canggu', 'h01-canggu', 'area', $2)`,
      [CANGGU, BALI],
    );
    const published = [
      [RATE_HIGH, "High Reply", CANGGU],
      [RATE_ZERO, "Zero Reply", CANGGU],
      [RATE_THIN, "Thin Reply", BALI],
      [TIME_DAY, "Day Reply", CANGGU],
      [TIME_SLOW, "Slow Reply", CANGGU],
      [TIME_FAST, "Fast Reply", CANGGU],
      [TIME_THIN, "Thin Time", CANGGU],
      [TIME_DOUBLE, "Double Time", CANGGU],
      [TIME_GMAIL, "Gmail Time", CANGGU],
      [EMERGE_LOW, "Emerge Low", BALI],
      [EMERGE_HIGH, "Emerge High", BALI],
      [DUBAI_HOTEL, "Dubai Reply", DUBAI],
      [OLD, "Old Reply", CANGGU],
    ] as const;
    for (const [id, name, destination] of published) {
      const lat = destination === DUBAI ? 25.2 : -8.4;
      const lng = destination === DUBAI ? 55.2 : 115.1;
      await adminQuery(
        `insert into public.hotels
           (id, name, slug, destination_id, star_rating, latitude, longitude, active_status)
         values ($1, $2, $3, $4, 5, $5, $6, 'active')`,
        [id, name, `h01-${id.replace(/-/g, "").slice(-12)}`, destination, lat, lng],
      );
    }
    await adminQuery(
      `insert into public.hotels
         (id, name, slug, destination_id, star_rating, latitude, longitude, active_status)
       values ($1, 'Closed Reply', 'h01-closed', $2, 5, -8.4, 115.1, 'closed')`,
      [CLOSED, CANGGU],
    );
    await adminQuery(
      `insert into public.hotels (id, name, slug, destination_id, star_rating, active_status)
       values ($1, 'Hidden Reply', 'h01-hidden', $2, 5, 'active')`,
      [UNPUBLISHED, CANGGU],
    );
    for (const id of [...CREATORS, FREE, PRO, PASS_BALI, PASS_DUBAI, EDITOR]) {
      const [row] = await adminQuery<{ id: string }>(
        "select id from public.creator_profiles where user_id = $1",
        [id],
      );
      profiles.set(id, row!.id);
    }
    await adminQuery(
      `insert into public.access_entitlements (user_id, access_type, status, starts_at)
       values ($1, 'pro', 'active', now())`,
      [PRO],
    );
    await adminQuery(
      `insert into public.access_entitlements
         (user_id, access_type, destination_id, status, starts_at)
       values ($1, 'destination', $2, 'active', now()),
              ($3, 'destination', $4, 'active', now())`,
      [PASS_BALI, BALI, PASS_DUBAI, DUBAI],
    );

    await addCycles(RATE_HIGH, FIVE, 3, null);
    await replySome(RATE_HIGH, 10, 2);
    await addCycles(RATE_ZERO, FIVE, 3, null);
    await addCycles(RATE_THIN, CREATORS.slice(0, 2), 8, 2);
    await addCycles(TIME_SLOW, FIVE, 2, 20);
    await addCycles(TIME_FAST, FIVE, 2, 1);
    await addCycles(TIME_DAY, FIVE, 2, 30);
    await addCycles(TIME_THIN, CREATORS.slice(0, 4), 2, 2);
    await addCycles(TIME_THIN, CREATORS.slice(0, 1), 1, 2);
    await addCycles(TIME_DOUBLE, FIVE, 1, 2);
    await addLatency(TIME_DOUBLE, 100);
    await addGmailLatency(TIME_GMAIL, FIVE, 2, 7_200_000);
    await addCycles(EMERGE_HIGH, CREATORS.slice(0, 3), 1, null);
    await addCycles(EMERGE_HIGH, CREATORS.slice(0, 2), 1, null);
    await addCycles(EMERGE_LOW, CREATORS.slice(0, 3), 1, null);
    await addCycles(EMERGE_LOW, CREATORS.slice(0, 2), 1, null);
    await addCycles(CLOSED, FIVE, 3, 1);
    await addCycles(UNPUBLISHED, FIVE, 3, 1);
    await addCycles(DUBAI_HOTEL, FIVE, 3, 1);
    await addCycles(OLD, FIVE, 3, 1, 10_000);

    await adminQuery(
      `insert into public.hotel_intelligence
         (hotel_id, reply_rate, reply_rate_365d, median_reply_hours, median_reply_hours_365d)
       values ($1, 1, 1, 0.1, 0.1)`,
      [RATE_ZERO],
    );
  }, 180_000);

  afterAll(async () => {
    await teardownDatabase();
  });

  async function addCycles(
    hotelId: string,
    creators: readonly string[],
    perCreator: number,
    replyAfterHours: number | null,
    pitchAgeHours = 240,
  ) {
    for (const userId of creators) {
      for (let i = 0; i < perCreator; i += 1) {
        const [item] = await adminQuery<{ id: string }>(
          `insert into public.pipeline_items (creator_id, hotel_id, status, cycle_number)
           values ($1, $2, 'closed', $3) returning id`,
          [profiles.get(userId), hotelId, i + 1],
        );
        await adminQuery(
          `insert into public.outreach_events
             (creator_id, hotel_id, pipeline_item_id, event_type, event_at, source)
           values ($1, $2, $3, 'pitch_sent', now() - make_interval(hours => $4::int), 'manual_creator')`,
          [profiles.get(userId), hotelId, item!.id, pitchAgeHours],
        );
        if (replyAfterHours !== null) {
          await adminQuery(
            `insert into public.outreach_events
               (creator_id, hotel_id, pipeline_item_id, event_type, event_at, source)
             values ($1, $2, $3, 'reply_received', now() - make_interval(hours => $4::int), 'manual_creator')`,
            [profiles.get(userId), hotelId, item!.id, pitchAgeHours - replyAfterHours],
          );
        }
      }
    }
  }

  async function replySome(hotelId: string, count: number, replyAfterHours: number) {
    const rows = await adminQuery<{ id: string; creator_id: string }>(
      `select id, creator_id from public.pipeline_items
        where hotel_id = $1
        order by id
        limit $2`,
      [hotelId, count],
    );
    expect(rows).toHaveLength(count);
    for (const row of rows) {
      await adminQuery(
        `insert into public.outreach_events
           (creator_id, hotel_id, pipeline_item_id, event_type, event_at, source)
         values ($1, $2, $3, 'reply_received', now() - make_interval(hours => $4::int), 'manual_creator')`,
        [row.creator_id, hotelId, row.id, 240 - replyAfterHours],
      );
    }
  }

  async function addLatency(hotelId: string, hours: number) {
    const rows = await adminQuery<{ id: string; creator_id: string }>(
      "select id, creator_id from public.pipeline_items where hotel_id = $1",
      [hotelId],
    );
    for (const row of rows) {
      const [user] = await adminQuery<{ user_id: string }>(
        "select user_id from public.creator_profiles where id = $1",
        [row.creator_id],
      );
      const [mail] = await adminQuery<{ id: string }>(
        `insert into public.mail_accounts
           (user_id, provider, provider_account_subject, email_address, connection_state)
         values ($1, 'gmail', $2, $3, 'pending_authorization')
         returning id`,
        [user!.user_id, randomUUID(), `${randomUUID()}@example.invalid`],
      );
      await adminQuery(
        `insert into private.intelligence_facts (
           owner_user_id, fact_type, provenance_class, source_family,
           canonical_hotel_id, evidence_kind, evidence_id, value, event_at,
           mail_account_id, network_eligible, counts_as_sample, pipeline_item_id
         ) values (
           $1, 'gmail_reply_latency', 'creator_confirmed', 'gmail',
           $2, 'gmail_confirmation', $3,
           jsonb_build_object('first_send_to_human_reply_ms', $4::int),
           now(), $5, true, false, $6
         )`,
        [user!.user_id, hotelId, randomUUID(), hours * 3_600_000, mail!.id, row.id],
      );
    }
  }

  async function addGmailLatency(
    hotelId: string,
    creators: readonly string[],
    perCreator: number,
    milliseconds: number,
  ) {
    for (const userId of creators) {
      for (let i = 0; i < perCreator; i += 1) {
        const [item] = await adminQuery<{ id: string }>(
          `insert into public.pipeline_items (creator_id, hotel_id, status, cycle_number)
           values ($1, $2, 'closed', $3) returning id`,
          [profiles.get(userId), hotelId, i + 1],
        );
        const [mail] = await adminQuery<{ id: string }>(
          `insert into public.mail_accounts
             (user_id, provider, provider_account_subject, email_address, connection_state)
           values ($1, 'gmail', $2, $3, 'pending_authorization')
           returning id`,
          [userId, randomUUID(), `${randomUUID()}@example.invalid`],
        );
        await adminQuery(
          `insert into private.intelligence_facts (
             owner_user_id, fact_type, provenance_class, source_family,
             canonical_hotel_id, evidence_kind, evidence_id, value, event_at,
             mail_account_id, network_eligible, counts_as_sample, pipeline_item_id
           ) values (
             $1, 'gmail_reply_latency', 'creator_confirmed', 'gmail',
             $2, 'gmail_confirmation', $3,
             jsonb_build_object('first_send_to_human_reply_ms', $4::int),
             now(), $5, true, false, $6
           )`,
          [userId, hotelId, randomUUID(), milliseconds, mail!.id, item!.id],
        );
      }
    }
  }

  function metric(body: Record<string, unknown>, name: string) {
    const metrics = body.metrics as Record<string, unknown>[];
    return metrics.find((item) => item.metric === name)!;
  }

  function ranks(body: Record<string, unknown>) {
    return (body.hotels as { hotel_id: string; rank: number; value_label: string }[]) ?? [];
  }

  it("publishes reply rate only above the D058 floor, including a measured zero", async () => {
    const [pro] = await call(PRO, "public.read_hotel_metric_signals", [RATE_HIGH]);
    expect(metric(pro!.body, "response_rate")).toMatchObject({
      state: "available",
      value_label: "67%",
      sample_basis: "Based on activity from 5 creators",
      threshold_rule: RULE_RATE,
    });
    const [zero] = await call(PRO, "public.read_hotel_metric_signals", [RATE_ZERO]);
    expect(metric(zero!.body, "response_rate").value_label).toBe("0%");
    const [thin] = await call(PRO, "public.read_hotel_metric_signals", [RATE_THIN]);
    expect(metric(thin!.body, "response_rate")).toMatchObject({
      state: "not_enough_data",
      value_label: null,
      sample_basis: null,
    });
    expect(JSON.stringify(thin!.body)).not.toContain("100%");
    expect(JSON.stringify(thin!.body)).not.toContain("0%");

    const [ranking] = await call(PRO, "public.read_destination_metric_ranking", [
      BALI,
      "response_rate",
    ]);
    const ids = ranks(ranking!.body).map((hotel) => hotel.hotel_id);
    expect(ids.indexOf(RATE_HIGH)).toBeGreaterThanOrEqual(0);
    expect(ids.indexOf(RATE_HIGH)).toBeLessThan(ids.indexOf(RATE_ZERO));
    expect(ids).not.toContain(RATE_THIN);
    expect(ids).not.toContain(DUBAI_HOTEL);
    expect(ids).not.toContain(CLOSED);
    expect(ids).not.toContain(UNPUBLISHED);
    expect(ids).not.toContain(OLD);
    expect(JSON.stringify(ranking!.body)).not.toMatch(
      /owner_user_id|evidence_id|median_hours|pitch_count|milliseconds|"score"/,
    );
  });

  it("ignores follow-ups, unconfirmed gmail pitches, classifications, and paid aggregates", async () => {
    const before = await call(PRO, "public.read_hotel_metric_signals", [RATE_HIGH]);
    expect(metric(before[0]!.body, "response_rate").value_label).toBe("67%");

    const items = await adminQuery<{ id: string; creator_id: string }>(
      "select id, creator_id from public.pipeline_items where hotel_id = $1",
      [RATE_HIGH],
    );
    for (const item of items) {
      await adminQuery(
        `insert into public.outreach_events
           (creator_id, hotel_id, pipeline_item_id, event_type, event_at, source)
         values ($1, $2, $3, 'followup_sent', now(), 'manual_creator')`,
        [item.creator_id, RATE_HIGH, item.id],
      );
      await adminQuery(
        `insert into public.outreach_events
           (creator_id, hotel_id, pipeline_item_id, event_type, event_at, source, metadata)
         values ($1, $2, $3, 'pitch_sent', now(), 'gmail', '{"sponsored":true}'::jsonb)`,
        [item.creator_id, RATE_HIGH, item.id],
      );
    }
    const zeroItems = await adminQuery<{ id: string; creator_id: string }>(
      "select id, creator_id from public.pipeline_items where hotel_id = $1",
      [RATE_ZERO],
    );
    for (const item of zeroItems) {
      await adminQuery(
        `insert into public.outreach_events
           (creator_id, hotel_id, pipeline_item_id, event_type, event_at, source)
         values ($1, $2, $3, 'positive_reply', now(), 'manual_creator')`,
        [item.creator_id, RATE_ZERO, item.id],
      );
    }

    const after = await call(PRO, "public.read_hotel_metric_signals", [RATE_HIGH]);
    expect(metric(after[0]!.body, "response_rate").value_label).toBe("67%");
    const zero = await call(PRO, "public.read_hotel_metric_signals", [RATE_ZERO]);
    expect(metric(zero[0]!.body, "response_rate").value_label).toBe("0%");

    const [def] = await adminQuery<{ def: string }>(
      "select pg_get_viewdef('private.hotel_metric_basis'::regclass, true) as def",
    );
    expect(def!.def).not.toMatch(/hotel_intelligence|purchases|subscriptions|access_entitlements/);
  });

  it("ranks reply time by the published band, not by the hidden hours", async () => {
    const [ranking] = await call(PRO, "public.read_destination_metric_ranking", [
      CANGGU,
      "response_time",
    ]);
    const rows = ranks(ranking!.body);
    const slow = rows.find((hotel) => hotel.hotel_id === TIME_SLOW);
    const fast = rows.find((hotel) => hotel.hotel_id === TIME_FAST);
    const day = rows.find((hotel) => hotel.hotel_id === TIME_DAY);
    expect(slow?.value_label).toBe("Under 24h");
    expect(fast?.value_label).toBe("Under 24h");
    expect(day?.value_label).toBe("1–3 days");
    expect(slow!.rank).toBeLessThan(fast!.rank);
    expect(fast!.rank).toBeLessThan(day!.rank);
    expect(rows.map((hotel) => hotel.hotel_id)).not.toContain(TIME_THIN);
    expect(rows.map((hotel) => hotel.hotel_id)).not.toContain(TIME_DOUBLE);

    const [gmail] = await call(PRO, "public.read_hotel_metric_signals", [TIME_GMAIL]);
    expect(metric(gmail!.body, "response_time")).toMatchObject({
      state: "available",
      value_label: "Under 24h",
      sample_basis: "Based on activity from 5 creators",
    });
    expect(metric(gmail!.body, "response_rate").state).toBe("not_enough_data");
    expect(JSON.stringify(gmail!.body)).not.toContain("7200000");

    const [thin] = await call(PRO, "public.read_hotel_metric_signals", [TIME_THIN]);
    expect(metric(thin!.body, "response_time").state).toBe("not_enough_data");
    expect(metric(thin!.body, "response_time").value_label).toBeNull();
  });

  it("ranks activity from confirmed samples and keeps the network label", async () => {
    const [low] = await call(null, "public.read_hotel_metric_signals", [EMERGE_LOW]);
    expect(metric(low!.body, "creator_activity")).toMatchObject({
      state: "available",
      value_label: "Emerging",
      sample_basis: null,
      layer: "public",
    });
    const [network] = await adminQuery<{ activity_level: string }>(
      "select activity_level from public.network_hotel_public where hotel_id = $1",
      [EMERGE_LOW],
    );
    expect(network!.activity_level).toBe("emerging");

    const [ranking] = await call(null, "public.read_destination_metric_ranking", [
      BALI,
      "creator_activity",
    ]);
    expect(ranking!.body.result).toBe("ok");
    const rows = ranks(ranking!.body);
    const emergeLow = rows.find((hotel) => hotel.hotel_id === EMERGE_LOW)!;
    const emergeHigh = rows.find((hotel) => hotel.hotel_id === EMERGE_HIGH)!;
    expect(emergeLow.rank).toBeLessThan(emergeHigh.rank);
    expect(emergeLow.value_label).toBe("Emerging");
    const medium = rows.find((hotel) => hotel.hotel_id === RATE_ZERO)!;
    expect(medium.value_label).toBe("Medium");
    expect(medium.rank).toBeLessThan(emergeLow.rank);
    expect(rows.map((hotel) => hotel.hotel_id)).not.toContain(DUBAI_HOTEL);

    const [canggu] = await call(null, "public.read_destination_metric_ranking", [
      CANGGU,
      "creator_activity",
    ]);
    expect(ranks(canggu!.body).map((hotel) => hotel.hotel_id)).not.toContain(EMERGE_LOW);
    expect(ranks(canggu!.body).map((hotel) => hotel.hotel_id)).toContain(RATE_HIGH);
  });

  it("locks premium metrics for Free, anon, and the wrong Pass, and hides provenance", async () => {
    for (const userId of [null, FREE, PASS_DUBAI]) {
      const [ranking] = await call(userId, "public.read_destination_metric_ranking", [
        BALI,
        "response_rate",
      ]);
      expect(ranking!.body.result).toBe("locked");
      expect(ranking!.body.hotels).toBeUndefined();
      expect(JSON.stringify(ranking!.body)).not.toContain(RATE_HIGH);
    }
    const [pass] = await call(PASS_BALI, "public.read_destination_metric_ranking", [
      BALI,
      "response_rate",
    ]);
    expect(ranks(pass!.body).map((hotel) => hotel.hotel_id)).toContain(RATE_HIGH);
    const [editor] = await call(EDITOR, "public.read_destination_metric_ranking", [
      DUBAI,
      "response_time",
    ]);
    expect(editor!.body.result).toBe("ok");
    expect(JSON.stringify(editor!.body)).not.toMatch(/owner_user_id|evidence_id/);

    const [signals] = await call(FREE, "public.read_hotel_metric_signals", [RATE_HIGH]);
    expect(metric(signals!.body, "response_rate").state).toBe("locked");
    expect(metric(signals!.body, "response_rate").value_label).toBeNull();
    expect(metric(signals!.body, "creator_activity").state).toBe("available");
    expect(JSON.stringify(signals!.body)).not.toContain("67%");

    const anonView = await queryAs(
      { role: "anon", sub: null },
      "select hotel_id from public.hotel_metric_signal_premium",
    );
    expect(anonView.error).not.toBeNull();
    const freeView = await queryAs(
      { role: "authenticated", sub: FREE },
      "select hotel_id, value_label from public.hotel_metric_signal_premium where hotel_id = $1",
      [RATE_HIGH],
    );
    expect(freeView.error).toBeNull();
    expect(freeView.rows).toEqual([]);
    const proView = await queryAs<{ value_label: string }>(
      { role: "authenticated", sub: PRO },
      "select value_label from public.hotel_metric_signal_premium where hotel_id = $1 and metric = 'response_rate'",
      [RATE_HIGH],
    );
    expect(proView.rows.map((row) => row.value_label)).toEqual(["67%"]);

    const basis = await queryAs(
      { role: "authenticated", sub: PRO },
      "select hotel_id from private.hotel_metric_basis",
    );
    expect(basis.error).not.toBeNull();
    const facts = await queryAs(
      { role: "authenticated", sub: FREE },
      "select owner_user_id from private.intelligence_facts",
    );
    expect(facts.error).not.toBeNull();

    const [missing] = await call(PRO, "public.read_hotel_metric_signals", [CLOSED]);
    expect(missing!.body.result).toBe("not_found");
    const [mail] = await adminQuery<{ id: string }>(
      `insert into public.mail_accounts
         (user_id, provider, provider_account_subject, email_address, connection_state)
       values ($1, 'gmail', $2, $3, 'pending_authorization')
       returning id`,
      [CREATORS[0], randomUUID(), `${randomUUID()}@example.invalid`],
    );
    const machine = await adminQuery(
      `insert into private.intelligence_facts (
         owner_user_id, fact_type, provenance_class, source_family,
         canonical_hotel_id, evidence_kind, evidence_id, mail_account_id,
         network_eligible, counts_as_sample
       ) values (
         $1, 'pitch_sent', 'machine', 'gmail', $2, 'gmail_thread_attempt', $3, $4, true, true
       )`,
      [CREATORS[0], RATE_HIGH, randomUUID(), mail!.id],
    ).catch((error: { message: string }) => error);
    expect(String(machine)).toMatch(/check|constraint|violates/i);
  });
});
