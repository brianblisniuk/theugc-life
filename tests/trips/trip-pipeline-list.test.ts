/**
 * The trip workspace must be able to find a pipeline item older than the
 * first 100. A hard cap would hide it from both link and unlink.
 */
import { describe, expect, it } from "vitest";

import {
  listLinkablePipelineItems,
  TRIP_PIPELINE_PAGE_SIZE,
  type LinkablePipelineItem,
} from "@/lib/trips/queries";

interface Seen {
  range: [number, number] | null;
  ilike: { column: string; pattern: string } | null;
  select: string | null;
}

function row(id: string, name: string): LinkablePipelineItem & { hotel: { name: string } } {
  return {
    id,
    status: "saved",
    tripId: null,
    hotelName: name,
    hotel: { name },
  };
}

function client(rowsFor: (seen: Seen) => unknown[]) {
  const seen: Seen = { range: null, ilike: null, select: null };
  const chain: Record<string, unknown> = {
    select: (columns: string) => {
      seen.select = columns;
      return chain;
    },
    order: () => chain,
    ilike: (column: string, pattern: string) => {
      seen.ilike = { column, pattern };
      return chain;
    },
    range: (from: number, to: number) => {
      seen.range = [from, to];
      return Promise.resolve({ data: rowsFor(seen), error: null });
    },
  };
  return {
    seen,
    client: { from: () => chain } as never,
  };
}

describe("listLinkablePipelineItems", () => {
  it("pages past the first 100 instead of dropping older items", async () => {
    const older = "d0140000-0000-0000-0000-000000000101";
    const { client: fake, seen } = client((call) => {
      if (call.range?.[0] === TRIP_PIPELINE_PAGE_SIZE) return [row(older, "Older Hotel")];
      return [];
    });

    const page = await listLinkablePipelineItems({ page: 2 }, fake);
    expect(page.status).toBe("ok");
    if (page.status !== "ok") return;
    expect(seen.range).toEqual([TRIP_PIPELINE_PAGE_SIZE, TRIP_PIPELINE_PAGE_SIZE * 2]);
    expect(page.items.map((item) => item.id)).toEqual([older]);
    expect(page.hasPrevious).toBe(true);
    expect(page.page).toBe(2);
  });

  it("finds an older hotel by name instead of only the latest page", async () => {
    const older = "d0140000-0000-0000-0000-000000000202";
    const { client: fake, seen } = client((call) => {
      if (call.ilike?.pattern === "%Old Harbor%") return [row(older, "Old Harbor")];
      return [];
    });

    const page = await listLinkablePipelineItems({ query: "Old Harbor" }, fake);
    expect(page.status).toBe("ok");
    if (page.status !== "ok") return;
    expect(seen.ilike).toEqual({ column: "hotel.name", pattern: "%Old Harbor%" });
    expect(seen.select).toContain("hotel:hotels!inner");
    expect(seen.range?.[0]).toBe(0);
    expect(page.items.map((item) => item.hotelName)).toEqual(["Old Harbor"]);
    expect(page.query).toBe("Old Harbor");
  });

  it("does not let a search wildcard widen the match", async () => {
    const { client: fake, seen } = client(() => []);
    const page = await listLinkablePipelineItems({ query: "100%_match" }, fake);
    expect(page.status).toBe("ok");
    if (page.status !== "ok") return;
    expect(seen.ilike).toEqual({ column: "hotel.name", pattern: "%100 match%" });
  });

  it("reports another page when the database returns one extra row", async () => {
    const rows = Array.from({ length: TRIP_PIPELINE_PAGE_SIZE + 1 }, (_, index) =>
      row(`d0140000-0000-0000-0000-${String(index).padStart(12, "0")}`, `Hotel ${index}`),
    );
    const { client: fake } = client(() => rows);
    const page = await listLinkablePipelineItems({ page: 1 }, fake);
    expect(page.status).toBe("ok");
    if (page.status !== "ok") return;
    expect(page.items).toHaveLength(TRIP_PIPELINE_PAGE_SIZE);
    expect(page.hasNext).toBe(true);
    expect(page.items.some((item) => item.hotelName === `Hotel ${TRIP_PIPELINE_PAGE_SIZE}`)).toBe(
      false,
    );
  });
});
