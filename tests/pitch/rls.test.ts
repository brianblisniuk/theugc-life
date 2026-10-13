/**
 * User A cannot read or change User B's pitch templates or drafts (D110).
 * A draft insert does not write outreach_events.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  adminQuery,
  commitAs,
  hasTestDb,
  queryAs,
  setupDatabase,
  teardownDatabase,
} from "../db/harness";

const d = describe.skipIf(!hasTestDb);

const USER_A = "f0200000-0000-4000-8000-00000000000a";
const USER_B = "f0200000-0000-4000-8000-00000000000b";
const DEST = "f0200000-0000-4000-8000-0000000000d1";
const HOTEL = "f0200000-0000-4000-8000-0000000000a1";
const SECRET = "b-pitch-secret-body";

let creatorA = "";
let creatorB = "";
let tripB = "";
let templateB = "";
let draftB = "";

beforeAll(async () => {
  if (!hasTestDb) return;
  await setupDatabase();
  await adminQuery("insert into auth.users (id, email) values ($1, $2), ($3, $4)", [
    USER_A,
    "pitch-a@test.local",
    USER_B,
    "pitch-b@test.local",
  ]);
  await adminQuery(
    `insert into public.destinations (id, name, slug, type) values ($1, 'Pitch Bay', 'pitch-bay', 'city')`,
    [DEST],
  );
  await adminQuery(
    `insert into public.hotels (id, name, slug, destination_id) values ($1, 'Casa Pitch', 'casa-pitch', $2)`,
    [HOTEL, DEST],
  );
  const profiles = await adminQuery<{ user_id: string; id: string }>(
    "select user_id, id from public.creator_profiles where user_id = any($1::uuid[])",
    [[USER_A, USER_B]],
  );
  creatorA = profiles.find((row) => row.user_id === USER_A)?.id ?? "";
  creatorB = profiles.find((row) => row.user_id === USER_B)?.id ?? "";
  const trip = await adminQuery<{ id: string }>(
    `insert into public.trips (creator_id, destination_id, name, start_date, end_date)
     values ($1, $2, 'B trip', '2026-12-01', '2026-12-08') returning id`,
    [creatorB, DEST],
  );
  tripB = trip[0]!.id;
  const template = await adminQuery<{ id: string }>(
    `insert into public.pitch_templates (creator_id, name, subject, body)
     values ($1, 'B template', 'B subject', $2) returning id`,
    [creatorB, SECRET],
  );
  templateB = template[0]!.id;
  const draft = await adminQuery<{ id: string }>(
    `insert into public.pitch_drafts (creator_id, hotel_id, subject, body)
     values ($1, $2, 'B draft', $3) returning id`,
    [creatorB, HOTEL, SECRET],
  );
  draftB = draft[0]!.id;
}, 120_000);

afterAll(async () => {
  await teardownDatabase();
});

d("pitch template isolation", () => {
  it("lets A read and write A's template and hides B", async () => {
    const inserted = await queryAs<{ id: string; creator_id: string }>(
      { role: "authenticated", sub: USER_A },
      `insert into public.pitch_templates (name, subject, body)
       values ('A template', 'Hello', 'From A')
       returning id, creator_id`,
    );
    expect(inserted.error).toBeNull();
    expect(inserted.rows[0]?.creator_id).toBe(creatorA);

    const hidden = await queryAs<{ body: string }>(
      { role: "authenticated", sub: USER_A },
      "select body from public.pitch_templates where id = $1",
      [templateB],
    );
    expect(hidden.rows).toEqual([]);
    expect(JSON.stringify(hidden)).not.toContain(SECRET);

    const anon = await queryAs(
      { role: "anon", sub: null },
      "select id from public.pitch_templates",
    );
    expect(anon.error).not.toBeNull();
    expect(anon.error!.message).toMatch(/permission denied/i);
  });

  it("refuses to store B as the owner or B's trip on A's draft", async () => {
    const owner = await queryAs(
      { role: "authenticated", sub: USER_A },
      `insert into public.pitch_templates (creator_id, name, subject, body)
       values ($1, 'Stolen', 'Stolen', 'Stolen')`,
      [creatorB],
    );
    expect(owner.error).not.toBeNull();

    const trip = await queryAs(
      { role: "authenticated", sub: USER_A },
      `insert into public.pitch_drafts (hotel_id, trip_id, subject, body)
       values ($1, $2, 'Trip', 'Body')`,
      [HOTEL, tripB],
    );
    expect(trip.error).not.toBeNull();

    const template = await queryAs(
      { role: "authenticated", sub: USER_A },
      `insert into public.pitch_drafts (hotel_id, template_id, subject, body)
       values ($1, $2, 'Tpl', 'Body')`,
      [HOTEL, templateB],
    );
    expect(template.error).not.toBeNull();

    const emailKey = await queryAs(
      { role: "authenticated", sub: USER_A },
      `insert into public.pitch_drafts (hotel_id, subject, body, variables_used)
       values ($1, 'Sub', 'Body', '["email"]'::jsonb)`,
      [HOTEL],
    );
    expect(emailKey.error).not.toBeNull();
  });

  it("does not let A update or delete B, and a draft is not an outreach event", async () => {
    const triggers = await adminQuery<{ tgname: string }>(
      `select t.tgname
         from pg_trigger t
         join pg_class c on c.oid = t.tgrelid
         join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'public'
          and c.relname = 'pitch_drafts'
          and not t.tgisinternal
        order by t.tgname`,
    );
    expect(triggers.map((row) => row.tgname)).toEqual([
      "pitch_drafts_owner",
      "pitch_drafts_set_updated_at",
    ]);

    const updated = await commitAs<{ id: string }>(
      { role: "authenticated", sub: USER_A },
      `update public.pitch_drafts set body = 'hacked' where id = $1 returning id`,
      [draftB],
    );
    expect(updated.error).toBeNull();
    expect(updated.rows).toEqual([]);
    const still = await adminQuery<{ body: string }>(
      "select body from public.pitch_drafts where id = $1",
      [draftB],
    );
    expect(still[0]?.body).toBe(SECRET);

    const removed = await commitAs<{ id: string }>(
      { role: "authenticated", sub: USER_A },
      `delete from public.pitch_templates where id = $1 returning id`,
      [templateB],
    );
    expect(removed.rows).toEqual([]);
    const template = await adminQuery<{ id: string }>(
      "select id from public.pitch_templates where id = $1",
      [templateB],
    );
    expect(template).toHaveLength(1);

    const draft = await commitAs<{ id: string }>(
      { role: "authenticated", sub: USER_A },
      `insert into public.pitch_drafts (hotel_id, subject, body)
       values ($1, 'A subject', 'A body') returning id`,
      [HOTEL],
    );
    expect(draft.error).toBeNull();

    const delivery = await commitAs<{ delivery: string }>(
      { role: "authenticated", sub: USER_A },
      `update public.pitch_drafts set delivery = 'mailto_opened' where id = $1 returning delivery`,
      [draft.rows[0]!.id],
    );
    expect(delivery.rows[0]?.delivery).toBe("mailto_opened");
    const events = await adminQuery<{ n: number }>(
      "select count(*)::int as n from public.outreach_events where creator_id = $1",
      [creatorA],
    );
    expect(events[0]?.n).toBe(0);

    await adminQuery("delete from public.pitch_drafts where id = $1", [draft.rows[0]!.id]);
  });
});
