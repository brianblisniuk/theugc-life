/**
 * D09 hotel share link against real Postgres.
 *
 * Anon with a valid token sees only opted-in fields. A revoked, rotated,
 * expired, or invalid token sees nothing, and those misses are identical.
 * User A cannot manage User B's link or opt-ins. A's token never includes
 * B's data. Turning a field off removes it on the next read.
 */
import { createHash } from "node:crypto";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { adminQuery, hasTestDb, queryAs, setupDatabase, teardownDatabase } from "../db/harness";
import { closeSession, endTxPool, openSession } from "../db/tx";

const d = describe.skipIf(!hasTestDb);

const USER_A = "d0900000-0000-0000-0000-000000000001";
const USER_B = "d0900000-0000-0000-0000-000000000002";
const DEST = "d0910000-0000-0000-0000-000000000001";
const HOTEL_A = "d0920000-0000-0000-0000-000000000001";
const HOTEL_B = "d0920000-0000-0000-0000-000000000002";

const NOT_FOUND = { result: "not_found" };
const OPT_KEYS = [
  "audience",
  "bio",
  "compensation",
  "content_examples",
  "niche",
  "past_collaborations",
  "social_links",
] as const;

function optIns(on: string[] = []): string {
  const body: Record<string, boolean> = {};
  for (const key of OPT_KEYS) body[key] = on.includes(key);
  return JSON.stringify(body);
}

async function creatorId(userId: string): Promise<string> {
  const rows = await adminQuery<{ id: string }>(
    "select id from public.creator_profiles where user_id = $1",
    [userId],
  );
  return rows[0]!.id;
}

async function commitCall(userId: string, sql: string, params: unknown[] = []) {
  const client = await openSession("authenticated", userId);
  try {
    const res = await client.query(sql, params);
    await closeSession(client, "commit");
    return res.rows as { r: Record<string, unknown> }[];
  } catch (error) {
    await closeSession(client, "rollback");
    throw error;
  }
}

async function readAsAnon(token: string) {
  return queryAs<{ r: Record<string, unknown> }>(
    { role: "anon" },
    "select public.read_creator_share_profile($1) as r",
    [token],
  );
}

async function insertItem(creator: string, hotelId: string): Promise<string> {
  const rows = await adminQuery<{ id: string }>(
    `insert into public.pipeline_items (creator_id, hotel_id, status, private_notes)
     values ($1, $2, 'closed', 'secret-pipeline-note') returning id`,
    [creator, hotelId],
  );
  return rows[0]!.id;
}

async function insertCollaboration(
  creator: string,
  hotelId: string,
  itemId: string,
  status: string,
): Promise<string> {
  const rows = await adminQuery<{ id: string }>(
    `insert into public.collaborations
       (creator_id, hotel_id, pipeline_item_id, status, collaboration_type, end_date, terms_matched)
     values ($1, $2, $3, $4, 'stay', '2026-04-02', 'unknown')
     returning id`,
    [creator, hotelId, itemId, status],
  );
  return rows[0]!.id;
}

beforeAll(async () => {
  if (!hasTestDb) return;
  await setupDatabase();
  await adminQuery("insert into auth.users (id, email) values ($1, $2), ($3, $4)", [
    USER_A,
    "d09-secret-a@test.local",
    USER_B,
    "d09-secret-b@test.local",
  ]);
  await adminQuery(
    "insert into public.destinations (id, name, slug, type) values ($1, 'D09 Coast', 'd09-coast', 'city')",
    [DEST],
  );
  await adminQuery(
    `insert into public.hotels (id, name, slug, destination_id) values
       ($1, 'Alpha Reef', 'd09-alpha-reef', $3),
       ($2, 'Beta Secret Hotel', 'd09-beta-secret', $3)`,
    [HOTEL_A, HOTEL_B, DEST],
  );
  await adminQuery(
    "insert into public.hotel_contacts (hotel_id, first_name, email) values ($1, 'Secret', 'secret-contact@test.local')",
    [HOTEL_A],
  );
}, 120_000);

afterAll(async () => {
  if (!hasTestDb) return;
  await endTxPool();
  await teardownDatabase();
});

beforeEach(async () => {
  if (!hasTestDb) return;
  const users = [USER_A, USER_B];
  await adminQuery(
    `delete from public.creator_deliverable_share_marks
      where creator_id in (select id from public.creator_profiles where user_id = any($1::uuid[]))`,
    [users],
  );
  await adminQuery(
    `delete from public.creator_collaboration_share_marks
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
    `delete from public.creator_share_links
      where creator_id in (select id from public.creator_profiles where user_id = any($1::uuid[]))`,
    [users],
  );
  await adminQuery(
    `delete from public.creator_profile_field_opt_ins
      where creator_id in (select id from public.creator_profiles where user_id = any($1::uuid[]))`,
    [users],
  );
  await adminQuery(
    `delete from public.creator_self_reported_audience
      where creator_id in (select id from public.creator_profiles where user_id = any($1::uuid[]))`,
    [users],
  );
  await adminQuery(
    `update public.creator_profiles
        set bio = case when user_id = $1 then 'alpha-secret-bio' else 'beta-secret-bio' end,
            creator_niches = case when user_id = $1 then array['hotels'] else array['beta-niche'] end,
            instagram_url = case when user_id = $1 then 'https://instagram.example/alpha' else 'https://instagram.example/beta' end,
            public_profile_enabled = false
      where user_id = any($2::uuid[])`,
    [USER_A, users],
  );
});

d("D09 creator share link", () => {
  it("stores only a digest and shows opted-in fields to anon", async () => {
    const creatorA = await creatorId(USER_A);
    const creatorB = await creatorId(USER_B);
    await commitCall(USER_A, "select public.set_creator_profile_field_opt_ins($1::jsonb) as r", [
      optIns(["bio"]),
    ]);
    const created = await commitCall(USER_A, "select public.create_creator_share_link(null) as r");
    const token = created[0]!.r.token as string;
    expect(token).toMatch(/^[0-9a-f]{64}$/);

    const stored = await adminQuery<{ token_hash: string; columns: string }>(
      `select encode(token_hash, 'hex') as token_hash,
              (select string_agg(column_name, ' ' order by column_name)
                 from information_schema.columns
                where table_schema = 'public' and table_name = 'creator_share_links') as columns
         from public.creator_share_links
        where creator_id = $1`,
      [creatorA],
    );
    expect(stored[0]!.columns).not.toMatch(/\btoken\b/);
    expect(stored[0]!.token_hash).toBe(createHash("sha256").update(token, "utf8").digest("hex"));
    expect(stored[0]!.token_hash).not.toBe(token);

    const itemB = await insertItem(creatorB, HOTEL_B);
    await insertCollaboration(creatorB, HOTEL_B, itemB, "completed");

    const seen = await readAsAnon(token);
    expect(seen.error).toBeNull();
    expect(seen.rows[0]!.r).toEqual({
      result: "ok",
      profile: { bio: "alpha-secret-bio" },
    });
    const text = JSON.stringify(seen.rows[0]!.r);
    expect(text).not.toMatch(
      /beta-secret-bio|beta-niche|secret-contact|secret-pipeline|d09-secret|Beta Secret Hotel/,
    );
    expect(text).not.toMatch(/email|creator_id|token_hash|private_notes|gmail/i);
  });

  it("returns the same not_found for invalid, revoked, rotated, and expired tokens", async () => {
    const created = await commitCall(USER_A, "select public.create_creator_share_link(null) as r");
    const token = created[0]!.r.token as string;
    const rotated = await commitCall(
      USER_A,
      "select public.rotate_creator_share_link($1::timestamptz) as r",
      [new Date(Date.now() + 86_400_000).toISOString()],
    );
    const next = rotated[0]!.r.token as string;
    expect(next).not.toBe(token);

    const invalid = await readAsAnon("ab".repeat(32));
    const malformed = await readAsAnon("not-a-token");
    const old = await readAsAnon(token);
    expect(invalid.rows[0]!.r).toEqual(NOT_FOUND);
    expect(malformed.rows[0]!.r).toEqual(NOT_FOUND);
    expect(old.rows[0]!.r).toEqual(NOT_FOUND);

    await adminQuery(
      `update public.creator_share_links
          set created_at = clock_timestamp() - interval '2 days',
              expires_at = clock_timestamp() - interval '1 minute'
        where token_hash = public.creator_share_token_hash($1)`,
      [next],
    );
    const expired = await readAsAnon(next);
    expect(expired.rows[0]!.r).toEqual(NOT_FOUND);

    await adminQuery(
      `update public.creator_share_links
          set expires_at = clock_timestamp() + interval '1 day',
              revoked_at = clock_timestamp()
        where token_hash = public.creator_share_token_hash($1)`,
      [next],
    );
    const revoked = await readAsAnon(next);
    expect(revoked.rows[0]!.r).toEqual(invalid.rows[0]!.r);
    expect(revoked.rows[0]!.r).toEqual(old.rows[0]!.r);
    expect(revoked.rows[0]!.r).toEqual(expired.rows[0]!.r);
  });

  it("keeps User B from creating, reading, or revoking A's link and opt-ins", async () => {
    await commitCall(USER_A, "select public.set_creator_profile_field_opt_ins($1::jsonb) as r", [
      optIns(["bio", "niche"]),
    ]);
    const created = await commitCall(USER_A, "select public.create_creator_share_link(null) as r");
    const token = created[0]!.r.token as string;
    const creatorA = await creatorId(USER_A);

    const bOwn = await queryAs<{ r: Record<string, unknown> }>(
      { role: "authenticated", sub: USER_B },
      "select public.read_own_creator_share_link() as r",
    );
    expect(bOwn.rows[0]!.r).toEqual({ result: "none" });

    const bRevoke = await commitCall(USER_B, "select public.revoke_creator_share_link() as r");
    expect(bRevoke[0]!.r).toEqual(NOT_FOUND);
    const still = await readAsAnon(token);
    expect(still.rows[0]!.r).toEqual({
      result: "ok",
      profile: { bio: "alpha-secret-bio", niche: ["hotels"] },
    });

    const bReadRow = await queryAs(
      { role: "authenticated", sub: USER_B },
      "select id from public.creator_share_links where creator_id = $1",
      [creatorA],
    );
    expect(bReadRow.rows).toEqual([]);

    const bOpt = await queryAs(
      { role: "authenticated", sub: USER_B },
      "select field_key from public.creator_profile_field_opt_ins where creator_id = $1",
      [creatorA],
    );
    expect(bOpt.rows).toEqual([]);

    const bWrite = await queryAs(
      { role: "authenticated", sub: USER_B },
      `insert into public.creator_profile_field_opt_ins (creator_id, field_key, opted_in)
       values ($1, 'bio', false)`,
      [creatorA],
    );
    expect(bWrite.error).not.toBeNull();

    const anonTables = [
      "creator_share_links",
      "creator_profile_field_opt_ins",
      "creator_self_reported_audience",
      "creator_collaboration_share_marks",
      "creator_deliverable_share_marks",
    ];
    for (const table of anonTables) {
      const anon = await queryAs({ role: "anon" }, `select 1 from public.${table}`);
      expect(anon.error, table).not.toBeNull();
    }
    const anonCreate = await queryAs(
      { role: "anon" },
      "select public.create_creator_share_link(null)",
    );
    expect(anonCreate.error).not.toBeNull();
    const anonHash = await queryAs(
      { role: "anon" },
      "select public.creator_share_token_hash('abc')",
    );
    expect(anonHash.error).not.toBeNull();
  });

  it("drops a field as soon as it is turned off, and never turns unknown into zero", async () => {
    await commitCall(USER_A, "select public.set_creator_self_reported_audience($1, $2) as r", [
      null,
      null,
    ]);
    await commitCall(USER_A, "select public.set_creator_profile_field_opt_ins($1::jsonb) as r", [
      optIns(["bio", "audience"]),
    ]);
    const created = await commitCall(USER_A, "select public.create_creator_share_link(null) as r");
    const token = created[0]!.r.token as string;

    const withAudience = await readAsAnon(token);
    expect(withAudience.rows[0]!.r).toEqual({
      result: "ok",
      profile: {
        bio: "alpha-secret-bio",
        audience: { followers: null, engagement: null, attribution: "self_reported" },
      },
    });
    expect(JSON.stringify(withAudience.rows[0]!.r)).not.toMatch(/"followers":0/);

    await commitCall(USER_A, "select public.set_creator_profile_field_opt_ins($1::jsonb) as r", [
      optIns(["audience"]),
    ]);
    const bioOff = await readAsAnon(token);
    expect(bioOff.rows[0]!.r).toEqual({
      result: "ok",
      profile: {
        audience: { followers: null, engagement: null, attribution: "self_reported" },
      },
    });

    await commitCall(USER_A, "select public.set_creator_self_reported_audience($1, $2) as r", [
      0,
      "about 3 percent",
    ]);
    const recordedZero = await readAsAnon(token);
    expect(recordedZero.rows[0]!.r).toEqual({
      result: "ok",
      profile: {
        audience: { followers: 0, engagement: "about 3 percent", attribution: "self_reported" },
      },
    });
  });

  it("shares only marked past collaborations and marked proof, and hides compensation until opted in", async () => {
    const creatorA = await creatorId(USER_A);
    const creatorB = await creatorId(USER_B);
    const itemA = await insertItem(creatorA, HOTEL_A);
    const itemActive = await insertItem(creatorA, HOTEL_A);
    const past = await insertCollaboration(creatorA, HOTEL_A, itemA, "completed");
    const active = await insertCollaboration(creatorA, HOTEL_A, itemActive, "active");
    const itemB = await insertItem(creatorB, HOTEL_B);
    const other = await insertCollaboration(creatorB, HOTEL_B, itemB, "completed");

    await adminQuery(
      `insert into public.collaboration_agreed_compensations
         (creator_id, collaboration_id, pipeline_item_id, structure, payment_status)
       values ($1, $2, $3, 'unknown', 'not_applicable')`,
      [creatorA, past, itemA],
    );
    const deliverables = await adminQuery<{ id: string }>(
      `insert into public.collaboration_deliverables
         (creator_id, collaboration_id, pipeline_item_id, deliverable_type, quantity, status, proof_url, notes)
       values
         ($1, $2, $3, 'reel', 2, 'approved', 'https://cdn.example/alpha-reel', 'secret-deliverable-note'),
         ($1, $2, $3, 'story', 1, 'approved', null, 'secret-hidden-note')
       returning id`,
      [creatorA, past, itemA],
    );
    const withProof = deliverables[0]!.id;
    const withoutProof = deliverables[1]!.id;

    await commitCall(USER_A, "select public.set_creator_profile_field_opt_ins($1::jsonb) as r", [
      optIns(["past_collaborations", "content_examples", "compensation"]),
    ]);
    const created = await commitCall(USER_A, "select public.create_creator_share_link(null) as r");
    const token = created[0]!.r.token as string;

    const unmarked = await readAsAnon(token);
    expect(unmarked.rows[0]!.r).toEqual({
      result: "ok",
      profile: { past_collaborations: [], content_examples: [] },
    });

    const markActive = await commitCall(
      USER_A,
      "select public.set_collaboration_share_mark($1, true) as r",
      [active],
    );
    expect(markActive[0]!.r.result).toBe("invalid_input");

    const markOther = await commitCall(
      USER_A,
      "select public.set_collaboration_share_mark($1, true) as r",
      [other],
    );
    expect(markOther[0]!.r).toEqual(NOT_FOUND);

    await commitCall(USER_A, "select public.set_collaboration_share_mark($1, true) as r", [past]);
    await commitCall(USER_A, "select public.set_deliverable_share_mark($1, true) as r", [
      withProof,
    ]);
    await commitCall(USER_A, "select public.set_deliverable_share_mark($1, true) as r", [
      withoutProof,
    ]);

    const shared = await readAsAnon(token);
    const profile = shared.rows[0]!.r.profile as {
      past_collaborations: Record<string, unknown>[];
      content_examples: Record<string, unknown>[];
    };
    expect(profile.past_collaborations).toEqual([
      {
        hotel_name: "Alpha Reef",
        status: "completed",
        collaboration_type: "stay",
        start_date: null,
        end_date: "2026-04-02",
        compensation: { structure: "unknown" },
      },
    ]);
    expect(profile.content_examples).toEqual([
      {
        deliverable_type: "reel",
        platform: null,
        proof_url: "https://cdn.example/alpha-reel",
      },
    ]);
    const sharedText = JSON.stringify(shared.rows[0]!.r);
    expect(sharedText).not.toMatch(
      /secret-deliverable-note|secret-pipeline-note|secret-contact|Beta Secret Hotel|cash_amount/,
    );

    await commitCall(USER_A, "select public.set_creator_profile_field_opt_ins($1::jsonb) as r", [
      optIns(["past_collaborations", "content_examples"]),
    ]);
    const compensationOff = await readAsAnon(token);
    expect(JSON.stringify(compensationOff.rows[0]!.r)).not.toMatch(/compensation|unknown/);

    await commitCall(USER_A, "select public.set_collaboration_share_mark($1, false) as r", [past]);
    const unmarkedAgain = await readAsAnon(token);
    const after = unmarkedAgain.rows[0]!.r.profile as { past_collaborations: unknown[] };
    expect(after.past_collaborations).toEqual([]);
  });

  it("rejects a second active link and an unknown field key without writing it", async () => {
    const first = await commitCall(USER_A, "select public.create_creator_share_link(null) as r");
    expect(first[0]!.r.result).toBe("created");
    const second = await commitCall(USER_A, "select public.create_creator_share_link(null) as r");
    expect(second[0]!.r).toEqual({ result: "active_link_exists" });

    const creatorA = await creatorId(USER_A);
    const bad = await commitCall(
      USER_A,
      "select public.set_creator_profile_field_opt_ins($1::jsonb) as r",
      [JSON.stringify({ bio: true, display_name: true })],
    );
    expect(bad[0]!.r).toEqual({ result: "invalid_input" });
    const rows = await adminQuery<{ n: string }>(
      "select count(*)::text as n from public.creator_profile_field_opt_ins where creator_id = $1",
      [creatorA],
    );
    expect(rows[0]!.n).toBe("0");

    const direct = await queryAs(
      { role: "authenticated", sub: USER_A },
      `insert into public.creator_profile_field_opt_ins (creator_id, field_key)
       values ($1, 'display_name')`,
      [creatorA],
    );
    expect(direct.error).not.toBeNull();
  });
});
