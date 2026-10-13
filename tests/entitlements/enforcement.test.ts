/**
 * Every inventory entry is enforced in Postgres.
 *
 * Tier probes use the real helpers and RPCs. Owner probes use real roles.
 * A Pro entitlement for User A does not reveal or alter User B. Anon gets
 * nothing on private surfaces. A purchase without an entitlement row is Free.
 * Missing and expired rows are Free, never Pro.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { workspaceLimit, type Enforcement } from "@/lib/entitlements/inventory";
import { INVENTORY } from "@/lib/entitlements/inventory";
import {
  adminQuery,
  commitAs,
  hasTestDb,
  queryAs,
  setupDatabase,
  teardownDatabase,
  type AsResult,
  type Role,
} from "../db/harness";

const d = describe.skipIf(!hasTestDb);

const U = {
  free: "e4111111-1111-4111-8111-111111111111",
  pass: "e4222222-2222-4222-8222-222222222222",
  pro: "e4333333-3333-4333-8333-333333333333",
  expired: "e4444444-4444-4444-8444-444444444444",
  revoked: "e4555555-5555-4555-8555-555555555555",
  other: "e4666666-6666-4666-8666-666666666666",
} as const;

const DEST = {
  bali: "e4d00000-0000-4000-8000-000000000001",
  ibiza: "e4d00000-0000-4000-8000-000000000002",
} as const;

const SECRET = "e04-b-secret-notes";
const CONTACT = "e04-secret-contact@hotel.test";

const savedLimit = workspaceLimit("pipeline.save");
const engagedLimit = workspaceLimit("pipeline.engage");
const tripLimit = workspaceLimit("trips.active");

interface Actor {
  userId: string | null;
  role: Role;
}

const ACTORS = {
  anon: { userId: null, role: "anon" },
  free: { userId: U.free, role: "authenticated" },
  pass: { userId: U.pass, role: "authenticated" },
  pro: { userId: U.pro, role: "authenticated" },
  expired: { userId: U.expired, role: "authenticated" },
  revoked: { userId: U.revoked, role: "authenticated" },
  other: { userId: U.other, role: "authenticated" },
} as const satisfies Record<string, Actor>;

function actor(name: keyof typeof ACTORS): Actor {
  return ACTORS[name];
}

let creators: Record<keyof typeof U, string>;
let baliHotels: string[] = [];
let ibizaHotel = "";
let outsideHotel = "";
let extraOutside: string[] = [];
let otherPipeline = "";
let otherTrip = "";
let otherMail = "";
let otherBinding = "";
let otherCollaboration = "";
let otherCompensation = "";
let otherDeliverable = "";
let otherPortfolio = "";
let otherPitchTemplate = "";
let otherPitchDraft = "";
let otherContractTemplate = "";
let otherContract = "";

function nothing<T>(result: AsResult<T>): boolean {
  return result.error !== null || result.rows.length === 0;
}

async function save(userId: string, hotelId: string): Promise<string> {
  const rows = await adminQuery<{ r: { result: string; pipeline_item_id?: string } }>(
    "select public.save_hotel_to_pipeline($1, $2, $3) as r",
    [userId, hotelId, savedLimit],
  );
  return rows[0]!.r.result === "created" || rows[0]!.r.result === "already_saved"
    ? (rows[0]!.r.pipeline_item_id ?? rows[0]!.r.result)
    : rows[0]!.r.result;
}

async function engage(userId: string, pipelineItemId: string): Promise<string> {
  const rows = await adminQuery<{ r: { result: string } }>(
    "select public.transition_pipeline_item($1, $2, 'plan', null, null, null, null, null, $3) as r",
    [userId, pipelineItemId, engagedLimit],
  );
  return rows[0]!.r.result;
}

async function createTrip(userId: string, destinationId: string): Promise<string> {
  const rows = await adminQuery<{ r: { result: string } }>(
    `select public.create_trip($1, $2, null, '2026-11-01', '2026-11-08', 'planning', $3) as r`,
    [userId, destinationId, tripLimit],
  );
  return rows[0]!.r.result;
}

async function premium(actor: Actor, hotelId: string): Promise<boolean> {
  const result = await queryAs<{ v: boolean }>(
    { role: actor.role, sub: actor.userId },
    "select public.has_premium_hotel_access($1) as v",
    [hotelId],
  );
  if (result.error) return false;
  return result.rows[0]?.v === true;
}

d("E04 entitlement inventory enforcement", () => {
  beforeAll(async () => {
    await setupDatabase();

    for (const id of Object.values(U)) {
      await adminQuery("insert into auth.users (id, email) values ($1, $2)", [
        id,
        `${id}@e04.test`,
      ]);
    }

    const profiles = await adminQuery<{ user_id: string; id: string }>(
      "select user_id, id from public.creator_profiles where user_id = any($1::uuid[])",
      [Object.values(U)],
    );
    const byUser = new Map(profiles.map((row) => [row.user_id, row.id]));
    creators = {
      free: byUser.get(U.free)!,
      pass: byUser.get(U.pass)!,
      pro: byUser.get(U.pro)!,
      expired: byUser.get(U.expired)!,
      revoked: byUser.get(U.revoked)!,
      other: byUser.get(U.other)!,
    };

    await adminQuery(
      `insert into public.destinations (id, name, slug, type) values
         ($1, 'E04 Bali', 'e04-bali', 'island'),
         ($2, 'E04 Ibiza', 'e04-ibiza', 'island')`,
      [DEST.bali, DEST.ibiza],
    );

    baliHotels = Array.from(
      { length: savedLimit + 1 },
      (_, i) => `e4a00000-0000-4000-8000-${(i + 1).toString().padStart(12, "0")}`,
    );
    ibizaHotel = "e4a00000-0000-4000-8000-000000000099";
    outsideHotel = "e4a00000-0000-4000-8000-000000000098";
    for (const [index, id] of baliHotels.entries()) {
      await adminQuery(
        `insert into public.hotels (id, name, slug, destination_id) values ($1, $2, $3, $4)`,
        [id, `E04 Bali ${index}`, `e04-bali-${index}`, DEST.bali],
      );
    }
    await adminQuery(
      `insert into public.hotels (id, name, slug, destination_id) values
         ($1, 'E04 Ibiza', 'e04-ibiza-hotel', $3),
         ($2, 'E04 Ibiza 2', 'e04-ibiza-hotel-2', $3)`,
      [ibizaHotel, outsideHotel, DEST.ibiza],
    );
    await adminQuery(
      `insert into public.hotel_contacts (hotel_id, first_name, email) values ($1, 'Secret', $2)`,
      [baliHotels[0], CONTACT],
    );
    await adminQuery(`insert into public.hotel_intelligence (hotel_id) values ($1)`, [
      baliHotels[0],
    ]);

    await adminQuery(
      `insert into public.access_entitlements
         (user_id, access_type, destination_id, status, starts_at, expires_at)
       values ($1, 'destination', $2, 'active', now() - interval '1 day', now() + interval '20 days')`,
      [U.pass, DEST.bali],
    );
    await adminQuery(
      `insert into public.access_entitlements (user_id, access_type, status, starts_at)
       values ($1, 'pro', 'active', now() - interval '1 day')`,
      [U.pro],
    );
    await adminQuery(
      `insert into public.access_entitlements
         (user_id, access_type, status, starts_at, expires_at)
       values ($1, 'pro', 'active', now() - interval '400 days', now() - interval '1 day')`,
      [U.expired],
    );
    await adminQuery(
      `insert into public.access_entitlements (user_id, access_type, status, starts_at)
       values ($1, 'pro', 'revoked', now() - interval '1 day')`,
      [U.revoked],
    );
    await adminQuery(
      `insert into public.access_entitlements (user_id, access_type, status, starts_at)
       values ($1, 'pro', 'active', now() - interval '1 day')`,
      [U.other],
    );
    await adminQuery(
      `insert into public.purchases
         (user_id, provider, provider_transaction_id, product_type, amount, currency, status)
       values ($1, 'stub', 'e04-purchase', 'pro', 199, 'USD', 'paid')`,
      [U.free],
    );

    const otherSaved = await save(U.other, baliHotels[0]!);
    expect(otherSaved).toMatch(/^[0-9a-f-]{36}$/);
    otherPipeline = otherSaved;
    await adminQuery("update public.pipeline_items set private_notes = $2 where id = $1", [
      otherPipeline,
      SECRET,
    ]);

    const tripRows = await adminQuery<{ id: string }>(
      `insert into public.trips (creator_id, destination_id, start_date, end_date, status)
       values ($1, $2, '2026-12-01', '2026-12-08', 'planning') returning id`,
      [creators.other, DEST.bali],
    );
    otherTrip = tripRows[0]!.id;

    const collab = await adminQuery<{ id: string }>(
      `insert into public.collaborations
         (creator_id, hotel_id, pipeline_item_id, status, collaboration_type)
       values ($1, $2, $3, 'agreed', 'stay') returning id`,
      [creators.other, baliHotels[0], otherPipeline],
    );
    otherCollaboration = collab[0]!.id;
    const comp = await adminQuery<{ id: string }>(
      `insert into public.collaboration_agreed_compensations
         (creator_id, collaboration_id, pipeline_item_id, structure, payment_status)
       values ($1, $2, $3, 'unknown', 'not_applicable') returning id`,
      [creators.other, otherCollaboration, otherPipeline],
    );
    otherCompensation = comp[0]!.id;
    const deliverable = await adminQuery<{ id: string }>(
      `insert into public.collaboration_deliverables
         (creator_id, collaboration_id, pipeline_item_id, deliverable_type, quantity, due_on, status, notes)
       values ($1, $2, $3, 'reel', 1, '2026-10-01', 'pending', $4)
       returning id`,
      [creators.other, otherCollaboration, otherPipeline, SECRET],
    );
    otherDeliverable = deliverable[0]!.id;

    const portfolio = await adminQuery<{ id: string }>(
      `insert into public.portfolio_assets (creator_id, type, external_url, is_public, title)
       values ($1, 'link', 'https://example.test/e04', false, $2) returning id`,
      [creators.other, SECRET],
    );
    otherPortfolio = portfolio[0]!.id;

    const mail = await adminQuery<{ id: string }>(
      `insert into public.mail_accounts (user_id, provider, provider_account_subject, email_address)
       values ($1, 'gmail', 'e04-other-subject', 'other-secret@e04.test') returning id`,
      [U.other],
    );
    otherMail = mail[0]!.id;
    await adminQuery(
      `insert into private.gmail_normalized_threads (user_id, mail_account_id, provider_thread_id)
       values ($1, $2, 'e04-thread')`,
      [U.other, otherMail],
    );
    const binding = await adminQuery<{ id: string }>(
      `with cfg as (select set_config('inbox_pipeline.writer', 'bind', true))
       insert into public.pipeline_inbox_bindings
         (creator_id, pipeline_item_id, mail_account_id, provider_thread_id)
       select $1, $2, $3, 'e04-thread' from cfg
       returning id`,
      [creators.other, otherPipeline, otherMail],
    );
    otherBinding = binding[0]!.id;
    await adminQuery(
      `with cfg as (select set_config('gmail_collab.writer', 'refresh', true))
       insert into public.gmail_collaboration_suggestions (
         creator_id, pipeline_item_id, binding_id, mail_account_id, provider_thread_id,
         kind, status, classifier, evidence_key, pitch_at, pitch_message_id
       )
       select $1, $2, $3, $4, 'e04-thread',
              'pitch_sent', 'pending', 'heuristic', 'e04-pitch', now(), 'e04-pitch'
         from cfg`,
      [creators.other, otherPipeline, otherBinding, otherMail],
    );

    await adminQuery(
      `insert into public.creator_profile_field_opt_ins (creator_id, field_key, opted_in)
       values ($1, 'content_examples', false)`,
      [creators.other],
    );

    const pitchTemplate = await adminQuery<{ id: string }>(
      `insert into public.pitch_templates (creator_id, name, subject, body)
       values ($1, 'Secret template', 'Secret subject', $2) returning id`,
      [creators.other, SECRET],
    );
    otherPitchTemplate = pitchTemplate[0]!.id;
    const pitchDraft = await adminQuery<{ id: string }>(
      `insert into public.pitch_drafts (creator_id, hotel_id, subject, body, variables_used)
       values ($1, $2, 'Secret draft', $3, '[]'::jsonb) returning id`,
      [creators.other, baliHotels[0], SECRET],
    );
    otherPitchDraft = pitchDraft[0]!.id;

    await adminQuery("update public.pipeline_items set status = 'won' where id = $1", [
      otherPipeline,
    ]);
    const contractTemplate = await adminQuery<{ id: string }>(
      `insert into public.contract_templates (creator_id, kind, title, body)
       values ($1, 'paid', 'Paid collaboration', $2) returning id`,
      [
        creators.other,
        `This template is not legal advice and it is not a signed contract.\n${SECRET}`,
      ],
    );
    otherContractTemplate = contractTemplate[0]!.id;
    const contract = await adminQuery<{ id: string }>(
      `insert into public.collaboration_contracts
         (creator_id, template_id, collaboration_id, pipeline_item_id, kind, title, body, facts_snapshot)
       values ($1, $2, $3, $4, 'paid', 'Paid collaboration', $5, '{}'::jsonb)
       returning id`,
      [
        creators.other,
        otherContractTemplate,
        otherCollaboration,
        otherPipeline,
        `This template is not legal advice and it is not a signed contract.\n${SECRET}`,
      ],
    );
    otherContract = contract[0]!.id;
  });

  afterAll(async () => {
    await teardownDatabase();
  });

  it("enforces every inventory entry for Free, Pass, Pro, expired, and anon", async () => {
    const covered = new Set<string>();

    for (const entry of INVENTORY) {
      covered.add(entry.id);
      await probe(entry.enforcement, entry.id, entry.anon);
    }

    expect([...covered].sort()).toEqual(INVENTORY.map((entry) => entry.id).sort());
  }, 120_000);

  async function probe(enforcement: Enforcement, id: string, anon: "allow" | "deny") {
    if (enforcement.kind === "hotel_select") {
      for (const name of ["anon", "free", "pass", "pro", "expired"] as const) {
        const who = actor(name);
        const result = await queryAs<{ id: string }>(
          { role: who.role, sub: who.userId },
          "select id from public.hotels where id = $1",
          [baliHotels[0]],
        );
        expect(result.error, id).toBeNull();
        expect(
          result.rows.map((row) => row.id),
          id,
        ).toEqual([baliHotels[0]]);
      }
      return;
    }

    if (enforcement.kind === "public_intelligence") {
      for (const name of ["anon", "free", "pass", "pro", "expired"] as const) {
        const who = actor(name);
        const result = await queryAs(
          { role: who.role, sub: who.userId },
          "select hotel_id from public.hotel_public_intelligence where hotel_id = $1",
          [baliHotels[0]],
        );
        expect(result.error, id).toBeNull();
        expect(result.rows.length, id).toBe(1);
      }
      return;
    }

    if (enforcement.kind === "contact_unlock") {
      const bali = baliHotels[0]!;
      await adminQuery(
        `insert into public.contact_cache (hotel_id, email, source, status, last_verified_at)
         values ($1, $2, 'owner_import', 'found', now())
         on conflict (hotel_id) do nothing`,
        [bali, CONTACT],
      );
      for (const name of ["free", "pass", "pro", "expired", "revoked", "other"] as const) {
        const rows = await queryAs<{ email: string }>(
          { role: "authenticated", sub: ACTORS[name].userId },
          "select email from public.hotel_contacts where hotel_id = $1",
          [bali],
        );
        expect(rows.rows, id).toEqual([]);
        expect(JSON.stringify(rows), id).not.toContain(CONTACT);
      }
      const anonRows = await queryAs(
        { role: "anon", sub: null },
        "select email from public.hotel_contacts where hotel_id = $1",
        [bali],
      );
      expect(nothing(anonRows), id).toBe(true);
      expect(JSON.stringify(anonRows), id).not.toContain(CONTACT);
      const unlocked = await commitAs<{ result: { status: string; email: string | null } }>(
        { role: "authenticated", sub: U.free },
        "select public.unlock_hotel_contact($1, 'enforcement-unlock') as result",
        [bali],
      );
      expect(unlocked.error, id).toBeNull();
      expect(unlocked.rows[0]?.result.status, id).toBe("unlocked");
      expect(unlocked.rows[0]?.result.email, id).toBe(CONTACT);
      const visible = await queryAs<{ email: string }>(
        { role: "authenticated", sub: U.free },
        "select email from public.hotel_contacts where hotel_id = $1",
        [bali],
      );
      expect(
        visible.rows.map((row) => row.email),
        id,
      ).toEqual([CONTACT]);
      const stillHidden = await queryAs<{ email: string }>(
        { role: "authenticated", sub: U.pro },
        "select email from public.hotel_contacts where hotel_id = $1",
        [bali],
      );
      expect(stillHidden.rows, id).toEqual([]);
      expect(JSON.stringify(stillHidden), id).not.toContain(CONTACT);
      return;
    }

    if (enforcement.kind === "pending_config") {
      const { CREDITS_CONFIG } = await import("@/lib/credits/config");
      const rows = await adminQuery<{
        free_credits: number;
        pro_monthly_credits: number;
        pro_plus_monthly_credits: number;
        unlock_cost: number;
        charge_on_not_found: boolean;
        cache_ttl_days: number;
        pack_sizes: number[];
      }>(
        "select free_credits, pro_monthly_credits, pro_plus_monthly_credits, unlock_cost, charge_on_not_found, cache_ttl_days, pack_sizes from public.credit_config",
      );
      expect(rows[0], id).toEqual({
        free_credits: CREDITS_CONFIG.freeCredits,
        pro_monthly_credits: CREDITS_CONFIG.planMonthlyCredits.pro,
        pro_plus_monthly_credits: CREDITS_CONFIG.planMonthlyCredits.proPlus,
        unlock_cost: CREDITS_CONFIG.unlockCost,
        charge_on_not_found: CREDITS_CONFIG.chargeOnNotFound,
        cache_ttl_days: CREDITS_CONFIG.cacheTtlDays,
        pack_sizes: [...CREDITS_CONFIG.packSizes],
      });
      const blocked = await queryAs(
        { role: "authenticated", sub: U.pro },
        "update public.credit_config set unlock_cost = 0",
      );
      expect(blocked.error, id).not.toBeNull();
      return;
    }

    if (enforcement.kind === "premium_intelligence") {
      const bali = baliHotels[0]!;
      expect(await premium(actor("anon"), bali), id).toBe(false);
      expect(await premium(actor("free"), bali), id).toBe(false);
      expect(await premium(actor("expired"), bali), id).toBe(false);
      expect(await premium(actor("revoked"), bali), id).toBe(false);
      expect(await premium(actor("pass"), bali), id).toBe(true);
      expect(await premium(actor("pass"), ibizaHotel), id).toBe(false);
      expect(await premium(actor("pro"), bali), id).toBe(true);
      expect(await premium(actor("pro"), ibizaHotel), id).toBe(true);

      {
        const freeView = await queryAs(
          { role: "authenticated", sub: U.free },
          "select hotel_id from public.hotel_premium_intelligence where hotel_id = $1",
          [bali],
        );
        expect(freeView.rows).toEqual([]);
        const proView = await queryAs(
          { role: "authenticated", sub: U.pro },
          "select hotel_id from public.hotel_premium_intelligence where hotel_id = $1",
          [bali],
        );
        expect(proView.error).toBeNull();
        expect(proView.rows.length).toBe(1);
        const anonView = await queryAs(
          { role: "anon", sub: null },
          "select hotel_id from public.hotel_premium_intelligence where hotel_id = $1",
          [bali],
        );
        expect(nothing(anonView)).toBe(true);
      }
      return;
    }

    if (enforcement.kind === "save_limit") {
      // The Pass user's outside hotel is saved first, while they are still
      // under the Free count, so a later engage outside the destination is possible.
      expect(await save(U.pass, ibizaHotel)).toMatch(/^[0-9a-f-]{36}$/);
      for (const userId of [U.free, U.pass, U.pro, U.expired]) {
        for (let i = 0; i < savedLimit; i++) {
          expect(await save(userId, baliHotels[i]!), `${id} ${userId} ${i}`).toMatch(
            /^[0-9a-f-]{36}$/,
          );
        }
      }
      expect(await save(U.free, baliHotels[savedLimit]!)).toBe("limit_reached");
      expect(await save(U.expired, baliHotels[savedLimit]!)).toBe("limit_reached");
      expect(await save(U.pass, baliHotels[savedLimit]!)).toMatch(/^[0-9a-f-]{36}$/);
      // In-destination open rows do not consume the outside Free allowance (D056).
      expect(await save(U.pass, outsideHotel)).toMatch(/^[0-9a-f-]{36}$/);
      extraOutside = Array.from(
        { length: savedLimit - 2 },
        (_, i) => `e4b00000-0000-4000-8000-${(i + 1).toString().padStart(12, "0")}`,
      );
      for (const [index, id] of extraOutside.entries()) {
        await adminQuery(
          `insert into public.hotels (id, name, slug, destination_id) values ($1, $2, $3, $4)`,
          [id, `E04 outside ${index}`, `e04-outside-${index}`, DEST.ibiza],
        );
        expect(await save(U.pass, id), `outside ${index}`).toMatch(/^[0-9a-f-]{36}$/);
      }
      const overflowOutside = "e4b00000-0000-4000-8000-000000000099";
      await adminQuery(
        `insert into public.hotels (id, name, slug, destination_id) values ($1, $2, $3, $4)`,
        [overflowOutside, "E04 outside overflow", "e04-outside-overflow", DEST.ibiza],
      );
      expect(await save(U.pass, overflowOutside)).toBe("limit_reached");
      expect(await save(U.pro, baliHotels[savedLimit]!)).toMatch(/^[0-9a-f-]{36}$/);
      expect(await save(U.pro, ibizaHotel)).toMatch(/^[0-9a-f-]{36}$/);
      return;
    }

    if (enforcement.kind === "engage_limit") {
      const idsFor = async (userId: string, hotelIds: string[]) => {
        const rows = await adminQuery<{ id: string; hotel_id: string }>(
          `select pi.id, pi.hotel_id
             from public.pipeline_items pi
             join public.creator_profiles cp on cp.id = pi.creator_id
            where cp.user_id = $1 and pi.hotel_id = any($2::uuid[]) and pi.status = 'saved'`,
          [userId, hotelIds],
        );
        return new Map(rows.map((row) => [row.hotel_id, row.id]));
      };

      const freeItems = await idsFor(U.free, baliHotels);
      for (let i = 0; i < engagedLimit; i++) {
        expect(await engage(U.free, freeItems.get(baliHotels[i]!)!)).toBe("applied");
      }
      expect(await engage(U.free, freeItems.get(baliHotels[engagedLimit]!)!)).toBe(
        "engaged_limit_reached",
      );

      const expiredItems = await idsFor(U.expired, baliHotels);
      for (let i = 0; i < engagedLimit; i++) {
        expect(await engage(U.expired, expiredItems.get(baliHotels[i]!)!)).toBe("applied");
      }
      expect(await engage(U.expired, expiredItems.get(baliHotels[engagedLimit]!)!)).toBe(
        "engaged_limit_reached",
      );

      const passItems = await idsFor(U.pass, [
        ...baliHotels,
        ibizaHotel,
        outsideHotel,
        ...extraOutside,
      ]);
      for (let i = 0; i < engagedLimit; i++) {
        expect(await engage(U.pass, passItems.get(baliHotels[i]!)!)).toBe("applied");
      }
      // In-destination engagements do not consume the outside Free allowance (D056).
      expect(await engage(U.pass, passItems.get(ibizaHotel)!)).toBe("applied");
      expect(await engage(U.pass, passItems.get(baliHotels[engagedLimit]!)!)).toBe("applied");
      const moreOutside = [outsideHotel, ...extraOutside];
      for (let i = 0; i < engagedLimit - 1; i++) {
        expect(await engage(U.pass, passItems.get(moreOutside[i]!)!)).toBe("applied");
      }
      expect(await engage(U.pass, passItems.get(moreOutside[engagedLimit - 1]!)!)).toBe(
        "engaged_limit_reached",
      );

      const proItems = await idsFor(U.pro, baliHotels);
      for (let i = 0; i <= engagedLimit; i++) {
        expect(await engage(U.pro, proItems.get(baliHotels[i]!)!)).toBe("applied");
      }
      return;
    }

    if (enforcement.kind === "trip_limit") {
      expect(await createTrip(U.free, DEST.bali)).toBe("created");
      expect(await createTrip(U.free, DEST.ibiza)).toBe("limit_reached");
      expect(await createTrip(U.expired, DEST.bali)).toBe("created");
      expect(await createTrip(U.expired, DEST.ibiza)).toBe("limit_reached");
      // A covered trip is created first, so it cannot be mistaken for the Free slot.
      expect(await createTrip(U.pass, DEST.bali)).toBe("created");
      expect(await createTrip(U.pass, DEST.ibiza)).toBe("created");
      expect(await createTrip(U.pass, DEST.ibiza)).toBe("limit_reached");
      expect(await createTrip(U.pro, DEST.bali)).toBe("created");
      expect(await createTrip(U.pro, DEST.ibiza)).toBe("created");
      return;
    }

    if (enforcement.kind === "owner_rows") {
      const secrets: Record<string, { sql: string; params: unknown[]; marker: string }> = {
        pipeline_items: {
          sql: "select private_notes from public.pipeline_items where id = $1",
          params: [otherPipeline],
          marker: SECRET,
        },
        trips: {
          sql: "select id from public.trips where id = $1",
          params: [otherTrip],
          marker: otherTrip,
        },
        collaborations: {
          sql: "select id from public.collaborations where id = $1",
          params: [otherCollaboration],
          marker: otherCollaboration,
        },
        collaboration_agreed_compensations: {
          sql: "select id from public.collaboration_agreed_compensations where id = $1",
          params: [otherCompensation],
          marker: otherCompensation,
        },
        collaboration_deliverables: {
          sql: "select notes from public.collaboration_deliverables where id = $1",
          params: [otherDeliverable],
          marker: SECRET,
        },
        pipeline_inbox_bindings: {
          sql: "select id from public.pipeline_inbox_bindings where id = $1",
          params: [otherBinding],
          marker: otherBinding,
        },
        gmail_collaboration_suggestions: {
          sql: "select binding_id from public.gmail_collaboration_suggestions where binding_id = $1",
          params: [otherBinding],
          marker: otherBinding,
        },
        access_entitlements: {
          sql: "select user_id from public.access_entitlements where user_id = $1",
          params: [U.other],
          marker: U.other,
        },
        creator_profiles: {
          sql: "select id from public.creator_profiles where id = $1",
          params: [creators.other],
          marker: creators.other,
        },
        portfolio_assets: {
          sql: "select title from public.portfolio_assets where id = $1",
          params: [otherPortfolio],
          marker: SECRET,
        },
        mail_accounts: {
          sql: "select email_address from public.mail_accounts where id = $1",
          params: [otherMail],
          marker: "other-secret@e04.test",
        },
        creator_profile_field_opt_ins: {
          sql: "select field_key from public.creator_profile_field_opt_ins where creator_id = $1",
          params: [creators.other],
          marker: "content_examples",
        },
        pitch_templates: {
          sql: "select body from public.pitch_templates where id = $1",
          params: [otherPitchTemplate],
          marker: SECRET,
        },
        pitch_drafts: {
          sql: "select body from public.pitch_drafts where id = $1",
          params: [otherPitchDraft],
          marker: SECRET,
        },
        contract_templates: {
          sql: "select body from public.contract_templates where id = $1",
          params: [otherContractTemplate],
          marker: SECRET,
        },
        collaboration_contracts: {
          sql: "select body from public.collaboration_contracts where id = $1",
          params: [otherContract],
          marker: SECRET,
        },
      };

      for (const table of enforcement.tables) {
        const probeSql = secrets[table];
        expect(probeSql, `${id} ${table}`).toBeTruthy();
        const owner = await queryAs(
          { role: "authenticated", sub: U.other },
          probeSql!.sql,
          probeSql!.params,
        );
        expect(owner.error, `${id} ${table} owner`).toBeNull();
        expect(JSON.stringify(owner.rows), `${id} ${table} owner`).toContain(probeSql!.marker);

        const attacker = await queryAs(
          { role: "authenticated", sub: U.pro },
          probeSql!.sql,
          probeSql!.params,
        );
        expect(nothing(attacker), `${id} ${table} pro attacker`).toBe(true);
        expect(JSON.stringify(attacker), `${id} ${table} pro attacker`).not.toContain(
          probeSql!.marker,
        );

        const anonResult = await queryAs(
          { role: "anon", sub: null },
          probeSql!.sql,
          probeSql!.params,
        );
        expect(nothing(anonResult), `${id} ${table} anon`).toBe(true);
        expect(JSON.stringify(anonResult)).not.toContain(probeSql!.marker);
      }

      if (anon === "allow") {
        throw new Error(`${id} is owner-private and must deny anon`);
      }
      return;
    }

    if (enforcement.kind === "staff_write") {
      const updated = await queryAs<{ n: number }>(
        { role: "authenticated", sub: U.pro },
        `with upd as (
           update public.hotels set name = 'hacked-by-pro' where id = $1 returning id
         )
         select count(*)::int as n from upd`,
        [baliHotels[0]],
      );
      const blocked = updated.error !== null || updated.rows[0]?.n === 0;
      expect(blocked, id).toBe(true);
      const name = await adminQuery<{ name: string }>(
        "select name from public.hotels where id = $1",
        [baliHotels[0]],
      );
      expect(name[0]!.name).not.toBe("hacked-by-pro");
      return;
    }

    if (enforcement.kind === "purchase_is_not_access") {
      const proFlag = await queryAs<{ v: boolean }>(
        { role: "authenticated", sub: U.free },
        "select public.has_active_pro() as v",
      );
      expect(proFlag.error).toBeNull();
      expect(proFlag.rows[0]?.v).toBe(false);
      expect(await premium(actor("free"), baliHotels[0]!)).toBe(false);

      const inserted = await queryAs(
        { role: "authenticated", sub: U.pro },
        `insert into public.access_entitlements (user_id, access_type, status, starts_at)
         values ($1, 'pro', 'active', now())`,
        [U.pro],
      );
      expect(inserted.error).not.toBeNull();

      const altered = await queryAs<{ n: number }>(
        { role: "authenticated", sub: U.pro },
        `with upd as (
           update public.access_entitlements set status = 'revoked' where user_id = $1 returning id
         )
         select count(*)::int as n from upd`,
        [U.other],
      );
      expect(altered.error !== null || altered.rows[0]?.n === 0).toBe(true);

      const removed = await queryAs<{ n: number }>(
        { role: "authenticated", sub: U.pro },
        `with del as (
           delete from public.access_entitlements where user_id = $1 returning id
         )
         select count(*)::int as n from del`,
        [U.other],
      );
      expect(removed.error !== null || removed.rows[0]?.n === 0).toBe(true);

      const stillThere = await adminQuery<{ status: string }>(
        "select status from public.access_entitlements where user_id = $1 and access_type = 'pro'",
        [U.other],
      );
      expect(stillThere.map((row) => row.status)).toContain("active");
      return;
    }

    if (enforcement.kind === "caller_scoped_rpc") {
      const call =
        enforcement.rpc === "creator_personal_counts"
          ? "select public.creator_personal_counts() as r"
          : "select public.creator_past_collaborations(null) as r";
      const anonCall = await queryAs({ role: "anon", sub: null }, call);
      expect(anonCall.error, id).not.toBeNull();
      expect(anonCall.error!.message, id).toMatch(/permission denied/i);

      if (enforcement.rpc === "creator_personal_counts") {
        const owner = await queryAs<{ r: { result: string; agreements: number } }>(
          { role: "authenticated", sub: U.other },
          call,
        );
        expect(owner.error, id).toBeNull();
        expect(owner.rows[0]!.r.result, id).toBe("ok");
        expect(owner.rows[0]!.r.agreements, id).toBeGreaterThan(0);
        const attacker = await queryAs<{ r: { result: string; agreements: number } }>(
          { role: "authenticated", sub: U.pro },
          call,
        );
        expect(attacker.error, id).toBeNull();
        expect(attacker.rows[0]!.r.result, id).toBe("ok");
        expect(attacker.rows[0]!.r.agreements, id).toBe(0);
        return;
      }

      const inserted = await adminQuery<{ id: string }>(
        `insert into public.collaborations (creator_id, hotel_id, status, collaboration_type)
         values ($1, $2, 'completed', 'stay') returning id`,
        [creators.other, baliHotels[0]],
      );
      const pastId = inserted[0]!.id;
      const owner = await queryAs<{ r: { result: string; collaborations: { id: string }[] } }>(
        { role: "authenticated", sub: U.other },
        call,
      );
      expect(owner.error, id).toBeNull();
      expect(JSON.stringify(owner.rows), id).toContain(pastId);
      const attacker = await queryAs({ role: "authenticated", sub: U.pro }, call);
      expect(attacker.error, id).toBeNull();
      expect(JSON.stringify(attacker), id).not.toContain(pastId);
      return;
    }

    if (enforcement.kind === "metric_ranking") {
      const metric = enforcement.layer === "public" ? "creator_activity" : "response_rate";
      if (enforcement.layer === "public") {
        for (const name of ["anon", "free", "pass", "pro", "expired"] as const) {
          const who = actor(name);
          const result = await queryAs<{ body: { result: string } }>(
            { role: who.role, sub: who.userId },
            "select public.read_destination_metric_ranking($1, $2) as body",
            [DEST.bali, metric],
          );
          expect(result.error, id).toBeNull();
          expect(result.rows[0]?.body.result, id).toBe("ok");
          expect(JSON.stringify(result.rows[0]?.body), id).not.toMatch(
            /owner_user_id|evidence_id|"score"/,
          );
        }
        return;
      }
      for (const name of ["anon", "free", "expired", "revoked"] as const) {
        const who = actor(name);
        const result = await queryAs<{ body: { result: string; hotels?: unknown } }>(
          { role: who.role, sub: who.userId },
          "select public.read_destination_metric_ranking($1, $2) as body",
          [DEST.bali, metric],
        );
        expect(result.error, id).toBeNull();
        expect(result.rows[0]?.body.result, id).toBe("locked");
        expect(result.rows[0]?.body.hotels, id).toBeUndefined();
      }
      for (const name of ["pass", "pro"] as const) {
        const who = actor(name);
        const result = await queryAs<{ body: { result: string } }>(
          { role: who.role, sub: who.userId },
          "select public.read_destination_metric_ranking($1, 'response_rate') as body",
          [DEST.bali],
        );
        expect(result.error, id).toBeNull();
        expect(result.rows[0]?.body.result, id).toBe("ok");
      }
      const ibiza = await queryAs<{ body: { result: string; hotels?: unknown } }>(
        { role: "authenticated", sub: U.pass },
        "select public.read_destination_metric_ranking($1, 'response_time') as body",
        [DEST.ibiza],
      );
      expect(ibiza.error, id).toBeNull();
      expect(ibiza.rows[0]?.body.result, id).toBe("locked");
      expect(ibiza.rows[0]?.body.hotels, id).toBeUndefined();
      const premiumView = await queryAs(
        { role: "anon", sub: null },
        "select hotel_id from public.hotel_metric_signal_premium",
      );
      expect(premiumView.error, id).not.toBeNull();
      return;
    }

    if (enforcement.kind === "kept_current") {
      expect(["owner_private", "all_tiers", "public_page"]).toContain(
        INVENTORY.find((entry) => entry.id === id)?.rule.kind,
      );
      return;
    }

    const _exhaustive: never = enforcement;
    throw new Error(`unprobed enforcement for ${id}: ${JSON.stringify(_exhaustive)}`);
  }
});
