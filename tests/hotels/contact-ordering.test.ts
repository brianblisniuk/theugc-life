/**
 * Contact list hygiene (PRD §7.3).
 *
 * Regression tests for review findings: the most trustworthy contact must be
 * shown first, and superseded/known-bad contacts must never be presented as
 * current. `hotel_contacts.verification_status` sorts alphabetically in SQL
 * (inferred < invalid < probable < unverified < verified), which would put the
 * WORST contact first — so ordering is applied in the query layer instead.
 *
 * These mirror the exact rules `getHotelContactsIfAuthorized` applies.
 */
import { describe, expect, it } from "vitest";

const RETIRED_CONTACT_STATUSES = new Set(["replaced", "invalid"]);
const VERIFICATION_RANK: Record<string, number> = {
  verified: 0,
  probable: 1,
  unverified: 2,
  inferred: 3,
  invalid: 4,
};

interface C {
  id: string;
  status: string | null;
  verificationStatus: string | null;
}

/** The transformation applied in queries.ts after fetching contacts. */
function presentable(contacts: C[]): C[] {
  return contacts
    .filter((c) => !RETIRED_CONTACT_STATUSES.has(c.status ?? ""))
    .filter((c) => c.verificationStatus !== "invalid")
    .sort(
      (a, b) =>
        (VERIFICATION_RANK[a.verificationStatus ?? ""] ?? 9) -
        (VERIFICATION_RANK[b.verificationStatus ?? ""] ?? 9),
    );
}

describe("contact ordering", () => {
  it("puts the verified contact first, not last", () => {
    const out = presentable([
      { id: "inferred", status: "active", verificationStatus: "inferred" },
      { id: "verified", status: "active", verificationStatus: "verified" },
      { id: "probable", status: "active", verificationStatus: "probable" },
    ]);
    expect(out.map((c) => c.id)).toEqual(["verified", "probable", "inferred"]);
  });

  it("does not rely on alphabetical status ordering", () => {
    // Alphabetically 'inferred' precedes 'verified'; rank must override that.
    const alphabetical = ["inferred", "verified"].sort();
    expect(alphabetical[0]).toBe("inferred");
    const out = presentable([
      { id: "a", status: "active", verificationStatus: "inferred" },
      { id: "b", status: "active", verificationStatus: "verified" },
    ]);
    expect(out[0]!.id).toBe("b");
  });
});

describe("retired contacts", () => {
  it("hides a replaced contact so a departed person is not shown as current", () => {
    const out = presentable([
      { id: "old", status: "replaced", verificationStatus: "verified" },
      { id: "new", status: "active", verificationStatus: "verified" },
    ]);
    expect(out.map((c) => c.id)).toEqual(["new"]);
  });

  it("hides contacts flagged invalid by status or verification", () => {
    const out = presentable([
      { id: "bad-status", status: "invalid", verificationStatus: "verified" },
      { id: "bad-verification", status: "active", verificationStatus: "invalid" },
      { id: "good", status: "active", verificationStatus: "probable" },
    ]);
    expect(out.map((c) => c.id)).toEqual(["good"]);
  });

  it("keeps stale/unverified operational states visible (they are still usable)", () => {
    const out = presentable([
      { id: "stale", status: "stale", verificationStatus: "probable" },
      { id: "unverified", status: "unverified", verificationStatus: "unverified" },
    ]);
    expect(out.map((c) => c.id).sort()).toEqual(["stale", "unverified"]);
  });
});
