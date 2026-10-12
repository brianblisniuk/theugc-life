/**
 * D08 personal counts and past collaborations against real Postgres.
 *
 * User A cannot read, insert, update, or delete User B's profile, and cannot
 * see B's counts. A machine agreement, a redirect, and silence do not become
 * creator outcomes. Unknown compensation is not zero. Cancelled is not
 * completed. An approved deliverable counts once, not by quantity.
 */
import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { adminQuery, hasTestDb, queryAs, setupDatabase, teardownDatabase } from "../db/harness";

const d = describe.skipIf(!hasTestDb);

const USER_A = "d0800000-0000-0000-0000-000000000001";
const USER_B = "d0800000-0000-0000-0000-000000000002";
const DEST = "d0820000-0000-0000-0000-000000000001";
const HOTEL_A = "d0830000-0000-0000-0000-000000000001";
const HOTEL_B = "d0830000-0000-0000-0000-000000000002";
const DIGEST = "ab".repeat(32);

async function creatorId(userId: string): Promise<string> {
  const rows = await adminQuery<{ id: string }>(
    "select id from public.creator_profiles where user_id = $1",
    [userId],
  );
  return rows[0]!.id;
}

async function counts(userId: string) {
  return queryAs<{ r: Record<string, unknown> }>(
    { role: "authenticated", sub: userId },
    "select public.creator_personal_counts() as r",
  );
}

async function past(userId: string, hotelId: string | null = null) {
  return queryAs<{ r: Record<string, unknown> }>(
    { role: "authenticated", sub: userId },
    "select public.creator_past_collaborations($1) as r",
    [hotelId],
  );
}

async function insertItem(creator: string, hotelId: string, status = "closed"): Promise<string> {
  const rows = await adminQuery<{ id: string }>(
    `insert into public.pipeline_items (creator_id, hotel_id, status)
     values ($1,$2,$3) returning id`,
    [creator, hotelId, status],
  );
  return rows[0]!.id;
}

async function insertEvent(
  creator: string,
  hotelId: string,
  itemId: string,
  eventType: string,
  source = "manual_creator",
) {
  await adminQuery(
    `insert into public.outreach_events
       (creator_id, hotel_id, pipeline_item_id, event_type, event_at, source)
     values ($1,$2,$3,$4, now(), $5)`,
    [creator, hotelId, itemId, eventType, source],
  );
}

async function insertCollaboration(
  creator: string,
  hotelId: string,
  itemId: string,
  status: string,
  endDate: string | null = null,
): Promise<string> {
  const rows = await adminQuery<{ id: string }>(
    `insert into public.collaborations
       (creator_id, hotel_id, pipeline_item_id, status, end_date, terms_matched)
     values ($1,$2,$3,$4,$5,'unknown')
     returning id`,
    [creator, hotelId, itemId, status, endDate],
  );
  return rows[0]!.id;
}

async function seedMachineReading(
  userId: string,
  creator: string,
  hotelId: string,
  state: string | null,
  flags: { redirect: boolean; rejection: boolean; humanReply: boolean; decline: boolean },
) {
  const itemId = await insertItem(creator, hotelId, "closed");
  const mailId = randomUUID();
  const threadId = `thread-${mailId}`;
  const attemptId = randomUUID();
  await adminQuery(
    `insert into public.mail_accounts
       (id, user_id, provider, provider_account_subject, connection_state)
     values ($1,$2,'gmail',$3,'pending_authorization')`,
    [mailId, userId, `sub-${mailId}`],
  );
  await adminQuery(
    `insert into private.gmail_normalized_threads (user_id, mail_account_id, provider_thread_id)
     values ($1,$2,$3)`,
    [userId, mailId, threadId],
  );
  await adminQuery(
    `with cfg as (select set_config('b07.machine_writer', 'on', true) as ok)
     insert into private.gmail_commercial_thread_attempts (
       id, user_id, mail_account_id, provider_thread_id, normalized_thread_id,
       input_digest, schema_version, transform_version, engine_kind, rule_version,
       commercial_state, compensation_structure, evidence_strength
     )
     select $1,$2,$3,$4,
            (select id from private.gmail_normalized_threads
              where mail_account_id = $3 and provider_thread_id = $4),
            $5,'gmail_commercial_schema_v1','gmail_commercial_text_v1',
            'rules','gmail_commercial_rules_v1',$6,'unknown','insufficient_evidence'
       from cfg`,
    [attemptId, userId, mailId, threadId, DIGEST, state],
  );
  const bindings = await adminQuery<{ id: string }>(
    `with cfg as (select set_config('inbox_pipeline.writer', 'bind', true) as ok)
     insert into public.pipeline_inbox_bindings
       (creator_id, pipeline_item_id, mail_account_id, provider_thread_id)
     select $1,$2,$3,$4 from cfg
     returning id`,
    [creator, itemId, mailId, threadId],
  );
  await adminQuery(
    `with cfg as (select set_config('inbox_pipeline.writer', 'refresh', true) as ok)
     insert into public.pipeline_inbox_readings (
       creator_id, pipeline_item_id, binding_id, source_attempt_id,
       commercial_state, rule_version, has_redirect, has_rejection,
       has_human_reply, decline_supported
     )
     select $1,$2,$3,$4,$5,'gmail_commercial_rules_v1',$6,$7,$8,$9 from cfg`,
    [
      creator,
      itemId,
      bindings[0]!.id,
      attemptId,
      state,
      flags.redirect,
      flags.rejection,
      flags.humanReply,
      flags.decline,
    ],
  );
}

beforeAll(async () => {
  if (!hasTestDb) return;
  await setupDatabase();
  for (const id of [USER_A, USER_B]) {
    await adminQuery("insert into auth.users (id, email) values ($1,$2)", [id, `${id}@t.local`]);
  }
  await adminQuery(
    "insert into public.destinations (id, name, slug, type) values ($1,'D08 Coast','d08-coast','city')",
    [DEST],
  );
  await adminQuery(
    `insert into public.hotels (id, name, slug, destination_id) values
       ($1,'D08 Reef','d08-reef',$3),
       ($2,'D08 Dune','d08-dune',$3)`,
    [HOTEL_A, HOTEL_B, DEST],
  );
}, 120_000);

afterAll(async () => {
  if (!hasTestDb) return;
  await teardownDatabase();
});

beforeEach(async () => {
  if (!hasTestDb) return;
  const users = [USER_A, USER_B];
  await adminQuery(
    `delete from public.creator_profile_field_opt_ins
      where creator_id in (select id from public.creator_profiles where user_id = any($1::uuid[]))`,
    [users],
  );
  await adminQuery(
    `delete from public.collaboration_deliverables
      where creator_id in (select id from public.creator_profiles where user_id = any($1::uuid[]))`,
    [users],
  );
  await adminQuery(
    `delete from public.collaboration_agreed_compensations
      where creator_id in (select id from public.creator_profiles where user_id = any($1::uuid[]))`,
    [users],
  );
  await adminQuery(
    `delete from public.pipeline_inbox_readings
      where creator_id in (select id from public.creator_profiles where user_id = any($1::uuid[]))`,
    [users],
  );
  await adminQuery(
    `delete from public.pipeline_inbox_bindings
      where creator_id in (select id from public.creator_profiles where user_id = any($1::uuid[]))`,
    [users],
  );
  await adminQuery(
    `delete from public.outreach_events
      where creator_id in (select id from public.creator_profiles where user_id = any($1::uuid[]))`,
    [users],
  );
  await adminQuery(
    `delete from public.collaborations
      where creator_id in (select id from public.creator_profiles where user_id = any($1::uuid[]))`,
    [users],
  );
  await adminQuery(
    `delete from public.pipeline_items
      where creator_id in (select id from public.creator_profiles where user_id = any($1::uuid[]))`,
    [users],
  );
  await adminQuery(
    `delete from public.trips
      where creator_id in (select id from public.creator_profiles where user_id = any($1::uuid[]))`,
    [users],
  );
  await adminQuery(
    `with cfg as (select set_config('b07.purge', 'on', true) as ok)
     delete from private.gmail_commercial_thread_attempts a
      using cfg
      where a.user_id = any($1::uuid[])`,
    [users],
  );
  await adminQuery("delete from private.gmail_normalized_threads where user_id = any($1::uuid[])", [
    users,
  ]);
  await adminQuery("delete from public.mail_accounts where user_id = any($1::uuid[])", [users]);
});

d("D08 creator-recorded counts", () => {
  it("counts cycles the creator recorded and leaves a real zero at zero", async () => {
    const creator = await creatorId(USER_A);
    const pitched = await insertItem(creator, HOTEL_A, "closed");
    await insertEvent(creator, HOTEL_A, pitched, "pitch_sent");
    await insertEvent(creator, HOTEL_A, pitched, "followup_sent");
    await insertEvent(creator, HOTEL_A, pitched, "reply_received");
    await insertEvent(creator, HOTEL_A, pitched, "positive_reply");
    const other = await insertItem(creator, HOTEL_B, "closed");
    await insertEvent(creator, HOTEL_B, other, "followup_sent");
    const agreed = await insertCollaboration(creator, HOTEL_A, pitched, "completed", "2026-04-02");
    await adminQuery(
      `insert into public.collaboration_deliverables
         (creator_id, collaboration_id, pipeline_item_id, deliverable_type, quantity, status)
       values ($1,$2,$3,'reel',4,'approved'),
              ($1,$2,$3,'story',1,'pending'),
              ($1,$2,$3,'post',1,'submitted'),
              ($1,$2,$3,'photo_set',1,'rejected')`,
      [creator, agreed, pitched],
    );

    const loaded = await counts(USER_A);
    expect(loaded.error).toBeNull();
    expect(loaded.rows[0]!.r).toEqual({
      result: "ok",
      outreach: 2,
      replies: 1,
      agreements: 1,
      completed_collaborations: 1,
      deliverables_done: 1,
    });
    const text = JSON.stringify(loaded.rows[0]!.r);
    expect(text).not.toMatch(/rate|unpaid|amount|ghost|declin/i);
  });

  it("does not count machine readings, silence, redirects, negotiation, or a gmail-sourced pitch", async () => {
    const creator = await creatorId(USER_A);
    await seedMachineReading(USER_A, creator, HOTEL_A, "agreement_observed", {
      redirect: false,
      rejection: false,
      humanReply: true,
      decline: false,
    });
    await seedMachineReading(USER_A, creator, HOTEL_A, "engaged", {
      redirect: true,
      rejection: false,
      humanReply: false,
      decline: false,
    });
    await seedMachineReading(USER_A, creator, HOTEL_A, "declined_observed", {
      redirect: false,
      rejection: true,
      humanReply: false,
      decline: true,
    });
    await seedMachineReading(USER_A, creator, HOTEL_A, null, {
      redirect: false,
      rejection: false,
      humanReply: false,
      decline: false,
    });
    const negotiating = await insertItem(creator, HOTEL_B, "negotiating");
    await insertEvent(creator, HOTEL_B, negotiating, "negotiation_started");
    const gmailPitch = await insertItem(creator, HOTEL_B, "closed");
    await insertEvent(creator, HOTEL_B, gmailPitch, "pitch_sent", "gmail");
    const statusOnly = await insertItem(creator, HOTEL_A, "replied");
    expect(statusOnly).toBeTruthy();

    const loaded = await counts(USER_A);
    expect(loaded.error).toBeNull();
    expect(loaded.rows[0]!.r).toMatchObject({
      result: "ok",
      outreach: 0,
      replies: 0,
      agreements: 0,
      completed_collaborations: 0,
      deliverables_done: 0,
    });
  });

  it("counts a cancelled collaboration as an agreement and not as completed", async () => {
    const creator = await creatorId(USER_A);
    const item = await insertItem(creator, HOTEL_A, "closed");
    const collaborationId = await insertCollaboration(creator, HOTEL_A, item, "cancelled", null);
    await adminQuery(
      `insert into public.collaboration_agreed_compensations
         (creator_id, collaboration_id, pipeline_item_id, structure, payment_status)
       values ($1,$2,$3,'unknown','not_applicable')`,
      [creator, collaborationId, item],
    );
    const loaded = await counts(USER_A);
    expect(loaded.rows[0]!.r).toMatchObject({
      result: "ok",
      agreements: 1,
      completed_collaborations: 0,
    });
    expect(JSON.stringify(loaded.rows[0]!.r)).not.toMatch(/unpaid|amount|0\.0/);
  });

  it("returns nulls, not zeros, when the caller has no profile", async () => {
    const missing = "d0800000-0000-0000-0000-000000000099";
    const loaded = await counts(missing);
    expect(loaded.error).toBeNull();
    expect(loaded.rows[0]!.r).toEqual({
      result: "not_found",
      outreach: null,
      replies: null,
      agreements: null,
      completed_collaborations: null,
      deliverables_done: null,
    });
  });
});

d("D08 past collaborations", () => {
  it("lists terminal rows newest end date first and omits an open agreement", async () => {
    const creator = await creatorId(USER_A);
    const older = await insertItem(creator, HOTEL_A, "closed");
    const newer = await insertItem(creator, HOTEL_B, "closed");
    const open = await insertItem(creator, HOTEL_A, "won");
    await insertCollaboration(creator, HOTEL_A, older, "completed", "2026-01-01");
    await insertCollaboration(creator, HOTEL_B, newer, "cancelled", "2026-06-01");
    await insertCollaboration(creator, HOTEL_A, open, "agreed", null);

    const loaded = await past(USER_A);
    expect(loaded.error).toBeNull();
    const body = loaded.rows[0]!.r;
    expect(body.result).toBe("ok");
    const rows = body.collaborations as { hotel_id: string; status: string }[];
    expect(rows.map((row) => row.status)).toEqual(["cancelled", "completed"]);
    expect(rows.map((row) => row.hotel_id)).toEqual([HOTEL_B, HOTEL_A]);
    expect(JSON.stringify(body)).not.toMatch(/private_value|cash_amount|private_notes/);

    const filtered = await past(USER_A, HOTEL_A);
    const only = (filtered.rows[0]!.r.collaborations as { status: string }[]).map(
      (row) => row.status,
    );
    expect(only).toEqual(["completed"]);
  });

  it("returns null, not an empty list, when the caller has no profile", async () => {
    const loaded = await past("d0800000-0000-0000-0000-000000000099");
    expect(loaded.rows[0]!.r).toEqual({ result: "not_found", collaborations: null });
  });
});

d("D08 profile and count isolation", () => {
  it("lets A edit only A's profile and shows A none of B's numbers", async () => {
    const creatorA = await creatorId(USER_A);
    const creatorB = await creatorId(USER_B);
    await adminQuery("update public.creator_profiles set display_name = 'Owner A' where id = $1", [
      creatorA,
    ]);
    await adminQuery(
      "update public.creator_profiles set display_name = 'Owner B', public_profile_enabled = true where id = $1",
      [creatorB],
    );
    const item = await insertItem(creatorB, HOTEL_B, "closed");
    await insertEvent(creatorB, HOTEL_B, item, "pitch_sent");
    await insertEvent(creatorB, HOTEL_B, item, "reply_received");
    await insertCollaboration(creatorB, HOTEL_B, item, "completed", "2026-05-01");

    const read = await queryAs<{ display_name: string }>(
      { role: "authenticated", sub: USER_A },
      "select display_name from public.creator_profiles where user_id = $1",
      [USER_B],
    );
    expect(read.error).toBeNull();
    expect(read.rows.map((row) => row.display_name)).toEqual(["Owner B"]);

    await adminQuery(
      "update public.creator_profiles set public_profile_enabled = false where id = $1",
      [creatorB],
    );
    const hidden = await queryAs(
      { role: "authenticated", sub: USER_A },
      "select display_name from public.creator_profiles where user_id = $1",
      [USER_B],
    );
    expect(hidden.rows).toEqual([]);

    const anon = await queryAs(
      { role: "anon" },
      "select display_name from public.creator_profiles where user_id = $1",
      [USER_B],
    );
    expect(anon.error).toBeNull();
    expect(anon.rows).toEqual([]);

    const updated = await queryAs(
      { role: "authenticated", sub: USER_A },
      "update public.creator_profiles set display_name = 'stolen' where user_id = $1 returning id",
      [USER_B],
    );
    expect(updated.rows).toEqual([]);
    const still = await adminQuery<{ display_name: string }>(
      "select display_name from public.creator_profiles where user_id = $1",
      [USER_B],
    );
    expect(still[0]!.display_name).toBe("Owner B");

    const inserted = await queryAs(
      { role: "authenticated", sub: USER_A },
      "insert into public.creator_profiles (user_id, display_name) values ($1,'intruder')",
      [USER_B],
    );
    expect(inserted.error).not.toBeNull();

    const deleted = await queryAs(
      { role: "authenticated", sub: USER_A },
      "delete from public.creator_profiles where user_id = $1",
      [USER_B],
    );
    expect(deleted.error).not.toBeNull();

    const aCounts = await counts(USER_A);
    expect(aCounts.rows[0]!.r).toMatchObject({
      result: "ok",
      outreach: 0,
      replies: 0,
      agreements: 0,
      completed_collaborations: 0,
    });
    const bCounts = await counts(USER_B);
    expect(bCounts.rows[0]!.r).toMatchObject({
      outreach: 1,
      replies: 1,
      agreements: 1,
      completed_collaborations: 1,
    });

    const aPast = await past(USER_A, HOTEL_B);
    expect(aPast.rows[0]!.r).toEqual({ result: "ok", collaborations: [] });
    const bPast = await past(USER_B);
    expect((bPast.rows[0]!.r.collaborations as unknown[]).length).toBe(1);

    const anonCounts = await queryAs({ role: "anon" }, "select public.creator_personal_counts()");
    expect(anonCounts.error).not.toBeNull();
    const anonPast = await queryAs(
      { role: "anon" },
      "select public.creator_past_collaborations(null)",
    );
    expect(anonPast.error).not.toBeNull();
  });

  it("keeps field opt-ins private, revocable, and off until the creator opts in", async () => {
    const creatorA = await creatorId(USER_A);
    const creatorB = await creatorId(USER_B);
    const absent = await adminQuery<{ n: string }>(
      "select count(*)::text as n from public.creator_profile_field_opt_ins where creator_id = $1",
      [creatorA],
    );
    expect(absent[0]!.n).toBe("0");

    const ownInsert = await queryAs<{ field_key: string; opted_in: boolean }>(
      { role: "authenticated", sub: USER_A },
      `insert into public.creator_profile_field_opt_ins (creator_id, field_key)
       values ($1, 'niche')
       returning field_key, opted_in`,
      [creatorA],
    );
    expect(ownInsert.error).toBeNull();
    expect(ownInsert.rows).toEqual([{ field_key: "niche", opted_in: false }]);

    await adminQuery(
      `insert into public.creator_profile_field_opt_ins (creator_id, field_key)
       values ($1, 'bio')`,
      [creatorA],
    );
    const named = await adminQuery<{ opted_in: boolean; revoked_at: string | null }>(
      `select opted_in, revoked_at from public.creator_profile_field_opt_ins
        where creator_id = $1 and field_key = 'bio'`,
      [creatorA],
    );
    expect(named[0]).toEqual({ opted_in: false, revoked_at: null });

    await adminQuery(
      `update public.creator_profile_field_opt_ins
          set opted_in = true
        where creator_id = $1 and field_key = 'bio'`,
      [creatorA],
    );
    const stillPrivate = await adminQuery<{ public_profile_enabled: boolean }>(
      "select public_profile_enabled from public.creator_profiles where id = $1",
      [creatorA],
    );
    expect(stillPrivate[0]!.public_profile_enabled).toBe(false);

    const cannotShareWhileRevoked = await queryAs(
      { role: "authenticated", sub: USER_A },
      `update public.creator_profile_field_opt_ins
          set opted_in = true, revoked_at = now()
        where creator_id = $1 and field_key = 'bio'`,
      [creatorA],
    );
    expect(cannotShareWhileRevoked.error).not.toBeNull();

    await adminQuery(
      `update public.creator_profile_field_opt_ins
          set opted_in = false, revoked_at = now()
        where creator_id = $1 and field_key = 'bio'`,
      [creatorA],
    );
    const revoked = await adminQuery<{ opted_in: boolean; revoked_at: string | null }>(
      `select opted_in, revoked_at from public.creator_profile_field_opt_ins
        where creator_id = $1 and field_key = 'bio'`,
      [creatorA],
    );
    expect(revoked[0]!.opted_in).toBe(false);
    expect(revoked[0]!.revoked_at).not.toBeNull();

    const staysRevoked = await queryAs(
      { role: "authenticated", sub: USER_A },
      `update public.creator_profile_field_opt_ins
          set opted_in = true
        where creator_id = $1 and field_key = 'bio'
        returning opted_in`,
      [creatorA],
    );
    expect(staysRevoked.error).not.toBeNull();

    await adminQuery(
      "update public.creator_profiles set public_profile_enabled = true where id = $1",
      [creatorB],
    );
    await adminQuery(
      `insert into public.creator_profile_field_opt_ins (creator_id, field_key, opted_in)
       values ($1, 'bio', true)`,
      [creatorB],
    );

    const seenByA = await queryAs(
      { role: "authenticated", sub: USER_A },
      "select field_key, opted_in from public.creator_profile_field_opt_ins where creator_id = $1",
      [creatorB],
    );
    expect(seenByA.error).toBeNull();
    expect(seenByA.rows).toEqual([]);

    const anon = await queryAs(
      { role: "anon" },
      "select field_key from public.creator_profile_field_opt_ins where creator_id = $1",
      [creatorB],
    );
    expect(anon.error).not.toBeNull();
    expect(anon.rows).toEqual([]);

    const inserted = await queryAs(
      { role: "authenticated", sub: USER_A },
      `insert into public.creator_profile_field_opt_ins (creator_id, field_key, opted_in)
       values ($1, 'social_links', true)`,
      [creatorB],
    );
    expect(inserted.error).not.toBeNull();

    const updated = await queryAs(
      { role: "authenticated", sub: USER_A },
      `update public.creator_profile_field_opt_ins
          set opted_in = false
        where creator_id = $1
        returning field_key`,
      [creatorB],
    );
    expect(updated.rows).toEqual([]);

    const deleted = await queryAs(
      { role: "authenticated", sub: USER_A },
      "delete from public.creator_profile_field_opt_ins where creator_id = $1 returning field_key",
      [creatorB],
    );
    expect(deleted.rows).toEqual([]);

    const stillB = await adminQuery<{ opted_in: boolean }>(
      `select opted_in from public.creator_profile_field_opt_ins
        where creator_id = $1 and field_key = 'bio'`,
      [creatorB],
    );
    expect(stillB[0]!.opted_in).toBe(true);

    const columns = await adminQuery<{ column_name: string }>(
      `select column_name from information_schema.columns
        where table_schema = 'public' and table_name = 'creator_profile_field_opt_ins'`,
    );
    expect(columns.map((column) => column.column_name).join(" ")).not.toMatch(/token|url/i);

    const rls = await adminQuery<{ relrowsecurity: boolean }>(
      `select c.relrowsecurity
         from pg_class c
         join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'public' and c.relname = 'creator_profile_field_opt_ins'`,
    );
    expect(rls[0]!.relrowsecurity).toBe(true);

    const countsForA = await counts(USER_A);
    expect(JSON.stringify(countsForA.rows[0]!.r)).not.toMatch(/opted_in|field_key|token/);
  });

  it("does not let a trip or another creator's rows change A's zeros", async () => {
    const creatorB = await creatorId(USER_B);
    await adminQuery(
      `insert into public.trips (creator_id, destination_id, start_date, end_date, status)
       values ($1,$2,'2026-07-01','2026-07-08','planning')`,
      [creatorB, DEST],
    );
    const loaded = await counts(USER_A);
    expect(loaded.rows[0]!.r).toMatchObject({ result: "ok", outreach: 0, agreements: 0 });
    expect(JSON.stringify(loaded.rows[0]!.r)).not.toMatch(/trip/);
  });
});
