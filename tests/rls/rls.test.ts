/**
 * RLS / permission tests — the automated coverage required by PERMISSIONS.md §13
 * and the Sprint 0 Definition of Done ("private ownership policies have tests").
 *
 * Each case impersonates a role + user and asserts what rows the policies allow.
 * Denial can surface either as a grant-level rejection (no table privilege) or
 * as zero visible rows (RLS filter); both mean "cannot access", captured by the
 * `denied()` helper.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  adminQuery,
  hasTestDb,
  queryAs,
  setupDatabase,
  teardownDatabase,
  type AsResult,
} from "../db/harness";
import { DEST, HOTEL, TRIP, USERS, seed, type CreatorIds } from "./seed";

/** A read is "denied" if it errored (no grant) or returned no rows. */
function denied(res: AsResult<unknown>): boolean {
  return res.error !== null || res.rows.length === 0;
}

const d = describe.skipIf(!hasTestDb);

let creators: CreatorIds;

beforeAll(async () => {
  if (!hasTestDb) return;
  await setupDatabase();
  creators = await seed();
}, 120_000);

afterAll(async () => {
  await teardownDatabase();
});

d("hotel_contacts access (PERMISSIONS.md §7, §13.1–§13.6)", () => {
  it("anonymous cannot select any hotel contact", async () => {
    const res = await queryAs({ role: "anon" }, "select id from public.hotel_contacts");
    expect(denied(res)).toBe(true);
  });

  it("free creator cannot select any hotel contact", async () => {
    const res = await queryAs(
      { role: "authenticated", sub: USERS.free },
      "select id from public.hotel_contacts",
    );
    expect(res.rows).toHaveLength(0);
  });

  it("destination user CAN select entitled (Bali) contact", async () => {
    const res = await queryAs(
      { role: "authenticated", sub: USERS.destBali },
      "select id from public.hotel_contacts where hotel_id = $1",
      [HOTEL.bali],
    );
    expect(res.error).toBeNull();
    expect(res.rows).toHaveLength(1);
  });

  it("destination user CANNOT select non-entitled (Ibiza) contact", async () => {
    const res = await queryAs(
      { role: "authenticated", sub: USERS.destBali },
      "select id from public.hotel_contacts where hotel_id = $1",
      [HOTEL.ibiza],
    );
    expect(res.rows).toHaveLength(0);
  });

  it("parent (Bali) pass covers descendant (Ubud) hotel contact", async () => {
    const res = await queryAs(
      { role: "authenticated", sub: USERS.destBali },
      "select id from public.hotel_contacts where hotel_id = $1",
      [HOTEL.ubud],
    );
    expect(res.error).toBeNull();
    expect(res.rows).toHaveLength(1);
  });

  it("pro user can select worldwide contacts", async () => {
    const res = await queryAs(
      { role: "authenticated", sub: USERS.pro },
      "select id from public.hotel_contacts",
    );
    expect(res.error).toBeNull();
    expect(res.rows.length).toBe(3);
  });

  it("revoked entitlement removes premium contact access (§13.15)", async () => {
    const res = await queryAs(
      { role: "authenticated", sub: USERS.revoked },
      "select id from public.hotel_contacts",
    );
    expect(res.rows).toHaveLength(0);
  });
});

d("creator ownership isolation (PERMISSIONS.md §5, §13.7–§13.9)", () => {
  it("creator A cannot read creator B's pipeline items", async () => {
    const res = await queryAs(
      { role: "authenticated", sub: USERS.destBali },
      "select id, private_notes from public.pipeline_items where creator_id = $1",
      [creators.pro],
    );
    expect(res.rows).toHaveLength(0);
  });

  it("creator A sees only their own pipeline items", async () => {
    const res = await queryAs(
      { role: "authenticated", sub: USERS.destBali },
      "select creator_id from public.pipeline_items",
    );
    expect(res.error).toBeNull();
    expect(res.rows).toHaveLength(1);
    expect(res.rows[0]).toMatchObject({ creator_id: creators.destBali });
  });

  it("creator A cannot update creator B's trip", async () => {
    const res = await queryAs(
      { role: "authenticated", sub: USERS.destBali },
      "update public.trips set name = 'hacked' where id = $1 returning id",
      [TRIP.pro],
    );
    // RLS filters the row out: zero rows updated, no error.
    expect(res.rows).toHaveLength(0);
    // Confirm the row is unchanged.
    const check = await adminQuery<{ name: string | null }>(
      "select name from public.trips where id = $1",
      [TRIP.pro],
    );
    expect(check[0]?.name).not.toBe("hacked");
  });

  it("creator A cannot insert an outreach event under creator B's identity", async () => {
    // Need a pipeline item id owned by B to reference.
    const bPipeline = await adminQuery<{ id: string }>(
      "select id from public.pipeline_items where creator_id = $1 limit 1",
      [creators.pro],
    );
    const res = await queryAs(
      { role: "authenticated", sub: USERS.destBali },
      `insert into public.outreach_events
         (creator_id, hotel_id, pipeline_item_id, event_type, event_at)
       values ($1, $2, $3, 'pitch_sent', now()) returning id`,
      [creators.pro, HOTEL.ibiza, bPipeline[0]!.id],
    );
    // WITH CHECK violation → error.
    expect(res.error).not.toBeNull();
  });

  it("creator A CAN insert an outreach event under their own identity", async () => {
    const aPipeline = await adminQuery<{ id: string }>(
      "select id from public.pipeline_items where creator_id = $1 limit 1",
      [creators.destBali],
    );
    const res = await queryAs(
      { role: "authenticated", sub: USERS.destBali },
      `insert into public.outreach_events
         (creator_id, hotel_id, pipeline_item_id, event_type, event_at)
       values ($1, $2, $3, 'pitch_sent', now()) returning id`,
      [creators.destBali, HOTEL.bali, aPipeline[0]!.id],
    );
    expect(res.error).toBeNull();
    expect(res.rows).toHaveLength(1);
  });

  it("anonymous cannot read outreach_events (§13.10)", async () => {
    const res = await queryAs({ role: "anon" }, "select id from public.outreach_events");
    expect(denied(res)).toBe(true);
  });
});

d("editor boundaries (PERMISSIONS.md §6, §13.12)", () => {
  it("editor cannot read creator private notes via ordinary select", async () => {
    const res = await queryAs(
      { role: "authenticated", sub: USERS.editor },
      "select id, private_notes from public.pipeline_items",
    );
    // Editor is not the owner: pipeline is invisible, private notes unreachable.
    expect(res.rows).toHaveLength(0);
  });

  it("editor CAN write hotel editorial data", async () => {
    const res = await queryAs(
      { role: "authenticated", sub: USERS.editor },
      "update public.hotels set description_short = 'edited' where id = $1 returning id",
      [HOTEL.bali],
    );
    expect(res.error).toBeNull();
    expect(res.rows).toHaveLength(1);
  });

  it("creator (non-editor) cannot write hotel editorial data", async () => {
    const res = await queryAs(
      { role: "authenticated", sub: USERS.free },
      "update public.hotels set description_short = 'nope' where id = $1 returning id",
      [HOTEL.bali],
    );
    expect(res.rows).toHaveLength(0);
  });
});

d("expiry/retention (PERMISSIONS.md §8, §13.13)", () => {
  it("expired pass loses premium contact access", async () => {
    const res = await queryAs(
      { role: "authenticated", sub: USERS.expired },
      "select id from public.hotel_contacts",
    );
    expect(res.rows).toHaveLength(0);
  });

  it("expired pass RETAINS own pipeline/workspace", async () => {
    const res = await queryAs(
      { role: "authenticated", sub: USERS.expired },
      "select id from public.pipeline_items",
    );
    expect(res.error).toBeNull();
    expect(res.rows).toHaveLength(1);
  });
});

d("commerce authorization (PERMISSIONS.md §12)", () => {
  it("creator cannot insert their own paid entitlement", async () => {
    const res = await queryAs(
      { role: "authenticated", sub: USERS.free },
      `insert into public.access_entitlements (user_id, access_type, status, starts_at)
         values ($1, 'pro', 'active', now()) returning id`,
      [USERS.free],
    );
    expect(res.error).not.toBeNull();
  });

  it("creator can read only their own entitlements", async () => {
    const res = await queryAs(
      { role: "authenticated", sub: USERS.pro },
      "select user_id from public.access_entitlements",
    );
    expect(res.error).toBeNull();
    expect(res.rows.every((r) => (r as { user_id: string }).user_id === USERS.pro)).toBe(true);
  });
});

d("public intelligence safety (PERMISSIONS.md §6, §13.11; PRD §12)", () => {
  it("public intelligence view exposes no creator identifiers", async () => {
    const cols = await adminQuery<{ column_name: string }>(
      `select column_name from information_schema.columns
         where table_schema = 'public' and table_name = 'hotel_public_intelligence'`,
    );
    const names = cols.map((c) => c.column_name);
    expect(names).not.toContain("creator_id");
    expect(names).not.toContain("pipeline_item_id");
    expect(names).not.toContain("private_notes");
    expect(names).not.toContain("private_value_amount");
  });

  it("low-confidence intelligence suppresses precise reply_rate in the view", async () => {
    await adminQuery(
      `insert into public.hotel_intelligence (hotel_id, reply_rate, confidence_level, collaboration_count)
         values ($1, 0.9, 'insufficient', 0)
       on conflict (hotel_id) do update set reply_rate = excluded.reply_rate,
         confidence_level = excluded.confidence_level`,
      [HOTEL.ibiza],
    );
    const res = await queryAs(
      { role: "anon" },
      "select reply_rate from public.hotel_public_intelligence where hotel_id = $1",
      [HOTEL.ibiza],
    );
    expect(res.error).toBeNull();
    expect(res.rows).toHaveLength(1);
    expect((res.rows[0] as { reply_rate: number | null }).reply_rate).toBeNull();
  });

  it("strong-confidence intelligence reveals reply_rate in the view", async () => {
    await adminQuery(
      `insert into public.hotel_intelligence (hotel_id, reply_rate, confidence_level, collaboration_count)
         values ($1, 0.63, 'strong', 2)
       on conflict (hotel_id) do update set reply_rate = excluded.reply_rate,
         confidence_level = excluded.confidence_level, collaboration_count = excluded.collaboration_count`,
      [HOTEL.bali],
    );
    const res = await queryAs(
      { role: "anon" },
      `select reply_rate, has_confirmed_collaboration
         from public.hotel_public_intelligence where hotel_id = $1`,
      [HOTEL.bali],
    );
    expect(res.error).toBeNull();
    const row = res.rows[0] as {
      reply_rate: number | null;
      has_confirmed_collaboration: boolean;
    };
    expect(Number(row.reply_rate)).toBeCloseTo(0.63);
    expect(row.has_confirmed_collaboration).toBe(true);
  });
});

d("privilege escalation guard (DATABASE.md §3, PRD §33.4)", () => {
  it("authenticated user cannot elevate their own role", async () => {
    const res = await queryAs(
      { role: "authenticated", sub: USERS.free },
      "update public.users set role = 'admin' where id = $1 returning role",
      [USERS.free],
    );
    // Trigger raises regardless of any row-update policy.
    expect(res.error).not.toBeNull();
  });
});
