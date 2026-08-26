/**
 * The explicit privilege contract (migration 0024, D046).
 *
 * The audit read the privilege matrix from a clean replay; external
 * verification read it from production and got a different answer, because part
 * of the matrix was inherited from hosted Supabase defaults rather than
 * established by migrations. This suite pins the intended matrix so the two can
 * never silently diverge again.
 *
 * It asserts three separate things, because a privilege bit alone is not proof:
 *
 *  1. the exact privilege set every client role holds on every relation;
 *  2. that RLS still decides which ROWS those privileges reach, by running
 *     representative queries as anon, as a creator, and as an admin;
 *  3. that no relation has drifted — a new table with no explicit grants, or an
 *     old table that gained one, fails the suite.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { adminQuery, hasTestDb, queryAs, setupDatabase, teardownDatabase } from "../db/harness";

const d = describe.skipIf(!hasTestDb);

/** Privilege letters, in a fixed order: Select Insert Update Delete. */
type Privs = "" | string;

interface Expected {
  anon: Privs;
  authenticated: Privs;
  /** Every application relation is fully available to the trusted role, except
   *  the read-only projections and the append-only evidence table — the trusted
   *  boundary is not exempt from an invariant that exists to keep evidence
   *  citable. */
  serviceRole: "all" | "S" | "SI";
}

/**
 * The contract. Derived from the RLS policies and the surfaces that exist —
 * NOT copied from whatever the database happened to report, which is exactly
 * how the drift got in.
 */
const CONTRACT: Record<string, Expected> = {
  // Identity. Own row only, and role/status are trigger-protected.
  users: { anon: "", authenticated: "SU", serviceRole: "all" },

  // Creator identity and portfolio. Public rows are anonymously readable.
  creator_profiles: { anon: "S", authenticated: "SIU", serviceRole: "all" },
  portfolio_assets: { anon: "S", authenticated: "SIUD", serviceRole: "all" },

  // Public catalogue. Writes exist as a capability; RLS restricts them to staff.
  brands: { anon: "S", authenticated: "SIUD", serviceRole: "all" },
  destinations: { anon: "S", authenticated: "SIUD", serviceRole: "all" },
  hotels: { anon: "S", authenticated: "SIUD", serviceRole: "all" },
  hotel_contacts: { anon: "", authenticated: "SIUD", serviceRole: "all" },

  // Commerce is read-only to the browser.
  access_entitlements: { anon: "", authenticated: "S", serviceRole: "all" },
  purchases: { anon: "", authenticated: "S", serviceRole: "all" },
  subscriptions: { anon: "", authenticated: "S", serviceRole: "all" },

  // Creator workspace. Trips are directly owner-writable; the CRM is not.
  trips: { anon: "", authenticated: "SIUD", serviceRole: "all" },
  trip_hotels: { anon: "", authenticated: "SIUD", serviceRole: "all" },
  pipeline_items: { anon: "", authenticated: "S", serviceRole: "all" },
  outreach_events: { anon: "", authenticated: "S", serviceRole: "all" },
  collaborations: { anon: "", authenticated: "S", serviceRole: "all" },

  // Intelligence. Base aggregates are unreachable by any client role.
  hotel_intelligence: { anon: "", authenticated: "", serviceRole: "all" },
  destination_intelligence: { anon: "", authenticated: "", serviceRole: "all" },
  hotel_public_intelligence: { anon: "S", authenticated: "S", serviceRole: "S" },
  // Premium projection (0026). anon holds NOTHING: it could never be entitled,
  // so the privilege should not exist at all — the in-view entitlement gate is
  // the second layer, not the only one.
  hotel_premium_intelligence: { anon: "", authenticated: "S", serviceRole: "S" },

  // Editorial / import / admin, gated by is_admin_or_editor().
  destination_aliases: { anon: "", authenticated: "SIUD", serviceRole: "all" },
  editorial_evidence: { anon: "", authenticated: "SIUD", serviceRole: "all" },
  hotel_organizations: { anon: "", authenticated: "SIUD", serviceRole: "all" },
  import_batches: { anon: "", authenticated: "SIUD", serviceRole: "all" },
  import_match_candidates: { anon: "", authenticated: "SIUD", serviceRole: "all" },
  import_property_reviews: { anon: "", authenticated: "SIUD", serviceRole: "all" },
  import_row_links: { anon: "", authenticated: "SIUD", serviceRole: "all" },
  import_row_reviews: { anon: "", authenticated: "SIUD", serviceRole: "all" },
  import_rows: { anon: "", authenticated: "SIUD", serviceRole: "all" },
  organization_contacts: { anon: "", authenticated: "SIUD", serviceRole: "all" },
  organizations: { anon: "", authenticated: "SIUD", serviceRole: "all" },
  admin_flags: { anon: "", authenticated: "SIU", serviceRole: "all" },

  // Property-content infrastructure (0027). Same shape as the import tables:
  // a capability grant to `authenticated` that is_admin_or_editor() reduces to
  // zero rows, and no anon privilege at all — these are provider/editorial
  // internals and must not be publicly enumerable.
  source_runs: { anon: "", authenticated: "SIUD", serviceRole: "all" },
  source_property_identities: { anon: "", authenticated: "SIUD", serviceRole: "all" },
  // APPEND-ONLY. A future canonical star cites an observation id as its
  // provenance, so no client role — service_role included — holds UPDATE or
  // DELETE. A trigger refuses both even for the table owner; this row is the
  // first layer, not the only one.
  source_property_observations: { anon: "", authenticated: "SI", serviceRole: "SI" },
  source_match_candidates: { anon: "", authenticated: "SIUD", serviceRole: "all" },
  hotel_source_identities: { anon: "", authenticated: "SIUD", serviceRole: "all" },

  // Lifecycle / closure evidence (0031). The policy tables keep the full set so
  // a NEW version can be assembled and approved — the freeze triggers hold the
  // approved one, which a grant could not do without also blocking the draft.
  provider_lifecycle_issue_policies: { anon: "", authenticated: "SIUD", serviceRole: "all" },
  provider_lifecycle_issue_policy_mappings: {
    anon: "",
    authenticated: "SIUD",
    serviceRole: "all",
  },
  // APPEND-ONLY, like the observations they cite. A snapshot is bound to an
  // immutable observation, so rewriting it would change what the provider is
  // recorded as having said at a moment that has already passed. No role —
  // service_role included — holds UPDATE or DELETE.
  source_property_issue_snapshots: { anon: "", authenticated: "SI", serviceRole: "SI" },
  source_property_issue_evidence: { anon: "", authenticated: "SI", serviceRole: "SI" },
  // A04.5 human review evidence: append-only internal operational provenance.
  // No anon grant, and no UPDATE/DELETE for any role including service_role.
  source_property_review_receipts: { anon: "", authenticated: "SI", serviceRole: "SI" },
  source_property_review_verifications: { anon: "", authenticated: "SI", serviceRole: "SI" },
  source_property_review_evidence_references: { anon: "", authenticated: "SI", serviceRole: "SI" },
  source_property_reviews: { anon: "", authenticated: "SIUD", serviceRole: "all" },
  // A04.6 revocation (0033): the same posture. A revocation records that a human
  // withdrew authorization at a moment that has passed, so editing it would
  // change what is recorded as having happened. There is no un-revoke, and
  // therefore no UPDATE or DELETE for anyone.
  source_property_review_revocations: { anon: "", authenticated: "SI", serviceRole: "SI" },

  // Pre-publication resolution (0028), in two layers with deliberately different
  // grants.
  //
  // REVISIONS are APPEND-ONLY, like the observations they cite: a future D062
  // publication names a revision id as the evidence that authorised it, so no
  // client role — service_role included — holds UPDATE or DELETE. A trigger
  // refuses both even for the table owner; this row is the first layer.
  source_property_star_resolution_revisions: { anon: "", authenticated: "SI", serviceRole: "SI" },
  source_property_location_resolution_revisions: {
    anon: "",
    authenticated: "SI",
    serviceRole: "SI",
  },
  // HEAD POINTERS are meant to move, so they carry the full capability set.
  // Moving a pointer changes which revision is current; it changes no revision.
  source_property_star_resolutions: { anon: "", authenticated: "SIUD", serviceRole: "all" },
  source_property_location_resolutions: { anon: "", authenticated: "SIUD", serviceRole: "all" },
  // The reviewed provider policy, as data. Editable by an admin/editor because
  // approving a new provider version IS an editorial act — but never by anon.
  provider_classification_policies: { anon: "", authenticated: "SIUD", serviceRole: "all" },
  provider_classification_policy_mappings: { anon: "", authenticated: "SIUD", serviceRole: "all" },
  // The full set is deliberate: assembling and APPROVING a new policy version is
  // editorial work. What must not move is an already-approved version, and that
  // is held by freeze triggers — a grant cannot tell a draft row from a frozen
  // one, and a trigger can.
  provider_location_policies: { anon: "", authenticated: "SIUD", serviceRole: "all" },
  // Physical-hospitality scope (0029). Same two-layer shape as 0028: the policy
  // tables carry the full set so a NEW version can be assembled and approved,
  // the REVISIONS are append-only, and the head pointer moves.
  provider_hospitality_scope_policies: { anon: "", authenticated: "SIUD", serviceRole: "all" },
  provider_hospitality_scope_policy_mappings: {
    anon: "",
    authenticated: "SIUD",
    serviceRole: "all",
  },
  source_property_scope_resolution_revisions: { anon: "", authenticated: "SI", serviceRole: "SI" },
  source_property_scope_resolutions: { anon: "", authenticated: "SIUD", serviceRole: "all" },
  source_property_current_scope_resolutions: { anon: "", authenticated: "S", serviceRole: "S" },
  // Read models over the head pointers. `security_invoker`, so they inherit the
  // base tables' RLS rather than handing a definer's view of everything to
  // anyone holding SELECT.
  source_property_current_star_resolutions: { anon: "", authenticated: "S", serviceRole: "S" },
  source_property_current_location_resolutions: { anon: "", authenticated: "S", serviceRole: "S" },
  hotel_claims: { anon: "", authenticated: "SU", serviceRole: "all" },
  contact_signals: { anon: "", authenticated: "SI", serviceRole: "all" },
  verification_events: { anon: "", authenticated: "SI", serviceRole: "all" },

  // Growth. No client write surface exists.
  milestones: { anon: "", authenticated: "S", serviceRole: "all" },
  public_creator_profile_views: { anon: "", authenticated: "S", serviceRole: "all" },
  referrals: { anon: "", authenticated: "S", serviceRole: "all" },
  share_cards: { anon: "", authenticated: "S", serviceRole: "all" },
};

const LETTERS = [
  ["SELECT", "S"],
  ["INSERT", "I"],
  ["UPDATE", "U"],
  ["DELETE", "D"],
] as const;

interface PrivRow {
  relname: string;
  rolname: string;
  sel: boolean;
  ins: boolean;
  upd: boolean;
  del: boolean;
  trunc: boolean;
  refs: boolean;
  trig: boolean;
}

async function readMatrix(): Promise<PrivRow[]> {
  return adminQuery<PrivRow>(`
    select c.relname, r.rolname,
      has_table_privilege(r.rolname, c.oid, 'SELECT')     as sel,
      has_table_privilege(r.rolname, c.oid, 'INSERT')     as ins,
      has_table_privilege(r.rolname, c.oid, 'UPDATE')     as upd,
      has_table_privilege(r.rolname, c.oid, 'DELETE')     as del,
      has_table_privilege(r.rolname, c.oid, 'TRUNCATE')   as trunc,
      has_table_privilege(r.rolname, c.oid, 'REFERENCES') as refs,
      has_table_privilege(r.rolname, c.oid, 'TRIGGER')    as trig
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    cross join (values ('anon'),('authenticated'),('service_role')) as r(rolname)
    where n.nspname = 'public' and c.relkind in ('r','v','m','p')
    order by c.relname, r.rolname
  `);
}

function letters(row: PrivRow): string {
  const flags = { S: row.sel, I: row.ins, U: row.upd, D: row.del };
  return LETTERS.map(([, letter]) => (flags[letter] ? letter : "")).join("");
}

/** Tables the audit named explicitly as required coverage. */
const REQUIRED = [
  "users",
  "creator_profiles",
  "hotels",
  "hotel_contacts",
  "subscriptions",
  "access_entitlements",
  "trips",
  "pipeline_items",
  "outreach_events",
  "collaborations",
  "hotel_intelligence",
  "destination_intelligence",
  "hotel_public_intelligence",
  "hotel_premium_intelligence",
  "import_batches",
  "import_rows",
  "organizations",
] as const;

d("explicit ACL contract (0024)", () => {
  let matrix: PrivRow[] = [];
  const byRelation = new Map<string, Map<string, PrivRow>>();

  beforeAll(async () => {
    await setupDatabase();
    matrix = await readMatrix();
    for (const row of matrix) {
      if (!byRelation.has(row.relname)) byRelation.set(row.relname, new Map());
      byRelation.get(row.relname)!.set(row.rolname, row);
    }
  }, 60_000);

  afterAll(async () => {
    await teardownDatabase();
  });

  it("covers every relation the audit named", () => {
    for (const name of REQUIRED) {
      expect(CONTRACT[name], `${name} missing from the contract`).toBeDefined();
      expect(byRelation.has(name), `${name} missing from the database`).toBe(true);
    }
  });

  it("matches the declared privilege set for anon and authenticated", () => {
    const actual: Record<string, string> = {};
    const expected: Record<string, string> = {};
    for (const [name, contract] of Object.entries(CONTRACT)) {
      const roles = byRelation.get(name);
      expect(roles, `${name} is missing`).toBeDefined();
      actual[`${name}:anon`] = letters(roles!.get("anon")!);
      actual[`${name}:authenticated`] = letters(roles!.get("authenticated")!);
      expected[`${name}:anon`] = contract.anon;
      expected[`${name}:authenticated`] = contract.authenticated;
    }
    expect(actual).toEqual(expected);
  });

  it("gives service_role the coverage the trusted boundary needs", () => {
    for (const [name, contract] of Object.entries(CONTRACT)) {
      const row = byRelation.get(name)!.get("service_role")!;
      const expected = contract.serviceRole === "all" ? "SIUD" : contract.serviceRole;
      expect(letters(row), name).toBe(expected);
    }
  });

  it("never grants TRUNCATE, REFERENCES or TRIGGER to a client role", () => {
    const offenders = matrix
      .filter((r) => r.rolname !== "service_role")
      .filter((r) => r.trunc || r.refs || r.trig)
      .map((r) => `${r.relname}:${r.rolname}`);
    expect(offenders).toEqual([]);
  });

  it("TRUNCATE is false for every client-facing relation, named individually", async () => {
    for (const name of Object.keys(CONTRACT)) {
      for (const role of ["anon", "authenticated"]) {
        const [row] = await adminQuery<{ ok: boolean }>(
          `select has_table_privilege($1, $2, 'TRUNCATE') as ok`,
          [role, `public.${name}`],
        );
        expect(row!.ok, `${role} can TRUNCATE ${name}`).toBe(false);
      }
    }
  });

  /* -------------------------------------------------------------- */
  /* Drift detection (§21)                                            */
  /* -------------------------------------------------------------- */

  it("has no relation outside the contract, and no contract entry without a relation", () => {
    const inDatabase = [...byRelation.keys()].sort();
    const inContract = Object.keys(CONTRACT).sort();
    // A new table added by a future migration must be added here deliberately,
    // with its grants stated, rather than picking up whatever the host defaults
    // happen to be.
    expect(inDatabase).toEqual(inContract);
  });

  it("keeps RLS enabled on every application table", async () => {
    const rows = await adminQuery<{ relname: string }>(`
      select c.relname from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relkind = 'r' and not c.relrowsecurity
    `);
    expect(rows.map((r) => r.relname)).toEqual([]);
  });

  it("keeps schema usage, without which PostgREST resolves nothing", async () => {
    const [row] = await adminQuery<{ anon: boolean; auth: boolean }>(
      `select has_schema_privilege('anon','public','USAGE') as anon,
              has_schema_privilege('authenticated','public','USAGE') as auth`,
    );
    expect(row).toEqual({ anon: true, auth: true });
  });

  it("leaves the eight application RPCs service_role-only", async () => {
    // 0024 touches no function grant, but a broad REVOKE is exactly the kind of
    // change that could take one out by accident, so the boundary is re-checked
    // on the post-0024 schema.
    const rows = await adminQuery<{
      proname: string;
      anon: boolean;
      auth: boolean;
      svc: boolean;
      pinned: boolean;
    }>(`
      select p.proname,
             has_function_privilege('anon', p.oid, 'EXECUTE')         as anon,
             has_function_privilege('authenticated', p.oid, 'EXECUTE') as auth,
             has_function_privilege('service_role', p.oid, 'EXECUTE')  as svc,
             coalesce(array_to_string(p.proconfig, ','), '') like '%search_path=public, pg_temp%'
               as pinned
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and p.proname in (
        'save_hotel_to_pipeline','transition_pipeline_item','progress_pipeline_deal',
        'progress_collaboration','recompute_hotel_intelligence',
        'recompute_hotel_intelligence_for_pipeline_item','recompute_all_hotel_intelligence',
        'hotel_intelligence_lock_key')
      order by p.proname
    `);
    expect(rows.length).toBe(8);
    for (const row of rows) {
      expect(row.anon, row.proname).toBe(false);
      expect(row.auth, row.proname).toBe(false);
      expect(row.svc, row.proname).toBe(true);
      expect(row.pinned, row.proname).toBe(true);
    }
  });

  it("keeps the self-scoped helper wrappers callable, as RLS policies require", async () => {
    // These take no user id and read only auth.uid(); RLS policies invoke them
    // as the calling role, so revoking them would break authorization itself.
    const rows = await adminQuery<{ proname: string; anon: boolean; auth: boolean }>(`
      select p.proname,
             has_function_privilege('anon', p.oid, 'EXECUTE')          as anon,
             has_function_privilege('authenticated', p.oid, 'EXECUTE') as auth
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and p.proname in (
        'current_creator_id','current_user_role','is_admin_or_editor',
        'has_active_pro','has_active_destination_access','has_premium_hotel_access')
    `);
    expect(rows.length).toBe(6);
    for (const row of rows) {
      expect(row.anon, row.proname).toBe(true);
      expect(row.auth, row.proname).toBe(true);
    }
  });

  it("leaves no default privileges that would re-grant client roles on future objects", async () => {
    const rows = await adminQuery<{ acl: string }>(`
      select unnest(defaclacl)::text as acl
      from pg_default_acl d
      join pg_namespace n on n.oid = d.defaclnamespace
      where n.nspname = 'public'
    `);
    for (const { acl } of rows) {
      expect(acl.startsWith("anon="), acl).toBe(false);
      expect(acl.startsWith("authenticated="), acl).toBe(false);
    }
  });
});

/* ------------------------------------------------------------------ */
/* A privilege bit is not enough — run the queries.                    */
/* ------------------------------------------------------------------ */

d("the contract behaves as intended for real callers", () => {
  const U = {
    creator: "b1000000-0000-0000-0000-000000000001",
    admin: "b1000000-0000-0000-0000-000000000002",
    stranger: "b1000000-0000-0000-0000-000000000003",
  } as const;
  const DEST = "b2000000-0000-0000-0000-000000000001";
  const HOTEL = "b3000000-0000-0000-0000-000000000001";

  beforeAll(async () => {
    await setupDatabase();
    for (const id of Object.values(U)) {
      await adminQuery("insert into auth.users (id, email) values ($1, $2)", [
        id,
        `${id}@test.local`,
      ]);
    }
    await adminQuery("update public.users set role = 'admin' where id = $1", [U.admin]);
    await adminQuery(
      "insert into public.destinations (id, name, slug, type) values ($1,'Acltown','acltown','city')",
      [DEST],
    );
    await adminQuery(
      "insert into public.hotels (id, name, slug, destination_id) values ($1,'ACL Hotel','acl-hotel',$2)",
      [HOTEL, DEST],
    );
    await adminQuery(
      "insert into public.hotel_contacts (hotel_id, first_name, email) values ($1,'ACL','acl@h.com')",
      [HOTEL],
    );
    const [creator] = await adminQuery<{ id: string }>(
      "select id from public.creator_profiles where user_id = $1",
      [U.creator],
    );
    await adminQuery("insert into public.pipeline_items (creator_id, hotel_id) values ($1,$2)", [
      creator!.id,
      HOTEL,
    ]);
  }, 60_000);

  afterAll(async () => {
    await teardownDatabase();
  });

  it("anon browses the catalogue and nothing else", async () => {
    const hotels = await queryAs({ role: "anon" }, "select id from public.hotels");
    expect(hotels.error).toBeNull();
    expect(hotels.rows.length).toBe(1);

    for (const table of [
      "users",
      "pipeline_items",
      "outreach_events",
      "collaborations",
      "hotel_contacts",
      "hotel_intelligence",
      "destination_intelligence",
      "subscriptions",
      "access_entitlements",
      "import_batches",
      "organizations",
    ]) {
      const res = await queryAs({ role: "anon" }, `select * from public.${table} limit 1`);
      expect(res.error, `anon could read ${table}`).not.toBeNull();
    }
  });

  it("anon reads the public intelligence projection but never the base tables", async () => {
    const view = await queryAs({ role: "anon" }, "select * from public.hotel_public_intelligence");
    expect(view.error).toBeNull();

    const base = await queryAs({ role: "anon" }, "select * from public.hotel_intelligence");
    expect(base.error).not.toBeNull();
  });

  it("a creator reads their own pipeline and cannot write it", async () => {
    const read = await queryAs(
      { role: "authenticated", sub: U.creator },
      "select id from public.pipeline_items",
    );
    expect(read.error).toBeNull();
    expect(read.rows.length).toBe(1);

    for (const sql of [
      "update public.pipeline_items set status = 'won'",
      "delete from public.pipeline_items",
      "insert into public.outreach_events (creator_id, hotel_id, event_type) values (null, null, 'pitch_sent')",
      "insert into public.collaborations (creator_id, hotel_id) values (null, null)",
    ]) {
      const res = await queryAs({ role: "authenticated", sub: U.creator }, sql);
      expect(res.error, sql).not.toBeNull();
      expect(res.error?.code, sql).toBe("42501");
    }
  });

  it("another creator's pipeline is invisible, not merely unwritable", async () => {
    const res = await queryAs(
      { role: "authenticated", sub: U.stranger },
      "select id from public.pipeline_items",
    );
    expect(res.error).toBeNull();
    expect(res.rows).toEqual([]);
  });

  it("a regular creator holds catalogue write privileges but RLS grants no rows", async () => {
    // The privilege exists...
    const [priv] = await adminQuery<{ ok: boolean }>(
      "select has_table_privilege('authenticated','public.hotels','UPDATE') as ok",
    );
    expect(priv!.ok).toBe(true);

    // ...and changes nothing, because hotels_write requires is_admin_or_editor().
    const res = await queryAs(
      { role: "authenticated", sub: U.creator },
      "update public.hotels set name = 'Hijacked' returning id",
    );
    expect(res.error).toBeNull();
    expect(res.rows).toEqual([]);

    const [row] = await adminQuery<{ name: string }>(
      "select name from public.hotels where id = $1",
      [HOTEL],
    );
    expect(row!.name).toBe("ACL Hotel");
  });

  it("an admin can still do the editorial work the grants are there for", async () => {
    const update = await queryAs(
      { role: "authenticated", sub: U.admin },
      "update public.hotels set name = 'Edited by admin' returning id",
    );
    expect(update.error).toBeNull();
    expect(update.rows.length).toBe(1);

    const contacts = await queryAs(
      { role: "authenticated", sub: U.admin },
      "select id from public.hotel_contacts",
    );
    expect(contacts.error).toBeNull();
    expect(contacts.rows.length).toBe(1);

    const batches = await queryAs(
      { role: "authenticated", sub: U.admin },
      `insert into public.import_batches (source_name, source_kind, parser_name, parser_version, status)
         values ('acl-test','canonical','acl','1','pending') returning id`,
    );
    expect(batches.error).toBeNull();
    expect(batches.rows.length).toBe(1);
  });

  it("a regular creator sees no import or organization rows", async () => {
    await adminQuery(
      "insert into public.organizations (name, normalized_name, org_type) values ('ACL Group','acl group','hotel_group')",
    );
    const orgs = await queryAs(
      { role: "authenticated", sub: U.creator },
      "select id from public.organizations",
    );
    expect(orgs.error).toBeNull();
    expect(orgs.rows).toEqual([]);
  });

  it("a creator cannot read another user's identity row", async () => {
    const res = await queryAs(
      { role: "authenticated", sub: U.creator },
      "select id from public.users where id = $1",
      [U.admin],
    );
    expect(res.error).toBeNull();
    expect(res.rows).toEqual([]);
  });
});
