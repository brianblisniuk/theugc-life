/**
 * THE canonical hotel slug. One definition, used by every path that creates a
 * row in `hotels`.
 *
 * Extracted verbatim from the import promotion engine when A05 added a second
 * publication path (source identity + D062 + human authorization). Two slug
 * generators would eventually disagree about what `hotels.slug` means — and the
 * one that is wrong is always the one nobody looked at — so the legacy import
 * path now imports this module instead of owning a private copy. Its behaviour
 * is unchanged, and `tests/import/promote-slug.test.ts` proves it.
 *
 * The collision ladder is deliberate and ordered from most to least readable:
 *
 *   1. the folded name                       `uma-linggah-resort`
 *   2. the folded name + destination slug    `uma-linggah-resort-bali`
 *   3. + a short digest of the caller's key  `uma-linggah-resort-a1b2c3`
 *   4. + a numeric suffix                    `uma-linggah-resort-a1b2c3-2`
 *
 * The digest is taken over a caller-supplied UNIQUENESS KEY, never over the
 * name: two genuinely different properties sharing a name must not collapse onto
 * the same slug, and the key is what distinguishes them. Each pipeline passes
 * its own namespace-scoped key (an import's `source_property_key`, a source
 * publication's `source:environment:providerId`), so a slug can never be
 * silently reused across provenance boundaries.
 */
import type { Client, PoolClient } from "pg";

import { sha256Hex } from "../import/fingerprint";
import { foldForMatch } from "../import/normalize";

type Db = Client | PoolClient;

/** Fold a property name into slug shape. Never empty: falls back to `hotel`. */
export function slugifyName(name: string): string {
  return foldForMatch(name).replace(/\s+/g, "-").slice(0, 80) || "hotel";
}

async function slugExists(db: Db, slug: string): Promise<boolean> {
  const r = await db.query("select 1 from public.hotels where slug = $1", [slug]);
  return r.rows.length > 0;
}

/** Deterministic, collision-safe slug (destination-derived or short hash). */
export async function generateSlug(
  db: Db,
  name: string,
  destinationSlug: string | null,
  uniquenessKey: string,
): Promise<string> {
  const base = slugifyName(name);
  if (!(await slugExists(db, base))) return base;
  if (destinationSlug) {
    const withDest = `${base}-${destinationSlug}`;
    if (!(await slugExists(db, withDest))) return withDest;
  }
  const hash = sha256Hex(uniquenessKey).slice(0, 6);
  let candidate = `${base}-${hash}`;
  let n = 2;
  while (await slugExists(db, candidate)) {
    candidate = `${base}-${hash}-${n++}`;
  }
  return candidate;
}
