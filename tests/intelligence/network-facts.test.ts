/**
 * C02–C05 privacy and admission gates (D099).
 *
 * User A cannot read User B's facts. Anonymous and creator callers cannot see
 * provenance. Dismissed Gmail readings never become network facts. The public
 * row appears only at three distinct creators, and it has no identity columns.
 */
import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { adminQuery, hasTestDb, queryAs, setupDatabase, teardownDatabase } from "../db/harness";

const d = describe.skipIf(!hasTestDb);

const HEX = "ab".repeat(32);
const DIGEST = "cd".repeat(32);
const DEST = "c2000000-0000-4000-8000-000000000001";
const HOTEL = "c2000000-0000-4000-8000-000000000010";
const OTHER = "c2000000-0000-4000-8000-000000000011";
const USERS = [
  "c2100000-0000-4000-8000-000000000001",
  "c2100000-0000-4000-8000-000000000002",
  "c2100000-0000-4000-8000-000000000003",
  "c2100000-0000-4000-8000-000000000004",
] as const;
const [A, B, C, ADMIN] = USERS;

function call(userId: string, fn: string, args: string, params: unknown[]) {
  const claims = JSON.stringify({ sub: userId });
  return adminQuery<{ body: Record<string, unknown> }>(
    `with cfg as (select set_config('request.jwt.claims', $1, true))
     select ${fn}(${args}) as body from cfg`,
    [claims, ...params],
  );
}

d("network intelligence facts", () => {
  beforeAll(async () => {
    await setupDatabase();
    for (const id of USERS) {
      await adminQuery("insert into auth.users (id, email) values ($1, $2)", [id, `${id}@test.local`]);
    }
    await adminQuery("update public.users set role = 'admin' where id = $1", [ADMIN]);
    await adminQuery(
      "insert into public.destinations (id, name, slug, type) values ($1, 'C02 Bay', 'c02-bay', 'city')",
      [DEST],
    );
    await adminQuery(
      `insert into public.hotels (id, name, slug, destination_id) values
         ($1, 'C02 House', 'c02-house', $3),
         ($2, 'C02 Other', 'c02-other', $3)`,
      [HOTEL, OTHER, DEST],
    );
  }, 120_000);

  afterAll(async () => {
    await teardownDatabase();
  });

  async function profile(userId: string): Promise<string> {
    const [row] = await adminQuery<{ id: string }>(
      "select id from public.creator_profiles where user_id = $1",
      [userId],
    );
    return row!.id;
  }

  async function pipeline(userId: string, hotelId = HOTEL): Promise<string> {
    const creatorId = await profile(userId);
    const [row] = await adminQuery<{ id: string }>(
      "insert into public.pipeline_items (creator_id, hotel_id) values ($1, $2) returning id",
      [creatorId, hotelId],
    );
    return row!.id;
  }

  async function pitch(
    userId: string,
    itemId: string,
    hotelId = HOTEL,
    age: "now" | "quarter" | "old" = "now",
  ) {
    const creatorId = await profile(userId);
    const eventAt =
      age === "old" ? "now() - interval '200 days'" : age === "quarter" ? "now() - interval '60 days'" : "now()";
    await adminQuery(
      `insert into public.outreach_events
         (creator_id, hotel_id, pipeline_item_id, event_type, event_at, source)
       values ($1, $2, $3, 'pitch_sent', ${eventAt}, 'manual_creator')`,
      [creatorId, hotelId, itemId],
    );
  }

  async function seedReading(input: {
    userId: string;
    creatorId: string;
    itemId: string;
    subject: string;
    thread: string;
    state: string;
    human: boolean;
  }) {
    const [account] = await adminQuery<{ id: string }>(
      `insert into public.mail_accounts
         (user_id, provider, provider_account_subject, email_address, connection_state)
       values ($1, 'gmail', $2, $3, 'pending_authorization')
       returning id`,
      [input.userId, input.subject, `${input.subject}@example.invalid`],
    );
    const [thread] = await adminQuery<{ id: string }>(
      `insert into private.gmail_normalized_threads (user_id, mail_account_id, provider_thread_id)
       values ($1, $2, $3) returning id`,
      [input.userId, account!.id, input.thread],
    );
    const attemptId = randomUUID();
    await adminQuery(
      `with cfg as (select set_config('b07.machine_writer', 'on', true) as ok)
       insert into private.gmail_commercial_thread_attempts (
         id, user_id, mail_account_id, provider_thread_id, normalized_thread_id,
         input_digest, schema_version, transform_version, engine_kind, rule_version,
         commercial_state, compensation_structure, evidence_strength
       )
       select $1, $2, $3, $4, $5, $6, 'gmail_commercial_schema_v1', 'gmail_commercial_text_v1',
              'rules', 'gmail_commercial_rules_v1', $7, 'unknown', 'insufficient_evidence'
         from cfg`,
      [attemptId, input.userId, account!.id, input.thread, thread!.id, DIGEST, input.state],
    );
    const [binding] = await adminQuery<{ id: string }>(
      `with cfg as (select set_config('inbox_pipeline.writer', 'bind', true) as ok)
       insert into public.pipeline_inbox_bindings
         (creator_id, pipeline_item_id, mail_account_id, provider_thread_id)
       select $1, $2, $3, $4 from cfg
       returning id`,
      [input.creatorId, input.itemId, account!.id, input.thread],
    );
    await adminQuery(
      `with cfg as (select set_config('inbox_pipeline.writer', 'refresh', true) as ok)
       insert into public.pipeline_inbox_readings (
         creator_id, pipeline_item_id, binding_id, source_attempt_id, commercial_state,
         rule_version, has_redirect, has_rejection, has_human_reply, decline_supported
       )
       select $1, $2, $3, $4, $5, 'gmail_commercial_rules_v1', false, false, $6, false from cfg`,
      [input.creatorId, input.itemId, binding!.id, attemptId, input.state, input.human],
    );
    return { accountId: account!.id, threadRowId: thread!.id };
  }

  it("keeps manual facts private and withholds the network row below three creators", async () => {
    const itemA = await pipeline(A);
    const itemB = await pipeline(B);
    await pitch(A, itemA);
    await pitch(A, itemA);
    await pitch(B, itemB);

    const own = await call(A, "public.read_own_network_facts", "$2", [HOTEL]);
    const body = own[0]!.body;
    expect(body.result).toBe("ok");
    expect(JSON.stringify(body)).not.toContain("evidence_id");
    const manual = body.manual as { fact_type: string; source_family: string }[];
    expect(manual.every((fact) => fact.source_family === "manual")).toBe(true);
    expect(manual.length).toBe(2);
    const other = await call(B, "public.read_own_network_facts", "$2", [HOTEL]);
    const otherManual = other[0]!.body.manual as { fact_type: string }[];
    expect(otherManual.length).toBe(1);

    const hidden = await queryAs({ role: "anon" }, "select * from public.network_hotel_public where hotel_id = $1", [
      HOTEL,
    ]);
    expect(hidden.error).toBeNull();
    expect(hidden.rows).toHaveLength(0);

    const denied = await queryAs({ role: "authenticated", sub: A }, "select * from private.intelligence_facts");
    expect(denied.error).not.toBeNull();
    const serviceDenied = await queryAs({ role: "service_role" }, "select * from private.intelligence_facts");
    expect(serviceDenied.error).not.toBeNull();
  });

  it("shows an anonymous insufficient row at three creators and metrics only from five facts", async () => {
    const itemC = await pipeline(C);
    await pitch(C, itemC);
    const low = await queryAs(
      { role: "anon" },
      "select * from public.network_hotel_public where hotel_id = $1",
      [HOTEL],
    );
    expect(low.rows).toHaveLength(1);
    expect(low.rows[0]).toMatchObject({
      confidence_level: "insufficient",
      activity_level: null,
      has_observed_collaboration: null,
      recency_band: null,
      freshness_band: null,
    });
    expect(Object.keys(low.rows[0]!).sort()).toEqual([
      "activity_level",
      "confidence_level",
      "freshness_band",
      "has_observed_collaboration",
      "hotel_id",
      "recency_band",
    ]);

    await pitch(C, itemC);
    const emerging = await queryAs(
      { role: "authenticated", sub: B },
      "select confidence_level, activity_level, has_observed_collaboration from public.network_hotel_public where hotel_id = $1",
      [HOTEL],
    );
    expect(emerging.rows[0]).toMatchObject({
      confidence_level: "emerging",
      activity_level: "emerging",
      has_observed_collaboration: null,
    });
    expect(JSON.stringify(emerging.rows[0])).not.toMatch(/creator|evidence|gmail|manual/i);
  });

  it("does not treat unknown completion as unpaid or as no", async () => {
    const creatorId = await profile(A);
    const [item] = await adminQuery<{ id: string }>(
      "select id from public.pipeline_items where creator_id = $1 and hotel_id = $2 limit 1",
      [creatorId, HOTEL],
    );
    await adminQuery(
      `insert into public.outreach_events
         (creator_id, hotel_id, pipeline_item_id, event_type, event_at, source, metadata)
       values ($1, $2, $3, 'collaboration_completed', now(), 'manual_creator', $4::jsonb)`,
      [
        creatorId,
        HOTEL,
        item!.id,
        JSON.stringify({ terms_matched: "unknown", would_work_again: null }),
      ],
    );
    const [fact] = await adminQuery<{ value: { terms_matched: string; would_work_again: boolean | null } }>(
      `select value from private.intelligence_facts
        where owner_user_id = $1 and fact_type = 'collaboration_completed'`,
      [A],
    );
    expect(fact!.value.terms_matched).toBe("unknown");
    expect(fact!.value.would_work_again).toBeNull();
    expect(JSON.stringify(fact!.value)).not.toContain("unpaid");
  });

  it("ignores a non-manual source and never networks a shortlist", async () => {
    const creatorId = await profile(A);
    const [item] = await adminQuery<{ id: string }>(
      "select id from public.pipeline_items where creator_id = $1 limit 1",
      [creatorId],
    );
    await adminQuery(
      `insert into public.outreach_events
         (creator_id, hotel_id, pipeline_item_id, event_type, event_at, source)
       values ($1, $2, $3, 'pitch_sent', now(), 'gmail')`,
      [creatorId, HOTEL, item!.id],
    );
    const [gmailSource] = await adminQuery<{ n: string }>(
      `select count(*)::text as n from private.intelligence_facts f
         join public.outreach_events e on e.id = f.evidence_id
        where e.source = 'gmail'`,
    );
    expect(gmailSource!.n).toBe("0");

    const [trip] = await adminQuery<{ id: string }>(
      `insert into public.trips (creator_id, destination_id, start_date, end_date)
       values ($1, $2, '2026-11-01', '2026-11-08') returning id`,
      [creatorId, DEST],
    );
    await adminQuery("insert into public.trip_hotels (trip_id, hotel_id) values ($1, $2)", [trip!.id, HOTEL]);
    const [shortlist] = await adminQuery<{ network_eligible: boolean }>(
      `select network_eligible from private.intelligence_facts
        where fact_type = 'trip_shortlist_membership' and owner_user_id = $1`,
      [A],
    );
    expect(shortlist!.network_eligible).toBe(false);
  });

  it("admits a confirmed Gmail reading only for one matching hotel, and never a dismissal", async () => {
    const creatorId = await profile(A);
    const [item] = await adminQuery<{ id: string }>(
      "insert into public.pipeline_items (creator_id, hotel_id, status) values ($1, $2, 'closed') returning id",
      [creatorId, HOTEL],
    );
    const seeded = await seedReading({
      userId: A,
      creatorId,
      itemId: item!.id,
      subject: "c02-subject",
      thread: "c02-thread",
      state: "engaged",
      human: true,
    });

    const unmatched = await call(A, "public.answer_gmail_network_reading", "$2, $3", [item!.id, "confirmed"]);
    expect(unmatched[0]!.body.result).toBe("confirmed_not_admitted");
    const [none] = await adminQuery<{ n: string }>(
      "select count(*)::text as n from private.intelligence_facts where source_family = 'gmail' and owner_user_id = $1",
      [A],
    );
    expect(none!.n).toBe("0");

    await adminQuery("delete from private.intelligence_gmail_confirmations where pipeline_item_id = $1", [item!.id]);
    const [observation] = await adminQuery<{ id: string }>(
      `insert into private.gmail_outreach_target_observations
         (user_id, mail_account_id, normalized_thread_id, observation_fingerprint, source_provider_message_ids)
       values ($1, $2, $3, $4, array['m1']) returning id`,
      [A, seeded.accountId, seeded.threadRowId, HEX],
    );
    await adminQuery(
      `insert into private.gmail_outreach_target_canonical_links
         (target_observation_id, target_kind, target_hotel_id, name_evidence, domain_evidence,
          address_evidence, contact_evidence, rank)
       values ($1, 'hotel', $2, 'unavailable', 'unavailable', 'unavailable', 'unavailable', 0)`,
      [observation!.id, OTHER],
    );
    const mismatch = await call(A, "public.answer_gmail_network_reading", "$2, $3", [item!.id, "confirmed"]);
    expect(mismatch[0]!.body.result).toBe("confirmed_not_admitted");
    const [stillNone] = await adminQuery<{ n: string }>(
      "select count(*)::text as n from private.intelligence_facts where canonical_hotel_id = $1 and source_family = 'gmail'",
      [OTHER],
    );
    expect(stillNone!.n).toBe("0");

    await adminQuery("delete from private.intelligence_gmail_confirmations where pipeline_item_id = $1", [item!.id]);
    await adminQuery(
      "update private.gmail_outreach_target_canonical_links set target_hotel_id = $1 where target_observation_id = $2",
      [HOTEL, observation!.id],
    );
    const admitted = await call(A, "public.answer_gmail_network_reading", "$2, $3", [item!.id, "dismissed"]);
    expect(admitted[0]!.body.result).toBe("dismissed");
    const [dismissedFacts] = await adminQuery<{ n: string }>(
      `select count(*)::text as n from private.intelligence_facts
        where source_family = 'gmail' and network_eligible and owner_user_id = $1`,
      [A],
    );
    expect(dismissedFacts!.n).toBe("0");
    const again = await call(A, "public.answer_gmail_network_reading", "$2, $3", [item!.id, "confirmed"]);
    expect(again[0]!.body.result).toBe("already_answered");
    expect(dismissedFacts!.n).toBe("0");

    const stranger = await call(B, "public.answer_gmail_network_reading", "$2, $3", [item!.id, "confirmed"]);
    expect(stranger[0]!.body.result).toBe("not_found");
  });

  it("separates an admitted Gmail fact from manual facts and hides provenance from creators", async () => {
    const creatorId = await profile(B);
    const [item] = await adminQuery<{ id: string }>(
      "select id from public.pipeline_items where creator_id = $1 and hotel_id = $2 and status = 'saved' limit 1",
      [creatorId, HOTEL],
    );
    const seeded = await seedReading({
      userId: B,
      creatorId,
      itemId: item!.id,
      subject: "c02-b",
      thread: "c02-thread-b",
      state: "negotiating",
      human: true,
    });
    const [observation] = await adminQuery<{ id: string }>(
      `insert into private.gmail_outreach_target_observations
         (user_id, mail_account_id, normalized_thread_id, observation_fingerprint, source_provider_message_ids)
       values ($1, $2, $3, $4, array['m2']) returning id`,
      [B, seeded.accountId, seeded.threadRowId, HEX],
    );
    await adminQuery(
      `insert into private.gmail_outreach_target_canonical_links
         (target_observation_id, target_kind, target_hotel_id, name_evidence, domain_evidence,
          address_evidence, contact_evidence, rank)
       values ($1, 'hotel', $2, 'unavailable', 'unavailable', 'unavailable', 'unavailable', 0)`,
      [observation!.id, HOTEL],
    );
    await adminQuery(
      `insert into private.gmail_reply_thread_summaries (
         user_id, mail_account_id, normalized_thread_id, eligibility, observation_state,
         first_creator_sent_provider_message_id, first_creator_sent_at,
         first_qualifying_human_reply_provider_message_id, first_qualifying_human_reply_at,
         latency_from_first_creator_sent_ms, evidence_digest, evidence_message_count,
         routing_context_digest, relation_rule_version, classification_rule_version, text_transform_version
       ) values (
         $1, $2, $3, 'eligible_confirmed', 'qualifying_human_reply_observed',
         'sent-1', now() - interval '2 hours', 'reply-1', now() - interval '1 hour',
         3600000, $4, 2, $4, 'rules_v1', 'rules_v1', 'text_v1'
       )`,
      [B, seeded.accountId, seeded.threadRowId, HEX],
    );

    const admitted = await call(B, "public.answer_gmail_network_reading", "$2, $3", [item!.id, "confirmed"]);
    expect(admitted[0]!.body.result).toBe("confirmed_admitted");
    const facts = await adminQuery<{
      fact_type: string;
      provenance_class: string;
      source_family: string;
      network_eligible: boolean;
      counts_as_sample: boolean;
      value: Record<string, unknown>;
    }>(
      `select fact_type, provenance_class, source_family, network_eligible, counts_as_sample, value
         from private.intelligence_facts
        where owner_user_id = $1 and source_family = 'gmail'
        order by fact_type`,
      [B],
    );
    const confirmed = facts.filter((fact) => fact.provenance_class === "creator_confirmed");
    expect(confirmed.map((fact) => fact.fact_type).sort()).toEqual([
      "gmail_human_reply_observed",
      "gmail_reply_latency",
      "gmail_thread_commercial_state",
    ]);
    expect(confirmed.every((fact) => fact.source_family === "gmail")).toBe(true);
    expect(confirmed.every((fact) => fact.network_eligible)).toBe(true);
    const machine = facts.filter((fact) => fact.provenance_class === "machine");
    expect(machine).toHaveLength(1);
    expect(machine[0]!.network_eligible).toBe(false);
    expect(machine[0]!.counts_as_sample).toBe(false);
    const latency = facts.find((fact) => fact.fact_type === "gmail_reply_latency");
    expect(latency!.counts_as_sample).toBe(false);
    expect(latency!.value.first_send_to_human_reply_ms).toBe(3600000);
    expect(JSON.stringify(latency!.value)).not.toContain("rejection");
    const [timing] = await adminQuery<{ matches: boolean; before_decision: boolean }>(
      `select bool_and(f.event_at = s.first_qualifying_human_reply_at) as matches,
              bool_and(f.event_at < c.decided_at) as before_decision
         from private.intelligence_facts f
         join private.gmail_reply_thread_summaries s on s.user_id = f.owner_user_id
         left join private.intelligence_gmail_confirmations c
           on c.id = f.evidence_id and f.evidence_kind = 'gmail_confirmation'
        where f.owner_user_id = $1 and f.source_family = 'gmail'`,
      [B],
    );
    expect(timing!.matches).toBe(true);
    expect(timing!.before_decision).toBe(true);

    const own = await call(A, "public.read_own_network_facts", "$2", [HOTEL]);
    const gmail = own[0]!.body.gmail as unknown[];
    expect(gmail).toEqual([]);
    const [fact] = await adminQuery<{ id: string }>(
      "select id from private.intelligence_facts where owner_user_id = $1 and source_family = 'gmail' limit 1",
      [B],
    );
    const creator = await call(A, "public.read_admin_fact_provenance", "$2", [fact!.id]);
    expect(creator[0]!.body.result).toBe("not_found");
    const editorUser = A;
    try {
      await adminQuery("update public.users set role = 'editor' where id = $1", [editorUser]);
      const editor = await call(editorUser, "public.read_admin_fact_provenance", "$2", [fact!.id]);
      expect(editor[0]!.body.result).toBe("not_found");
    } finally {
      await adminQuery("update public.users set role = 'creator' where id = $1", [editorUser]);
    }
    const admin = await call(ADMIN, "public.read_admin_fact_provenance", "$2", [fact!.id]);
    expect(admin[0]!.body.result).toBe("ok");
    expect(admin[0]!.body.evidence_id).toBeTruthy();
    expect(admin[0]!.body.owner_user_id).toBe(B);
    const anon = await queryAs({ role: "anon" }, "select public.read_admin_fact_provenance($1)", [fact!.id]);
    expect(anon.error).not.toBeNull();
    const kpisAnon = await queryAs({ role: "anon" }, "select public.read_admin_pilot_kpis()");
    expect(kpisAnon.error).not.toBeNull();
    const kpisCreator = await call(A, "public.read_admin_pilot_kpis", "", []);
    expect(kpisCreator[0]!.body.result).toBe("not_found");
  });

  it("publishes a response-time band only at three creators and five observations", async () => {
    const kpis = await call(ADMIN, "public.read_admin_pilot_kpis", "", []);
    expect(kpis[0]!.body.result).toBe("ok");
    const times = kpis[0]!.body.hotel_response_time as unknown[];
    expect(times).toEqual([]);
    expect(kpis[0]!.body.gmail_confirmed_pct).not.toBe(0);
    const prior = await call(ADMIN, "public.read_admin_prior_experiment", "$2", [DEST]);
    expect(prior[0]!.body.prior_applied).toBe(false);
    const rows = (prior[0]!.body.rows as { baseline_rank: number; prior_rank: number }[]) ?? [];
    expect(rows.every((row) => row.baseline_rank === row.prior_rank)).toBe(true);
    const creatorPrior = await call(A, "public.read_admin_prior_experiment", "$2", [DEST]);
    expect(creatorPrior[0]!.body.result).toBe("not_found");
  });

  it("does not let a priority change the anonymous row", async () => {
    const before = await adminQuery("select confidence_level from public.network_hotel_public where hotel_id = $1", [
      HOTEL,
    ]);
    const priority = await call(A, "public.record_network_priority", "$2", [HOTEL]);
    expect(priority[0]!.body.result).toBe("ok");
    const after = await adminQuery("select confidence_level from public.network_hotel_public where hotel_id = $1", [
      HOTEL,
    ]);
    expect(after).toEqual(before);
    const own = await call(B, "public.read_own_network_priority", "$2", [HOTEL]);
    expect(own[0]!.body.prioritized).toBe(false);
  });

  it("nulls a recency band when fewer than three creators fall inside its window", async () => {
    const thin = "c2000000-0000-4000-8000-000000000020";
    const spread = "c2000000-0000-4000-8000-000000000023";
    await adminQuery(
      `insert into public.hotels (id, name, slug, destination_id) values
         ($1, 'C02 Thin', 'c02-thin', $3),
         ($2, 'C02 Spread', 'c02-spread', $3)`,
      [thin, spread, DEST],
    );

    const thinA = await pipeline(A, thin);
    const thinB = await pipeline(B, thin);
    const thinC = await pipeline(C, thin);
    for (let i = 0; i < 7; i += 1) {
      await pitch(A, thinA, thin, "now");
      await pitch(B, thinB, thin, "now");
    }
    await pitch(C, thinC, thin, "old");

    const thinRow = await queryAs(
      { role: "anon" },
      "select confidence_level, recency_band, freshness_band from public.network_hotel_public where hotel_id = $1",
      [thin],
    );
    expect(thinRow.rows[0]).toMatchObject({
      confidence_level: "moderate",
      recency_band: null,
      freshness_band: null,
    });

    for (const userId of [A, B]) {
      const itemId = await pipeline(userId, spread);
      for (let i = 0; i < 5; i += 1) await pitch(userId, itemId, spread, "now");
    }
    const spreadC = await pipeline(C, spread);
    for (let i = 0; i < 5; i += 1) await pitch(C, spreadC, spread, "quarter");

    const spreadRow = await queryAs(
      { role: "anon" },
      "select recency_band, freshness_band from public.network_hotel_public where hotel_id = $1",
      [spread],
    );
    expect(spreadRow.rows[0]).toMatchObject({
      recency_band: "past_quarter",
      freshness_band: "past_quarter",
    });
  });

  it("does not let one Gmail confirmation move a recency band or the destination rank", async () => {
    const earlier = "c2000000-0000-4000-8000-000000000021";
    const later = "c2000000-0000-4000-8000-000000000022";
    await adminQuery(
      `insert into public.hotels (id, name, slug, destination_id) values
         ($1, 'C02 Earlier', 'c02-earlier', $3),
         ($2, 'C02 Later', 'c02-later', $3)`,
      [earlier, later, DEST],
    );
    let laterItemA = "";
    for (const hotelId of [earlier, later]) {
      for (const userId of [A, B, C]) {
        const itemId = await pipeline(userId, hotelId);
        if (hotelId === later && userId === A) laterItemA = itemId;
        for (let i = 0; i < 5; i += 1) await pitch(userId, itemId, hotelId, "old");
      }
    }

    const bands = () =>
      adminQuery<{ hotel_id: string; recency_band: string | null; freshness_band: string | null }>(
        `select hotel_id, recency_band, freshness_band
           from public.network_hotel_public
          where hotel_id = any($1::uuid[])
          order by hotel_id`,
        [[earlier, later]],
      );
    const rank = async () => {
      const body = (await call(A, "public.read_network_destination_rank", "$2", [DEST]))[0]!.body;
      return body.hotels;
    };
    const beforeBands = await bands();
    expect(beforeBands).toEqual([
      { hotel_id: earlier, recency_band: "older", freshness_band: "older" },
      { hotel_id: later, recency_band: "older", freshness_band: "older" },
    ]);
    const beforeRank = await rank();

    const creatorId = await profile(A);
    const itemId = laterItemA;
    const seeded = await seedReading({
      userId: A,
      creatorId,
      itemId,
      subject: "c02-rank",
      thread: "c02-thread-rank",
      state: "engaged",
      human: true,
    });
    const [observation] = await adminQuery<{ id: string }>(
      `insert into private.gmail_outreach_target_observations
         (user_id, mail_account_id, normalized_thread_id, observation_fingerprint, source_provider_message_ids)
       values ($1, $2, $3, $4, array['m-rank']) returning id`,
      [A, seeded.accountId, seeded.threadRowId, HEX],
    );
    await adminQuery(
      `insert into private.gmail_outreach_target_canonical_links
         (target_observation_id, target_kind, target_hotel_id, name_evidence, domain_evidence,
          address_evidence, contact_evidence, rank)
       values ($1, 'hotel', $2, 'unavailable', 'unavailable', 'unavailable', 'unavailable', 0)`,
      [observation!.id, later],
    );
    await adminQuery(
      `insert into private.gmail_reply_thread_summaries (
         user_id, mail_account_id, normalized_thread_id, eligibility, observation_state,
         first_creator_sent_provider_message_id, first_creator_sent_at,
         first_qualifying_human_reply_provider_message_id, first_qualifying_human_reply_at,
         latency_from_first_creator_sent_ms, evidence_digest, evidence_message_count,
         routing_context_digest, relation_rule_version, classification_rule_version, text_transform_version
       ) values (
         $1, $2, $3, 'eligible_confirmed', 'qualifying_human_reply_observed',
         'sent-rank', now() - interval '2 days', 'reply-rank', now() - interval '1 day',
         86400000, $4, 2, $4, 'rules_v1', 'rules_v1', 'text_v1'
       )`,
      [A, seeded.accountId, seeded.threadRowId, HEX],
    );

    const admitted = await call(A, "public.answer_gmail_network_reading", "$2, $3", [itemId, "confirmed"]);
    expect(admitted[0]!.body.result).toBe("confirmed_admitted");
    const [stored] = await adminQuery<{ matches: boolean; before_decision: boolean }>(
      `select bool_and(f.event_at = s.first_qualifying_human_reply_at) as matches,
              bool_and(f.event_at < c.decided_at) as before_decision
         from private.intelligence_facts f
         join private.gmail_reply_thread_summaries s
           on s.mail_account_id = $2 and s.user_id = f.owner_user_id
         join private.intelligence_gmail_confirmations c on c.pipeline_item_id = $3
        where f.owner_user_id = $1
          and f.canonical_hotel_id = $4
          and f.evidence_kind = 'gmail_confirmation'
          and f.provenance_class = 'creator_confirmed'`,
      [A, seeded.accountId, itemId, later],
    );
    expect(stored!.matches).toBe(true);
    expect(stored!.before_decision).toBe(true);
    expect(await bands()).toEqual(beforeBands);
    expect(await rank()).toEqual(beforeRank);
  });

  async function hotelWithEmergingManualFacts(hotelId: string, slug: string) {
    await adminQuery(
      "insert into public.hotels (id, name, slug, destination_id) values ($1, $2, $3, $4)",
      [hotelId, slug, slug, DEST],
    );
    const counts: [string, number][] = [
      [A, 5],
      [B, 5],
      [C, 4],
    ];
    for (const [userId, count] of counts) {
      const itemId = await pipeline(userId, hotelId);
      for (let i = 0; i < count; i += 1) await pitch(userId, itemId, hotelId, "old");
    }
  }

  async function confirmGmailSample(hotelId: string, subject: string, thread: string) {
    const creatorId = await profile(A);
    const [item] = await adminQuery<{ id: string }>(
      "select id from public.pipeline_items where creator_id = $1 and hotel_id = $2",
      [creatorId, hotelId],
    );
    const seeded = await seedReading({
      userId: A,
      creatorId,
      itemId: item!.id,
      subject,
      thread,
      state: "engaged",
      human: true,
    });
    const [observation] = await adminQuery<{ id: string }>(
      `insert into private.gmail_outreach_target_observations
         (user_id, mail_account_id, normalized_thread_id, observation_fingerprint, source_provider_message_ids)
       values ($1, $2, $3, $4, array['m-purge']) returning id`,
      [A, seeded.accountId, seeded.threadRowId, HEX],
    );
    await adminQuery(
      `insert into private.gmail_outreach_target_canonical_links
         (target_observation_id, target_kind, target_hotel_id, name_evidence, domain_evidence,
          address_evidence, contact_evidence, rank)
       values ($1, 'hotel', $2, 'unavailable', 'unavailable', 'unavailable', 'unavailable', 0)`,
      [observation!.id, hotelId],
    );
    await adminQuery(
      `insert into private.gmail_reply_thread_summaries (
         user_id, mail_account_id, normalized_thread_id, eligibility, observation_state,
         first_creator_sent_provider_message_id, first_creator_sent_at,
         first_qualifying_human_reply_provider_message_id, first_qualifying_human_reply_at,
         latency_from_first_creator_sent_ms, evidence_digest, evidence_message_count,
         routing_context_digest, relation_rule_version, classification_rule_version, text_transform_version
       ) values (
         $1, $2, $3, 'eligible_confirmed', 'qualifying_human_reply_observed',
         'sent-purge', now() - interval '2 days', 'reply-purge', now() - interval '1 day',
         86400000, $4, 2, $4, 'rules_v1', 'rules_v1', 'text_v1'
       )`,
      [A, seeded.accountId, seeded.threadRowId, HEX],
    );
    const admitted = await call(A, "public.answer_gmail_network_reading", "$2, $3", [item!.id, "confirmed"]);
    expect(admitted[0]!.body.result).toBe("confirmed_admitted");
    return seeded.accountId;
  }

  async function confidenceOf(hotelId: string): Promise<string> {
    const row = await queryAs(
      { role: "anon" },
      "select confidence_level from public.network_hotel_public where hotel_id = $1",
      [hotelId],
    );
    return String(row.rows[0]?.confidence_level ?? "");
  }

  async function countsFor(hotelId: string, mailAccountId: string) {
    const [gmail] = await adminQuery<{ n: string }>(
      `select count(*)::text as n from private.intelligence_facts
        where canonical_hotel_id = $1 and source_family = 'gmail' and counts_as_sample`,
      [hotelId],
    );
    const [manual] = await adminQuery<{ n: string }>(
      `select count(*)::text as n from private.intelligence_facts
        where canonical_hotel_id = $1 and owner_user_id = $2 and source_family = 'manual'`,
      [hotelId, A],
    );
    const [confirmations] = await adminQuery<{ n: string }>(
      `select count(*)::text as n from private.intelligence_gmail_confirmations c
         join public.pipeline_inbox_bindings b on b.id = c.binding_id
        where b.mail_account_id = $1`,
      [mailAccountId],
    );
    return { gmail: gmail!.n, manual: manual!.n, confirmations: confirmations!.n };
  }

  async function openDeletion(mailAccountId: string, scope: "gmail_derived_data" | "account_and_gmail_derived_data") {
    const [request] = await adminQuery<{ id: string }>(
      `insert into public.mail_account_deletion_requests
         (mail_account_id, user_id, scope, requested_by_user_id, requested_at, status)
       values ($1, $2, $3, $2, now(), 'in_progress') returning id`,
      [mailAccountId, A, scope],
    );
    await adminQuery(
      `update public.mail_accounts
          set connection_state = 'deletion_pending',
              current_deletion_request_id = $2,
              disconnected_at = now(),
              granted_scopes = '{}'
        where id = $1`,
      [mailAccountId, request!.id],
    );
    return request!.id;
  }

  it("drops a confirmed Gmail fact from the aggregate when that mailbox is purged", async () => {
    const hotelId = "c2000000-0000-4000-8000-000000000030";
    await hotelWithEmergingManualFacts(hotelId, "c02-purge");
    expect(await confidenceOf(hotelId)).toBe("emerging");
    const mailAccountId = await confirmGmailSample(hotelId, "c02-purge-subject", "c02-purge-thread");
    expect(await confidenceOf(hotelId)).toBe("moderate");
    const before = await countsFor(hotelId, mailAccountId);
    expect(before.gmail).toBe("1");
    expect(before.manual).toBe("5");
    expect(before.confirmations).toBe("1");

    const requestId = await openDeletion(mailAccountId, "gmail_derived_data");
    const [purged] = await adminQuery<{ body: { result: string } }>(
      "select public.gmail_reply_purge_for_deletion($1, $2, $3) as body",
      [A, mailAccountId, requestId],
    );
    expect(purged!.body.result).toBe("ok");
    const [state] = await adminQuery<{ connection_state: string }>(
      "select connection_state from public.mail_accounts where id = $1",
      [mailAccountId],
    );
    expect(state!.connection_state).toBe("deletion_pending");

    const after = await countsFor(hotelId, mailAccountId);
    expect(after.gmail).toBe("0");
    expect(after.confirmations).toBe("0");
    expect(after.manual).toBe("5");
    expect(await confidenceOf(hotelId)).toBe("emerging");
  });

  it("drops a confirmed Gmail fact when the mailbox becomes deleted", async () => {
    const hotelId = "c2000000-0000-4000-8000-000000000031";
    await hotelWithEmergingManualFacts(hotelId, "c02-deleted");
    const mailAccountId = await confirmGmailSample(hotelId, "c02-deleted-subject", "c02-deleted-thread");
    expect(await confidenceOf(hotelId)).toBe("moderate");
    expect((await countsFor(hotelId, mailAccountId)).gmail).toBe("1");

    const requestId = await openDeletion(mailAccountId, "account_and_gmail_derived_data");
    await adminQuery(
      `delete from private.gmail_outreach_target_canonical_links
        where target_observation_id in (
          select id from private.gmail_outreach_target_observations where mail_account_id = $1
        )`,
      [mailAccountId],
    );
    await adminQuery("delete from private.gmail_outreach_target_observations where mail_account_id = $1", [
      mailAccountId,
    ]);
    await adminQuery(
      `with cfg as (select set_config('b07.purge', 'on', true))
       delete from private.gmail_commercial_thread_attempts a
        using cfg
       where a.mail_account_id = $1`,
      [mailAccountId],
    );
    await adminQuery("delete from private.gmail_reply_thread_summaries where mail_account_id = $1", [mailAccountId]);
    await adminQuery("delete from private.gmail_normalized_threads where mail_account_id = $1", [mailAccountId]);
    await adminQuery(
      `with done as (
         update public.mail_account_deletion_requests
            set status = 'completed', completed_at = now()
          where id = $1
         returning id
       )
       update public.mail_accounts
          set connection_state = 'deleted'
        where id = $2`,
      [requestId, mailAccountId],
    );

    const after = await countsFor(hotelId, mailAccountId);
    expect(after.gmail).toBe("0");
    expect(after.confirmations).toBe("0");
    expect(after.manual).toBe("5");
    expect(await confidenceOf(hotelId)).toBe("emerging");
  });
});
