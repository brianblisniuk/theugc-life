/**
 * Contact display rules (PRD §7.3, HOTEL_DATA_CONTRACT §4).
 *
 * The critical property: a person's name is NEVER invented. Generic mailboxes
 * fall back to a role/department label derived from real data.
 */
import { describe, expect, it } from "vitest";

import {
  contactDisplayLabel,
  contactVerificationLabel,
  departmentLabel,
  formatVerifiedAt,
  isGenericContact,
} from "@/lib/hotels/contact-display";

const base = { displayName: null, jobTitle: null, department: null };

describe("contactDisplayLabel", () => {
  it("prefers the researched display name exactly as stored", () => {
    expect(contactDisplayLabel({ ...base, displayName: "María José García-López" })).toBe(
      "María José García-López",
    );
  });

  it("falls back to job title when there is no name", () => {
    expect(contactDisplayLabel({ ...base, jobTitle: "Director of Marketing" })).toBe(
      "Director of Marketing",
    );
  });

  it("labels generic mailboxes by department, never with a person's name", () => {
    expect(contactDisplayLabel({ ...base, department: "marketing" })).toBe("Marketing contact");
    expect(contactDisplayLabel({ ...base, department: "sales" })).toBe("Sales contact");
    expect(contactDisplayLabel({ ...base, department: "reservations" })).toBe(
      "Reservations contact",
    );
    expect(contactDisplayLabel({ ...base, department: "pr" })).toBe("PR contact");
    expect(contactDisplayLabel({ ...base, department: "social_media" })).toBe(
      "Social media contact",
    );
  });

  it("uses a neutral label when nothing identifying exists", () => {
    expect(contactDisplayLabel(base)).toBe("General contact");
    expect(contactDisplayLabel({ ...base, department: "unknown" })).toBe("General contact");
    expect(contactDisplayLabel({ ...base, department: "other" })).toBe("General contact");
  });

  it("treats blank/whitespace names as absent rather than rendering emptiness", () => {
    expect(contactDisplayLabel({ ...base, displayName: "   ", department: "events" })).toBe(
      "Events contact",
    );
    expect(isGenericContact({ displayName: "  " })).toBe(true);
    expect(isGenericContact({ displayName: "Jane Roe" })).toBe(false);
  });
});

describe("departmentLabel", () => {
  it("maps the canonical vocabulary and hides meaningless values", () => {
    expect(departmentLabel("communications")).toBe("Communications");
    expect(departmentLabel("partnerships")).toBe("Partnerships");
    expect(departmentLabel("unknown")).toBeNull();
    expect(departmentLabel(null)).toBeNull();
  });
});

describe("formatVerifiedAt / contactVerificationLabel", () => {
  it("formats an ISO timestamp as a plain date", () => {
    expect(formatVerifiedAt("2026-08-13T10:11:12.000Z")).toBe("2026-08-13");
  });

  it("returns null for missing or invalid dates", () => {
    expect(formatVerifiedAt(null)).toBeNull();
    expect(formatVerifiedAt("not-a-date")).toBeNull();
  });

  it("labels verification status honestly", () => {
    expect(contactVerificationLabel("verified")).toBe("Verified contact");
    expect(contactVerificationLabel("inferred")).toBe("Inferred contact");
    expect(contactVerificationLabel(null)).toBe("Unverified contact");
  });
});
