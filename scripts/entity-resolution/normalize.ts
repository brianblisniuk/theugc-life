/**
 * Comparison normalisers for pre-publication entity resolution.
 *
 * Every function here exists to answer ONE question — "are these two provider
 * values the same string once formatting is set aside?" — and nothing else.
 *
 * THREE RULES THIS MODULE OBEYS
 * -----------------------------
 *  1. **Nothing is written back.** These values are computed for comparison and
 *     discarded. `source_property_observations` keeps the provider's own text
 *     verbatim; a normalised form is never persisted over evidence.
 *  2. **Conservative or nothing.** A transformation is allowed only when it
 *     cannot change what the value MEANS. Lower-casing a hostname is safe;
 *     inventing a country dialling code is not, so a national phone number
 *     without one stays unusable rather than being guessed into a match.
 *  3. **Unusable is not equal.** Every function returns `null` for a value it
 *     cannot compare, and `null` never equals anything — including another
 *     `null`. That is what keeps "neither side supplied a phone" out of the
 *     evidence as agreement AND out of it as disagreement.
 *
 * There is no similarity scoring here: no Levenshtein, no trigram, no embedding,
 * no percentage. Equality of a normalised string, or nothing.
 */

/**
 * A hostname reduced to what identifies a site.
 *
 * `null` for anything that is not plausibly a hostname. The Bali evaluation
 * contains a `web` value of exactly `"n"`, and treating that as a blocking key
 * would have made every property carrying it a candidate for every other one.
 * Requiring a dot and a letter-bearing final label is the cheapest honest test
 * for "this is a domain at all".
 *
 * `www.` is stripped: no site means something different at `www.x.com` than at
 * `x.com`. Nothing else is stripped — a subdomain can be a different property,
 * and `booking.chain.com` is not `chain.com`.
 */
export function normalizeDomain(value: string | null | undefined): string | null {
  if (!value) return null;
  let host = value.trim().toLowerCase();
  if (host === "") return null;
  host = host.replace(/^[a-z][a-z0-9+.-]*:\/\//, "");
  // Drop credentials, path, query and fragment; keep only the authority.
  host = host.split("/")[0]!.split("?")[0]!.split("#")[0]!;
  host = host.split("@").pop()!;
  // A port is not part of the identity.
  host = host.replace(/:\d+$/, "");
  if (host.startsWith("www.")) host = host.slice(4);
  host = host.replace(/\.+$/, "");

  const labels = host.split(".");
  if (labels.length < 2) return null;
  if (labels.some((l) => l === "")) return null;
  const tld = labels[labels.length - 1]!;
  if (!/^[a-z]{2,}$/.test(tld)) return null;
  return host;
}

/**
 * A phone number reduced to its digits, when it is safe to compare at all.
 *
 * Deliberately NOT parsed into a country/national split, and a country code is
 * never added: `0361 123456` is a Bali landline and `+62 361 123456` is the same
 * line, but turning the first into the second requires knowing the country from
 * somewhere, and that knowledge would be inferred rather than observed. So a
 * value is comparable only when the provider gave an international form —
 * `+`-prefixed or `00`-prefixed — and everything else is unusable.
 *
 * That is a deliberate loss of recall in exchange for never manufacturing a
 * collision between two national numbers from different countries.
 */
export function normalizePhone(value: string | null | undefined): string | null {
  if (!value) return null;
  const raw = value.trim();
  if (raw === "") return null;

  // The Bali payload carries `+62…`, `0062…` AND `+0062…` for the same lines,
  // so both prefixes are peeled, in that order and once each. Peeling them
  // independently would key `+0062…` and `0062…` differently and split one
  // property's own number into two blocking keys.
  let body = raw.replace(/[\s()./-]/g, "");
  if (body.startsWith("+")) body = body.slice(1);
  else if (!body.startsWith("00")) return null;
  if (body.startsWith("00")) body = body.slice(2);
  if (body.startsWith("0")) return null;

  const digits = body.replace(/\D/g, "");
  if (digits !== body) return null;
  // Shorter than a country code plus a subscriber number is not a phone number.
  if (digits.length < 8 || digits.length > 15) return null;
  return digits;
}

/**
 * Is this phone worth comparing at all, given the provider's own type label?
 *
 * A fax number is not a way to reach a property and two properties sharing one
 * says nothing about identity, so 0027 keeps `source_phone_type` precisely to
 * stop a FAXNUMBER being read as a contact phone. Reused here.
 */
export function isComparablePhoneType(phoneType: string | null | undefined): boolean {
  if (!phoneType) return true;
  return !/fax/i.test(phoneType);
}

/**
 * A property name reduced to comparable tokens.
 *
 * Case, punctuation and whitespace only. No stop-word list, no "hotel"/"resort"
 * stripping, no transliteration: dropping the word "Hotel" would make
 * "Hotel Bali" and "Bali" the same name, and those are two properties until a
 * human says otherwise.
 */
export function normalizeName(value: string | null | undefined): string | null {
  if (!value) return null;
  const normalized = value
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .replace(/\s+/g, " ");
  return normalized === "" ? null : normalized;
}

/** The distinct tokens of a normalised name, in order, for containment only. */
export function nameTokens(value: string | null | undefined): string[] {
  const normalized = normalizeName(value);
  return normalized === null ? [] : normalized.split(" ");
}

/**
 * Does one name's token set contain the other's, as a WEAKER form of evidence?
 *
 * "the legian bali" contains "the legian". This is recorded as
 * `token_containment`, never as `exact`, and it never decides anything on its
 * own — 0027's schema keeps both strengths in ONE dimension precisely so an
 * exact name cannot be counted twice as two agreements.
 *
 * A single shared token is not containment. Requiring the shorter name to be
 * fully contained keeps "Bali Garden" and "Bali Dynasty" apart, which a token
 * overlap score would not.
 */
export function nameContainment(
  a: string | null | undefined,
  b: string | null | undefined,
): boolean {
  const left = nameTokens(a);
  const right = nameTokens(b);
  if (left.length === 0 || right.length === 0) return false;
  const [shorter, longer] = left.length <= right.length ? [left, right] : [right, left];
  // A one-token name inside a longer one is a coincidence waiting to happen
  // ("Bali" inside "Bali Dynasty Resort"), so it is not containment either.
  if (shorter.length < 2) return false;
  const longerSet = new Set(longer);
  return shorter.every((token) => longerSet.has(token));
}

/**
 * An address reduced to comparable text.
 *
 * Textual only — no geocoding, no gazetteer, no abbreviation dictionary.
 * "Jl." and "Jalan" therefore do NOT compare equal, which is the conservative
 * direction: the pair simply produces no address agreement rather than a false
 * one. Address is a supporting dimension; it was never going to carry a match
 * alone.
 */
export function normalizeAddress(value: string | null | undefined): string | null {
  return normalizeName(value);
}

/** A provider brand/chain code, compared exactly once case is set aside. */
export function normalizeBrand(value: string | null | undefined): string | null {
  if (!value) return null;
  const normalized = value.trim().toUpperCase();
  return normalized === "" ? null : normalized;
}

/**
 * Great-circle distance in metres, or `null` when either point is missing.
 *
 * RAW EVIDENCE. Nothing in this repository turns it into `agrees`/`differs`,
 * and no threshold is applied to it anywhere — D063 §12.2 refuses to invent a
 * distance cutoff, and a number written into the schema would later read as a
 * decision nobody made.
 */
export function haversineMetres(
  aLat: number | null,
  aLon: number | null,
  bLat: number | null,
  bLon: number | null,
): number | null {
  if (aLat === null || aLon === null || bLat === null || bLon === null) return null;
  if (![aLat, aLon, bLat, bLon].every(Number.isFinite)) return null;
  const R = 6_371_008.8; // IUGG mean Earth radius, metres.
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(bLat - aLat);
  const dLon = toRad(bLon - aLon);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(aLat)) * Math.cos(toRad(bLat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}
