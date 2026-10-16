/**
 * Discover's "Contact available" flag.
 *
 * The RPC returns a boolean per published hotel id. An email, phone, or name
 * in the payload is a failed read, not a contact to render.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function parseContactFlags(data: unknown): Map<string, boolean> | null {
  if (!Array.isArray(data)) return null;
  const flags = new Map<string, boolean>();
  for (const row of data) {
    if (!row || typeof row !== "object" || Array.isArray(row)) return null;
    const record = row as Record<string, unknown>;
    if ("email" in record || "phone" in record || "name" in record || "linkedin_url" in record) {
      return null;
    }
    const hotelId = record.hotel_id;
    const exists = record.contact_exists;
    if (typeof hotelId !== "string" || !UUID.test(hotelId)) return null;
    if (typeof exists !== "boolean") return null;
    flags.set(hotelId, exists);
  }
  return flags;
}

/**
 * A successful read that omits a requested id is unknown.
 * Unknown is not the same as a stored false.
 */
export function contactAvailability(
  flags: ReadonlyMap<string, boolean>,
  hotelId: string,
): "available" | "absent" | "unknown" {
  if (!flags.has(hotelId)) return "unknown";
  return flags.get(hotelId) ? "available" : "absent";
}
