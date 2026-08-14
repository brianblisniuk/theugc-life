/**
 * Pipeline pagination against a real database (audit F-03).
 *
 * The previous implementation capped the list at 200 rows with no count and
 * presented `items.length` as the creator's total, so a pipeline larger than
 * that was silently truncated AND misreported. These tests seed more than 200
 * relationships and assert the numbers the page states are the numbers the
 * database holds.
 *
 * `listPipelineItems` is exercised through a PostgREST-shaped client whose
 * queries are executed by the real `authenticated` role, so ownership is
 * enforced by `pipeline_items_all` (RLS) and the counts come from Postgres —
 * not from a re-implementation of the filter in TypeScript.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  adminQuery,
  hasTestDb,
  queryAs,
  setupDatabase,
  teardownDatabase,
  type Role,
} from "../db/harness";
import {
  PIPELINE_PAGE_SIZE,
  listPipelineItems,
  normalizePageParam,
  type PipelineQueryClient,
} from "@/lib/pipeline/queries";

const d = describe.skipIf(!hasTestDb);

const U = {
  /** Owns TOTAL relationships. */
  owner: "f1000000-0000-0000-0000-000000000001",
  /** Owns a handful, which must never appear in the owner's pages. */
  other: "f1000000-0000-0000-0000-000000000002",
} as const;

const DESTINATION = "f2000000-0000-0000-0000-000000000001";

/** Deliberately > 200: the old cap, and not a multiple of the page size. */
const TOTAL = 243;
/** Of those, this many are `pitched`; the rest are `saved`. */
const PITCHED = 60;
const OTHER_TOTAL = 7;

function hotelId(prefix: string, i: number): string {
  return `f300000${prefix}-0000-0000-0000-${i.toString().padStart(12, "0")}`;
}

/** Zero-padded so lexical order matches insertion order in assertions. */
function hotelName(i: number): string {
  return `Paged Hotel ${i.toString().padStart(3, "0")}`;
}

/* ------------------------------------------------------------------ */
/* A PostgREST-shaped client backed by real SQL under a real DB role.  */
/* ------------------------------------------------------------------ */

interface ShimState {
  eqs: [string, unknown][];
  head: boolean;
  count: boolean;
  range: [number, number] | null;
}

const ROW_SQL = `
  select pi.id, pi.status, pi.saved_at, pi.last_activity_at, pi.next_followup_at,
         case when h.id is null then null else jsonb_build_object(
           'id', h.id, 'name', h.name, 'country_code', h.country_code,
           'destination', case when de.id is null then null
                          else jsonb_build_object('name', de.name) end
         ) end as hotel
  from public.pipeline_items pi
  left join public.hotels h on h.id = pi.hotel_id
  left join public.destinations de on de.id = h.destination_id
`;

function shimClient(role: Role, sub: string | null): PipelineQueryClient {
  const from = (table: string) => {
    const state: ShimState = { eqs: [], head: false, count: false, range: null };

    const run = async () => {
      const where = state.eqs.map(([col], i) => `pi.${col} = $${i + 1}`);
      const params = state.eqs.map(([, value]) => value);
      const clause = where.length ? ` where ${where.join(" and ")}` : "";

      if (state.head && state.count) {
        const res = await queryAs<{ count: string }>(
          { role, sub },
          `select count(*)::text as count from public.${table} pi${clause}`,
          params,
        );
        if (res.error) return { data: null, count: null, error: res.error };
        return { data: null, count: Number(res.rows[0]!.count), error: null };
      }

      const [start, end] = state.range ?? [0, PIPELINE_PAGE_SIZE - 1];
      const res = await queryAs(
        { role, sub },
        `${ROW_SQL}${clause}
         order by pi.last_activity_at desc, pi.id asc
         limit ${end - start + 1} offset ${start}`,
        params,
      );
      if (res.error) return { data: null, count: null, error: res.error };
      return { data: res.rows, count: null, error: null };
    };

    const builder = {
      select(_columns: string, options?: { count?: string; head?: boolean }) {
        state.count = options?.count === "exact";
        state.head = Boolean(options?.head);
        return builder;
      },
      eq(column: string, value: unknown) {
        state.eqs.push([column, value]);
        return builder;
      },
      order() {
        return builder;
      },
      range(start: number, end: number) {
        state.range = [start, end];
        return builder;
      },
      then(resolve: (value: unknown) => unknown, reject: (reason: unknown) => unknown) {
        return run().then(resolve, reject);
      },
    };
    return builder;
  };

  return { from } as unknown as PipelineQueryClient;
}

const asOwner = () => shimClient("authenticated", U.owner);

d("pipeline pagination", () => {
  beforeAll(async () => {
    await setupDatabase();

    for (const id of Object.values(U)) {
      await adminQuery("insert into auth.users (id, email) values ($1, $2)", [
        id,
        `${id}@test.local`,
      ]);
    }
    await adminQuery(
      "insert into public.destinations (id, name, slug, type) values ($1,'Pagedland','pagedland','island')",
      [DESTINATION],
    );

    const creator = async (userId: string) =>
      (
        await adminQuery<{ id: string }>(
          "select id from public.creator_profiles where user_id = $1",
          [userId],
        )
      )[0]!.id;
    const ownerCreator = await creator(U.owner);
    const otherCreator = await creator(U.other);

    // One hotel per relationship: pipeline_items_single_active_cycle_uidx allows
    // only one non-closed cycle per (creator, hotel).
    for (let i = 0; i < TOTAL; i += 1) {
      await adminQuery(
        `insert into public.hotels (id, name, slug, destination_id, country_code)
           values ($1,$2,$3,$4,'ID')`,
        [hotelId("a", i), hotelName(i), `paged-hotel-${i}`, DESTINATION],
      );
      await adminQuery(
        `insert into public.pipeline_items (creator_id, hotel_id, status, last_activity_at)
           values ($1,$2,$3, now() - ($4 || ' minutes')::interval)`,
        [ownerCreator, hotelId("a", i), i < PITCHED ? "pitched" : "saved", String(i)],
      );
    }

    for (let i = 0; i < OTHER_TOTAL; i += 1) {
      await adminQuery(
        `insert into public.hotels (id, name, slug, destination_id)
           values ($1,$2,$3,$4)`,
        [hotelId("b", i), `Other Hotel ${i}`, `other-hotel-${i}`, DESTINATION],
      );
      await adminQuery("insert into public.pipeline_items (creator_id, hotel_id) values ($1,$2)", [
        otherCreator,
        hotelId("b", i),
      ]);
    }
  }, 120_000);

  afterAll(async () => {
    await teardownDatabase();
  });

  it("reports the EXACT total, not the size of the page", async () => {
    const result = await listPipelineItems(null, 1, asOwner());
    expect(result.status).toBe("ok");
    if (result.status !== "ok") throw new Error("unreachable");

    expect(result.page.total).toBe(TOTAL);
    expect(result.page.total).toBeGreaterThan(200);
    expect(result.page.items.length).toBe(PIPELINE_PAGE_SIZE);
    // The old behaviour: 200 rows returned, 200 reported as the creator's total.
    expect(result.page.total).not.toBe(result.page.items.length);
    expect(result.page.total).not.toBe(200);
  });

  it("derives page metadata from the total", async () => {
    const result = await listPipelineItems(null, 1, asOwner());
    if (result.status !== "ok") throw new Error("unreachable");
    expect(result.page).toMatchObject({
      page: 1,
      pageSize: 50,
      totalPages: 5, // ceil(243 / 50)
      hasPrevious: false,
      hasNext: true,
    });
  });

  it("returns the right rows on each page, in order, with no overlap", async () => {
    const seen = new Set<string>();
    for (let page = 1; page <= 5; page += 1) {
      const result = await listPipelineItems(null, page, asOwner());
      if (result.status !== "ok") throw new Error("unreachable");

      const expectedSize = page === 5 ? TOTAL - 4 * PIPELINE_PAGE_SIZE : PIPELINE_PAGE_SIZE;
      expect(result.page.items.length).toBe(expectedSize);

      // last_activity_at descends with the seed index, so page N starts at
      // index (N-1)*50.
      const firstIndex = (page - 1) * PIPELINE_PAGE_SIZE;
      expect(result.page.items[0]?.hotel?.name).toBe(hotelName(firstIndex));
      expect(result.page.items.at(-1)?.hotel?.name).toBe(hotelName(firstIndex + expectedSize - 1));

      for (const item of result.page.items) {
        expect(seen.has(item.id)).toBe(false);
        seen.add(item.id);
      }
    }
    expect(seen.size).toBe(TOTAL);
  });

  it("the last page knows it is the last", async () => {
    const result = await listPipelineItems(null, 5, asOwner());
    if (result.status !== "ok") throw new Error("unreachable");
    expect(result.page).toMatchObject({ page: 5, hasNext: false, hasPrevious: true });
    expect(result.page.items.length).toBe(43);
  });

  it("counts the FILTERED set, not the whole pipeline", async () => {
    const result = await listPipelineItems("pitched", 1, asOwner());
    if (result.status !== "ok") throw new Error("unreachable");
    expect(result.page.total).toBe(PITCHED);
    expect(result.page.totalPages).toBe(2);
    expect(result.page.items.length).toBe(PIPELINE_PAGE_SIZE);
    expect(result.page.items.every((i) => i.status === "pitched")).toBe(true);

    const second = await listPipelineItems("pitched", 2, asOwner());
    if (second.status !== "ok") throw new Error("unreachable");
    expect(second.page.items.length).toBe(PITCHED - PIPELINE_PAGE_SIZE);
    expect(second.page.hasNext).toBe(false);
  });

  it("a filter with no matches is an honest zero, not an error", async () => {
    const result = await listPipelineItems("won", 1, asOwner());
    if (result.status !== "ok") throw new Error("unreachable");
    expect(result.page.total).toBe(0);
    expect(result.page.items).toEqual([]);
    expect(result.page.totalPages).toBe(1);
  });

  it("never includes another creator's relationships", async () => {
    const ids = new Set<string>();
    for (let page = 1; page <= 5; page += 1) {
      const result = await listPipelineItems(null, page, asOwner());
      if (result.status !== "ok") throw new Error("unreachable");
      for (const item of result.page.items) ids.add(item.hotel?.id ?? "");
    }
    for (let i = 0; i < OTHER_TOTAL; i += 1) {
      expect(ids.has(hotelId("b", i))).toBe(false);
    }

    const other = await listPipelineItems(null, 1, shimClient("authenticated", U.other));
    if (other.status !== "ok") throw new Error("unreachable");
    expect(other.page.total).toBe(OTHER_TOTAL);
  });

  it("clamps a page past the end instead of claiming an empty pipeline", async () => {
    for (const requested of [6, 99, 100_000]) {
      const result = await listPipelineItems(null, requested, asOwner());
      if (result.status !== "ok") throw new Error("unreachable");
      expect(result.page.page).toBe(5);
      expect(result.page.total).toBe(TOTAL);
      expect(result.page.items.length).toBeGreaterThan(0);
    }
  });

  it("a failed read is an error, never a total of zero", async () => {
    // `anon` holds no privilege on pipeline_items, so the count itself fails.
    const result = await listPipelineItems(null, 1, shimClient("anon", null));
    expect(result).toEqual({ status: "error" });
  });

  it("a failed row read is an error even when the count succeeded", async () => {
    const client = {
      from: () => {
        const state = { head: false };
        const builder = {
          select(_c: string, options?: { head?: boolean }) {
            state.head = Boolean(options?.head);
            return builder;
          },
          eq: () => builder,
          order: () => builder,
          range: () => builder,
          then(resolve: (value: unknown) => unknown) {
            return Promise.resolve(
              state.head
                ? { data: null, count: 243, error: null }
                : { data: null, count: null, error: { message: "boom" } },
            ).then(resolve);
          },
        };
        return builder;
      },
    } as unknown as PipelineQueryClient;

    expect(await listPipelineItems(null, 1, client)).toEqual({ status: "error" });
  });
});

describe("page parameter normalization", () => {
  it("treats anything that is not a positive whole number as page 1", () => {
    for (const raw of [
      undefined,
      null,
      "",
      "0",
      "-1",
      "-42",
      "1.5",
      "abc",
      "1e3",
      " ",
      "NaN",
      "Infinity",
      "99999999999999999999",
      ["nope"],
    ]) {
      expect(normalizePageParam(raw as string | string[] | undefined | null)).toBe(1);
    }
  });

  it("accepts a positive whole number, including from a repeated parameter", () => {
    expect(normalizePageParam("1")).toBe(1);
    expect(normalizePageParam("7")).toBe(7);
    expect(normalizePageParam(" 12 ")).toBe(12);
    expect(normalizePageParam(["3", "9"])).toBe(3);
  });
});
