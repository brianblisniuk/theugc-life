/**
 * D096–D097. The page projection drops anything that is not a basic field
 * or a simple count. Missing and private are null, not zero.
 */
import { describe, expect, it } from "vitest";

import { PUBLIC_CARD_KEYS, projectPublicCard } from "@/lib/profile/public-card";

const RAW = {
  display_name: "Ada",
  username: "ada",
  bio: "Travel",
  home_city: "BA",
  home_country: "AR",
  profile_photo_url: null,
  primary_language: "es",
  languages: ["es"],
  creator_niches: ["travel"],
  content_formats: ["reel"],
  instagram_url: null,
  instagram_handle: null,
  tiktok_url: null,
  tiktok_handle: null,
  youtube_url: null,
  website_url: null,
  outreach: 1,
  replies: 2,
  agreements: 3,
  completed_collaborations: 4,
  deliverables_done: 5,
  hotel_name: "Casa Lumbre",
  email: "secret@hotel.example",
  private_value_amount: 99999,
  past_collaborations: [{ hotel_name: "Casa Lumbre" }],
};

describe("projectPublicCard", () => {
  it("returns null for a missing card and for a non-integer count", () => {
    expect(projectPublicCard(null)).toBeNull();
    expect(projectPublicCard(undefined)).toBeNull();
    expect(projectPublicCard({ ...RAW, outreach: 1.5 })).toBeNull();
    expect(projectPublicCard({ ...RAW, username: "  " })).toBeNull();
    expect(projectPublicCard({ ...RAW, replies: null })).toBeNull();
  });

  it("keeps basic fields and counts and drops hotel names, emails, and amounts", () => {
    const card = projectPublicCard(RAW);
    expect(card?.username).toBe("ada");
    expect(card?.counts).toEqual({
      outreach: 1,
      replies: 2,
      agreements: 3,
      completedCollaborations: 4,
      deliverablesDone: 5,
    });
    const packed = JSON.stringify(card);
    expect(packed).not.toContain("Casa Lumbre");
    expect(packed).not.toContain("secret@hotel.example");
    expect(packed).not.toContain("99999");
    expect(packed).not.toContain("past_collaborations");
    expect(packed).not.toContain("%");
    expect(PUBLIC_CARD_KEYS).not.toContain("hotel_name");
    expect(Object.keys(RAW).filter((key) => !(PUBLIC_CARD_KEYS as readonly string[]).includes(key))).toEqual([
      "hotel_name",
      "email",
      "private_value_amount",
      "past_collaborations",
    ]);
  });
});
