/**
 * Deterministic fixtures for the RLS suite. All inserts run as the superuser
 * (adminQuery), so they persist across the rolled-back `queryAs` calls the tests
 * use to probe policy behavior.
 */
import { adminQuery } from "../db/harness";

export const USERS = {
  /** Destination Pass for Bali (active). Owns a pipeline item + trip. */
  destBali: "11111111-1111-1111-1111-111111111111",
  /** Active Pro (worldwide). Owns a pipeline item + trip. */
  pro: "22222222-2222-2222-2222-222222222222",
  /** Free creator, no entitlement. */
  free: "33333333-3333-3333-3333-333333333333",
  /** Expired Bali pass; owns a pipeline item (must survive expiry). */
  expired: "44444444-4444-4444-4444-444444444444",
  /** Editor role. */
  editor: "55555555-5555-5555-5555-555555555555",
  /** Admin role. */
  admin: "66666666-6666-6666-6666-666666666666",
  /** Revoked Pro entitlement. */
  revoked: "77777777-7777-7777-7777-777777777777",
} as const;

export const DEST = {
  bali: "d0000000-0000-0000-0000-000000000001",
  ubud: "d0000000-0000-0000-0000-000000000002", // child of Bali
  ibiza: "d0000000-0000-0000-0000-000000000003",
} as const;

export const HOTEL = {
  bali: "40000000-0000-0000-0000-000000000001",
  ubud: "40000000-0000-0000-0000-000000000002",
  ibiza: "40000000-0000-0000-0000-000000000003",
} as const;

export const TRIP = {
  destBali: "70000000-0000-0000-0000-000000000001",
  pro: "70000000-0000-0000-0000-000000000002",
} as const;

export interface CreatorIds {
  destBali: string;
  pro: string;
  free: string;
  expired: string;
  editor: string;
  admin: string;
  revoked: string;
}

/** Insert all fixtures. Returns creator_profile ids keyed by user alias. */
export async function seed(): Promise<CreatorIds> {
  // Auth users (fires handle_new_user → users + creator_profiles).
  for (const id of Object.values(USERS)) {
    await adminQuery("insert into auth.users (id, email) values ($1, $2)", [
      id,
      `${id}@test.local`,
    ]);
  }

  // Assign privileged roles (as superuser — the privilege-guard trigger permits
  // this only for trusted DB roles).
  await adminQuery("update public.users set role = 'editor' where id = $1", [USERS.editor]);
  await adminQuery("update public.users set role = 'admin' where id = $1", [USERS.admin]);

  // Destinations (Ubud is a child of Bali).
  await adminQuery(
    `insert into public.destinations (id, name, slug, type) values
       ($1,'Bali','bali','island'), ($2,'Ibiza','ibiza','island')`,
    [DEST.bali, DEST.ibiza],
  );
  await adminQuery(
    `insert into public.destinations (id, name, slug, type, parent_destination_id)
       values ($1,'Ubud','ubud','area',$2)`,
    [DEST.ubud, DEST.bali],
  );

  // Hotels + one contact each.
  await adminQuery(
    `insert into public.hotels (id, name, slug, destination_id) values
       ($1,'Bali Hotel','bali-hotel',$4),
       ($2,'Ubud Hotel','ubud-hotel',$5),
       ($3,'Ibiza Hotel','ibiza-hotel',$6)`,
    [HOTEL.bali, HOTEL.ubud, HOTEL.ibiza, DEST.bali, DEST.ubud, DEST.ibiza],
  );
  await adminQuery(
    `insert into public.hotel_contacts (hotel_id, first_name, email) values
       ($1,'Bali Contact','bali@h.com'),
       ($2,'Ubud Contact','ubud@h.com'),
       ($3,'Ibiza Contact','ibiza@h.com')`,
    [HOTEL.bali, HOTEL.ubud, HOTEL.ibiza],
  );

  // Entitlements.
  await adminQuery(
    `insert into public.access_entitlements (user_id, access_type, destination_id, status, starts_at)
       values ($1,'destination',$2,'active', now() - interval '1 day')`,
    [USERS.destBali, DEST.bali],
  );
  await adminQuery(
    `insert into public.access_entitlements (user_id, access_type, status, starts_at)
       values ($1,'pro','active', now() - interval '1 day')`,
    [USERS.pro],
  );
  await adminQuery(
    `insert into public.access_entitlements (user_id, access_type, destination_id, status, starts_at, expires_at)
       values ($1,'destination',$2,'active', now() - interval '100 days', now() - interval '10 days')`,
    [USERS.expired, DEST.bali],
  );
  await adminQuery(
    `insert into public.access_entitlements (user_id, access_type, status, starts_at)
       values ($1,'pro','revoked', now() - interval '1 day')`,
    [USERS.revoked],
  );

  // Resolve creator_profile ids.
  const rows = await adminQuery<{ user_id: string; id: string }>(
    "select user_id, id from public.creator_profiles",
  );
  const byUser = new Map(rows.map((r) => [r.user_id, r.id]));
  const creators: CreatorIds = {
    destBali: byUser.get(USERS.destBali)!,
    pro: byUser.get(USERS.pro)!,
    free: byUser.get(USERS.free)!,
    expired: byUser.get(USERS.expired)!,
    editor: byUser.get(USERS.editor)!,
    admin: byUser.get(USERS.admin)!,
    revoked: byUser.get(USERS.revoked)!,
  };

  // Pipeline items (with private notes) + trips.
  await adminQuery(
    `insert into public.pipeline_items (creator_id, hotel_id, private_notes) values
       ($1,$2,'secret notes A'),
       ($3,$4,'secret notes B'),
       ($5,$2,'secret notes expired')`,
    [creators.destBali, HOTEL.bali, creators.pro, HOTEL.ibiza, creators.expired],
  );
  await adminQuery(
    `insert into public.trips (id, creator_id, destination_id, start_date, end_date) values
       ($1,$2,$4,'2026-09-01','2026-09-10'),
       ($3,$5,$6,'2026-10-01','2026-10-10')`,
    [TRIP.destBali, creators.destBali, TRIP.pro, DEST.bali, creators.pro, DEST.ibiza],
  );

  return creators;
}
