/**
 * THE CANONICAL SLUG — one definition, two publication paths.
 *
 * A05 added the second path that creates a row in `hotels`, so the import
 * promoter's private slug generator became `src/lib/canonical/slug.ts` and the
 * promoter now imports it. This suite exists because an extraction is only safe
 * if the legacy behaviour is provably unchanged: the collision ladder, the
 * 80-character truncation, the diacritic folding, the `hotel` fallback and the
 * per-caller uniqueness key all still behave exactly as they did.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { adminQuery, hasTestDb, setupDatabase, teardownDatabase } from "./harness";
import { generateSlug, slugifyName } from "../../src/lib/canonical/slug";

const d = describe.skipIf(!hasTestDb);

let counter = 0;
const uniq = () => `S${Date.now().toString(36)}${(counter += 1)}`;

async function destination(slug: string): Promise<string> {
  const existing = await adminQuery<{ id: string }>(
    "select id from public.destinations where slug = $1",
    [slug],
  );
  if (existing.length > 0) return existing[0]!.id;
  const rows = await adminQuery<{ id: string }>(
    `insert into public.destinations (slug, name, type, country_code)
     values ($1,$1,'city','ID') returning id`,
    [slug],
  );
  return rows[0]!.id;
}

/** The shape `generateSlug` needs: a `query` returning `{ rows }`. */
function db() {
  return {
    query: async (sql: string, params?: unknown[]) => ({
      rows: await adminQuery(sql, params ?? []),
    }),
  } as never;
}

async function insertHotel(name: string, slug: string, destinationId: string): Promise<void> {
  await adminQuery(
    `insert into public.hotels (name, slug, destination_id, active_status)
     values ($1,$2,$3,'unknown')`,
    [name, slug, destinationId],
  );
}

describe("slugifyName (pure)", () => {
  it("folds case, diacritics and punctuation the way the import path always did", () => {
    expect(slugifyName("Hôtel Amãzing & Co.")).toBe("hotel-amazing-co");
    expect(slugifyName("  Uma  Linggah   Resort ")).toBe("uma-linggah-resort");
  });

  it("truncates at 80 characters", () => {
    const long = "a".repeat(200);
    expect(slugifyName(long)).toHaveLength(80);
  });

  it("never returns an empty slug", () => {
    // A name that folds to nothing still has to produce a usable slug rather
    // than an empty unique key.
    expect(slugifyName("!!!")).toBe("hotel");
    expect(slugifyName("")).toBe("hotel");
  });
});

d("generateSlug collision ladder (real hotels table)", () => {
  beforeAll(setupDatabase);
  afterAll(teardownDatabase);

  it("returns the folded name when nothing collides", async () => {
    const destinationId = await destination("bali");
    const name = `Villa ${uniq()}`;
    const pool = db();
    const slug = await generateSlug(pool, name, "bali", "hotelbeds:production:1");
    expect(slug).toBe(slugifyName(name));
    await insertHotel(name, slug, destinationId);
  });

  it("falls back to name+destination, then to a digest of the uniqueness key", async () => {
    const destinationId = await destination("bali");
    const name = `Shared ${uniq()}`;
    const base = slugifyName(name);
    const pool = db();

    await insertHotel(name, base, destinationId);
    const second = await generateSlug(pool, name, "bali", "hotelbeds:production:A");
    expect(second).toBe(`${base}-bali`);
    await insertHotel(name, second, destinationId);

    const third = await generateSlug(pool, name, "bali", "hotelbeds:production:A");
    expect(third).toMatch(new RegExp(`^${base}-[0-9a-f]{6}$`));
    await insertHotel(name, third, destinationId);

    // The digest is over the CALLER'S key, never the name: two genuinely
    // different properties sharing a name must not collapse onto one slug.
    const other = await generateSlug(pool, name, "bali", "hotelbeds:production:B");
    expect(other).not.toBe(third);
    expect(other).toMatch(new RegExp(`^${base}-[0-9a-f]{6}$`));

    // ...and a repeat of the SAME key walks on to a numeric suffix rather than
    // returning a slug that already exists.
    const fourth = await generateSlug(pool, name, "bali", "hotelbeds:production:A");
    expect(fourth).toBe(`${third}-2`);
  });

  it("skips the destination rung when no destination slug is known", async () => {
    const destinationId = await destination("bali");
    const name = `Nodest ${uniq()}`;
    const base = slugifyName(name);
    const pool = db();
    await insertHotel(name, base, destinationId);
    const next = await generateSlug(pool, name, null, "key");
    expect(next).toMatch(new RegExp(`^${base}-[0-9a-f]{6}$`));
  });
});
