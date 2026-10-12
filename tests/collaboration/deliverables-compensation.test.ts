/**
 * D078 deliverables and agreed compensation on real Postgres.
 *
 * Proves creator records, derived value (unknown is null, never zero), that a
 * B07 suggestion cannot overwrite creator compensation, and that User A cannot
 * read or attach User B's rows.
 */
import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { parseWorkspacePayload } from "@/lib/collaboration/contract";
import { adminQuery, hasTestDb, queryAs, setupDatabase, teardownDatabase } from "../db/harness";

const d = describe.skipIf(!hasTestDb);

const USER_A = "d0710000-0000-0000-0000-00000000000a";
const USER_B = "d0710000-0000-0000-0000-00000000000b";
const DEST = "d0720000-0000-0000-0000-000000000001";
const HOTELS = Array.from({ length: 24 }, (_, index) => {
  const n = (index + 1).toString(16).padStart(12, "0");
  return `d0730000-0000-0000-0000-${n}`;
});

const DIGEST = "ab".repeat(32);
let hotelCursor = 0;

async function call(sql: string, params: unknown[] = []): Promise<Record<string, unknown>> {
  const rows = await adminQuery<{ r: Record<string, unknown> }>(sql, params);
  return rows[0]!.r;
}

function daysAgo(days: number): string {
  return new Date(Date.now() - days * 86_400_000).toISOString();
}

async function win(userId: string): Promise<string> {
  const hotelId = HOTELS[hotelCursor++]!;
  const saved = await call("select public.save_hotel_to_pipeline($1,$2,50) as r", [
    userId,
    hotelId,
  ]);
  expect(saved.result).toBe("created");
  const itemId = saved.pipeline_item_id as string;
  const pitched = await call(
    "select public.transition_pipeline_item($1,$2,'mark_pitched',$3,'email',null,null,null,50) as r",
    [userId, itemId, daysAgo(4)],
  );
  expect(pitched.result).toBe("applied");
  const replied = await call(
    "select public.transition_pipeline_item($1,$2,'mark_replied',$3,null,'positive',null,null,50) as r",
    [userId, itemId, daysAgo(3)],
  );
  expect(replied.result).toBe("applied");
  const negotiating = await call(
    "select public.progress_pipeline_deal($1,$2,'start_negotiation',null,null) as r",
    [userId, itemId],
  );
  expect(negotiating.result).toBe("applied");
  const won = await call("select public.progress_pipeline_deal($1,$2,'mark_won',$3,'stay') as r", [
    userId,
    itemId,
    daysAgo(1),
  ]);
  expect(won.result).toBe("applied");
  return itemId;
}

function saveCompensation(
  userId: string,
  itemId: string,
  structure: string,
  cash: number | null = null,
  cashCurrency: string | null = null,
  description: string | null = null,
  estimate: number | null = null,
  estimateCurrency: string | null = null,
  payment = "not_applicable",
) {
  return call(`select public.upsert_collaboration_compensation($1,$2,$3,$4,$5,$6,$7,$8,$9) as r`, [
    userId,
    itemId,
    structure,
    cash,
    cashCurrency,
    description,
    estimate,
    estimateCurrency,
    payment,
  ]);
}

function addDeliverable(
  userId: string,
  itemId: string,
  type: string,
  quantity: number,
  status = "pending",
  id: string | null = null,
) {
  return call(
    `select public.upsert_collaboration_deliverable($1,$2,$3,$4,$5,null,null,$6,null,null) as r`,
    [userId, itemId, id, type, quantity, status],
  );
}

async function read(userId: string, itemId: string) {
  const res = await queryAs<{ r: Record<string, unknown> }>(
    { role: "authenticated", sub: userId },
    "select public.collaboration_deliverable_values($1) as r",
    [itemId],
  );
  expect(res.error).toBeNull();
  return res.rows[0]!.r;
}

async function readOk(userId: string, itemId: string) {
  const raw = await read(userId, itemId);
  const parsed = parseWorkspacePayload(raw);
  expect(parsed, JSON.stringify(raw)).not.toBeNull();
  return parsed!;
}

async function creatorId(userId: string): Promise<string> {
  const rows = await adminQuery<{ id: string }>(
    "select id from public.creator_profiles where user_id = $1",
    [userId],
  );
  return rows[0]!.id;
}

async function collaborationId(itemId: string): Promise<string> {
  const rows = await adminQuery<{ id: string }>(
    "select id from public.collaborations where pipeline_item_id = $1",
    [itemId],
  );
  return rows[0]!.id;
}

async function expectViolation(run: () => Promise<unknown>) {
  try {
    await run();
  } catch (error) {
    expect((error as { code?: string }).code).toBe("23514");
    return;
  }
  throw new Error("expected check violation 23514");
}

async function seedMailbox(userId: string, mailId: string) {
  await adminQuery(
    `insert into public.mail_accounts (id, user_id, provider, provider_account_subject, connection_state)
     values ($1,$2,'gmail',$3,'pending_authorization')`,
    [mailId, userId, `sub-${mailId}`],
  );
}

async function seedReading(
  userId: string,
  mailId: string,
  threadId: string,
  structure: string,
  options: { stale?: boolean; unbound?: boolean } = {},
) {
  const attemptId = randomUUID();
  let normalizedThreadId: string | null = null;
  if (!options.unbound) {
    const threads = await adminQuery<{ id: string }>(
      `insert into private.gmail_normalized_threads (user_id, mail_account_id, provider_thread_id)
       values ($1,$2,$3)
       returning id`,
      [userId, mailId, threadId],
    );
    normalizedThreadId = threads[0]!.id;
  }
  await adminQuery(
    `with cfg as (select set_config('b07.machine_writer', 'on', true) as ok)
     insert into private.gmail_commercial_thread_attempts (
       id, user_id, mail_account_id, provider_thread_id, normalized_thread_id,
       input_digest, schema_version, transform_version, engine_kind, rule_version,
       compensation_structure, evidence_strength
     )
     select $1,$2,$3,$4,$5,$6,'gmail_commercial_schema_v1','gmail_commercial_text_v1',
            'rules','gmail_commercial_rules_v1',$7,'moderate'
       from cfg`,
    [attemptId, userId, mailId, threadId, normalizedThreadId, DIGEST, structure],
  );
  await adminQuery(
    `with cfg as (select set_config('b07.machine_writer', 'on', true) as ok)
     insert into private.gmail_commercial_thread_current (
       user_id, mail_account_id, provider_thread_id, current_attempt_id, input_digest, stale
     )
     select $1,$2,$3,$4,$5,$6 from cfg`,
    [userId, mailId, threadId, attemptId, DIGEST, options.stale ?? false],
  );
  return attemptId;
}

beforeAll(async () => {
  if (!hasTestDb) return;
  await setupDatabase();
  for (const id of [USER_A, USER_B]) {
    await adminQuery("insert into auth.users (id, email) values ($1,$2)", [id, `${id}@t.local`]);
  }
  await adminQuery(
    "insert into public.destinations (id, name, slug, type) values ($1,'D07 Town','d07-town','city')",
    [DEST],
  );
  for (const [index, id] of HOTELS.entries()) {
    await adminQuery(
      "insert into public.hotels (id, name, slug, destination_id) values ($1,$2,$3,$4)",
      [id, `D07 Hotel ${index}`, `d07-hotel-${index}`, DEST],
    );
  }
}, 120_000);

afterAll(async () => {
  await teardownDatabase();
});

d("D078 agreed compensation and derived deliverable value", () => {
  it("allocates a known cash total by quantity and labels it derived", async () => {
    const item = await win(USER_A);
    expect(
      await saveCompensation(USER_A, item, "paid", 100, "usd", null, null, null, "pending"),
    ).toEqual({
      result: "saved",
    });
    const first = await addDeliverable(USER_A, item, "reel", 1);
    const second = await addDeliverable(USER_A, item, "story", 2);
    expect(first.result).toBe("saved");
    expect(second.result).toBe("saved");

    const again = await saveCompensation(
      USER_A,
      item,
      "paid",
      100,
      "USD",
      null,
      null,
      null,
      "pending",
    );
    expect(again.result).toBe("saved");
    const rows = await adminQuery<{ n: string }>(
      `select count(*)::text as n from public.collaboration_agreed_compensations c
         join public.collaborations k on k.id = c.collaboration_id
        where k.pipeline_item_id = $1`,
      [item],
    );
    expect(rows[0]!.n).toBe("1");

    const workspace = await readOk(USER_A, item);
    expect(workspace.compensation?.authority).toBe("creator");
    expect(workspace.compensation?.cash_currency).toBe("USD");
    expect(workspace.valuation).toMatchObject({
      kind: "derived",
      label: "derived",
      reason: "allocated",
      currency: "USD",
      total_minor: 100,
    });
    expect(workspace.deliverables.map((row) => row.attributed_value.amount_minor)).toEqual([
      33, 67,
    ]);
    expect(workspace.deliverables.every((row) => row.attributed_value.basis === "allocated")).toBe(
      true,
    );
    expect(workspace.deliverables.every((row) => row.attributed_value.label === "derived")).toBe(
      true,
    );

    const rejected = await addDeliverable(
      USER_A,
      item,
      "reel",
      1,
      "rejected",
      workspace.deliverables[0]!.id,
    );
    expect(rejected.result).toBe("saved");
    const afterStatus = await readOk(USER_A, item);
    expect(afterStatus.deliverables.map((row) => row.attributed_value.amount_minor)).toEqual([
      33, 67,
    ]);
    expect(afterStatus.deliverables[0]!.status).toBe("rejected");
  });

  it("gives the largest fractional remainder to the earliest deliverable", async () => {
    const item = await win(USER_A);
    await saveCompensation(USER_A, item, "paid", 10, "USD", null, null, null, "paid");
    await addDeliverable(USER_A, item, "post", 1);
    await addDeliverable(USER_A, item, "post", 1);
    await addDeliverable(USER_A, item, "post", 1);
    const workspace = await readOk(USER_A, item);
    expect(workspace.deliverables.map((row) => row.attributed_value.amount_minor)).toEqual([
      4, 3, 3,
    ]);
  });

  it("may derive a zero share of a known total, which is not unknown", async () => {
    const item = await win(USER_A);
    await saveCompensation(USER_A, item, "paid", 1, "USD", null, null, null, "pending");
    await addDeliverable(USER_A, item, "reel", 2);
    await addDeliverable(USER_A, item, "story", 1);
    const workspace = await readOk(USER_A, item);
    expect(workspace.deliverables.map((row) => row.attributed_value)).toEqual([
      { kind: "derived", label: "derived", basis: "allocated", amount_minor: 1, currency: "USD" },
      { kind: "derived", label: "derived", basis: "allocated", amount_minor: 0, currency: "USD" },
    ]);
  });

  it("keeps unknown, other, missing estimates, and mixed currencies null", async () => {
    const unknown = await win(USER_A);
    await saveCompensation(USER_A, unknown, "unknown");
    await addDeliverable(USER_A, unknown, "reel", 1);
    const unknownRead = await readOk(USER_A, unknown);
    expect(unknownRead.valuation.total_minor).toBeNull();
    expect(unknownRead.valuation.reason).toBe("structure_unknown");
    expect(unknownRead.deliverables[0]!.attributed_value.amount_minor).toBeNull();
    expect(unknownRead.deliverables[0]!.attributed_value.kind).toBe("unknown");

    const other = await win(USER_A);
    await saveCompensation(USER_A, other, "other");
    await addDeliverable(USER_A, other, "reel", 1);
    expect((await readOk(USER_A, other)).valuation.reason).toBe("structure_other");
    expect((await readOk(USER_A, other)).deliverables[0]!.attributed_value.amount_minor).toBeNull();

    const kind = await win(USER_A);
    await saveCompensation(USER_A, kind, "in_kind", null, null, "Two nights");
    await addDeliverable(USER_A, kind, "photo_set", 1);
    const kindRead = await readOk(USER_A, kind);
    expect(kindRead.valuation.reason).toBe("in_kind_estimate_missing");
    expect(kindRead.valuation.total_minor).toBeNull();
    expect(kindRead.compensation?.in_kind_estimate_label).toBeNull();

    const estimated = await win(USER_A);
    await saveCompensation(USER_A, estimated, "in_kind", null, null, "Two nights", 5000, "EUR");
    await addDeliverable(USER_A, estimated, "photo_set", 1);
    const estimatedRead = await readOk(USER_A, estimated);
    expect(estimatedRead.valuation).toMatchObject({
      reason: "allocated",
      total_minor: 5000,
      currency: "EUR",
    });
    expect(estimatedRead.compensation?.in_kind_estimate_label).toBe("creator_estimate");

    const hybrid = await win(USER_A);
    await saveCompensation(
      USER_A,
      hybrid,
      "hybrid",
      2000,
      "USD",
      "Breakfast",
      null,
      null,
      "partially_paid",
    );
    await addDeliverable(USER_A, hybrid, "ugc_video", 1);
    const hybridRead = await readOk(USER_A, hybrid);
    expect(hybridRead.valuation.reason).toBe("hybrid_incomplete");
    expect(hybridRead.valuation.total_minor).toBeNull();
    expect(hybridRead.deliverables[0]!.attributed_value.amount_minor).toBeNull();

    const mixed = await win(USER_A);
    await saveCompensation(
      USER_A,
      mixed,
      "hybrid",
      2000,
      "USD",
      "Breakfast",
      1000,
      "EUR",
      "pending",
    );
    await addDeliverable(USER_A, mixed, "ugc_video", 1);
    expect((await readOk(USER_A, mixed)).valuation.reason).toBe("currency_mismatch");
    expect((await readOk(USER_A, mixed)).valuation.total_minor).toBeNull();
  });

  it("records unpaid as an explicit zero, distinct from unknown", async () => {
    const item = await win(USER_A);
    await saveCompensation(USER_A, item, "unpaid");
    await addDeliverable(USER_A, item, "tiktok", 3);
    const workspace = await readOk(USER_A, item);
    expect(workspace.valuation).toMatchObject({
      kind: "derived",
      label: "derived",
      reason: "unpaid",
      total_minor: 0,
      currency: null,
    });
    expect(workspace.deliverables[0]!.attributed_value).toEqual({
      kind: "derived",
      label: "derived",
      basis: "unpaid_explicit",
      amount_minor: 0,
      currency: null,
    });
  });

  it("does not write the legacy private value column or a new outreach event", async () => {
    const item = await win(USER_A);
    const before = await adminQuery<{ n: string }>(
      "select count(*)::text as n from public.outreach_events where pipeline_item_id = $1",
      [item],
    );
    await saveCompensation(USER_A, item, "paid", 900, "GBP", null, null, null, "paid");
    const value = await adminQuery<{ private_value_amount: string | null }>(
      "select private_value_amount from public.collaborations where pipeline_item_id = $1",
      [item],
    );
    const after = await adminQuery<{ n: string }>(
      "select count(*)::text as n from public.outreach_events where pipeline_item_id = $1",
      [item],
    );
    expect(value[0]!.private_value_amount).toBeNull();
    expect(after[0]!.n).toBe(before[0]!.n);
  });

  it("rejects a bad currency, a negative amount, and a non-https proof", async () => {
    const item = await win(USER_A);
    expect(
      (await saveCompensation(USER_A, item, "paid", 10, "ZZZ", null, null, null, "pending")).result,
    ).toBe("invalid_input");
    expect(
      (await saveCompensation(USER_A, item, "paid", -1, "USD", null, null, null, "pending")).result,
    ).toBe("invalid_input");
    const proof = await call(
      `select public.upsert_collaboration_deliverable($1,$2,null,'reel',1,null,null,'pending',$3,null) as r`,
      [USER_A, item, "javascript:alert(1)"],
    );
    expect(proof.result).toBe("invalid_input");
    expect(await call("select public.is_iso_currency('USD') as r")).toBe(true);
    expect(await call("select public.is_iso_currency('usd') as r")).toBe(false);
  });
});

d("D078 machine suggestions never become creator compensation", () => {
  it("prefills a structure and does not value deliverables from it", async () => {
    const item = await win(USER_A);
    const mail = randomUUID();
    await seedMailbox(USER_A, mail);
    await seedReading(USER_A, mail, "thread-paid", "paid");
    await addDeliverable(USER_A, item, "youtube", 1);
    const suggested = await call(
      "select public.prefill_collaboration_compensation_suggestion($1,$2,$3,$4) as r",
      [USER_A, item, mail, "thread-paid"],
    );
    expect(suggested).toMatchObject({
      result: "suggested",
      structure: "paid",
      authority: "machine_suggestion",
    });
    const workspace = await readOk(USER_A, item);
    expect(workspace.compensation).toBeNull();
    expect(workspace.suggestion?.authority).toBe("machine_suggestion");
    expect(workspace.suggestion?.structure).toBe("paid");
    expect(workspace.valuation.reason).toBe("no_creator_compensation");
    expect(workspace.deliverables[0]!.attributed_value.amount_minor).toBeNull();
  });

  it("does not overwrite creator compensation, and a stale reading writes nothing", async () => {
    const item = await win(USER_A);
    const mail = randomUUID();
    await seedMailbox(USER_A, mail);
    await seedReading(USER_A, mail, "thread-kind", "in_kind");
    await saveCompensation(USER_A, item, "paid", 5000, "USD", null, null, null, "pending");
    const before = await adminQuery<{
      structure: string;
      cash_amount_minor: string;
      updated_at: string;
    }>(
      `select c.structure, c.cash_amount_minor::text, c.updated_at::text
         from public.collaboration_agreed_compensations c
         join public.collaborations k on k.id = c.collaboration_id
        where k.pipeline_item_id = $1`,
      [item],
    );
    const suggested = await call(
      "select public.prefill_collaboration_compensation_suggestion($1,$2,$3,$4) as r",
      [USER_A, item, mail, "thread-kind"],
    );
    expect(suggested.result).toBe("suggested");
    const after = await adminQuery<{
      structure: string;
      cash_amount_minor: string;
      updated_at: string;
    }>(
      `select c.structure, c.cash_amount_minor::text, c.updated_at::text
         from public.collaboration_agreed_compensations c
         join public.collaborations k on k.id = c.collaboration_id
        where k.pipeline_item_id = $1`,
      [item],
    );
    expect(after).toEqual(before);
    const workspace = await readOk(USER_A, item);
    expect(workspace.compensation?.structure).toBe("paid");
    expect(workspace.compensation?.cash_amount_minor).toBe(5000);
    expect(workspace.suggestion?.structure).toBe("in_kind");

    await adminQuery(
      `with cfg as (select set_config('b07.machine_writer', 'on', true) as ok)
       update private.gmail_commercial_thread_current c
          set stale = true
         from cfg
        where c.mail_account_id = $1 and c.provider_thread_id = 'thread-kind'`,
      [mail],
    );
    const stale = await call(
      "select public.prefill_collaboration_compensation_suggestion($1,$2,$3,$4) as r",
      [USER_A, item, mail, "thread-kind"],
    );
    expect(stale.result).toBe("no_current_machine_compensation");
    expect((await readOk(USER_A, item)).suggestion?.structure).toBe("in_kind");
  });

  it("refuses another creator's mailbox and an unbound machine row", async () => {
    const item = await win(USER_A);
    const ownMail = randomUUID();
    const otherMail = randomUUID();
    await seedMailbox(USER_A, ownMail);
    await seedMailbox(USER_B, otherMail);
    await seedReading(USER_B, otherMail, "thread-b", "hybrid");
    await seedReading(USER_A, ownMail, "thread-unbound", "paid", { unbound: true });
    const foreign = await call(
      "select public.prefill_collaboration_compensation_suggestion($1,$2,$3,$4) as r",
      [USER_A, item, otherMail, "thread-b"],
    );
    const missingMail = await call(
      "select public.prefill_collaboration_compensation_suggestion($1,$2,$3,$4) as r",
      [USER_A, item, randomUUID(), "thread-b"],
    );
    expect(JSON.stringify(foreign)).toBe(JSON.stringify(missingMail));
    expect(foreign).toEqual({ result: "not_found" });
    const unbound = await call(
      "select public.prefill_collaboration_compensation_suggestion($1,$2,$3,$4) as r",
      [USER_A, item, ownMail, "thread-unbound"],
    );
    expect(unbound.result).toBe("no_current_machine_compensation");
    const count = await adminQuery<{ n: string }>(
      `select count(*)::text as n from public.collaboration_compensation_suggestions s
         join public.collaborations c on c.id = s.collaboration_id
        where c.pipeline_item_id = $1`,
      [item],
    );
    expect(count[0]!.n).toBe("0");
  });
});

d("D078 tenant isolation", () => {
  it("returns the same not_found for a foreign pipeline item and a missing id", async () => {
    const itemA = await win(USER_A);
    const itemB = await win(USER_B);
    await saveCompensation(USER_B, itemB, "paid", 100, "USD", null, null, null, "pending");
    const foreign = await saveCompensation(
      USER_A,
      itemB,
      "paid",
      1,
      "USD",
      null,
      null,
      null,
      "pending",
    );
    const missing = await saveCompensation(
      USER_A,
      randomUUID(),
      "paid",
      1,
      "USD",
      null,
      null,
      null,
      "pending",
    );
    expect(JSON.stringify(foreign)).toBe(JSON.stringify(missing));
    expect(foreign).toEqual({ result: "not_found" });
    const still = await adminQuery<{ cash_amount_minor: string }>(
      `select cash_amount_minor::text from public.collaboration_agreed_compensations c
         join public.collaborations k on k.id = c.collaboration_id
        where k.pipeline_item_id = $1`,
      [itemB],
    );
    expect(still[0]!.cash_amount_minor).toBe("100");

    const readForeign = await read(USER_A, itemB);
    const readMissing = await read(USER_A, randomUUID());
    expect(JSON.stringify(readForeign)).toBe(JSON.stringify(readMissing));
    expect(readForeign).toEqual({ result: "not_found" });

    const added = await addDeliverable(USER_B, itemB, "reel", 1);
    const deleted = await call("select public.delete_collaboration_deliverable($1,$2,$3) as r", [
      USER_A,
      itemB,
      added.deliverable_id,
    ]);
    const deletedMissing = await call(
      "select public.delete_collaboration_deliverable($1,$2,$3) as r",
      [USER_A, randomUUID(), added.deliverable_id],
    );
    expect(JSON.stringify(deleted)).toBe(JSON.stringify(deletedMissing));
    expect(deleted).toEqual({ result: "not_found" });
    const remaining = await adminQuery<{ n: string }>(
      "select count(*)::text as n from public.collaboration_deliverables where id = $1",
      [added.deliverable_id],
    );
    expect(remaining[0]!.n).toBe("1");

    const anon = await queryAs(
      { role: "anon" },
      "select public.collaboration_deliverable_values($1)",
      [itemA],
    );
    expect(anon.error?.code).toBe("42501");
    const asAuth = await queryAs(
      { role: "authenticated", sub: USER_A },
      "select public.upsert_collaboration_compensation($1,$2,'paid',1,'USD',null,null,null,'pending')",
      [USER_B, itemB],
    );
    expect(asAuth.error?.code).toBe("42501");

    const seen = await queryAs<{ id: string }>(
      { role: "authenticated", sub: USER_A },
      "select id from public.collaboration_agreed_compensations",
    );
    expect(seen.error).toBeNull();
    const own = await adminQuery<{ id: string }>(
      `select c.id from public.collaboration_agreed_compensations c
         join public.creator_profiles p on p.id = c.creator_id
        where p.user_id = $1`,
      [USER_A],
    );
    expect(seen.rows.map((row) => row.id).sort()).toEqual(own.map((row) => row.id).sort());
  });

  it("rejects a cross-tenant attach even from the table owner", async () => {
    const itemA = await win(USER_A);
    const itemB = await win(USER_B);
    const creatorA = await creatorId(USER_A);
    const creatorB = await creatorId(USER_B);
    const collabB = await collaborationId(itemB);
    await expectViolation(() =>
      adminQuery(
        `insert into public.collaboration_deliverables
           (creator_id, collaboration_id, pipeline_item_id, deliverable_type, quantity)
         values ($1,$2,$3,'reel',1)`,
        [creatorA, collabB, itemB],
      ),
    );
    const collabA = await collaborationId(itemA);
    await expectViolation(() =>
      adminQuery(
        `insert into public.collaboration_agreed_compensations
           (creator_id, collaboration_id, pipeline_item_id, structure, payment_status)
         values ($1,$2,$3,'unknown','not_applicable')`,
        [creatorB, collabA, itemA],
      ),
    );
    await saveCompensation(USER_A, itemA, "paid", 10, "USD", null, null, null, "pending");
    await expectViolation(() =>
      adminQuery("update public.collaborations set creator_id = $2 where pipeline_item_id = $1", [
        itemA,
        creatorB,
      ]),
    );
    await expectViolation(() =>
      adminQuery(
        `insert into public.collaboration_deliverables
           (creator_id, collaboration_id, pipeline_item_id, deliverable_type, quantity, proof_url)
         values ($1,$2,$3,'reel',1,'javascript:alert(1)')`,
        [creatorA, collabA, itemA],
      ),
    );
  });
});
