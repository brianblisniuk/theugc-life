/**
 * Pipeline order for one metric (D130).
 *
 * User A's list cannot gain User B's hotel from the signal view. A locked
 * reply-rate order has no hotel names. Below-floor hotels are omitted, and a
 * measured zero stays in the order.
 */
import { describe, expect, it } from "vitest";

import type { BillingAccessResult } from "@/lib/billing/queries";
import {
  listPipelineItems,
  PIPELINE_RANK_CAP,
  type PipelineQueryClient,
} from "@/lib/pipeline/queries";

const A1 = "a1300000-0000-4000-8000-000000000011";
const A2 = "a1300000-0000-4000-8000-000000000012";
const A3 = "a1300000-0000-4000-8000-000000000013";
const FOREIGN = "b1300000-0000-4000-8000-000000000099";
const BALI = "d1300000-0000-4000-8000-0000000000b1";
const DUBAI = "d1300000-0000-4000-8000-0000000000d1";

interface Call {
  table: string;
  head: boolean;
  eqs: [string, unknown][];
  orders: [string, boolean][];
  ins: [string, unknown[]][];
}

const creator = {
  status: "authenticated" as const,
  session: { userId: "user-a", email: null, role: "creator" as const },
};

const noBilling: BillingAccessResult = { status: "ok", entitlements: [] };
const baliPass: BillingAccessResult = {
  status: "ok",
  entitlements: [
    {
      accessType: "destination",
      status: "active",
      startsAt: "2020-01-01T00:00:00.000Z",
      expiresAt: null,
    },
  ],
};

function row(id: string, name: string, destinationId: string, activity: string) {
  return {
    id: `item-${id}`,
    status: "saved",
    saved_at: "2026-01-01",
    last_activity_at: activity,
    next_followup_at: null,
    hotel: {
      id,
      name,
      country_code: "ID",
      destination_id: destinationId,
      destination: { id: destinationId, name: destinationId === BALI ? "Bali" : "Dubai" },
    },
  };
}

function client(
  calls: Call[],
  options: {
    count?: number;
    rows?: unknown[];
    signals?: unknown[];
    pro?: boolean | "error";
    destinations?: ReadonlySet<string>;
  },
): PipelineQueryClient {
  return {
    from(table: string) {
      const call: Call = { table, head: false, eqs: [], orders: [], ins: [] };
      const finish = () => {
        calls.push(call);
        if (table === "pipeline_items" && call.head) {
          return { data: null, count: options.count ?? options.rows?.length ?? 0, error: null };
        }
        if (table === "pipeline_items") return { data: options.rows ?? [], error: null };
        const requested = call.ins.find(([column]) => column === "hotel_id")?.[1] ?? [];
        const signals = (options.signals ?? []).filter((signal) =>
          requested.includes(String((signal as { hotel_id: string }).hotel_id)),
        );
        return { data: signals, error: null };
      };
      const chain: Record<string, unknown> = {
        select: (_columns: string, opts?: { head?: boolean }) => {
          call.head = Boolean(opts?.head);
          return chain;
        },
        eq: (column: string, value: unknown) => {
          call.eqs.push([column, value]);
          return chain;
        },
        in: (column: string, values: unknown[]) => {
          call.ins.push([column, values]);
          return chain;
        },
        order: (column: string, opts?: { ascending?: boolean }) => {
          call.orders.push([column, opts?.ascending !== false]);
          return chain;
        },
        range: () => finish(),
        limit: () => finish(),
        then: (resolve: (value: unknown) => unknown) => Promise.resolve(finish()).then(resolve),
      };
      return chain;
    },
    async rpc(name: string, args?: Record<string, unknown>) {
      calls.push({
        table: `rpc:${name}`,
        head: false,
        eqs: args?.dest_id ? [["dest_id", args.dest_id]] : [],
        orders: [],
        ins: [],
      });
      if (name === "has_active_pro") {
        if (options.pro === "error") return { data: null, error: { code: "57014" } };
        return { data: options.pro === true, error: null };
      }
      if (name === "has_active_destination_access") {
        return { data: options.destinations?.has(String(args?.dest_id)) === true, error: null };
      }
      return { data: null, error: { code: "unexpected" } };
    },
  } as unknown as PipelineQueryClient;
}

describe("listPipelineItems metric order", () => {
  it("orders the caller's hotels by one rank key and drops a foreign hotel", async () => {
    const calls: Call[] = [];
    const db = client(calls, {
      rows: [
        row(A2, "Later activity", BALI, "2026-10-02"),
        row(A1, "Earlier activity", BALI, "2026-10-01"),
        row(A3, "No metric", BALI, "2026-10-03"),
      ],
      signals: [
        {
          hotel_id: A2,
          metric: "creator_activity",
          rank_key: 1,
          value_label: "Emerging",
          sample_basis: null,
        },
        {
          hotel_id: A1,
          metric: "creator_activity",
          rank_key: 3,
          value_label: "High",
          sample_basis: null,
        },
        {
          hotel_id: FOREIGN,
          metric: "creator_activity",
          rank_key: 3,
          value_label: "High",
          sample_basis: null,
        },
      ],
    });
    const result = await listPipelineItems(null, 1, db, "creator_activity", {
      session: creator,
    });
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    expect(result.page.items.map((item) => item.hotel?.id)).toEqual([A1, A2]);
    expect(result.page.items.map((item) => item.metricValue)).toEqual(["High", "Emerging"]);
    expect(JSON.stringify(result)).not.toContain(FOREIGN);
    expect(JSON.stringify(result)).not.toContain("No metric");
    const view = calls.find((call) => call.table === "hotel_metric_signal_public");
    expect(view?.orders).toEqual([
      ["rank_key", false],
      ["hotel_id", true],
    ]);
    expect(view?.eqs).toEqual([["metric", "creator_activity"]]);
    expect(view?.ins[0]?.[1]).toEqual([A2, A1, A3]);
  });

  it("keeps a measured zero and does not sort by the percent text", async () => {
    const db = client([], {
      rows: [row(A1, "Zero", BALI, "2026-10-02"), row(A2, "High", BALI, "2026-01-01")],
      signals: [
        {
          hotel_id: A1,
          metric: "response_rate",
          rank_key: 0,
          value_label: "0%",
          sample_basis: null,
        },
        {
          hotel_id: A2,
          metric: "response_rate",
          rank_key: 80,
          value_label: "80%",
          sample_basis: null,
        },
      ],
      pro: true,
    });
    const result = await listPipelineItems(null, 1, db, "response_rate", { session: creator });
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    expect(result.page.items.map((item) => item.metricValue)).toEqual(["80%", "0%"]);
  });

  it("shows a locked caller no reply-rate hotels", async () => {
    const calls: Call[] = [];
    const db = client(calls, {
      rows: [row(A1, "Secret Hotel", BALI, "2026-10-01")],
      signals: [
        {
          hotel_id: A1,
          metric: "response_rate",
          rank_key: 80,
          value_label: "80%",
          sample_basis: null,
        },
      ],
      pro: false,
    });
    const result = await listPipelineItems(null, 1, db, "response_rate", {
      session: creator,
      billing: noBilling,
    });
    expect(result).toEqual({ status: "locked", metric: "response_rate" });
    expect(JSON.stringify(result)).not.toContain("Secret Hotel");
    expect(calls.some((call) => call.table === "hotel_metric_signal_premium")).toBe(false);
  });

  it("omits a destination the Pass does not cover", async () => {
    const db = client([], {
      rows: [
        row(A1, "Bali Hotel", BALI, "2026-01-01"),
        row(A2, "Dubai Hotel", DUBAI, "2026-02-01"),
      ],
      signals: [
        {
          hotel_id: A1,
          metric: "response_rate",
          rank_key: 10,
          value_label: "10%",
          sample_basis: null,
        },
        {
          hotel_id: A2,
          metric: "response_rate",
          rank_key: 90,
          value_label: "90%",
          sample_basis: null,
        },
      ],
      pro: false,
      destinations: new Set([BALI]),
    });
    const result = await listPipelineItems(null, 1, db, "response_rate", {
      session: creator,
      billing: baliPass,
    });
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    expect(result.page.items.map((item) => item.hotel?.name)).toEqual(["Bali Hotel"]);
    expect(JSON.stringify(result)).not.toContain("Dubai Hotel");
  });

  it("says not enough data when entitled hotels are below the floor", async () => {
    const db = client([], {
      rows: [row(A1, "Thin Hotel", BALI, "2026-01-01")],
      signals: [],
      pro: true,
    });
    const result = await listPipelineItems(null, 1, db, "response_time", { session: creator });
    expect(result).toEqual({ status: "not_enough_data", metric: "response_time" });
    expect(JSON.stringify(result)).not.toContain("Thin Hotel");
  });

  it("fails closed when the entitlement read fails", async () => {
    const db = client([], {
      rows: [row(A1, "Secret Hotel", BALI, "2026-01-01")],
      pro: "error",
    });
    const result = await listPipelineItems(null, 1, db, "response_rate", { session: creator });
    expect(result).toEqual({ status: "error" });
    expect(JSON.stringify(result)).not.toContain("Secret Hotel");
  });

  it("does not rank a truncated pipeline", async () => {
    const calls: Call[] = [];
    const db = client(calls, { count: PIPELINE_RANK_CAP + 1, rows: [], pro: true });
    const result = await listPipelineItems(null, 1, db, "creator_activity", { session: creator });
    expect(result).toEqual({ status: "error" });
    expect(calls.some((call) => call.table.startsWith("hotel_metric"))).toBe(false);
  });
});
