/**
 * Durable normalization rules (IMPORT_SPEC.md §6). Pure, dependency-free, and
 * unit-tested. These rules are shared by the standard importer and every legacy
 * adapter so all inputs converge on one normalized representation.
 */
import { HOTEL_TYPES, type HotelType, type VerificationStatus } from "./contract";

/** Unicode-normalize (NFC), trim, collapse internal whitespace. Empty -> null. */
export function normalizeString(input: unknown): string | null {
  if (input === null || input === undefined) return null;
  const s = String(input).normalize("NFC").replace(/\s+/g, " ").trim();
  return s.length === 0 ? null : s;
}

/** Lowercase + strip diacritics + drop punctuation for match comparison. */
export function foldForMatch(input: string): string {
  return input
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "") // strip combining diacritical marks
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Match key for a hotel name. Per IMPORT_SPEC §6 we do NOT aggressively strip
 * brand/geographic/property-type words — we only fold case/diacritics/punct.
 */
export function nameMatchKey(name: string): string {
  return foldForMatch(name);
}

// --- Email handling (IMPORT_SPEC §6, §8) -----------------------------------

// Complete, syntactically valid email token. Intentionally strict.
const EMAIL_RE =
  /[a-z0-9!#$%&'*+/=?^_`{|}~-]+(?:\.[a-z0-9!#$%&'*+/=?^_`{|}~-]+)*@(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}/gi;

// Obfuscation markers that indicate a deliberately masked address.
const MASK_MARKERS = [
  /\[\s*at\s*\]/i,
  /\(\s*at\s*\)/i,
  /\{\s*at\s*\}/i,
  /\s+at\s+\S+\s+dot\s+/i,
  /\[\s*dot\s*\]/i,
  /\(\s*dot\s*\)/i,
  /\*{2,}/,
  /x{3,}@/i,
  /@x{3,}/i,
  /…/, // ellipsis …
];

export interface EmailExtraction {
  /** Lowercased, de-duplicated valid email tokens found in the cell. */
  emails: string[];
  /** True when the cell appears to contain a masked/obfuscated address. */
  masked: boolean;
}

/**
 * Extract complete valid email tokens (case-insensitive). Multiple emails in one
 * cell (a legacy quirk) are all returned. Masked/obfuscated values yield no
 * valid endpoint and set `masked = true`.
 */
export function extractEmails(input: unknown): EmailExtraction {
  const raw = input === null || input === undefined ? "" : String(input);
  if (raw.trim().length === 0) return { emails: [], masked: false };

  // Obfuscation markers win even if a token technically matches (e.g. `j***@x`),
  // because `*` is a legal local-part character.
  if (MASK_MARKERS.some((re) => re.test(raw))) {
    return { emails: [], masked: true };
  }

  const matches = raw.match(EMAIL_RE) ?? [];
  const emails = Array.from(new Set(matches.map((m) => m.toLowerCase().trim()))).filter(
    (e) => isValidEmail(e) && !e.includes("*"),
  );

  // Cells that contain an @ but yield no valid token look masked/garbled.
  const looksMasked = emails.length === 0 && raw.includes("@");

  return { emails, masked: looksMasked };
}

/** Strict single-token validity check. */
export function isValidEmail(token: string): boolean {
  const t = token.trim();
  const m = t.match(EMAIL_RE);
  return m !== null && m.length === 1 && m[0] === t;
}

// Generic mailbox local-parts: an endpoint, not a named person (IMPORT_SPEC §8).
const GENERIC_LOCAL_PARTS = new Set([
  "info",
  "contact",
  "contacts",
  "hello",
  "hi",
  "reservations",
  "reservation",
  "reception",
  "sales",
  "marketing",
  "pr",
  "press",
  "media",
  "booking",
  "bookings",
  "admin",
  "office",
  "enquiries",
  "enquiry",
  "inquiries",
  "inquiry",
  "hotel",
  "stay",
  "general",
  "frontdesk",
  "concierge",
  "events",
  "mail",
  "email",
  "team",
  "welcome",
  "guestrelations",
  "guest",
  "communications",
  "comms",
]);

/** Is this a generic/role mailbox rather than a personal address? */
export function isGenericMailbox(email: string): boolean {
  const local = email.split("@")[0]?.toLowerCase() ?? "";
  if (GENERIC_LOCAL_PARTS.has(local)) return true;
  // role-prefixed variants like marketing.dubai, info-uk
  const head = local.split(/[.\-_+]/)[0] ?? "";
  return GENERIC_LOCAL_PARTS.has(head);
}

// --- URL handling (IMPORT_SPEC §6) -----------------------------------------

const TRACKING_PARAM_RE = /^(utm_|fbclid$|gclid$|mc_|ref$|ref_src$|igshid$)/i;

export interface UrlNormalization {
  normalized: string | null;
  host: string | null;
}

/**
 * Normalize hostname + strip tracking params + trailing slash for comparison.
 * A chain hostname alone is never a hotel identity key (enforced in resolve.ts).
 */
export function normalizeUrl(input: unknown): UrlNormalization {
  const s = normalizeString(input);
  if (!s) return { normalized: null, host: null };
  let candidate = s;
  if (!/^https?:\/\//i.test(candidate)) candidate = `https://${candidate}`;
  try {
    const u = new URL(candidate);
    u.hostname = u.hostname.toLowerCase().replace(/^www\./, "");
    u.protocol = "https:";
    u.hash = "";
    for (const key of Array.from(u.searchParams.keys())) {
      if (TRACKING_PARAM_RE.test(key)) u.searchParams.delete(key);
    }
    let out = u.toString();
    // Drop a lone trailing slash on the path root and elsewhere.
    out = out.replace(/\/(\?|$)/, "$1");
    return { normalized: out, host: u.hostname };
  } catch {
    return { normalized: null, host: null };
  }
}

// --- hotel_type taxonomy (HOTEL_DATA_CONTRACT §3) --------------------------

const HOTEL_TYPE_ALIASES: Record<string, HotelType> = {
  hotel: "hotel",
  hotels: "hotel",
  resort: "resort",
  resorts: "resort",
  "beach resort": "resort",
  boutique: "boutique_hotel",
  "boutique hotel": "boutique_hotel",
  aparthotel: "aparthotel",
  "apart hotel": "aparthotel",
  "apart-hotel": "aparthotel",
  "serviced apartment": "aparthotel",
  "serviced apartments": "aparthotel",
  apartment: "aparthotel",
  hostel: "hostel",
  villa: "villa",
  villas: "villa",
  residence: "residence",
  residences: "residence",
  guesthouse: "guesthouse",
  "guest house": "guesthouse",
  "bed and breakfast": "guesthouse",
  "b and b": "guesthouse",
  bnb: "guesthouse",
  lodge: "lodge",
  "safari lodge": "lodge",
};

/** Map free text to the closed hotel_type taxonomy. Unknown is acceptable. */
export function normalizeHotelType(input: unknown): HotelType {
  const s = normalizeString(input);
  if (!s) return "unknown";
  const folded = foldForMatch(s);
  if ((HOTEL_TYPES as readonly string[]).includes(folded)) return folded as HotelType;
  if (HOTEL_TYPE_ALIASES[folded]) return HOTEL_TYPE_ALIASES[folded];
  // partial keyword scan
  for (const [alias, type] of Object.entries(HOTEL_TYPE_ALIASES)) {
    if (folded.includes(alias)) return type;
  }
  return "other";
}

// --- verification status (HOTEL_DATA_CONTRACT §5) --------------------------

const VERIFICATION_ALIASES: Record<string, VerificationStatus> = {
  verified: "verified",
  confirmed: "verified",
  official: "verified",
  probable: "probable",
  likely: "probable",
  inferred: "inferred",
  guessed: "inferred",
  pattern: "inferred",
  unverified: "unverified",
  unknown: "unverified",
  invalid: "invalid",
  masked: "invalid",
  bounced: "invalid",
  obsolete: "invalid",
};

/**
 * Map a raw verification token to the taxonomy. Defaults to `unverified`. Never
 * promotes to `verified` from a weaker token (HOTEL_DATA_CONTRACT §5).
 */
export function normalizeVerificationStatus(input: unknown): VerificationStatus {
  const s = normalizeString(input);
  if (!s) return "unverified";
  const folded = foldForMatch(s);
  if (VERIFICATION_ALIASES[folded]) return VERIFICATION_ALIASES[folded];
  for (const [alias, status] of Object.entries(VERIFICATION_ALIASES)) {
    if (folded.includes(alias)) return status;
  }
  return "unverified";
}

/** ISO 3166-1 alpha-2 normalization (best effort). */
export function normalizeCountryCode(input: unknown): string | null {
  const s = normalizeString(input);
  if (!s) return null;
  const up = s.toUpperCase();
  return /^[A-Z]{2}$/.test(up) ? up : null;
}

/** Parse a numeric field, tolerating stray characters. */
export function parseNumber(input: unknown): number | null {
  if (input === null || input === undefined) return null;
  if (typeof input === "number") return Number.isFinite(input) ? input : null;
  const s = String(input).replace(/[^0-9.\-]/g, "");
  if (s === "" || s === "-" || s === ".") return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}
