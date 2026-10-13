/**
 * SECURITY: premium contact authorization (PERMISSIONS.md §7, §13.1–§13.6).
 *
 * Premium intelligence still asks `has_premium_hotel_access`. Contact rows do
 * not. `hotel_contacts` RLS requires this user's unlock, or admin/editor
 * (D100). A Pass or Pro row is not an unlock. These tests exercise both
 * against real Postgres.
 *
 * Highest-priority property: an unauthorized caller can never obtain premium
 * email / phone / LinkedIn values.
 */
import { describe, expect, it, beforeAll, afterAll } from "vitest";

import {
  adminQuery,
  commitAs,
  hasTestDb,
  queryAs,
  setupDatabase,
  teardownDatabase,
} from "../db/harness";
import { HOTEL, USERS, seed } from "../rls/seed";
import { HOTEL_PUBLIC_COLUMNS, PREMIUM_CONTACT_FIELDS } from "@/lib/hotels/columns";

const d = describe.skipIf(!hasTestDb);

/** Mirrors the app's gate: ask the DB, as this user, for premium access. */
async function premiumAccess(sub: string | null, hotelId: string): Promise<boolean | null> {
  const res = await queryAs<{ ok: boolean }>(
    { role: sub ? "authenticated" : "anon", sub },
    "select public.has_premium_hotel_access($1) as ok",
    [hotelId],
  );
  if (res.error) return null;
  return res.rows[0]?.ok ?? null;
}

/** The exact contact projection the app would run, as this user. */
async function fetchContacts(sub: string | null, hotelId: string) {
  return queryAs<Record<string, unknown>>(
    { role: sub ? "authenticated" : "anon", sub },
    "select id, display_name, first_name, last_name, job_title, email, phone, linkedin_url from public.hotel_contacts where hotel_id = $1",
    [hotelId],
  );
}

beforeAll(async () => {
  if (!hasTestDb) return;
  await setupDatabase();
  await seed();
  // Give the Bali contact real premium values so a leak would be visible.
  await adminQuery(
    `update public.hotel_contacts
        set email = 'premium@leak.test', phone = '+971500000000',
            linkedin_url = 'https://linkedin.com/in/premium-leak'
      where hotel_id = $1`,
    [HOTEL.bali],
  );
}, 120_000);

afterAll(async () => {
  await teardownDatabase();
});

d("premium access gate — has_premium_hotel_access", () => {
  it("is FALSE for a free creator", async () => {
    expect(await premiumAccess(USERS.free, HOTEL.bali)).toBe(false);
  });

  it("is TRUE for a creator entitled to that destination", async () => {
    expect(await premiumAccess(USERS.destBali, HOTEL.bali)).toBe(true);
  });

  it("is FALSE for an entitled creator on a DIFFERENT destination", async () => {
    expect(await premiumAccess(USERS.destBali, HOTEL.ibiza)).toBe(false);
  });

  it("is TRUE for an active Pro anywhere", async () => {
    expect(await premiumAccess(USERS.pro, HOTEL.bali)).toBe(true);
    expect(await premiumAccess(USERS.pro, HOTEL.ibiza)).toBe(true);
  });

  it("is TRUE for admin and editor", async () => {
    expect(await premiumAccess(USERS.admin, HOTEL.bali)).toBe(true);
    expect(await premiumAccess(USERS.editor, HOTEL.bali)).toBe(true);
  });

  it("is FALSE for an expired pass and a revoked Pro", async () => {
    expect(await premiumAccess(USERS.expired, HOTEL.bali)).toBe(false);
    expect(await premiumAccess(USERS.revoked, HOTEL.bali)).toBe(false);
  });

  it("covers child destinations of an entitled parent", async () => {
    // Ubud is a child of Bali; a Bali pass must reach it.
    expect(await premiumAccess(USERS.destBali, HOTEL.ubud)).toBe(true);
  });
});

d("contact rows — RLS backstop", () => {
  it("free creator receives ZERO contact rows (no premium values at all)", async () => {
    const res = await fetchContacts(USERS.free, HOTEL.bali);
    expect(res.rows).toHaveLength(0);
    expect(JSON.stringify(res.rows)).not.toContain("premium@leak.test");
  });

  it("anonymous cannot read contacts", async () => {
    const res = await fetchContacts(null, HOTEL.bali);
    expect(res.error !== null || res.rows.length === 0).toBe(true);
  });

  it("an entitled destination creator receives no contact until they unlock", async () => {
    const res = await fetchContacts(USERS.destBali, HOTEL.bali);
    expect(res.rows).toHaveLength(0);
    expect(JSON.stringify(res)).not.toContain("premium@leak.test");
  });

  it("Pro receives no contact until they unlock", async () => {
    const res = await fetchContacts(USERS.pro, HOTEL.bali);
    expect(res.rows).toHaveLength(0);
    expect(JSON.stringify(res)).not.toContain("premium@leak.test");
  });

  it("the owner of an unlock receives the contact, and the other user still does not", async () => {
    await adminQuery(
      `insert into public.contact_cache (hotel_id, email, source, status, last_verified_at)
       values ($1, 'premium@leak.test', 'owner_import', 'found', now())
       on conflict (hotel_id) do update
         set email = excluded.email, status = 'found', last_verified_at = now()`,
      [HOTEL.bali],
    );
    const opened = await commitAs<{ result: { status: string; email: string | null } }>(
      { role: "authenticated", sub: USERS.free },
      "select public.unlock_hotel_contact($1, 'contact-access-unlock') as result",
      [HOTEL.bali],
    );
    expect(opened.error).toBeNull();
    expect(opened.rows[0]?.result.status).toBe("unlocked");
    expect(opened.rows[0]?.result.email).toBe("premium@leak.test");
    const visible = await fetchContacts(USERS.free, HOTEL.bali);
    expect(visible.rows.map((row) => row.email)).toEqual(["premium@leak.test"]);
    const other = await fetchContacts(USERS.pro, HOTEL.bali);
    expect(other.rows).toHaveLength(0);
    expect(JSON.stringify(other)).not.toContain("premium@leak.test");
  });

  it("expired and revoked entitlements receive nothing", async () => {
    expect((await fetchContacts(USERS.expired, HOTEL.bali)).rows).toHaveLength(0);
    expect((await fetchContacts(USERS.revoked, HOTEL.bali)).rows).toHaveLength(0);
  });

  it("never serializes premium fields for any unauthorized identity", async () => {
    for (const sub of [USERS.expired, USERS.revoked, USERS.destBali]) {
      const res = await fetchContacts(sub, HOTEL.bali);
      const serialized = JSON.stringify(res.rows);
      for (const field of ["premium@leak.test", "+971500000000", "linkedin.com/in/premium-leak"]) {
        expect(serialized).not.toContain(field);
      }
    }
  });
});

d("discovery projection never carries contact data", () => {
  it("the hotel column allow-list contains no premium contact field", () => {
    // Pinning this prevents a future 'convenience' join from leaking contacts.
    for (const field of PREMIUM_CONTACT_FIELDS) {
      expect(HOTEL_PUBLIC_COLUMNS as readonly string[]).not.toContain(field);
    }
  });

  it("a free creator can still read hotel basics (hotels are world-readable)", async () => {
    const res = await queryAs<{ id: string; name: string }>(
      { role: "authenticated", sub: USERS.free },
      "select id, name from public.hotels where id = $1",
      [HOTEL.bali],
    );
    expect(res.error).toBeNull();
    expect(res.rows).toHaveLength(1);
  });
});
