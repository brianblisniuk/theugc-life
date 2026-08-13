/**
 * Normalization unit tests (IMPORT_SPEC.md §6). Synthetic inputs only — no real
 * contact data (IMPORT_SPEC §12).
 */
import { describe, expect, it } from "vitest";

import {
  extractEmails,
  isGenericMailbox,
  nameMatchKey,
  normalizeHotelType,
  normalizeString,
  normalizeUrl,
  normalizeVerificationStatus,
} from "@/lib/import/normalize";

describe("string normalization", () => {
  it("NFC-normalizes, trims, and collapses whitespace", () => {
    expect(normalizeString("  Hotel   Example \n Bali ")).toBe("Hotel Example Bali");
    expect(normalizeString("")).toBeNull();
    expect(normalizeString(null)).toBeNull();
  });

  it("folds case/diacritics/punctuation for match keys without stripping words", () => {
    expect(nameMatchKey("Café Málaga Hôtel & Spa")).toBe("cafe malaga hotel spa");
    // brand/geo/type words are preserved (not stripped)
    expect(nameMatchKey("Bulgari Resort Bali")).toBe("bulgari resort bali");
  });
});

describe("email extraction", () => {
  it("extracts a single valid email (case-insensitive)", () => {
    const r = extractEmails("Marketing <INFO@Hotel.com>");
    expect(r.emails).toEqual(["info@hotel.com"]);
    expect(r.masked).toBe(false);
  });

  it("extracts multiple emails from one cell (legacy quirk)", () => {
    const r = extractEmails("a@h.com; b@h.com / c@h.com");
    expect(r.emails.sort()).toEqual(["a@h.com", "b@h.com", "c@h.com"]);
  });

  it("rejects masked/obfuscated addresses", () => {
    expect(extractEmails("info [at] hotel [dot] com").emails).toHaveLength(0);
    expect(extractEmails("info [at] hotel [dot] com").masked).toBe(true);
    expect(extractEmails("j***@hotel.com").emails).toHaveLength(0);
    expect(extractEmails("j***@hotel.com").masked).toBe(true);
  });

  it("returns nothing for empty cells without flagging masked", () => {
    expect(extractEmails("")).toEqual({ emails: [], masked: false });
    expect(extractEmails("n/a")).toEqual({ emails: [], masked: false });
  });
});

describe("generic mailbox detection", () => {
  it("flags role mailboxes as endpoints, not people", () => {
    expect(isGenericMailbox("info@hotel.com")).toBe(true);
    expect(isGenericMailbox("reservations@hotel.com")).toBe(true);
    expect(isGenericMailbox("marketing.dubai@hotel.com")).toBe(true);
  });
  it("does not flag personal addresses", () => {
    expect(isGenericMailbox("jane.doe@hotel.com")).toBe(false);
  });
});

describe("URL normalization", () => {
  it("lowercases host, drops www, strips tracking + trailing slash", () => {
    const r = normalizeUrl("HTTP://WWW.Hotel.com/rooms/?utm_source=x&id=5");
    expect(r.host).toBe("hotel.com");
    expect(r.normalized).toBe("https://hotel.com/rooms?id=5");
  });
  it("returns nulls for junk", () => {
    expect(normalizeUrl("not a url").normalized).toBeNull();
  });
});

describe("hotel_type taxonomy", () => {
  it("maps free text into the closed taxonomy", () => {
    expect(normalizeHotelType("5-star Resort")).toBe("resort");
    expect(normalizeHotelType("Boutique Hotel")).toBe("boutique_hotel");
    expect(normalizeHotelType("Serviced Apartments")).toBe("aparthotel");
    expect(normalizeHotelType("")).toBe("unknown");
    expect(normalizeHotelType("motel")).toBe("other");
  });
});

describe("verification status", () => {
  it("never up-promotes and defaults to unverified", () => {
    expect(normalizeVerificationStatus("Verified")).toBe("verified");
    expect(normalizeVerificationStatus("guessed")).toBe("inferred");
    expect(normalizeVerificationStatus("masked")).toBe("invalid");
    expect(normalizeVerificationStatus("")).toBe("unverified");
    expect(normalizeVerificationStatus("something else")).toBe("unverified");
  });
});
