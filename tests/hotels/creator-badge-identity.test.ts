/**
 * Pipeline and trip rows store creator_profiles.id. The session id is
 * auth.uid(). Those two values differ. Passing the auth id into the badge
 * assembler drops the viewer's own rows and the shortlist looks empty.
 */
import { describe, expect, it } from "vitest";

import { assembleCreatorBadges } from "@/lib/hotels/card-signal";
import { loadSessionCreatorBadges, type HotelQueryClient } from "@/lib/hotels/queries";

const AUTH_UID = "11111111-1111-1111-1111-111111111111";
const PROFILE_ID = "99999999-9999-9999-9999-999999999999";
const OTHER_PROFILE = "88888888-8888-8888-8888-888888888888";
const HOTEL = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const TRIP = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";

type Outcome = { data: unknown; error: unknown };

function builder(outcome: Outcome, executed: string[], table: string, eqs: string[]) {
  const run = () => {
    executed.push(table);
    return Promise.resolve(outcome);
  };
  const chain: Record<string, unknown> = {
    select: () => chain,
    eq: (column: string, value: string) => {
      eqs.push(`${table}.${column}=${value}`);
      return chain;
    },
    in: () => chain,
    neq: () => chain,
    maybeSingle: () => run(),
    then: (resolve: (value: Outcome) => unknown) => run().then(resolve),
  };
  return chain;
}

function client(outcomes: Record<string, Outcome>, executed: string[], eqs: string[]) {
  return {
    from: (table: string) =>
      builder(outcomes[table] ?? { data: [], error: null }, executed, table, eqs),
  } as unknown as HotelQueryClient;
}

const OWN_ROWS: Record<string, Outcome> = {
  creator_profiles: { data: { id: PROFILE_ID }, error: null },
  pipeline_items: {
    data: [
      { hotel_id: HOTEL, creator_id: OTHER_PROFILE, status: "negotiating" },
      { hotel_id: HOTEL, creator_id: PROFILE_ID, status: "pitched" },
    ],
    error: null,
  },
  trip_hotels: {
    data: [
      { hotel_id: HOTEL, trip_id: "trip-other", trip: { creator_id: OTHER_PROFILE } },
      { hotel_id: HOTEL, trip_id: TRIP, trip: { creator_id: PROFILE_ID } },
    ],
    error: null,
  },
};

describe("creator badge identity", () => {
  it("keeps the viewer's badges when the auth uid and the creator profile id differ", async () => {
    expect(AUTH_UID).not.toBe(PROFILE_ID);
    const executed: string[] = [];
    const eqs: string[] = [];
    const loaded = await loadSessionCreatorBadges(
      [HOTEL],
      AUTH_UID,
      client(OWN_ROWS, executed, eqs),
    );

    expect(eqs).toContain(`creator_profiles.user_id=${AUTH_UID}`);
    expect(loaded.status).toBe("known");
    if (loaded.status !== "known") return;
    const badge = loaded.byHotel.get(HOTEL);
    expect(badge?.pipeline).toEqual({ kind: "status", label: "Sent" });
    expect(badge?.tripIds).toEqual([TRIP]);
    expect(JSON.stringify(badge)).not.toContain("negotiating");
    expect(JSON.stringify(badge)).not.toContain("trip-other");

    const dropped = assembleCreatorBadges({
      hotelIds: [HOTEL],
      viewerId: AUTH_UID,
      pipelineRows: [{ hotelId: HOTEL, creatorId: PROFILE_ID, status: "pitched" }],
      tripRows: [{ hotelId: HOTEL, creatorId: PROFILE_ID, tripId: TRIP }],
    }).get(HOTEL);
    expect(dropped?.pipeline).toEqual({ kind: "none" });
    expect(dropped?.tripIds).toEqual([]);
  });

  it("returns unknown when the creator profile lookup fails or the id is unusable", async () => {
    for (const profile of [
      { data: null, error: { message: "db down" } },
      { data: null, error: null },
      { data: { id: "not-a-uuid" }, error: null },
    ]) {
      const executed: string[] = [];
      const loaded = await loadSessionCreatorBadges(
        [HOTEL],
        AUTH_UID,
        client({ ...OWN_ROWS, creator_profiles: profile }, executed, []),
      );
      expect(loaded.status).toBe("unknown");
      expect(executed).not.toContain("pipeline_items");
    }
  });
});
