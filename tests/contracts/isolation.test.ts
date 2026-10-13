/**
 * D114. Agreement drafts are owner-private.
 * User A cannot read, list, update, or delete User B's templates or drafts,
 * and a draft cannot reference B's deal, trip, collaboration, or template.
 * Generation reads only stored facts. A missing fact stays "[to be filled in]".
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

const d = describe.skipIf(!hasTestDb);

const USER_A = "c1140000-0000-4000-8000-00000000000a";
const USER_B = "c1140000-0000-4000-8000-00000000000b";
const DEST = "c1140000-0000-4000-8000-0000000000d1";

const HOTEL = {
  shared: "c1140000-0000-4000-8000-000000000011",
  full: "c1140000-0000-4000-8000-000000000012",
  negotiating: "c1140000-0000-4000-8000-000000000013",
  unpaid: "c1140000-0000-4000-8000-000000000014",
  nodates: "c1140000-0000-4000-8000-000000000015",
  trip: "c1140000-0000-4000-8000-000000000016",
} as const;

const PIPE = {
  blank: "c1140000-0000-4000-8000-000000000021",
  secret: "c1140000-0000-4000-8000-000000000022",
  full: "c1140000-0000-4000-8000-000000000023",
  negotiating: "c1140000-0000-4000-8000-000000000024",
  unpaid: "c1140000-0000-4000-8000-000000000025",
  nodates: "c1140000-0000-4000-8000-000000000026",
  trip: "c1140000-0000-4000-8000-000000000027",
} as const;

const COLLAB = {
  blank: "c1140000-0000-4000-8000-000000000031",
  secret: "c1140000-0000-4000-8000-000000000032",
  full: "c1140000-0000-4000-8000-000000000033",
  unpaid: "c1140000-0000-4000-8000-000000000034",
  nodates: "c1140000-0000-4000-8000-000000000035",
  trip: "c1140000-0000-4000-8000-000000000036",
} as const;

const TRIP_A = "c1140000-0000-4000-8000-000000000041";
const TRIP_B = "c1140000-0000-4000-8000-000000000042";
const TRIP_DELETE = "c1140000-0000-4000-8000-000000000043";
const TRIP_OTHER = "c1140000-0000-4000-8000-000000000044";

const NOTICE = "This template is not legal advice";
const BLANK = "[to be filled in]";

let creatorA = "";
let creatorB = "";

type Generated = {
  result: string;
  contract_id?: string;
  body?: string;
  title?: string;
  kind?: string;
};

async function generate(userId: string, pipelineId: string, kind: string): Promise<Generated> {
  const rows = await adminQuery<{ r: Generated }>(
    "select public.generate_collaboration_contract($1, $2, $3) as r",
    [userId, pipelineId, kind],
  );
  return rows[0]!.r;
}

async function contractsFor(
  pipelineId: string,
): Promise<{ id: string; creator_id: string; body: string }[]> {
  return adminQuery(
    "select id, creator_id, body from public.collaboration_contracts where pipeline_item_id = $1",
    [pipelineId],
  );
}

beforeAll(async () => {
  if (!hasTestDb) return;
  await setupDatabase();
  await adminQuery(
    `insert into auth.users (id, email) values ($1, 'ada-contract@test.local'), ($2, 'bea-contract@test.local')`,
    [USER_A, USER_B],
  );
  const creators = await adminQuery<{ user_id: string; id: string }>(
    "select user_id, id from public.creator_profiles where user_id = any($1::uuid[])",
    [[USER_A, USER_B]],
  );
  creatorA = creators.find((row) => row.user_id === USER_A)?.id ?? "";
  creatorB = creators.find((row) => row.user_id === USER_B)?.id ?? "";
  expect(creatorA).not.toBe("");
  expect(creatorB).not.toBe("");

  await adminQuery(
    `insert into public.destinations (id, name, slug, type, country_code, country_name)
     values ($1, 'Lisbon Coast', 'lisbon-coast-g01', 'city', 'PT', 'Portugal')`,
    [DEST],
  );
  await adminQuery(
    `insert into public.hotels (id, name, slug, destination_id, address)
     values
       ($1, 'Harbor House', 'harbor-house-g01', $7, null),
       ($2, 'Palm House', 'palm-house-g01', $7, '1 Rua Ada'),
       ($3, 'Negotiating House', 'negotiating-house-g01', $7, null),
       ($4, 'Unpaid House', 'unpaid-house-g01', $7, null),
       ($5, 'Undated House', 'undated-house-g01', $7, null),
       ($6, 'Trip House', 'trip-house-g01', $7, null)`,
    [HOTEL.shared, HOTEL.full, HOTEL.negotiating, HOTEL.unpaid, HOTEL.nodates, HOTEL.trip, DEST],
  );
  await adminQuery(
    `update public.creator_profiles
        set display_name = 'Ada Creator',
            home_city = 'Lisbon',
            home_country = 'Portugal',
            languages = '{English,Portuguese}',
            instagram_handle = 'ada'
      where id = $1`,
    [creatorA],
  );
  await adminQuery(
    `update public.creator_profiles set display_name = 'Bea Creator' where id = $1`,
    [creatorB],
  );
  await adminQuery(
    `insert into public.creator_self_reported_audience (creator_id, follower_count, engagement)
     values ($1, 99999, 'bea-only-engagement')`,
    [creatorB],
  );
  await adminQuery(
    `insert into public.trips (id, creator_id, destination_id, name, start_date, end_date)
     values
       ($1, $2, $5, 'Ada trip', '2026-11-01', '2026-11-04'),
       ($3, $4, $5, 'Bea trip', '2026-12-01', '2026-12-02'),
       ($6, $2, $5, 'Delete trip', '2026-08-01', '2026-08-03'),
       ($7, $2, $5, 'Other Ada trip', '2026-01-01', '2026-01-02')`,
    [TRIP_A, creatorA, TRIP_B, creatorB, DEST, TRIP_DELETE, TRIP_OTHER],
  );
  await adminQuery(
    `insert into public.pipeline_items (id, creator_id, hotel_id, trip_id, status)
     values
       ($1, $2, $3, $4, 'won'),
       ($5, $6, $3, $7, 'won'),
       ($8, $2, $9, null, 'won'),
       ($10, $2, $11, null, 'negotiating'),
       ($12, $2, $13, null, 'won'),
       ($14, $2, $15, null, 'won'),
       ($16, $2, $17, $18, 'won')`,
    [
      PIPE.blank,
      creatorA,
      HOTEL.shared,
      TRIP_A,
      PIPE.secret,
      creatorB,
      TRIP_B,
      PIPE.full,
      HOTEL.full,
      PIPE.negotiating,
      HOTEL.negotiating,
      PIPE.unpaid,
      HOTEL.unpaid,
      PIPE.nodates,
      HOTEL.nodates,
      PIPE.trip,
      HOTEL.trip,
      TRIP_DELETE,
    ],
  );
  await adminQuery(
    `insert into public.collaborations
       (id, creator_id, hotel_id, pipeline_item_id, status, collaboration_type, start_date, end_date)
     values
       ($1, $2, $3, $4, 'agreed', 'stay', '2026-11-02', '2026-11-03'),
       ($5, $6, $3, $7, 'agreed', 'paid', '2026-12-01', '2026-12-02'),
       ($8, $2, $9, $10, 'agreed', 'paid', '2026-06-01', '2026-06-04'),
       ($11, $2, $12, $13, 'agreed', 'stay', null, null),
       ($14, $2, $15, $16, 'agreed', null, null, null),
       ($17, $2, $18, $19, 'agreed', 'stay', '2026-08-01', '2026-08-02')`,
    [
      COLLAB.blank,
      creatorA,
      HOTEL.shared,
      PIPE.blank,
      COLLAB.secret,
      creatorB,
      PIPE.secret,
      COLLAB.full,
      HOTEL.full,
      PIPE.full,
      COLLAB.unpaid,
      HOTEL.unpaid,
      PIPE.unpaid,
      COLLAB.nodates,
      HOTEL.nodates,
      PIPE.nodates,
      COLLAB.trip,
      HOTEL.trip,
      PIPE.trip,
    ],
  );
  await adminQuery(
    `insert into public.collaboration_agreed_compensations
       (creator_id, collaboration_id, pipeline_item_id, structure, cash_amount_minor, cash_currency, payment_status)
     values ($1, $2, $3, 'paid', 50000, 'USD', 'pending')`,
    [creatorB, COLLAB.secret, PIPE.secret],
  );
  await adminQuery(
    `insert into public.collaboration_deliverables
       (creator_id, collaboration_id, pipeline_item_id, deliverable_type, quantity, notes)
     values ($1, $2, $3, 'reel', 1, 'Bea secret reel')`,
    [creatorB, COLLAB.secret, PIPE.secret],
  );
  await adminQuery(
    `insert into public.collaboration_agreed_compensations
       (creator_id, collaboration_id, pipeline_item_id, structure, cash_amount_minor, cash_currency, payment_status)
     values ($1, $2, $3, 'paid', 15000, 'USD', 'pending')`,
    [creatorA, COLLAB.full, PIPE.full],
  );
  await adminQuery(
    `insert into public.collaboration_deliverables
       (creator_id, collaboration_id, pipeline_item_id, deliverable_type, quantity, platform, due_on, status)
     values ($1, $2, $3, 'reel', 2, 'Instagram', '2026-11-02', 'pending')`,
    [creatorA, COLLAB.full, PIPE.full],
  );
  await adminQuery(
    `insert into public.collaboration_agreed_compensations
       (creator_id, collaboration_id, pipeline_item_id, structure, payment_status)
     values ($1, $2, $3, 'unpaid', 'not_applicable')`,
    [creatorA, COLLAB.unpaid, PIPE.unpaid],
  );
}, 120_000);

beforeEach(async () => {
  if (!hasTestDb) return;
  await adminQuery(
    `delete from public.collaboration_contracts where creator_id = any($1::uuid[])`,
    [[creatorA, creatorB]],
  );
  await adminQuery(`delete from public.contract_templates where creator_id = any($1::uuid[])`, [
    [creatorA, creatorB],
  ]);
  await adminQuery(
    `update public.creator_profiles
        set display_name = 'Ada Creator'
      where id = $1`,
    [creatorA],
  );
  await adminQuery(`delete from public.creator_self_reported_audience where creator_id = $1`, [
    creatorA,
  ]);
  await adminQuery(
    `delete from public.collaboration_agreed_compensations where collaboration_id = $1`,
    [COLLAB.blank],
  );
});

afterAll(async () => {
  await teardownDatabase();
});

d("G01 contract drafts", () => {
  it("fills a won deal from stored facts and leaves missing facts blank", async () => {
    const created = await generate(USER_A, PIPE.blank, "hotel_stay_barter");
    expect(created.result).toBe("created");
    const body = created.body ?? "";
    expect(body).toContain(NOTICE);
    expect(body).toContain("Ada Creator");
    expect(body).toContain("Lisbon, Portugal");
    expect(body).toContain("English, Portuguese");
    expect(body).toContain("ada");
    expect(body).toContain("Harbor House");
    expect(body).toContain("Lisbon Coast");
    expect(body).toContain("Portugal");
    expect(body).toContain("Ada trip");
    expect(body).toContain("2026-11-01");
    expect(body).toContain("2026-11-04");
    expect(body).toContain("Stay");
    expect(body).toContain("2026-11-02");
    expect(body).toContain("2026-11-03");
    expect(body).toContain(`Self-reported followers: ${BLANK}`);
    expect(body).toContain(`Self-reported engagement: ${BLANK}`);
    expect(body).toContain(`Address: ${BLANK}`);
    expect(body).toContain(`Compensation recorded on the deal:\n${BLANK}`);
    expect(body).toContain(`Deliverables recorded on the deal:\n${BLANK}`);
    expect(body).not.toContain("{{");
    expect(body).not.toContain("Bea Creator");
    expect(body).not.toContain("99999");
    expect(body).not.toContain("50000");
    expect(body).not.toContain("Bea secret");
    expect(body).not.toContain("Bea trip");
    expect(body).not.toContain("0 minor");

    const [row] = await adminQuery<{
      facts_snapshot: { audience_followers: number | null; compensation: unknown };
    }>("select facts_snapshot from public.collaboration_contracts where id = $1", [
      created.contract_id,
    ]);
    expect(row!.facts_snapshot.audience_followers).toBeNull();
    expect(row!.facts_snapshot.compensation).toBeNull();

    const [template] = await adminQuery<{ body: string; creator_id: string }>(
      "select body, creator_id from public.contract_templates where creator_id = $1 and kind = 'hotel_stay_barter'",
      [creatorA],
    );
    expect(template!.creator_id).toBe(creatorA);
    expect(template!.body).toContain("{{hotel_name}}");
    expect(template!.body).toContain(NOTICE);
  });

  it("copies recorded compensation and deliverables and does not scale the amount", async () => {
    const created = await generate(USER_A, PIPE.full, "paid");
    expect(created.result).toBe("created");
    expect(created.body).toContain("15000 minor units of USD");
    expect(created.body).toContain("Payment status: Pending");
    expect(created.body).toContain("2 Reel on Instagram, due 2026-11-02, status Pending");
    expect(created.body).toContain("Palm House");
    expect(created.body).toContain("1 Rua Ada");
    expect(created.body).not.toContain("150.00");
    expect(created.body).not.toContain(BLANK + " minor");
  });

  it("keeps an explicit unpaid agreement from becoming a cash figure", async () => {
    const created = await generate(USER_A, PIPE.unpaid, "hotel_stay_barter");
    expect(created.result).toBe("created");
    expect(created.body).toContain("Unpaid. No cash amount is stored.");
    expect(created.body).not.toContain("minor units");
    expect(created.body).not.toContain("0 USD");
  });

  it("does not invent dates when none were stored", async () => {
    const created = await generate(USER_A, PIPE.nodates, "usage_rights");
    expect(created.result).toBe("created");
    expect(created.body).toContain(`Trip start: ${BLANK}`);
    expect(created.body).toContain(`Trip end: ${BLANK}`);
    expect(created.body).toContain(`Collaboration start: ${BLANK}`);
    expect(created.body).toContain(`Collaboration end: ${BLANK}`);
    expect(created.body).toContain(`Collaboration type: ${BLANK}`);
    expect(created.body).toContain("Where the content may be used: [to be filled in]");
    expect(created.body).not.toMatch(/\d{4}-\d{2}-\d{2}/);
    expect(created.body).not.toContain("worldwide");
    expect(created.body).not.toContain("12 months");
  });

  it("keeps a recorded follower count of zero and never copies another creator's audience", async () => {
    await adminQuery(
      `insert into public.creator_self_reported_audience (creator_id, follower_count)
       values ($1, 0)`,
      [creatorA],
    );
    const created = await generate(USER_A, PIPE.blank, "paid");
    expect(created.body).toContain("Self-reported followers: 0");
    expect(created.body).not.toContain("99999");
    const [row] = await adminQuery<{ facts_snapshot: { audience_followers: number | null } }>(
      "select facts_snapshot from public.collaboration_contracts where id = $1",
      [created.contract_id],
    );
    expect(row!.facts_snapshot.audience_followers).toBe(0);
  });

  it("does not let one fact overwrite another", async () => {
    await adminQuery(
      `update public.creator_profiles set display_name = '{{hotel_name}}' where id = $1`,
      [creatorA],
    );
    const created = await generate(USER_A, PIPE.blank, "paid");
    expect(created.body).toContain("Creator: {{hotel_name}}");
    expect(created.body).toContain("Hotel: Harbor House");
  });

  it("leaves an unknown token alone", async () => {
    await generate(USER_A, PIPE.blank, "paid");
    await adminQuery(
      `update public.contract_templates
          set body = body || E'\n{{not_a_fact}}'
        where creator_id = $1 and kind = 'paid'`,
      [creatorA],
    );
    await adminQuery(`delete from public.collaboration_contracts where pipeline_item_id = $1`, [
      PIPE.blank,
    ]);
    const created = await generate(USER_A, PIPE.blank, "paid");
    expect(created.body).toContain("{{not_a_fact}}");
    expect(created.body).toContain("Harbor House");
  });

  it("refuses a deal that is not won and does not write a row", async () => {
    const created = await generate(USER_A, PIPE.negotiating, "paid");
    expect(created.result).toBe("not_won");
    expect(await contractsFor(PIPE.negotiating)).toEqual([]);
  });

  it("refuses another creator's won deal without writing or revealing it", async () => {
    const before = await contractsFor(PIPE.secret);
    const created = await generate(USER_A, PIPE.secret, "paid");
    expect(created.result).toBe("not_found");
    expect(created.body).toBeUndefined();
    expect(await contractsFor(PIPE.secret)).toEqual(before);
    const templates = await adminQuery<{ creator_id: string }>(
      "select creator_id from public.contract_templates where creator_id = $1",
      [creatorB],
    );
    expect(templates).toEqual([]);
  });

  it("does not add an outreach event", async () => {
    const [before] = await adminQuery<{ n: string }>(
      "select count(*)::text as n from public.outreach_events",
    );
    await generate(USER_A, PIPE.blank, "usage_rights");
    const [after] = await adminQuery<{ n: string }>(
      "select count(*)::text as n from public.outreach_events",
    );
    expect(after!.n).toBe(before!.n);
  });

  it("lets the owner edit and delete, and keeps the generation snapshot", async () => {
    const created = await generate(USER_A, PIPE.blank, "paid");
    const [before] = await adminQuery<{ facts_snapshot: unknown }>(
      "select facts_snapshot from public.collaboration_contracts where id = $1",
      [created.contract_id],
    );
    const nextBody = `${NOTICE} and it is not a signed contract.\n\nEdited by Ada.`;
    const [saved] = await adminQuery<{ r: { result: string } }>(
      "select public.update_collaboration_contract($1, $2, $3, $4) as r",
      [USER_A, created.contract_id, "Ada edited", nextBody],
    );
    expect(saved!.r.result).toBe("saved");
    const [after] = await adminQuery<{
      title: string;
      body: string;
      status: string;
      facts_snapshot: unknown;
    }>(
      "select title, body, status, facts_snapshot from public.collaboration_contracts where id = $1",
      [created.contract_id],
    );
    expect(after!.title).toBe("Ada edited");
    expect(after!.body).toBe(nextBody);
    expect(after!.status).toBe("draft");
    expect(after!.facts_snapshot).toEqual(before!.facts_snapshot);

    await adminQuery(
      `insert into public.collaboration_agreed_compensations
         (creator_id, collaboration_id, pipeline_item_id, structure, cash_amount_minor, cash_currency, payment_status)
       values ($1, $2, $3, 'paid', 15000, 'USD', 'pending')`,
      [creatorA, COLLAB.blank, PIPE.blank],
    );
    const [still] = await adminQuery<{ body: string }>(
      "select body from public.collaboration_contracts where id = $1",
      [created.contract_id],
    );
    expect(still!.body).not.toContain("15000");
    await adminQuery(
      `delete from public.collaboration_agreed_compensations where collaboration_id = $1`,
      [COLLAB.blank],
    );

    const [removed] = await adminQuery<{ r: { result: string } }>(
      "select public.delete_collaboration_contract($1, $2) as r",
      [USER_A, created.contract_id],
    );
    expect(removed!.r.result).toBe("deleted");
    expect(await contractsFor(PIPE.blank)).toEqual([]);
  });

  it("refuses to save a draft that drops the not-legal-advice sentence", async () => {
    const created = await generate(USER_A, PIPE.blank, "paid");
    const [saved] = await adminQuery<{ r: { result: string } }>(
      "select public.update_collaboration_contract($1, $2, 'Title', 'No notice here') as r",
      [USER_A, created.contract_id],
    );
    expect(saved!.r.result).toBe("disclaimer_required");
    const [row] = await adminQuery<{ body: string }>(
      "select body from public.collaboration_contracts where id = $1",
      [created.contract_id],
    );
    expect(row!.body).toContain(NOTICE);
  });

  it("returns not_found when User A updates or deletes User B's draft", async () => {
    const created = await generate(USER_B, PIPE.secret, "paid");
    expect(created.body).toContain("Bea Creator");
    expect(created.body).toContain("99999");
    expect(created.body).toContain("50000 minor units of USD");
    expect(created.body).toContain("Bea secret reel");
    const [updated] = await adminQuery<{ r: { result: string } }>(
      "select public.update_collaboration_contract($1, $2, 'Stolen', $3) as r",
      [USER_A, created.contract_id, `${NOTICE}\nStolen`],
    );
    expect(updated!.r.result).toBe("not_found");
    const [deleted] = await adminQuery<{ r: { result: string } }>(
      "select public.delete_collaboration_contract($1, $2) as r",
      [USER_A, created.contract_id],
    );
    expect(deleted!.r.result).toBe("not_found");
    const [row] = await adminQuery<{ body: string }>(
      "select body from public.collaboration_contracts where id = $1",
      [created.contract_id],
    );
    expect(row!.body).toContain("Bea Creator");
    expect(row!.body).not.toContain("Stolen");
  });

  it("hides User B's rows from User A under RLS, including update and delete", async () => {
    const ada = await generate(USER_A, PIPE.blank, "hotel_stay_barter");
    const bea = await generate(USER_B, PIPE.secret, "paid");

    const listed = await queryAs<{ id: string }>(
      { role: "authenticated", sub: USER_A },
      "select id from public.collaboration_contracts order by id",
    );
    expect(listed.error).toBeNull();
    expect(listed.rows.map((row) => row.id)).toEqual([ada.contract_id]);

    const templates = await queryAs<{ creator_id: string }>(
      { role: "authenticated", sub: USER_A },
      "select creator_id from public.contract_templates",
    );
    expect(templates.error).toBeNull();
    expect(templates.rows.every((row) => row.creator_id === creatorA)).toBe(true);
    expect(templates.rows.length).toBeGreaterThan(0);

    const updated = await commitAs<{ id: string }>(
      { role: "authenticated", sub: USER_A },
      `update public.collaboration_contracts
          set title = 'Stolen'
        where id = $1
        returning id`,
      [bea.contract_id],
    );
    expect(updated.error).toBeNull();
    expect(updated.rows).toEqual([]);

    const deleted = await commitAs<{ id: string }>(
      { role: "authenticated", sub: USER_A },
      "delete from public.collaboration_contracts where id = $1 returning id",
      [bea.contract_id],
    );
    expect(deleted.error).toBeNull();
    expect(deleted.rows).toEqual([]);

    const [still] = await adminQuery<{ title: string }>(
      "select title from public.collaboration_contracts where id = $1",
      [bea.contract_id],
    );
    expect(still!.title).not.toBe("Stolen");

    const inserted = await queryAs(
      { role: "authenticated", sub: USER_A },
      `insert into public.contract_templates (creator_id, kind, title, body)
       values ($1, 'usage_rights', 'Usage rights', $2)`,
      [creatorB, `${NOTICE}\nno`],
    );
    expect(inserted.error).not.toBeNull();
  });

  it("rejects anon and an authenticated execute of the generator", async () => {
    const anon = await queryAs({ role: "anon" }, "select id from public.collaboration_contracts");
    expect(anon.error).not.toBeNull();
    const called = await queryAs(
      { role: "authenticated", sub: USER_A },
      "select public.generate_collaboration_contract($1, $2, 'paid')",
      [USER_B, PIPE.secret],
    );
    expect(called.error).not.toBeNull();
  });

  it("rejects a draft that points at another creator's collaboration, template, or trip", async () => {
    const ada = await generate(USER_A, PIPE.full, "paid");
    const bea = await generate(USER_B, PIPE.secret, "hotel_stay_barter");
    const [adaTemplate] = await adminQuery<{ id: string }>(
      "select id from public.contract_templates where creator_id = $1 and kind = 'paid'",
      [creatorA],
    );
    const [beaTemplate] = await adminQuery<{ id: string }>(
      "select id from public.contract_templates where creator_id = $1 and kind = 'hotel_stay_barter'",
      [creatorB],
    );

    await expect(
      adminQuery(
        `insert into public.collaboration_contracts
           (creator_id, template_id, collaboration_id, pipeline_item_id, kind, title, body, facts_snapshot)
         values ($1, $2, $3, $4, 'paid', 'Paid collaboration', $5, '{}'::jsonb)`,
        [creatorA, adaTemplate!.id, COLLAB.secret, PIPE.full, `${NOTICE}\nno`],
      ),
    ).rejects.toThrow(/contract_scope|foreign key|collaborations_id_creator/i);

    await expect(
      adminQuery(
        `insert into public.collaboration_contracts
           (creator_id, template_id, collaboration_id, pipeline_item_id, kind, title, body, facts_snapshot)
         values ($1, $2, $3, $4, 'hotel_stay_barter', 'Hotel stay / barter', $5, '{}'::jsonb)`,
        [creatorA, beaTemplate!.id, COLLAB.full, PIPE.full, `${NOTICE}\nno`],
      ),
    ).rejects.toThrow(/contract_scope|foreign key|contract_templates/i);

    await expect(
      adminQuery(
        `insert into public.collaboration_contracts
           (creator_id, template_id, collaboration_id, pipeline_item_id, trip_id, kind, title, body, facts_snapshot)
         values ($1, $2, $3, $4, $5, 'paid', 'Paid collaboration', $6, '{}'::jsonb)`,
        [creatorA, adaTemplate!.id, COLLAB.full, PIPE.full, TRIP_B, `${NOTICE}\nno`],
      ),
    ).rejects.toThrow(/contract_scope|foreign key|trips_id_creator/i);

    await expect(
      adminQuery(
        `insert into public.collaboration_contracts
           (creator_id, template_id, collaboration_id, pipeline_item_id, trip_id, kind, title, body, facts_snapshot)
         values ($1, $2, $3, $4, $5, 'paid', 'Paid collaboration', $6, '{}'::jsonb)`,
        [creatorA, adaTemplate!.id, COLLAB.full, PIPE.full, TRIP_OTHER, `${NOTICE}\nno`],
      ),
    ).rejects.toThrow(/contract_scope: trip/);

    await expect(
      adminQuery(
        `update public.collaboration_contracts
            set status = 'signed'
          where id = $1`,
        [ada.contract_id],
      ),
    ).rejects.toThrow(/draft|check|status/i);

    expect(bea.contract_id).toBeTruthy();
  });

  it("refuses generation when the filled text would have to be cut off", async () => {
    await adminQuery(
      `update public.creator_profiles set display_name = repeat('n', 60000) where id = $1`,
      [creatorA],
    );
    const created = await generate(USER_A, PIPE.nodates, "paid");
    expect(created.result).toBe("too_long");
    expect(await contractsFor(PIPE.nodates)).toEqual([]);
  });

  it("clears the live trip id when the trip is deleted and keeps the drafted dates", async () => {
    const created = await generate(USER_A, PIPE.trip, "hotel_stay_barter");
    expect(created.body).toContain("2026-08-01");
    await adminQuery("delete from public.trips where id = $1", [TRIP_DELETE]);
    const [row] = await adminQuery<{ trip_id: string | null; body: string }>(
      "select trip_id, body from public.collaboration_contracts where id = $1",
      [created.contract_id],
    );
    expect(row!.trip_id).toBeNull();
    expect(row!.body).toContain("2026-08-01");
    await adminQuery(
      `insert into public.trips (id, creator_id, destination_id, name, start_date, end_date)
       values ($1, $2, $3, 'Delete trip', '2026-08-01', '2026-08-03')`,
      [TRIP_DELETE, creatorA, DEST],
    );
    await adminQuery("update public.pipeline_items set trip_id = $1 where id = $2", [
      TRIP_DELETE,
      PIPE.trip,
    ]);
  });
});
