/**
 * Heuristic check that a draft is a collaboration pitch for the named hotel.
 *
 * No model call. Tests use this function only.
 */

const COLLABORATION =
  /\b(collaborat\w*|partnership|partner|ugc|creator|content|campaign|stay|host(?:ed|ing)?|work together)\b/i;

const FOLLOW_UP =
  /\b(follow(?:ing|ed)?(?:\s|-)?up|checking in|circle back|circling back|touch base|touching base|bumping this|just checking)\b/i;

export function collaborationPitchOk(input: {
  subject: string;
  body: string;
  hotelName: string;
}): boolean {
  const haystack = `${input.subject}\n${input.body}`.toLowerCase();
  const tokens = input.hotelName
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((part) => part.length >= 4);
  if (tokens.length === 0) return false;
  const mentionsHotel = tokens.some((token) => haystack.includes(token));
  return mentionsHotel && COLLABORATION.test(haystack);
}

/**
 * A follow-up must still be a collaboration pitch for that hotel, and it
 * must read as a follow-up. No model call.
 */
export function collaborationFollowUpOk(input: {
  subject: string;
  body: string;
  hotelName: string;
}): boolean {
  if (!collaborationPitchOk(input)) return false;
  return FOLLOW_UP.test(`${input.subject}\n${input.body}`);
}
