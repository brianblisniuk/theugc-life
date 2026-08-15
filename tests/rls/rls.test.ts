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
    // The INSERT grant is gone (0020); the WITH CHECK policy remains behind it.
    expect(res.error).not.toBeNull();
  });

  it("creator A cannot insert an outreach event even under their OWN identity (0020)", async () => {
    // Before 0020 this was allowed, and a creator could write arbitrary
    // pitch/reply/deal events straight into the ledger that intelligence
    // aggregates. Events now come only from trusted server RPCs.
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
    expect(res.error).not.toBeNull();
    expect(res.error!.message).toMatch(/permission denied/i);
  });

  it("creator A CAN still read their own outreach events", async () => {
    const res = await queryAs(
      { role: "authenticated", sub: USERS.destBali },
      "select id from public.outreach_events",
    );
    expect(res.error).toBeNull();
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

  it("the public view does not project reply_rate at all (D050)", async () => {
    // 0026 removed the column. This is stronger than suppression: there is no
    // confidence band, and no privilege, that can produce it publicly.
    const cols = await adminQuery<{ column_name: string }>(
      `select column_name from information_schema.columns
         where table_schema = 'public' and table_name = 'hotel_public_intelligence'`,
    );
    expect(cols.map((c) => c.column_name)).not.toContain("reply_rate");

    const res = await queryAs(
      { role: "anon" },
      "select reply_rate from public.hotel_public_intelligence limit 1",
    );
    expect(res.error).not.toBeNull();
  });

  it("anon holds no privilege on the premium view whatsoever", async () => {
    const [priv] = await adminQuery<{ ok: boolean }>(
      "select has_table_privilege('anon','public.hotel_premium_intelligence','SELECT') as ok",
    );
    expect(priv!.ok).toBe(false);

    const res = await queryAs(
      { role: "anon" },
      "select reply_rate from public.hotel_premium_intelligence limit 1",
    );
    expect(res.error).not.toBeNull();
  });

  it("collaboration presence is positive-only and needs 3 distinct creators", async () => {
    // Two collaborating creators, high confidence: still withheld. `false`
    // would assert that this hotel does not collaborate with creators, which
    // too little observed evidence cannot prove.
    await adminQuery(
      `insert into public.hotel_intelligence
         (hotel_id, confidence_level, collaboration_count, distinct_collaboration_creators_365d)
       values ($1, 'strong', 9, 2)
       on conflict (hotel_id) do update set
         confidence_level = excluded.confidence_level,
         collaboration_count = excluded.collaboration_count,
         distinct_collaboration_creators_365d = excluded.distinct_collaboration_creators_365d`,
      [HOTEL.bali],
    );
    let res = await queryAs<{ has_observed_collaboration: boolean | null }>(
      { role: "anon" },
      "select has_observed_collaboration from public.hotel_public_intelligence where hotel_id = $1",
      [HOTEL.bali],
    );
    expect(res.error).toBeNull();
    expect(res.rows[0]!.has_observed_collaboration).toBeNull();
    expect(res.rows[0]!.has_observed_collaboration).not.toBe(false);

    // A third distinct collaborating creator, and the presence signal publishes.
    await adminQuery(
      "update public.hotel_intelligence set distinct_collaboration_creators_365d = 3 where hotel_id = $1",
      [HOTEL.bali],
    );
    res = await queryAs<{ has_observed_collaboration: boolean | null }>(
      { role: "anon" },
      "select has_observed_collaboration from public.hotel_public_intelligence where hotel_id = $1",
      [HOTEL.bali],
    );
    expect(res.rows[0]!.has_observed_collaboration).toBe(true);
  });

  it("public activity needs 3 distinct recent creators, and withholding is not 'low'", async () => {
    await adminQuery(
      `insert into public.hotel_intelligence
         (hotel_id, confidence_level, activity_level, distinct_creators_90d)
       values ($1, 'strong', 'high', 2)
       on conflict (hotel_id) do update set
         confidence_level = excluded.confidence_level,
         activity_level = excluded.activity_level,
         distinct_creators_90d = excluded.distinct_creators_90d`,
      [HOTEL.ubud],
    );
    let res = await queryAs<{ activity_level: string | null }>(
      { role: "anon" },
      "select activity_level from public.hotel_public_intelligence where hotel_id = $1",
      [HOTEL.ubud],
    );
    expect(res.rows[0]!.activity_level).toBeNull();
    expect(res.rows[0]!.activity_level).not.toBe("low");

    await adminQuery(
      "update public.hotel_intelligence set distinct_creators_90d = 3 where hotel_id = $1",
      [HOTEL.ubud],
    );
    res = await queryAs<{ activity_level: string | null }>(
      { role: "anon" },
      "select activity_level from public.hotel_public_intelligence where hotel_id = $1",
      [HOTEL.ubud],
    );
    expect(res.rows[0]!.activity_level).toBe("high");
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

d("authorization helper exposure (Sprint 0.1 hardening)", () => {
  // User A (free) must not be able to learn User B's (pro) entitlement/role
  // state through any helper reachable over the client RPC surface.

  it("A cannot call the private arbitrary-user pro helper for B", async () => {
    const res = await queryAs(
      { role: "authenticated", sub: USERS.free },
      "select public._has_active_pro($1) as v",
      [USERS.pro],
    );
    // EXECUTE revoked from PUBLIC → permission denied for function.
    expect(res.error).not.toBeNull();
  });

  it("no arbitrary-user pro helper signature is exposed to clients", async () => {
    const res = await queryAs(
      { role: "authenticated", sub: USERS.free },
      "select public.has_active_pro($1) as v",
      [USERS.pro],
    );
    // Only the no-arg self-scoped wrapper exists → function does not exist.
    expect(res.error).not.toBeNull();
  });

  it("A cannot probe B's destination entitlement via the private helper", async () => {
    const res = await queryAs(
      { role: "authenticated", sub: USERS.free },
      "select public._has_active_destination_access($1, $2) as v",
      [USERS.destBali, DEST.bali],
    );
    expect(res.error).not.toBeNull();
  });

  it("A cannot probe another user's role via the private helper", async () => {
    const res = await queryAs(
      { role: "authenticated", sub: USERS.free },
      "select public._is_admin_or_editor($1) as v",
      [USERS.admin],
    );
    expect(res.error).not.toBeNull();
  });

  it("A cannot probe B's premium hotel access via the private helper", async () => {
    const res = await queryAs(
      { role: "authenticated", sub: USERS.free },
      "select public._has_premium_hotel_access($1, $2) as v",
      [USERS.pro, HOTEL.ibiza],
    );
    expect(res.error).not.toBeNull();
  });

  it("self-scoped helpers only ever reflect the caller (cannot substitute B)", async () => {
    // Free caller: false. Pro caller: true. The client cannot pass a user id,
    // so it can only ever observe its own authorization state.
    const asFree = await queryAs<{ v: boolean }>(
      { role: "authenticated", sub: USERS.free },
      "select public.has_active_pro() as v",
    );
    expect(asFree.error).toBeNull();
    expect(asFree.rows[0]?.v).toBe(false);

    const asPro = await queryAs<{ v: boolean }>(
      { role: "authenticated", sub: USERS.pro },
      "select public.has_active_pro() as v",
    );
    expect(asPro.error).toBeNull();
    expect(asPro.rows[0]?.v).toBe(true);
  });

  it("self-scoped destination helper reflects only the caller's entitlement", async () => {
    const asDest = await queryAs<{ v: boolean }>(
      { role: "authenticated", sub: USERS.destBali },
      "select public.has_active_destination_access($1) as v",
      [DEST.bali],
    );
    expect(asDest.error).toBeNull();
    expect(asDest.rows[0]?.v).toBe(true);

    const asFree = await queryAs<{ v: boolean }>(
      { role: "authenticated", sub: USERS.free },
      "select public.has_active_destination_access($1) as v",
      [DEST.bali],
    );
    expect(asFree.error).toBeNull();
    expect(asFree.rows[0]?.v).toBe(false);
  });
});

d("server-mediated growth writes (Sprint 0.1 hardening)", () => {
  it("anonymous cannot directly insert a hotel_claim", async () => {
    const res = await queryAs(
      { role: "anon" },
      "insert into public.hotel_claims (hotel_id, claimant_email) values ($1, $2)",
      [HOTEL.bali, "claimer@example.com"],
    );
    expect(res.error).not.toBeNull();
  });

  it("authenticated cannot directly insert a hotel_claim", async () => {
    const res = await queryAs(
      { role: "authenticated", sub: USERS.free },
      "insert into public.hotel_claims (hotel_id, claimant_email) values ($1, $2)",
      [HOTEL.bali, "claimer@example.com"],
    );
    expect(res.error).not.toBeNull();
  });

  it("anonymous cannot directly insert a public_creator_profile_view", async () => {
    const res = await queryAs(
      { role: "anon" },
      "insert into public.public_creator_profile_views (creator_id) values ($1)",
      [creators.pro],
    );
    expect(res.error).not.toBeNull();
  });

  it("authenticated cannot directly insert a public_creator_profile_view", async () => {
    const res = await queryAs(
      { role: "authenticated", sub: USERS.free },
      "insert into public.public_creator_profile_views (creator_id) values ($1)",
      [creators.pro],
    );
    expect(res.error).not.toBeNull();
  });
});

d("import/provenance internals are admin-only (Sprint 1A; IMPORT_SPEC §12)", () => {
  beforeAll(async () => {
    if (!hasTestDb) return;
    await adminQuery(
      `insert into public.import_batches (id, source_name, source_kind, parser_name, parser_version)
         values ('e1000000-0000-0000-0000-000000000001','seed','canonical','canonical-standard','1.0.0')
       on conflict do nothing`,
    );
    await adminQuery(
      `insert into public.import_rows
         (id, import_batch_id, row_kind, raw_fingerprint, validation_status)
         values ('e2000000-0000-0000-0000-000000000001','e1000000-0000-0000-0000-000000000001',
                 'property','fp-1','valid')
       on conflict do nothing`,
    );
    await adminQuery(
      `insert into public.editorial_evidence (id, claim_type, source_type, verification_status)
         values ('e3000000-0000-0000-0000-000000000001','property_exists','official_website','verified')
       on conflict do nothing`,
    );
    await adminQuery(
      `insert into public.organizations (id, name, normalized_name, org_type)
         values ('e4000000-0000-0000-0000-000000000001','Acme Hotels','acme hotels','hotel_group')
       on conflict do nothing`,
    );
  });

  const internalTables = [
    "import_batches",
    "import_rows",
    "import_match_candidates",
    "import_row_links",
    "editorial_evidence",
    "organizations",
    "hotel_organizations",
    "organization_contacts",
    // Sprint 1B review/catalog internals.
    "destination_aliases",
    "import_property_reviews",
    "import_row_reviews",
  ];

  it("creator cannot read any import/provenance internal table", async () => {
    for (const table of internalTables) {
      const res = await queryAs(
        { role: "authenticated", sub: USERS.free },
        `select * from public.${table}`,
      );
      // Either RLS filters to zero rows or the grant is absent — never data.
      expect(res.rows).toHaveLength(0);
    }
  });

  it("anonymous cannot read import/provenance internal tables", async () => {
    for (const table of internalTables) {
      const res = await queryAs({ role: "anon" }, `select * from public.${table}`);
      expect(denied(res)).toBe(true);
    }
  });

  it("editor CAN read import internals + organizations", async () => {
    const batches = await queryAs(
      { role: "authenticated", sub: USERS.editor },
      "select id from public.import_batches",
    );
    expect(batches.error).toBeNull();
    expect(batches.rows.length).toBeGreaterThanOrEqual(1);

    const orgs = await queryAs(
      { role: "authenticated", sub: USERS.editor },
      "select id from public.organizations",
    );
    expect(orgs.error).toBeNull();
    expect(orgs.rows.length).toBeGreaterThanOrEqual(1);
  });

  it("creator cannot insert into import internals", async () => {
    const res = await queryAs(
      { role: "authenticated", sub: USERS.free },
      `insert into public.organizations (name, normalized_name, org_type)
         values ('x','x','other')`,
    );
    expect(res.error).not.toBeNull();
  });
});
