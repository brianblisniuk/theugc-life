/**
 * D08 profile input and count display. No database.
 *
 * A missing count is not zero. A rate, an amount, and a decline are not
 * rendered. Unknown terms are not shown as a recorded "no".
 */
import { describe, expect, it } from "vitest";

import {
  mapPastCollaborations,
  mapPersonalCounts,
  parseProfileForm,
  personalCountEntries,
  type ProfileWrite,
} from "@/lib/profile/contract";

const HOTEL = "d0830000-0000-0000-0000-000000000001";
const COLL = "d0840000-0000-0000-0000-000000000001";

function fields(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    displayName: "Ada",
    username: "ada_ugc",
    bio: "",
    homeCity: "",
    homeCountry: "",
    profilePhotoUrl: "",
    primaryLanguage: "",
    languages: "",
    creatorNiches: "",
    contentFormats: "",
    instagramUrl: "",
    instagramHandle: "",
    tiktokUrl: "",
    tiktokHandle: "",
    youtubeUrl: "",
    websiteUrl: "",
    ...overrides,
  };
}

describe("profile form", () => {
  it("keeps public portfolio columns out of the write", () => {
    const parsed = parseProfileForm(fields());
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const keys = Object.keys(parsed.value) as (keyof ProfileWrite)[];
    expect(keys).not.toContain("public_profile_enabled" as keyof ProfileWrite);
    expect(keys).not.toContain("portfolio_visibility" as keyof ProfileWrite);
    expect(keys).not.toContain("opted_in" as keyof ProfileWrite);
    expect(keys.join(" ")).not.toMatch(/token|share/i);
    expect(parsed.value.languages).toEqual([]);
    expect(parsed.value.bio).toBeNull();
  });

  it("rejects a public http photo link and a short username", () => {
    expect(parseProfileForm(fields({ username: "ab" })).ok).toBe(false);
    expect(parseProfileForm(fields({ profilePhotoUrl: "http://cdn.example/a.jpg" })).ok).toBe(
      false,
    );
    const https = parseProfileForm(
      fields({ profilePhotoUrl: "https://cdn.example/a.jpg", instagramHandle: "@Ada.ugc" }),
    );
    expect(https.ok).toBe(true);
    if (!https.ok) return;
    expect(https.value.profilePhotoUrl).toBe("https://cdn.example/a.jpg");
    expect(https.value.instagramHandle).toBe("Ada.ugc");
  });

  it("dedupes niche tokens and does not invent a taxonomy", () => {
    const parsed = parseProfileForm(fields({ creatorNiches: " Hotels , hotels, Food " }));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.creatorNiches).toEqual(["Hotels", "Food"]);
  });
});

describe("personal counts", () => {
  it("shows a real zero as a count and never as a rate", () => {
    const load = mapPersonalCounts({
      result: "ok",
      outreach: 0,
      replies: 1,
      agreements: 2,
      completed_collaborations: 0,
      deliverables_done: 3,
    });
    expect(load.status).toBe("ok");
    if (load.status !== "ok") return;
    const entries = personalCountEntries(load.counts);
    expect(entries.map((entry) => entry.value)).toEqual(["0", "1", "2", "0", "3"]);
    expect(entries.some((entry) => entry.value.includes("%") || entry.label.includes("rate"))).toBe(
      false,
    );
  });

  it("treats a missing profile as unknown, not zero", () => {
    expect(
      mapPersonalCounts({
        result: "not_found",
        outreach: null,
        replies: null,
        agreements: null,
        completed_collaborations: null,
        deliverables_done: null,
      }),
    ).toEqual({ status: "not_found" });
    expect(
      mapPersonalCounts({
        result: "not_found",
        outreach: 0,
        replies: 0,
        agreements: 0,
        completed_collaborations: 0,
        deliverables_done: 0,
      }).status,
    ).toBe("error");
  });

  it("refuses a payload that carries a rate, an amount, or a decline", () => {
    const base = {
      result: "ok",
      outreach: 4,
      replies: 1,
      agreements: 1,
      completed_collaborations: 1,
      deliverables_done: 1,
    };
    expect(mapPersonalCounts({ ...base, reply_rate: 0.25 }).status).toBe("error");
    expect(mapPersonalCounts({ ...base, unpaid: 0 }).status).toBe("error");
    expect(mapPersonalCounts({ ...base, ghosted: 2 }).status).toBe("error");
    expect(mapPersonalCounts({ ...base, declined: 1 }).status).toBe("error");
  });
});

describe("past collaborations", () => {
  it("links a completed row to the hotel and does not treat unknown as no", () => {
    const load = mapPastCollaborations({
      result: "ok",
      collaborations: [
        {
          id: COLL,
          hotel_id: HOTEL,
          hotel_name: "Reef",
          status: "cancelled",
          collaboration_type: null,
          start_date: null,
          end_date: "2026-03-01",
          would_work_again: null,
          terms_matched: "unknown",
        },
      ],
    });
    expect(load.status).toBe("ok");
    if (load.status !== "ok") return;
    expect(load.items[0]).toMatchObject({
      statusLabel: "Cancelled",
      href: `/app/hotels/${HOTEL}?from=pipeline`,
      againLabel: "Not recorded",
      termsLabel: null,
      when: "2026-03-01",
    });
    expect(load.items[0]!.statusLabel).not.toMatch(/declin|lost|ghost/i);
  });

  it("rejects an open collaboration and a compensation amount", () => {
    expect(
      mapPastCollaborations({
        result: "ok",
        collaborations: [
          {
            id: COLL,
            hotel_id: HOTEL,
            hotel_name: "Reef",
            status: "agreed",
            collaboration_type: "stay",
            start_date: null,
            end_date: null,
            would_work_again: null,
            terms_matched: "unknown",
          },
        ],
      }).status,
    ).toBe("error");
    expect(
      mapPastCollaborations({
        result: "ok",
        collaborations: [
          {
            id: COLL,
            hotel_id: HOTEL,
            hotel_name: "Reef",
            status: "completed",
            collaboration_type: "stay",
            start_date: null,
            end_date: null,
            would_work_again: false,
            terms_matched: "no",
            private_value_amount: 0,
          },
        ],
      }).status,
    ).toBe("error");
  });

  it("treats a missing profile as null, not an empty list", () => {
    expect(mapPastCollaborations({ result: "not_found", collaborations: null })).toEqual({
      status: "not_found",
    });
    expect(mapPastCollaborations({ result: "not_found", collaborations: [] }).status).toBe("error");
    expect(mapPastCollaborations({ result: "ok", collaborations: [] })).toEqual({
      status: "ok",
      items: [],
    });
  });
});
