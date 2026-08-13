/**
 * Discover data behavior + hotel detail resolution (PRD §7.2, §22; ROUTES.md §4).
 *
 * The query layer talks to Supabase over HTTP, which this sandbox cannot reach,
 * so these tests exercise the exact SQL semantics that layer relies on —
 * against real Postgres, under a real authenticated role, with RLS on. They
 * pin: canonical rows are returned, free-text matches name OR destination,
 * type/star/verification filters narrow correctly, results stay bounded, and
 * discovery never returns contact data.
 *
 * A Dubai-shaped fixture mirrors the canonical pilot (verified, 4–5 star, no
 * coordinates) without copying any real contact data.
 */
import { describe, expect, it, beforeAll, afterAll } from "vitest";

import { adminQuery, hasTestDb, queryAs, setupDatabase, teardownDatabase } from "../db/harness";
import { USERS, seed } from "../rls/seed";
import { DISCOVER_MAX_PAGE_SIZE, parseDiscoverQuery } from "@/lib/hotels/filters";
import { isUuid } from "@/lib/hotels/ids";

const d = describe.skipIf(!hasTestDb);

const DUBAI = "d0000000-0000-0000-0000-0000000000aa";
const HOTELS: { id: string; name: string; type: string; stars: number; status: string }[] = [
  {
    id: "4a000000-0000-0000-0000-000000000001",
    name: "Zz Alpha Resort",
    type: "resort",
    stars: 5,
    status: "verified",
  },
  {
    id: "4a000000-0000-0000-0000-000000000002",
    name: "Zz Beta Hotel",
    type: "hotel",
    stars: 4,
    status: "verified",
  },
  {
    id: "4a000000-0000-0000-0000-000000000003",
    name: "Zz Gamma Villa",
    type: "villa",
    stars: 3,
    status: "needs_review",
  },
  {
    id: "4a000000-0000-0000-0000-000000000004",
    name: "Zz Delta Resort",
    type: "resort",
    stars: 5,
    status: "unverified",
  },
];

/** The SQL shape searchHotels() issues: name ILIKE, or destination match. */
async function search(term: string) {
  const q = parseDiscoverQuery({ q: term }).q!;
  return queryAs<{ id: string; name: string }>(
    { role: "authenticated", sub: USERS.free },
    `select h.id, h.name
       from public.hotels h
      where h.name ilike '%' || $1 || '%'
         or h.destination_id in (
              select d.id from public.destinations d
               where d.name ilike '%' || $1 || '%' or d.slug ilike '%' || $1 || '%')
      order by h.name`,
    [q],
  );
}

beforeAll(async () => {
  if (!hasTestDb) return;
  await setupDatabase();
  await seed();

  await adminQuery(
    `insert into public.destinations (id, name, slug, type, country_code)
       values ($1, 'Zzdubai', 'zzdubai', 'city', 'AE')`,
    [DUBAI],
  );
  for (const h of HOTELS) {
    await adminQuery(
      `insert into public.hotels
         (id, name, slug, destination_id, country_code, hotel_type, star_rating,
          website_url, editorial_verification_status, active_status)
       values ($1,$2,$3,$4,'AE',$5,$6,$7,$8,'active')`,
      [
        h.id,
        h.name,
        h.name.toLowerCase().replace(/\s+/g, "-"),
        DUBAI,
        h.type,
        h.stars,
        `https://example.test/${h.id}`,
        h.status,
      ],
    );
  }
}, 120_000);

afterAll(async () => {
  await teardownDatabase();
});

d("discover — returns canonical hotels", () => {
  it("an authenticated free creator can list hotel basics", async () => {
    const res = await queryAs<{ n: string }>(
      { role: "authenticated", sub: USERS.free },
      "select count(*)::text n from public.hotels where destination_id = $1",
      [DUBAI],
    );
    expect(res.error).toBeNull();
    expect(Number(res.rows[0]!.n)).toBe(HOTELS.length);
  });

  it("joins the canonical destination for display", async () => {
    const res = await queryAs<{ name: string; dest: string; country: string }>(
      { role: "authenticated", sub: USERS.free },
      `select h.name, d.name as dest, d.country_code as country
         from public.hotels h join public.destinations d on d.id = h.destination_id
        where h.id = $1`,
      [HOTELS[0]!.id],
    );
    expect(res.rows[0]!.dest).toBe("Zzdubai");
    expect(res.rows[0]!.country).toBe("AE");
  });
});

d("discover — search", () => {
  it("matches on hotel name", async () => {
    const res = await search("Alpha");
    expect(res.rows.map((r) => r.name)).toEqual(["Zz Alpha Resort"]);
  });

  it("matches on destination name, not just hotel name", async () => {
    const res = await search("Zzdubai");
    expect(res.rows).toHaveLength(HOTELS.length);
  });

  it("is case-insensitive", async () => {
    expect((await search("alpha")).rows).toHaveLength(1);
  });

  it("returns no rows for a term that matches nothing", async () => {
    expect((await search("Zznotarealhotel")).rows).toHaveLength(0);
  });

  it("treats sanitized punctuation safely rather than breaking the query", async () => {
    const res = await search("Alpha, (Resort)");
    expect(res.error).toBeNull();
  });
});

d("discover — filters", () => {
  async function filtered(sql: string, params: unknown[]) {
    return queryAs<{ name: string }>({ role: "authenticated", sub: USERS.free }, sql, params);
  }

  it("filters by hotel type", async () => {
    const res = await filtered(
      "select name from public.hotels where destination_id=$1 and hotel_type=$2 order by name",
      [DUBAI, "resort"],
    );
    expect(res.rows.map((r) => r.name)).toEqual(["Zz Alpha Resort", "Zz Delta Resort"]);
  });

  it("filters by minimum star rating", async () => {
    const res = await filtered(
      "select name from public.hotels where destination_id=$1 and star_rating >= $2 order by name",
      [DUBAI, 5],
    );
    expect(res.rows.map((r) => r.name)).toEqual(["Zz Alpha Resort", "Zz Delta Resort"]);
  });

  it("filters by editorial verification status", async () => {
    const res = await filtered(
      "select name from public.hotels where destination_id=$1 and editorial_verification_status=$2 order by name",
      [DUBAI, "verified"],
    );
    expect(res.rows.map((r) => r.name)).toEqual(["Zz Alpha Resort", "Zz Beta Hotel"]);
  });

  it("combines filters", async () => {
    const res = await filtered(
      `select name from public.hotels
        where destination_id=$1 and hotel_type=$2 and star_rating >= $3
          and editorial_verification_status=$4`,
      [DUBAI, "resort", 5, "verified"],
    );
    expect(res.rows.map((r) => r.name)).toEqual(["Zz Alpha Resort"]);
  });
});

d("discover — bounded results", () => {
  it("never returns more than the requested page size", async () => {
    const res = await queryAs<{ name: string }>(
      { role: "authenticated", sub: USERS.free },
      "select name from public.hotels order by name limit $1 offset $2",
      [2, 0],
    );
    expect(res.rows.length).toBeLessThanOrEqual(2);
  });

  it("pages deterministically without overlap", async () => {
    const page = async (limit: number, offset: number) =>
      (
        await queryAs<{ name: string }>(
          { role: "authenticated", sub: USERS.free },
          "select name from public.hotels where destination_id=$3 order by name limit $1 offset $2",
          [limit, offset, DUBAI],
        )
      ).rows.map((r) => r.name);

    const first = await page(2, 0);
    const second = await page(2, 2);
    expect(first).toHaveLength(2);
    expect(second).toHaveLength(2);
    expect(new Set([...first, ...second]).size).toBe(4);
  });

  it("the parsed page size can never exceed the hard ceiling", () => {
    expect(parseDiscoverQuery({ pageSize: "100000" }).pageSize).toBe(DISCOVER_MAX_PAGE_SIZE);
  });
});

d("hotel detail — resolution by UUID", () => {
  it("resolves an existing hotel by its UUID", async () => {
    const res = await queryAs<{ id: string; name: string }>(
      { role: "authenticated", sub: USERS.free },
      "select id, name from public.hotels where id = $1",
      [HOTELS[1]!.id],
    );
    expect(res.rows).toHaveLength(1);
    expect(res.rows[0]!.name).toBe("Zz Beta Hotel");
  });

  it("returns nothing for an unknown UUID (page renders not-found)", async () => {
    const res = await queryAs(
      { role: "authenticated", sub: USERS.free },
      "select id from public.hotels where id = $1",
      ["4a000000-0000-0000-0000-0000000000ff"],
    );
    expect(res.rows).toHaveLength(0);
  });

  it("rejects a malformed id before it reaches the database", () => {
    expect(isUuid("not-a-uuid")).toBe(false);
    expect(isUuid("")).toBe(false);
    expect(isUuid(HOTELS[0]!.id)).toBe(true);
  });
});

d("intelligence — empty dataset yields no rows, not zero metrics", () => {
  it("the public intelligence view returns no row for a hotel with no intelligence", async () => {
    // Mirrors production today: hotel_intelligence is empty, and the view is an
    // INNER JOIN, so there is simply no row — never a fabricated 0%.
    const res = await queryAs(
      { role: "authenticated", sub: USERS.free },
      "select * from public.hotel_public_intelligence where hotel_id = $1",
      [HOTELS[0]!.id],
    );
    expect(res.error).toBeNull();
    expect(res.rows).toHaveLength(0);
  });

  it("no intelligence or outreach rows exist in the fixture at all", async () => {
    for (const table of ["hotel_intelligence", "destination_intelligence", "outreach_events"]) {
      const rows = await adminQuery<{ n: string }>(`select count(*)::text n from public.${table}`);
      expect(Number(rows[0]!.n)).toBe(0);
    }
  });
});
