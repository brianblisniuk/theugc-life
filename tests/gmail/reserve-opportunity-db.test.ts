/**
 * D182 guards still apply after 0101 replaces gmail_send_reserve.
 * The database is the full migration list. Gmail is not called.
 */
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { B02_REQUESTED_SCOPES, GMAIL_SEND_SCOPE } from "@/lib/gmail/contract";
import { adminQuery, commitAs, hasTestDb, setupDatabase, teardownDatabase } from "../db/harness";

const d = describe.skipIf(!hasTestDb);

const PRO = "e2e20100-0000-4000-8000-000000000001";
const OTHER = "e2e20100-0000-4000-8000-000000000002";
const DEST = "e2e20110-0000-4000-8000-000000000001";
const HOTEL = "e2e20120-0000-4000-8000-000000000001";
const RECIPIENT = "desk@opportunity-hotel.example";
const SEND_SCOPES = [...B02_REQUESTED_SCOPES, GMAIL_SEND_SCOPE];

const mailboxes = new Map<string, string>();

async function asService<T>(sql: string, params: unknown[] = []): Promise<T[]> {
  await adminQuery("grant usage on schema public to service_role");
  try {
    const res = await commitAs<T>({ role: "service_role" }, sql, params);
    if (res.error) throw new Error(res.error.message);
    return res.rows;
  } finally {
    await adminQuery("revoke usage on schema public from service_role");
  }
}

async function creatorId(userId: string): Promise<string> {
  const rows = await adminQuery<{ id: string }>(
    "select id from public.creator_profiles where user_id = $1",
    [userId],
  );
  return rows[0]!.id;
}

async function connectMailbox(userId: string): Promise<void> {
  const granted = [...SEND_SCOPES].sort();
  const receiptDigest = userId.replace(/-/g, "").repeat(2).slice(0, 64);
  const client = new Client({ connectionString: process.env.TEST_DATABASE_URL });
  await client.connect();
  try {
    await client.query("begin");
    const account = await client.query<{ id: string }>(
      `insert into public.mail_accounts
         (user_id, provider, provider_account_subject, email_address, connection_state)
       values ($1, 'gmail', $2, $3, 'pending_authorization')
       returning id`,
      [userId, `sub-${userId}`, `${userId}@example.invalid`],
    );
    const id = account.rows[0]!.id;
    await client.query(
      `update public.mail_accounts
          set connection_state = 'connected', connected_at = now(), granted_scopes = $2
        where id = $1`,
      [id, granted],
    );
    const receipt = await client.query<{ id: string; event_seq: string }>(
      `insert into public.mail_account_consent_receipts
         (mail_account_id, user_id, consent_kind, decision, policy_version, consent_text_digest,
          granted_scopes_at_decision, decided_by_user_id, decided_at, receipt_digest)
       values ($1, $2, 'private_gmail_processing', 'granted',
               'gmail-private-processing/2026-10-14-send', $3, $4, $2, now(), $5)
       returning id, event_seq`,
      [id, userId, "a".repeat(64), granted, receiptDigest],
    );
    await client.query(
      `insert into public.mail_account_consents
         (mail_account_id, user_id, consent_kind, state, current_receipt_id, current_event_seq)
       values ($1, $2, 'private_gmail_processing', 'granted', $3, $4)`,
      [id, userId, receipt.rows[0]!.id, receipt.rows[0]!.event_seq],
    );
    await client.query(
      `insert into private.gmail_oauth_credentials
         (mail_account_id, user_id, refresh_token_ciphertext, refresh_token_iv,
          refresh_token_auth_tag, encryption_key_version)
       values ($1, $2, 'ct', 'iv', 'tag', 'v1')`,
      [id, userId],
    );
    await client.query("commit");
    mailboxes.set(userId, id);
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    throw error;
  } finally {
    await client.end();
  }
}

async function unlock(userId: string): Promise<void> {
  const ledger = await adminQuery<{ id: string }>(
    "select id from public.credit_ledger where user_id = $1 and reason = 'free_grant' limit 1",
    [userId],
  );
  await adminQuery(
    "insert into public.contact_unlocks (user_id, hotel_id, ledger_id) values ($1, $2, $3)",
    [userId, HOTEL, ledger[0]!.id],
  );
}

async function reserve(input: {
  userId: string;
  key: string;
  pipelineId?: string | null;
  draftId?: string | null;
}): Promise<Record<string, unknown>> {
  const rows = await asService<{ r: Record<string, unknown> }>(
    `select public.gmail_send_reserve(
       $1::uuid, $2::uuid, $3, 'pitch', $4, 'Hello hotel', 'A pitch body',
       $5::uuid, $6::uuid, null, $7::uuid, null
     ) as r`,
    [
      input.userId,
      mailboxes.get(input.userId),
      input.key,
      RECIPIENT,
      HOTEL,
      input.pipelineId ?? null,
      input.draftId ?? null,
    ],
  );
  return rows[0]!.r;
}

async function attemptCount(key: string): Promise<number> {
  const rows = await adminQuery<{ n: number }>(
    "select count(*)::int as n from private.gmail_send_attempts where idempotency_key = $1",
    [key],
  );
  return rows[0]!.n;
}

async function openOpportunity(
  creatorId: string,
  tripStart: string,
  tripEnd: string,
  stayStart: string,
  stayEnd: string,
): Promise<string> {
  const trip = await adminQuery<{ id: string }>(
    `insert into public.trips (creator_id, destination_id, start_date, end_date)
     values ($1, $2, $3, $4) returning id`,
    [creatorId, DEST, tripStart, tripEnd],
  );
  const item = await adminQuery<{ id: string }>(
    `insert into public.pipeline_items
       (creator_id, hotel_id, trip_id, status, stay_start, stay_end)
     values ($1, $2, $3, 'saved', $4, $5) returning id`,
    [creatorId, HOTEL, trip[0]!.id, stayStart, stayEnd],
  );
  return item[0]!.id;
}

d("gmail_send_reserve keeps the opportunity guards", () => {
  let first = "";
  let second = "";
  let draftOnFirst = "";

  beforeAll(async () => {
    await setupDatabase();
    await adminQuery(
      `insert into auth.users (id, email) values
         ($1, 'opp-pro@example.invalid'),
         ($2, 'opp-other@example.invalid')`,
      [PRO, OTHER],
    );
    await adminQuery(
      "insert into public.destinations (id, name, slug, type) values ($1, 'Guard Bay', 'guard-bay', 'city')",
      [DEST],
    );
    await adminQuery(
      "insert into public.hotels (id, name, slug, destination_id) values ($1, 'Guard Hotel', 'guard-hotel', $2)",
      [HOTEL, DEST],
    );
    await adminQuery(
      `insert into public.hotel_contacts (hotel_id, email, status, source_type)
       values ($1, $2, 'active', 'editorial')`,
      [HOTEL, RECIPIENT],
    );
    await adminQuery(
      `insert into public.access_entitlements (user_id, access_type, status, starts_at)
       values ($1, 'pro', 'active', now()), ($2, 'pro', 'active', now())`,
      [PRO, OTHER],
    );
    for (const userId of [PRO, OTHER]) {
      await connectMailbox(userId);
      await unlock(userId);
    }
    const creator = await creatorId(PRO);
    first = await openOpportunity(creator, "2026-11-01", "2026-11-08", "2026-11-01", "2026-11-04");
  }, 120_000);

  afterAll(async () => {
    await teardownDatabase();
  });

  it("binds the only open opportunity when the caller omits the id", async () => {
    const row = await reserve({ userId: PRO, key: "opp-one-open-000001" });
    expect(row).toMatchObject({
      result: "queued",
      call_provider: false,
      pipeline_item_id: first,
    });
  });

  it("returns invalid_input when more than one open opportunity exists and does not bind one", async () => {
    const creator = await creatorId(PRO);
    second = await openOpportunity(creator, "2026-12-01", "2026-12-08", "2026-12-01", "2026-12-04");
    const before = await attemptCount("opp-two-open-000001");
    const row = await reserve({ userId: PRO, key: "opp-two-open-000001" });
    expect(row).toMatchObject({ result: "invalid_input", call_provider: false });
    expect(row.pipeline_item_id ?? null).toBeNull();
    expect(await attemptCount("opp-two-open-000001")).toBe(before);
    const otherCreator = await creatorId(OTHER);
    const otherItem = await openOpportunity(
      otherCreator,
      "2026-11-01",
      "2026-11-08",
      "2026-11-01",
      "2026-11-04",
    );
    const other = await reserve({ userId: OTHER, key: "opp-other-one-00001" });
    expect(other).toMatchObject({
      result: "queued",
      call_provider: false,
      pipeline_item_id: otherItem,
    });
  });

  it("returns invalid_input when the draft is bound to a different opportunity", async () => {
    const creator = await creatorId(PRO);
    const client = new Client({ connectionString: process.env.TEST_DATABASE_URL });
    await client.connect();
    let draftId = "";
    try {
      const draft = await client.query<{ id: string }>(
        `insert into public.pitch_drafts (creator_id, hotel_id, pipeline_item_id, subject, body)
         values ($1, $2, $3, 'Hello hotel', 'A pitch body') returning id`,
        [creator, HOTEL, first],
      );
      draftId = draft.rows[0]!.id;
    } finally {
      await client.end();
    }
    draftOnFirst = draftId;
    const before = await attemptCount("opp-draft-mismatch01");
    const mismatched = await reserve({
      userId: PRO,
      key: "opp-draft-mismatch01",
      pipelineId: second,
      draftId: draftOnFirst,
    });
    expect(mismatched).toMatchObject({ result: "invalid_input", call_provider: false });
    expect(await attemptCount("opp-draft-mismatch01")).toBe(before);
    const matched = await reserve({
      userId: PRO,
      key: "opp-draft-match-0001",
      pipelineId: first,
      draftId: draftOnFirst,
    });
    expect(matched).toMatchObject({
      result: "queued",
      call_provider: false,
      pipeline_item_id: first,
    });
  });
});
