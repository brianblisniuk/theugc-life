/**
 * SECURITY: premium contact authorization (PERMISSIONS.md §7, §13.1–§13.6).
 *
 * The hotel detail page decides whether to fetch contacts by asking the
 * database `has_premium_hotel_access(hotel_id)`, and `hotel_contacts` RLS
 * (`using (public.has_premium_hotel_access(hotel_id))`) is the backstop. These
 * tests exercise BOTH against real Postgres with real roles, so a UI change can
 * never quietly widen access.
 *
 * Highest-priority property: an unauthorized caller can never obtain premium
 * email / phone / LinkedIn values.
 */
import { describe, expect, it, beforeAll, afterAll } from "vitest";

import { adminQuery, hasTestDb, queryAs, setupDatabase, teardownDatabase } from "../db/harness";
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

  it("entitled destination creator DOES receive the contact", async () => {
    const res = await fetchContacts(USERS.destBali, HOTEL.bali);
    expect(res.error).toBeNull();
    expect(res.rows).toHaveLength(1);
    expect(res.rows[0]!.email).toBe("premium@leak.test");
  });

  it("Pro DOES receive the contact", async () => {
    const res = await fetchContacts(USERS.pro, HOTEL.bali);
    expect(res.error).toBeNull();
    expect(res.rows).toHaveLength(1);
  });

  it("expired and revoked entitlements receive nothing", async () => {
    expect((await fetchContacts(USERS.expired, HOTEL.bali)).rows).toHaveLength(0);
    expect((await fetchContacts(USERS.revoked, HOTEL.bali)).rows).toHaveLength(0);
  });

  it("never serializes premium fields for any unauthorized identity", async () => {
    for (const sub of [USERS.free, USERS.expired, USERS.revoked]) {
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
