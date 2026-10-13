/**
 * Published-catalog predicate (D062, D054, D060).
 *
 * A hotels row is not rendered unless the column-visible publishability
 * conditions hold. Unknown closure stays visible. Permanently closed does not.
 * Fractional ratings are not classifications.
 */
import { describe, expect, it } from "vitest";

import {
  hospitalityClassificationLabel,
  isPublishableStarProvenance,
  isPublishedCanonicalHotel,
  PUBLISHED_ACTIVE_STATUSES,
  PUBLISHED_CANONICAL_HOTEL_WHERE,
  PUBLISHABLE_STAR_PROVENANCE_OR,
  PUBLISHED_STAR_RATINGS,
  type PublicationFacts,
} from "@/lib/hotels/publication";

const published: PublicationFacts = {
  destinationId: "d1",
  starRating: 5,
  latitude: 25.2,
  longitude: 55.27,
  activeStatus: "unknown",
};

describe("isPublishedCanonicalHotel", () => {
  it("accepts an A05-shaped row: 4 or 5 stars, coordinates, closure unknown", () => {
    expect(isPublishedCanonicalHotel(published)).toBe(true);
    expect(isPublishedCanonicalHotel({ ...published, starRating: 4, activeStatus: "active" })).toBe(
      true,
    );
    expect(isPublishedCanonicalHotel({ ...published, activeStatus: "temporarily_closed" })).toBe(
      true,
    );
  });

  it("rejects a permanently closed hotel", () => {
    expect(isPublishedCanonicalHotel({ ...published, activeStatus: "closed" })).toBe(false);
  });

  it("rejects a missing classification, a 3-star row, and a fractional rating", () => {
    expect(isPublishedCanonicalHotel({ ...published, starRating: null })).toBe(false);
    expect(isPublishedCanonicalHotel({ ...published, starRating: 3 })).toBe(false);
    expect(isPublishedCanonicalHotel({ ...published, starRating: 4.5 })).toBe(false);
    expect(isPublishedCanonicalHotel({ ...published, starRating: 0 })).toBe(false);
  });

  it("rejects a hotel with no coordinates or an impossible coordinate", () => {
    expect(isPublishedCanonicalHotel({ ...published, latitude: null })).toBe(false);
    expect(isPublishedCanonicalHotel({ ...published, longitude: null })).toBe(false);
    expect(isPublishedCanonicalHotel({ ...published, latitude: 120 })).toBe(false);
    expect(isPublishedCanonicalHotel({ ...published, longitude: 200 })).toBe(false);
  });

  it("rejects a row with no destination", () => {
    expect(isPublishedCanonicalHotel({ ...published, destinationId: null })).toBe(false);
  });

  it("keeps the SQL fragment aligned with the same stars and statuses", () => {
    for (const star of PUBLISHED_STAR_RATINGS) {
      expect(PUBLISHED_CANONICAL_HOTEL_WHERE).toContain(String(star));
    }
    for (const status of PUBLISHED_ACTIVE_STATUSES) {
      expect(PUBLISHED_CANONICAL_HOTEL_WHERE).toContain(`'${status}'`);
    }
    expect(PUBLISHED_CANONICAL_HOTEL_WHERE).not.toContain("'closed'");
    expect(PUBLISHED_CANONICAL_HOTEL_WHERE).toContain("star_rating_source = 'hotelbeds'");
    expect(PUBLISHED_CANONICAL_HOTEL_WHERE).toContain("star_rating_confidence = 'provisional'");
    expect(PUBLISHED_CANONICAL_HOTEL_WHERE).toContain("star_rating_source = 'owner'");
    expect(PUBLISHABLE_STAR_PROVENANCE_OR).toContain("hotelbeds");
    expect(PUBLISHABLE_STAR_PROVENANCE_OR).toContain("provisional");
  });

  it("publishes Hotelbeds provisional 4 and 5, and owner confirmed", () => {
    expect(
      isPublishedCanonicalHotel({
        ...published,
        starRatingSource: "hotelbeds",
        starRatingConfidence: "provisional",
      }),
    ).toBe(true);
    expect(
      isPublishedCanonicalHotel({
        ...published,
        starRating: 4,
        starRatingSource: "hotelbeds",
        starRatingConfidence: "provisional",
      }),
    ).toBe(true);
    expect(
      isPublishedCanonicalHotel({
        ...published,
        starRatingSource: "owner",
        starRatingConfidence: "confirmed",
      }),
    ).toBe(true);
    expect(isPublishableStarProvenance(undefined, undefined)).toBe(true);
    expect(isPublishableStarProvenance(null, null)).toBe(true);
  });

  it("does not publish a provenance pair D106 did not allow", () => {
    expect(
      isPublishedCanonicalHotel({
        ...published,
        starRatingSource: "hotelbeds",
        starRatingConfidence: "confirmed",
      }),
    ).toBe(false);
    expect(
      isPublishedCanonicalHotel({
        ...published,
        starRatingSource: "owner",
        starRatingConfidence: "provisional",
      }),
    ).toBe(false);
    expect(
      isPublishedCanonicalHotel({
        ...published,
        starRatingSource: "booking",
        starRatingConfidence: "confirmed",
      }),
    ).toBe(false);
    expect(isPublishableStarProvenance("hotelbeds", null)).toBe(false);
    expect(isPublishableStarProvenance(null, "provisional")).toBe(false);
  });
});

describe("hospitalityClassificationLabel", () => {
  it("names 4 and 5 as classification, not a review score", () => {
    expect(hospitalityClassificationLabel(4)).toBe("4-star hospitality classification");
    expect(hospitalityClassificationLabel(5)).toBe("5-star hospitality classification");
    expect(hospitalityClassificationLabel(4)).not.toMatch(/review|tripadvisor|booking|google/i);
  });

  it("does not round, average, or render zero", () => {
    expect(hospitalityClassificationLabel(4.7)).toBeNull();
    expect(hospitalityClassificationLabel(4.5)).toBeNull();
    expect(hospitalityClassificationLabel(0)).toBeNull();
    expect(hospitalityClassificationLabel(null)).toBeNull();
    expect(hospitalityClassificationLabel(3)).toBeNull();
  });
});
