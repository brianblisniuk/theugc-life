import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  adminQuery,
  commitAs,
  hasTestDb,
  queryAs,
  setupDatabase,
  teardownDatabase,
} from "../db/harness";
import { HOTEL, USERS, seed } from "../rls/seed";

const d = describe.skipIf(!hasTestDb);

const FORBES = "91000000-0000-4000-8000-000000000001";
const BEDS = "91000000-0000-4000-8000-000000000002";
const HIDDEN = "91000000-0000-4000-8000-000000000003";

d("hotel_media RLS (D189)", () => {
  beforeAll(async () => {
    await setupDatabase();
    await seed();
    await adminQuery(
      `insert into public.hotel_media
         (id, hotel_id, source, source_media_key, storage_bucket, storage_path, remote_path, role, position, alt_text, credit, rights_basis, status)
       values
         ($1, $2, 'forbes', 'city/a/facade', 'hotel-media', 'forbes/city/a/00-facade', null, 'gallery', 0, 'Facade', 'Forbes Travel Guide', 'owner_decision_D189', 'active'),
         ($3, $2, 'hotelbeds', '00/1/a.jpg', null, null, '00/1/a.jpg', 'gallery', 1, 'Pool', 'Hotelbeds', 'owner_decision_D189', 'active'),
         ($4, $2, 'hotelbeds', '00/1/hidden.jpg', null, null, '00/1/hidden.jpg', 'gallery', 2, 'Hidden', 'Hotelbeds', 'owner_decision_D189', 'hidden')`,
      [FORBES, HOTEL.bali, BEDS, HIDDEN],
    );
  }, 120_000);

  afterAll(async () => {
    await teardownDatabase();
  });

  it("lets anon read active rows and the Forbes-first cover, and hides the rest", async () => {
    const visible = await queryAs<{ id: string }>(
      { role: "anon" },
      "select id from public.hotel_media order by position",
    );
    expect(visible.error).toBeNull();
    expect(visible.rows.map((row) => row.id).sort()).toEqual([BEDS, FORBES].sort());
    const cover = await queryAs<{ source: string }>(
      { role: "anon" },
      "select source from public.hotel_cover where hotel_id = $1",
      [HOTEL.bali],
    );
    expect(cover.rows).toEqual([{ source: "forbes" }]);
    const hidden = await queryAs({ role: "anon" }, "select id from public.hotel_media where id = $1", [
      HIDDEN,
    ]);
    expect(hidden.rows).toEqual([]);
  });

  it("refuses anon and creator writes, and lets an editor hide", async () => {
    const anonInsert = await queryAs(
      { role: "anon" },
      `insert into public.hotel_media
         (hotel_id, source, source_media_key, remote_path, credit, rights_basis)
       values ($1, 'hotelbeds', 'x.jpg', 'x.jpg', 'Hotelbeds', 'owner_decision_D189')`,
      [HOTEL.bali],
    );
    expect(anonInsert.error).not.toBeNull();

    const creator = await queryAs<{ ok: boolean }>(
      { role: "authenticated", sub: USERS.free },
      "select public.hide_hotel_media($1::uuid) as ok",
      [FORBES],
    );
    expect(creator.error).toBeNull();
    expect(creator.rows[0]?.ok).toBe(false);

    const editor = await commitAs<{ ok: boolean }>(
      { role: "authenticated", sub: USERS.editor },
      "select public.hide_hotel_media($1::uuid) as ok",
      [BEDS],
    );
    expect(editor.error).toBeNull();
    expect(editor.rows[0]?.ok).toBe(true);
    const hidden = await adminQuery<{ status: string }>(
      "select status from public.hotel_media where id = $1",
      [BEDS],
    );
    expect(hidden[0]?.status).toBe("hidden");
    const anonAfter = await queryAs({ role: "anon" }, "select id from public.hotel_media where id = $1", [
      BEDS,
    ]);
    expect(anonAfter.rows).toEqual([]);
  });

  it("promotes one Forbes cover for service_role and refuses authenticated", async () => {
    const denied = await queryAs(
      { role: "authenticated", sub: USERS.admin },
      "select public.promote_hotel_covers($1::uuid[])",
      [[HOTEL.bali]],
    );
    expect(denied.error).not.toBeNull();
    // The test database does not grant schema usage to service_role. Hosted
    // Supabase does. The grant here is the same temporary grant the other
    // service-role suites use.
    await adminQuery("grant usage on schema public to service_role");
    try {
      const promoted = await commitAs<{ n: number }>(
        { role: "service_role" },
        "select public.promote_hotel_covers($1::uuid[]) as n",
        [[HOTEL.bali]],
      );
      expect(promoted.error).toBeNull();
      expect(promoted.rows[0]?.n).toBe(1);
      const covers = await adminQuery<{ source: string }>(
        `select source from public.hotel_media
          where hotel_id = $1 and role = 'cover' and status = 'active'`,
        [HOTEL.bali],
      );
      expect(covers).toEqual([{ source: "forbes" }]);
    } finally {
      await adminQuery("revoke usage on schema public from service_role");
    }
  });

  it("creates a public webp bucket and denies an anon object insert", async () => {
    const buckets = await adminQuery<{
      public: boolean;
      file_size_limit: string;
      allowed_mime_types: string[];
    }>(
      `select public, file_size_limit::text, allowed_mime_types
         from storage.buckets where id = 'hotel-media'`,
    );
    expect(buckets[0]).toEqual({
      public: true,
      file_size_limit: "2097152",
      allowed_mime_types: ["image/webp"],
    });
    await adminQuery(
      `insert into storage.objects (bucket_id, name)
       values ('hotel-media', 'forbes/a/w480.webp')
       on conflict (bucket_id, name) do nothing`,
    );
    const readable = await queryAs<{ name: string }>(
      { role: "anon" },
      `select name from storage.objects where bucket_id = 'hotel-media'`,
    );
    expect(readable.error).toBeNull();
    expect(readable.rows).toEqual([]);
    const inserted = await queryAs(
      { role: "anon" },
      `insert into storage.objects (bucket_id, name) values ('hotel-media', 'forbes/a/secret.webp')`,
    );
    expect(inserted.error).not.toBeNull();
    await adminQuery("grant insert on table storage.objects to anon");
    try {
      const withGrant = await queryAs(
        { role: "anon" },
        `insert into storage.objects (bucket_id, name) values ('hotel-media', 'forbes/a/secret.webp')`,
      );
      expect(withGrant.error).not.toBeNull();
    } finally {
      await adminQuery("revoke insert on table storage.objects from anon");
    }
  });

  it("moves a hidden Forbes object into the private bucket and restores it on unhide", async () => {
    const privateBucket = await adminQuery<{ public: boolean }>(
      "select public from storage.buckets where id = 'hotel-media-private'",
    );
    expect(privateBucket).toEqual([{ public: false }]);
    await adminQuery(
      `insert into storage.objects (bucket_id, name)
       values ('hotel-media', 'forbes/city/a/00-facade/w480.webp'),
              ('hotel-media', 'forbes/city/a/00-facade/w1280.webp')
       on conflict (bucket_id, name) do nothing`,
    );
    const creator = await queryAs<{ ok: boolean }>(
      { role: "authenticated", sub: USERS.free },
      "select public.unhide_hotel_media($1::uuid) as ok",
      [FORBES],
    );
    expect(creator.rows[0]?.ok).toBe(false);

    const hidden = await commitAs<{ ok: boolean }>(
      { role: "authenticated", sub: USERS.editor },
      "select public.hide_hotel_media($1::uuid) as ok",
      [FORBES],
    );
    expect(hidden.error).toBeNull();
    expect(hidden.rows[0]?.ok).toBe(true);
    const moved = await adminQuery<{ bucket_id: string; name: string }>(
      `select bucket_id, name from storage.objects
        where name like 'forbes/city/a/00-facade/%'
        order by name`,
    );
    expect(moved).toEqual([
      { bucket_id: "hotel-media-private", name: "forbes/city/a/00-facade/w1280.webp" },
      { bucket_id: "hotel-media-private", name: "forbes/city/a/00-facade/w480.webp" },
    ]);
    const listed = await queryAs<{ name: string }>(
      { role: "anon" },
      "select name from storage.objects where name like 'forbes/city/a/00-facade/%'",
    );
    expect(listed.rows).toEqual([]);
    const row = await adminQuery<{ status: string; storage_bucket: string }>(
      "select status, storage_bucket from public.hotel_media where id = $1",
      [FORBES],
    );
    expect(row[0]).toEqual({ status: "hidden", storage_bucket: "hotel-media-private" });

    const denied = await queryAs<{ ok: boolean }>(
      { role: "authenticated", sub: USERS.free },
      "select public.unhide_hotel_media($1::uuid) as ok",
      [FORBES],
    );
    expect(denied.rows[0]?.ok).toBe(false);
    const restored = await commitAs<{ ok: boolean }>(
      { role: "authenticated", sub: USERS.editor },
      "select public.unhide_hotel_media($1::uuid) as ok",
      [FORBES],
    );
    expect(restored.error).toBeNull();
    expect(restored.rows[0]?.ok).toBe(true);
    const back = await adminQuery<{ bucket_id: string }>(
      `select bucket_id from storage.objects
        where name like 'forbes/city/a/00-facade/%'
        order by name`,
    );
    expect(back.map((item) => item.bucket_id)).toEqual(["hotel-media", "hotel-media"]);
    const visible = await adminQuery<{ status: string; storage_bucket: string }>(
      "select status, storage_bucket from public.hotel_media where id = $1",
      [FORBES],
    );
    expect(visible[0]).toEqual({ status: "active", storage_bucket: "hotel-media" });
  });
});
