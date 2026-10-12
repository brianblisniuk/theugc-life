/**
 * The rows the first-flow checklist and the new lists read are already
 * owner-scoped. User A, signed in, does not receive User B's trip, pipeline
 * item, collaboration, mailbox, or inbox link.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { adminQuery, hasTestDb, queryAs, setupDatabase, teardownDatabase } from "../db/harness";
import { HOTEL, TRIP, USERS, seed, type CreatorIds } from "../rls/seed";

const d = describe.skipIf(!hasTestDb);

const MAIL_A = "a1000000-0000-0000-0000-000000000001";
const MAIL_B = "a1000000-0000-0000-0000-000000000002";
const COLL_A = "c1000000-0000-0000-0000-000000000001";
const COLL_B = "c1000000-0000-0000-0000-000000000002";

let creators: CreatorIds;
let itemA = "";
let itemB = "";

beforeAll(async () => {
  if (!hasTestDb) return;
  await setupDatabase();
  creators = await seed();
  const items = await adminQuery<{ id: string; creator_id: string }>(
    "select id, creator_id from public.pipeline_items where creator_id = any($1::uuid[])",
    [[creators.destBali, creators.pro]],
  );
  itemA = items.find((row) => row.creator_id === creators.destBali)?.id ?? "";
  itemB = items.find((row) => row.creator_id === creators.pro)?.id ?? "";
  expect(itemA).not.toBe("");
  expect(itemB).not.toBe("");

  await adminQuery(
    `insert into public.collaborations (id, creator_id, hotel_id, status)
     values ($1, $2, $3, 'agreed'), ($4, $5, $6, 'active')`,
    [COLL_A, creators.destBali, HOTEL.bali, COLL_B, creators.pro, HOTEL.ibiza],
  );

  // `connected` is one fact with its credential and its private-processing
  // consent. Those checks are deferred to commit, so they have to land in
  // the same statement. Placeholder ciphertext is not a secret and is never
  // decrypted. The scope is the existing read-only grant, not gmail.send.
  const readonlyScope = "https://www.googleapis.com/auth/gmail.readonly";
  await adminQuery(
    `with accounts as (
       insert into public.mail_accounts (
         id, user_id, provider, provider_account_subject, email_address,
         connection_state, granted_scopes, connected_at
       ) values
         ($1, $2, 'gmail', 'sub-a', 'ada@example.com', 'connected',
          array[$5]::text[], now()),
         ($3, $4, 'gmail', 'sub-b', 'bee-secret@example.com', 'connected',
          array[$5]::text[], now())
       returning id, user_id
     ),
     creds as (
       insert into private.gmail_oauth_credentials (
         mail_account_id, user_id, refresh_token_ciphertext, refresh_token_iv,
         refresh_token_auth_tag, encryption_key_version
       )
       select id, user_id, 'fixture-ciphertext', 'fixture-iv', 'fixture-tag', 'v1'
         from accounts
       returning mail_account_id
     ),
     receipts as (
       insert into public.mail_account_consent_receipts (
         mail_account_id, user_id, consent_kind, decision, policy_version,
         consent_text_digest, granted_scopes_at_decision, decided_by_user_id,
         decided_at, receipt_digest
       )
       select id, user_id, 'private_gmail_processing', 'granted', 'gmail-consent/1',
              repeat('a', 64), array[$5]::text[], user_id, now(),
              md5(id::text) || md5(user_id::text)
         from accounts
       returning id, mail_account_id, user_id, event_seq
     )
     insert into public.mail_account_consents (
       mail_account_id, user_id, consent_kind, state, current_receipt_id, current_event_seq
     )
     select mail_account_id, user_id, 'private_gmail_processing', 'granted', id, event_seq
       from receipts
      where (select count(*) from creds) = 2`,
    [MAIL_A, USERS.destBali, MAIL_B, USERS.pro, readonlyScope],
  );

  await adminQuery(
    `insert into private.gmail_normalized_threads (
       user_id, mail_account_id, provider_thread_id
     ) values
       ($1, $2, 'thread-a'),
       ($3, $4, 'thread-b')`,
    [USERS.destBali, MAIL_A, USERS.pro, MAIL_B],
  );

  await adminQuery(
    `with writer as (
       select set_config('inbox_pipeline.writer', 'bind', true)
     )
     insert into public.pipeline_inbox_bindings (
       creator_id, pipeline_item_id, mail_account_id, provider_thread_id
     )
     select * from (values
       ($1::uuid, $2::uuid, $3::uuid, 'thread-a'),
       ($4::uuid, $5::uuid, $6::uuid, 'thread-b')
     ) as v(creator_id, pipeline_item_id, mail_account_id, provider_thread_id)
     where (select count(*) from writer) = 1`,
    [creators.destBali, itemA, MAIL_A, creators.pro, itemB, MAIL_B],
  );
}, 120_000);

afterAll(async () => {
  await teardownDatabase();
});

function ids(rows: { id: string }[]): string[] {
  return rows.map((row) => row.id);
}

d("activation and list tables — User A cannot read User B", () => {
  it("A sees A's trip and pipeline item and not B's", async () => {
    const trips = await queryAs<{ id: string }>(
      { role: "authenticated", sub: USERS.destBali },
      "select id from public.trips",
    );
    expect(trips.error).toBeNull();
    expect(ids(trips.rows)).toContain(TRIP.destBali);
    expect(ids(trips.rows)).not.toContain(TRIP.pro);

    const pipeline = await queryAs<{ id: string }>(
      { role: "authenticated", sub: USERS.destBali },
      "select id from public.pipeline_items",
    );
    expect(pipeline.error).toBeNull();
    expect(ids(pipeline.rows)).toContain(itemA);
    expect(ids(pipeline.rows)).not.toContain(itemB);
  });

  it("A sees A's collaboration and not B's", async () => {
    const rows = await queryAs<{ id: string }>(
      { role: "authenticated", sub: USERS.destBali },
      "select id from public.collaborations",
    );
    expect(rows.error).toBeNull();
    expect(ids(rows.rows)).toEqual([COLL_A]);
  });

  it("A sees A's mailbox and not B's address", async () => {
    const rows = await queryAs<{ id: string; email_address: string | null }>(
      { role: "authenticated", sub: USERS.destBali },
      "select id, email_address::text from public.mail_accounts",
    );
    expect(rows.error).toBeNull();
    expect(rows.rows.map((row) => row.id)).toEqual([MAIL_A]);
    expect(rows.rows.map((row) => row.email_address)).not.toContain("bee-secret@example.com");
  });

  it("A sees A's inbox link and not B's", async () => {
    const rows = await queryAs<{ provider_thread_id: string }>(
      { role: "authenticated", sub: USERS.destBali },
      "select provider_thread_id from public.pipeline_inbox_bindings",
    );
    expect(rows.error).toBeNull();
    expect(rows.rows.map((row) => row.provider_thread_id)).toEqual(["thread-a"]);
  });

  it("anon sees none of A's or B's private rows", async () => {
    for (const sql of [
      "select id from public.trips",
      "select id from public.pipeline_items",
      "select id from public.collaborations",
      "select id from public.mail_accounts",
      "select id from public.pipeline_inbox_bindings",
    ]) {
      const rows = await queryAs({ role: "anon" }, sql);
      expect(rows.error !== null || rows.rows.length === 0).toBe(true);
    }
  });
});
