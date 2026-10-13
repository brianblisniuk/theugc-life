/**
 * G03 travel portfolio against real Postgres (D125).
 *
 * User A cannot read or write User B's layout or approvals. Anon has no table
 * privilege. The share link adds a portfolio only after an explicit publish
 * and a chosen layout, and that object has no compensation, contact, or note.
 * A Gmail detection never becomes a suggestion. A missing profile is null.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  adminQuery,
  commitAs,
  hasTestDb,
  queryAs,
  setupDatabase,
  teardownDatabase,
} from "../db/harness";
import { closeSession, endTxPool, openSession } from "../db/tx";

const d = describe.skipIf(!hasTestDb);

const USER_A = "a0300000-0000-4000-8000-000000000001";
const USER_B = "a0300000-0000-4000-8000-000000000002";
const USER_C = "a0300000-0000-4000-8000-000000000003";
const DEST_ALPHA = "a0310000-0000-4000-8000-000000000001";
const DEST_ZULU = "a0310000-0000-4000-8000-000000000002";
const HOTEL_REEF = "a0320000-0000-4000-8000-000000000001";
const HOTEL_COVE = "a0320000-0000-4000-8000-000000000002";
const HOTEL_AGREED = "a0320000-0000-4000-8000-000000000003";
const HOTEL_CANCELLED = "a0320000-0000-4000-8000-000000000004";
const HOTEL_DISMISSED = "a0320000-0000-4000-8000-000000000005";
const HOTEL_GMAIL = "a0320000-0000-4000-8000-000000000006";
const HOTEL_BETA = "a0320000-0000-4000-8000-000000000007";

const LEAK_EMAIL = "g03-leak-contact@hotel.test";
const LEAK_NOTE = "g03-private-note-secret";
const LEAK_THREAD = "g03-secret-thread";
const LEAK_AMOUNT = "864201";

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

async function insertItem(creator: string, hotelId: string, notes: string): Promise<string> {
  const rows = await adminQuery<{ id: string }>(
    `insert into public.pipeline_items (creator_id, hotel_id, status, private_notes)
     values ($1, $2, 'won', $3) returning id`,
    [creator, hotelId, notes],
  );
  return rows[0]!.id;
}

async function insertCollaboration(
  creator: string,
  hotelId: string,
  itemId: string,
  status: string,
  endDate: string,
): Promise<string> {
  const rows = await adminQuery<{ id: string }>(
    `insert into public.collaborations
       (creator_id, hotel_id, pipeline_item_id, status, collaboration_type,
        start_date, end_date, terms_matched, private_value_amount, private_value_currency)
     values ($1, $2, $3, $4, 'stay', '2026-01-02', $5, 'unknown', 864201, 'USD')
     returning id`,
    [creator, hotelId, itemId, status, endDate],
  );
  return rows[0]!.id;
}

beforeAll(async () => {
  if (!hasTestDb) return;
  await setupDatabase();
  await adminQuery("insert into auth.users (id, email) values ($1, $2), ($3, $4), ($5, $6)", [
    USER_A,
    "g03-a@test.local",
    USER_B,
    "g03-b@test.local",
    USER_C,
    "g03-c@test.local",
  ]);
  await adminQuery(
    `insert into public.destinations (id, name, slug, type) values
       ($1, 'Alpha Bay', 'g03-alpha-bay', 'city'),
       ($2, 'Zulu Coast', 'g03-zulu-coast', 'city')`,
    [DEST_ALPHA, DEST_ZULU],
  );
  await adminQuery(
    `insert into public.hotels (id, name, slug, destination_id) values
       ($1, 'Public Reef', 'g03-public-reef', $8),
       ($2, 'Active Cove', 'g03-active-cove', $9),
       ($3, 'Agreed Secret', 'g03-agreed-secret', $8),
       ($4, 'Cancelled Stay', 'g03-cancelled-stay', $8),
       ($5, 'Dismissed Inn', 'g03-dismissed-inn', $8),
       ($6, 'Gmail Only Hotel', 'g03-gmail-only', $8),
       ($7, 'Beta Secret Hotel', 'g03-beta-secret', $9)`,
    [
      HOTEL_REEF,
      HOTEL_COVE,
      HOTEL_AGREED,
      HOTEL_CANCELLED,
      HOTEL_DISMISSED,
      HOTEL_GMAIL,
      HOTEL_BETA,
      DEST_ALPHA,
      DEST_ZULU,
    ],
  );
  await adminQuery(
    "insert into public.hotel_contacts (hotel_id, first_name, email) values ($1, 'Leak', $2)",
    [HOTEL_REEF, LEAK_EMAIL],
  );
}, 120_000);

afterAll(async () => {
  if (!hasTestDb) return;
  await endTxPool();
  await teardownDatabase();
});

let creatorA = "";
let creatorB = "";
let reefId = "";
let coveId = "";
let agreedId = "";
let cancelledId = "";
let dismissedId = "";
let betaId = "";

beforeEach(async () => {
  if (!hasTestDb) return;
  const users = [USER_A, USER_B];
  await adminQuery(
    `delete from public.creator_portfolio_entries
      where creator_id in (select id from public.creator_profiles where user_id = any($1::uuid[]))`,
    [users],
  );
  await adminQuery(
    `delete from public.creator_portfolio_settings
      where creator_id in (select id from public.creator_profiles where user_id = any($1::uuid[]))`,
    [users],
  );
  await adminQuery(
    `delete from public.gmail_collaboration_suggestions
      where creator_id in (select id from public.creator_profiles where user_id = any($1::uuid[]))`,
    [users],
  );
  await adminQuery(
    `delete from public.pipeline_inbox_bindings
      where creator_id in (select id from public.creator_profiles where user_id = any($1::uuid[]))`,
    [users],
  );
  await adminQuery(`delete from private.gmail_normalized_threads where user_id = any($1::uuid[])`, [
    users,
  ]);
  await adminQuery(`delete from public.mail_accounts where user_id = any($1::uuid[])`, [users]);
  await adminQuery(
    `delete from public.collaboration_agreed_compensations
      where creator_id in (select id from public.creator_profiles where user_id = any($1::uuid[]))`,
    [users],
  );
  await adminQuery(
    `delete from public.creator_collaboration_share_marks
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
    `update public.creator_profiles
        set public_profile_enabled = false, portfolio_visibility = 'private', username = 'g03alpha'
      where user_id = $1`,
    [USER_A],
  );

  creatorA = await creatorId(USER_A);
  creatorB = await creatorId(USER_B);
  const reefItem = await insertItem(creatorA, HOTEL_REEF, LEAK_NOTE);
  const coveItem = await insertItem(creatorA, HOTEL_COVE, LEAK_NOTE);
  const agreedItem = await insertItem(creatorA, HOTEL_AGREED, LEAK_NOTE);
  const cancelledItem = await insertItem(creatorA, HOTEL_CANCELLED, LEAK_NOTE);
  const dismissedItem = await insertItem(creatorA, HOTEL_DISMISSED, LEAK_NOTE);
  const gmailItem = await insertItem(creatorA, HOTEL_GMAIL, LEAK_NOTE);
  const betaItem = await insertItem(creatorB, HOTEL_BETA, "beta-private-note");
  reefId = await insertCollaboration(creatorA, HOTEL_REEF, reefItem, "completed", "2026-08-01");
  coveId = await insertCollaboration(creatorA, HOTEL_COVE, coveItem, "active", "2026-09-01");
  agreedId = await insertCollaboration(creatorA, HOTEL_AGREED, agreedItem, "agreed", "2026-05-01");
  cancelledId = await insertCollaboration(
    creatorA,
    HOTEL_CANCELLED,
    cancelledItem,
    "cancelled",
    "2026-02-01",
  );
  dismissedId = await insertCollaboration(
    creatorA,
    HOTEL_DISMISSED,
    dismissedItem,
    "completed",
    "2026-04-01",
  );
  betaId = await insertCollaboration(creatorB, HOTEL_BETA, betaItem, "completed", "2026-07-01");
  await adminQuery(
    `insert into public.collaboration_agreed_compensations
       (creator_id, collaboration_id, pipeline_item_id, structure, cash_amount_minor, cash_currency, payment_status)
     values ($1, $2, $3, 'paid', 864201, 'USD', 'pending')`,
    [creatorA, reefId, reefItem],
  );

  const mail = await adminQuery<{ id: string }>(
    `insert into public.mail_accounts (user_id, provider, provider_account_subject, email_address)
     values ($1, 'gmail', 'g03-subject', 'g03-mailbox@test.local') returning id`,
    [USER_A],
  );
  const mailId = mail[0]!.id;
  await adminQuery(
    `insert into private.gmail_normalized_threads (user_id, mail_account_id, provider_thread_id)
     values ($1, $2, $3)`,
    [USER_A, mailId, LEAK_THREAD],
  );
  const binding = await adminQuery<{ id: string }>(
    `with cfg as (select set_config('inbox_pipeline.writer', 'bind', true))
     insert into public.pipeline_inbox_bindings
       (creator_id, pipeline_item_id, mail_account_id, provider_thread_id)
     select $1, $2, $3, $4 from cfg
     returning id`,
    [creatorA, gmailItem, mailId, LEAK_THREAD],
  );
  const attempt = "a0330000-0000-4000-8000-000000000099";
  await adminQuery(
    `with cfg as (select set_config('gmail_collab.writer', 'refresh', true))
     insert into public.gmail_collaboration_suggestions (
       creator_id, pipeline_item_id, binding_id, mail_account_id, provider_thread_id,
       kind, status, classifier, evidence_key,
       pitch_at, reply_at, pitch_message_id, reply_message_id, commercial_state, source_attempt_id
     )
     select $1, $2, $3, $4, $5,
            'collaboration', 'pending', 'heuristic',
            'g03-pitch' || '|' || 'g03-reply' || '|' || $6::uuid::text,
            now(), now(), 'g03-pitch', 'g03-reply', 'agreement_observed', $6::uuid
       from cfg`,
    [creatorA, gmailItem, binding[0]!.id, mailId, LEAK_THREAD, attempt],
  );
  await adminQuery(
    `with cfg as (select set_config('gmail_collab.writer', 'confirm', true))
     update public.gmail_collaboration_suggestions
        set status = 'confirmed'
       from cfg
      where creator_id = $1 and kind = 'collaboration'`,
    [creatorA],
  );
});

async function ownPortfolio(userId: string) {
  const rows = await commitCall(userId, "select public.read_own_creator_portfolio() as r");
  return rows[0]!.r;
}

function names(list: unknown): string[] {
  return (list as { hotel_name: string }[]).map((row) => row.hotel_name);
}

d("G03 travel portfolio", () => {
  it("suggests confirmed collaborations and never a Gmail detection", async () => {
    const portfolio = await ownPortfolio(USER_A);
    expect(portfolio).not.toBeNull();
    expect(portfolio.template).toBeNull();
    expect(names(portfolio.suggestions).sort()).toEqual(
      ["Active Cove", "Agreed Secret", "Dismissed Inn", "Public Reef"].sort(),
    );
    const blob = JSON.stringify(portfolio);
    expect(blob).not.toContain("Gmail Only Hotel");
    expect(blob).not.toContain("Cancelled Stay");
    expect(blob).not.toContain("Beta Secret Hotel");
    expect(blob).not.toContain(LEAK_EMAIL);
    expect(blob).not.toContain(LEAK_NOTE);
    expect(blob).not.toContain(LEAK_THREAD);
    expect(blob).not.toContain(LEAK_AMOUNT);
    expect(blob).not.toContain("compensation");
    expect(portfolio.published).toEqual([]);
    expect(portfolio.dismissed).toEqual([]);
  });

  it("returns null when the caller has no profile, not an empty list", async () => {
    await adminQuery("delete from public.creator_profiles where user_id = $1", [USER_C]);
    const rows = await commitCall(USER_C, "select public.read_own_creator_portfolio() as r");
    expect(rows[0]!.r).toBeNull();
    await adminQuery("insert into public.creator_profiles (user_id) values ($1)", [USER_C]);
  });

  it("keeps anon and the other creator off the tables and the writes", async () => {
    await commitCall(USER_B, "select public.publish_creator_portfolio_entry($1) as r", [betaId]);
    const anonRead = await queryAs({ role: "anon" }, "select public.read_own_creator_portfolio()");
    expect(anonRead.error).not.toBeNull();
    const anonWrite = await queryAs(
      { role: "anon" },
      "select public.publish_creator_portfolio_entry($1)",
      [reefId],
    );
    expect(anonWrite.error).not.toBeNull();

    const seen = await queryAs(
      { role: "authenticated", sub: USER_A },
      "select collaboration_id from public.creator_portfolio_entries where creator_id = $1",
      [creatorB],
    );
    expect(seen.error).toBeNull();
    expect(seen.rows).toEqual([]);
    expect(JSON.stringify(seen.rows)).not.toContain(betaId);

    const inserted = await queryAs(
      { role: "authenticated", sub: USER_A },
      `insert into public.creator_portfolio_entries (creator_id, collaboration_id, decision)
       values ($1, $2, 'published')`,
      [creatorA, reefId],
    );
    expect(inserted.error).not.toBeNull();

    const crossed = await commitCall(
      USER_A,
      "select public.publish_creator_portfolio_entry($1) as r",
      [betaId],
    );
    expect(crossed[0]!.r).toEqual({ result: "not_found" });
    const betaRows = await adminQuery<{ n: string }>(
      "select count(*)::text as n from public.creator_portfolio_entries where creator_id = $1",
      [creatorB],
    );
    expect(betaRows[0]!.n).toBe("1");

    const updated = await queryAs(
      { role: "authenticated", sub: USER_A },
      "update public.creator_portfolio_entries set decision = 'dismissed' where creator_id = $1",
      [creatorB],
    );
    expect(updated.error).not.toBeNull();
    const still = await adminQuery<{ decision: string }>(
      "select decision from public.creator_portfolio_entries where collaboration_id = $1",
      [betaId],
    );
    expect(still[0]!.decision).toBe("published");
  });

  it("refuses a cancelled collaboration and a direct row for one", async () => {
    const refused = await commitCall(
      USER_A,
      "select public.publish_creator_portfolio_entry($1) as r",
      [cancelledId],
    );
    expect(refused[0]!.r).toEqual({ result: "not_confirmed" });
    await expect(
      adminQuery(
        `insert into public.creator_portfolio_entries (creator_id, collaboration_id, decision)
         values ($1, $2, 'published')`,
        [creatorA, cancelledId],
      ),
    ).rejects.toThrow(/confirmed/i);
  });

  it("shows a published portfolio on the share link only after a layout is chosen", async () => {
    expect(
      (
        await commitCall(USER_A, "select public.publish_creator_portfolio_entry($1) as r", [reefId])
      )[0]!.r,
    ).toEqual({ result: "published" });
    expect(
      (
        await commitCall(USER_A, "select public.publish_creator_portfolio_entry($1) as r", [coveId])
      )[0]!.r,
    ).toEqual({ result: "published" });
    expect(
      (
        await commitCall(USER_A, "select public.dismiss_creator_portfolio_entry($1) as r", [
          dismissedId,
        ])
      )[0]!.r,
    ).toEqual({ result: "dismissed" });
    const badTemplate = await commitCall(
      USER_A,
      "select public.set_creator_portfolio_template($1) as r",
      ["ranked"],
    );
    expect(badTemplate[0]!.r).toEqual({ result: "invalid_input" });

    const created = await commitCall(USER_A, "select public.create_creator_share_link(null) as r");
    const token = created[0]!.r.token as string;
    const before = await queryAs<{ r: Record<string, unknown> }>(
      { role: "anon" },
      "select public.read_creator_share_profile($1) as r",
      [token],
    );
    const beforeProfile = (before.rows[0]!.r.profile ?? {}) as Record<string, unknown>;
    expect(beforeProfile.portfolio).toBeUndefined();
    expect(JSON.stringify(before.rows[0]!.r)).not.toContain("Public Reef");

    await commitCall(USER_A, "select public.set_creator_portfolio_template($1) as r", ["journey"]);
    const after = await queryAs<{ r: { profile: Record<string, unknown> } }>(
      { role: "anon" },
      "select public.read_creator_share_profile($1) as r",
      [token],
    );
    const portfolio = after.rows[0]!.r.profile.portfolio as {
      template: string;
      entries: Record<string, unknown>[];
    };
    expect(portfolio.template).toBe("journey");
    expect(portfolio.entries.map((entry) => entry.hotel_name)).toEqual([
      "Active Cove",
      "Public Reef",
    ]);
    const shown = JSON.stringify(portfolio);
    expect(shown).not.toContain("Agreed Secret");
    expect(shown).not.toContain("Dismissed Inn");
    expect(shown).not.toContain("Cancelled Stay");
    expect(shown).not.toContain("Beta Secret Hotel");
    expect(shown).not.toContain("Gmail Only Hotel");
    expect(shown).not.toContain(LEAK_EMAIL);
    expect(shown).not.toContain(LEAK_NOTE);
    expect(shown).not.toContain(LEAK_THREAD);
    expect(shown).not.toContain(LEAK_AMOUNT);
    expect(shown).not.toContain("compensation");
    expect(shown).not.toContain("collaboration_id");
    expect(after.rows[0]!.r.profile.past_collaborations).toBeUndefined();

    const opted = await commitCall(
      USER_A,
      "select public.set_creator_profile_field_opt_ins($1::jsonb) as r",
      [
        JSON.stringify({
          audience: false,
          bio: false,
          compensation: true,
          content_examples: false,
          niche: false,
          past_collaborations: true,
          social_links: false,
        }),
      ],
    );
    expect(opted[0]!.r.result).toBe("saved");
    await commitCall(USER_A, "select public.set_collaboration_share_mark($1, true) as r", [reefId]);
    await commitCall(USER_A, "select public.set_collaboration_share_mark($1, true) as r", [
      cancelledId,
    ]);
    const mixed = await queryAs<{ r: { profile: Record<string, unknown> } }>(
      { role: "anon" },
      "select public.read_creator_share_profile($1) as r",
      [token],
    );
    const past = mixed.rows[0]!.r.profile.past_collaborations as { hotel_name: string }[];
    expect(past.map((row) => row.hotel_name).sort()).toEqual(["Cancelled Stay", "Public Reef"]);
    expect(JSON.stringify(past)).toContain(LEAK_AMOUNT);
    const stillPortfolio = mixed.rows[0]!.r.profile.portfolio as {
      entries: Record<string, unknown>[];
    };
    expect(JSON.stringify(stillPortfolio)).not.toContain(LEAK_AMOUNT);
    expect(JSON.stringify(stillPortfolio)).not.toContain("Cancelled Stay");

    await commitCall(USER_A, "select public.set_creator_portfolio_template($1) as r", [
      "destinations",
    ]);
    const grouped = await queryAs<{
      r: { profile: { portfolio: { entries: { hotel_name: string }[] } } };
    }>({ role: "anon" }, "select public.read_creator_share_profile($1) as r", [token]);
    expect(grouped.rows[0]!.r.profile.portfolio.entries.map((entry) => entry.hotel_name)).toEqual([
      "Public Reef",
      "Active Cove",
    ]);

    await adminQuery("update public.collaborations set status = 'cancelled' where id = $1", [
      coveId,
    ]);
    const withheld = await ownPortfolio(USER_A);
    expect(names(withheld.published)).toEqual(["Public Reef"]);
    expect(names(withheld.withheld)).toEqual(["Active Cove"]);
    const afterCancel = await queryAs<{
      r: { profile: { portfolio: { entries: { hotel_name: string }[] } } };
    }>({ role: "anon" }, "select public.read_creator_share_profile($1) as r", [token]);
    expect(
      afterCancel.rows[0]!.r.profile.portfolio.entries.map((entry) => entry.hotel_name),
    ).toEqual(["Public Reef"]);

    const flags = await adminQuery<{
      portfolio_visibility: string;
      public_profile_enabled: boolean;
    }>(
      "select portfolio_visibility, public_profile_enabled from public.creator_profiles where id = $1",
      [creatorA],
    );
    expect(flags[0]).toEqual({ portfolio_visibility: "private", public_profile_enabled: false });

    await adminQuery(
      "update public.creator_profiles set public_profile_enabled = true where id = $1",
      [creatorA],
    );
    const card = await queryAs<{ r: unknown }>(
      { role: "anon" },
      "select public.read_public_creator_card($1) as r",
      ["g03alpha"],
    );
    const cardText = JSON.stringify(card.rows[0]!.r);
    expect(cardText).not.toContain("Public Reef");
    expect(cardText).not.toContain("Active Cove");
    expect(cardText).not.toContain(LEAK_EMAIL);
    expect(cardText).not.toContain(LEAK_AMOUNT);
    expect(cardText).not.toContain("portfolio");
  });

  it("pins the owner read and keeps anon off it", async () => {
    const rows = await adminQuery<{
      definer: boolean;
      pinned: boolean;
      anon: boolean;
      auth: boolean;
    }>(
      `select p.prosecdef as definer,
              coalesce(array_to_string(p.proconfig, ','), '') = 'search_path=""' as pinned,
              has_function_privilege('anon', p.oid, 'EXECUTE') as anon,
              has_function_privilege('authenticated', p.oid, 'EXECUTE') as auth
         from pg_proc p
         join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public' and p.proname = 'read_own_creator_portfolio'`,
    );
    expect(rows[0]).toEqual({ definer: false, pinned: true, anon: false, auth: true });
  });
});
