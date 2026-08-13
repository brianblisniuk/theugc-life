/**
 * Discover query parsing (PRD §7.2, §22).
 *
 * Pure — no database. Proves the URL contract, that unknown values are dropped
 * rather than forwarded to the database, and that results are always bounded.
 */
import { describe, expect, it } from "vitest";

import {
  DISCOVER_MAX_PAGE_SIZE,
  DISCOVER_PAGE_SIZE,
  buildDiscoverHref,
  hasActiveFilters,
  hotelTypeLabel,
  parseDiscoverQuery,
  sanitizeSearchTerm,
  verificationLabel,
} from "@/lib/hotels/filters";

describe("parseDiscoverQuery", () => {
  it("defaults to an unfiltered, bounded first page", () => {
    const q = parseDiscoverQuery({});
    expect(q).toEqual({
      q: null,
      type: null,
      minStars: null,
      verification: null,
      page: 1,
      pageSize: DISCOVER_PAGE_SIZE,
    });
    expect(hasActiveFilters(q)).toBe(false);
  });

  it("parses the documented URL shapes", () => {
    expect(parseDiscoverQuery({ q: "four seasons" }).q).toBe("four seasons");
    expect(parseDiscoverQuery({ type: "resort" }).type).toBe("resort");
    expect(parseDiscoverQuery({ stars: "5" }).minStars).toBe(5);
    expect(parseDiscoverQuery({ verified: "verified" }).verification).toBe("verified");
  });

  it("drops unknown hotel types instead of querying them", () => {
    expect(parseDiscoverQuery({ type: "spaceship" }).type).toBeNull();
    expect(parseDiscoverQuery({ type: "" }).type).toBeNull();
  });

  it("drops out-of-vocabulary star and verification values", () => {
    expect(parseDiscoverQuery({ stars: "7" }).minStars).toBeNull();
    expect(parseDiscoverQuery({ stars: "abc" }).minStars).toBeNull();
    expect(parseDiscoverQuery({ verified: "sort-of" }).verification).toBeNull();
  });

  it("caps page size at the hard ceiling and rejects junk paging", () => {
    expect(parseDiscoverQuery({ pageSize: "1000" }).pageSize).toBe(DISCOVER_MAX_PAGE_SIZE);
    expect(parseDiscoverQuery({ pageSize: "-5" }).pageSize).toBe(DISCOVER_PAGE_SIZE);
    expect(parseDiscoverQuery({ page: "0" }).page).toBe(1);
    expect(parseDiscoverQuery({ page: "abc" }).page).toBe(1);
    expect(parseDiscoverQuery({ page: "3" }).page).toBe(3);
  });

  it("takes the first value when a param repeats", () => {
    expect(parseDiscoverQuery({ q: ["dubai", "bali"] }).q).toBe("dubai");
  });

  it("marks filters active for any narrowing input", () => {
    expect(hasActiveFilters(parseDiscoverQuery({ q: "x" }))).toBe(true);
    expect(hasActiveFilters(parseDiscoverQuery({ type: "resort" }))).toBe(true);
    expect(hasActiveFilters(parseDiscoverQuery({ stars: "4" }))).toBe(true);
    expect(hasActiveFilters(parseDiscoverQuery({ page: "2" }))).toBe(false);
  });
});

describe("sanitizeSearchTerm", () => {
  it("strips characters that carry meaning in a PostgREST or() filter", () => {
    const cleaned = sanitizeSearchTerm("four,seasons(*)%\\'\"");
    expect(cleaned).not.toMatch(/[(),*%\\"']/);
  });

  it("collapses whitespace and caps length", () => {
    expect(sanitizeSearchTerm("  four    seasons  ")).toBe("four seasons");
    expect((sanitizeSearchTerm("a".repeat(500)) ?? "").length).toBe(80);
  });

  it("returns null for empty or non-string input", () => {
    expect(sanitizeSearchTerm("   ")).toBeNull();
    expect(sanitizeSearchTerm(null)).toBeNull();
    expect(sanitizeSearchTerm(undefined)).toBeNull();
    expect(sanitizeSearchTerm(",,,")).toBeNull();
  });
});

describe("buildDiscoverHref", () => {
  it("omits defaults and encodes values", () => {
    expect(buildDiscoverHref({})).toBe("/app/discover");
    expect(buildDiscoverHref({ page: 1 })).toBe("/app/discover");
    expect(buildDiscoverHref({ q: "four seasons" })).toBe("/app/discover?q=four+seasons");
    expect(buildDiscoverHref({ type: "resort", minStars: 5 })).toBe(
      "/app/discover?type=resort&stars=5",
    );
    expect(buildDiscoverHref({ page: 2 })).toBe("/app/discover?page=2");
  });

  it("round-trips through parseDiscoverQuery", () => {
    const original = parseDiscoverQuery({ q: "dubai", type: "resort", stars: "5", page: "2" });
    const href = buildDiscoverHref(original);
    const parsed = parseDiscoverQuery(
      Object.fromEntries(new URL(`https://x${href}`).searchParams.entries()),
    );
    expect(parsed.q).toBe("dubai");
    expect(parsed.type).toBe("resort");
    expect(parsed.minStars).toBe(5);
    expect(parsed.page).toBe(2);
  });
});

describe("labels", () => {
  it("humanizes hotel types without inventing values", () => {
    expect(hotelTypeLabel("boutique_hotel")).toBe("Boutique hotel");
    expect(hotelTypeLabel("resort")).toBe("Resort");
    expect(hotelTypeLabel(null)).toBeNull();
  });

  it("labels verification status", () => {
    expect(verificationLabel("verified")).toBe("Editorially verified");
    expect(verificationLabel("needs_review")).toBe("Needs review");
    expect(verificationLabel(null)).toBe("Unverified");
  });
});
