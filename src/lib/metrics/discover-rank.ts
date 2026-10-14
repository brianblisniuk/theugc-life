/**
 * Discover order for one H01 metric (D130).
 *
 * A destination uses `read_destination_metric_ranking`. No destination uses
 * `hotel_metric_signal_public` or `hotel_metric_signal_premium`. The order is
 * rank_key descending, then hotel id. Hotels below the floor are absent.
 * A locked premium read returns no hotels and does not query the premium view
 * when the caller has no Pass, Pro, or staff role.
 */
import "server-only";

import type { SessionResolution } from "@/lib/auth/guards";
import { resolveSession } from "@/lib/auth/guards";
import { loadBillingAccess, type BillingAccessResult } from "@/lib/billing/queries";
import { isActiveEntitlement } from "@/lib/billing/view";
import { hasDiscoverNarrowing, type DiscoverQuery } from "@/lib/hotels/filters";
import {
  loadPublishedInOrder,
  resolveDestinationScope,
  retainDiscoverHotelIds,
  type HotelQueryClient,
  type HotelSearchResult,
  type PublishedHotelView,
} from "@/lib/hotels/queries";
import { createClient } from "@/lib/supabase/server";

import {
  METRIC_LAYERS,
  METRIC_TITLES,
  THRESHOLD_RULES,
  isPublishedValue,
  isSampleBasis,
  parseRanking,
  type MetricId,
} from "./contract";
import { orderByRankKey } from "./order";

const METRIC_ROW_CAP = 5000;

export interface MetricLine {
  rank: number;
  valueLabel: string;
  sampleBasis: string | null;
}

export type RankedDiscover =
  | { kind: "locked"; metric: MetricId; title: string; thresholdRule: string }
  | { kind: "below_floor"; metric: MetricId; title: string; thresholdRule: string }
  | {
      kind: "list";
      metric: MetricId;
      title: string;
      thresholdRule: string;
      result: HotelSearchResult;
      lines: ReadonlyMap<string, MetricLine>;
    };

export interface RankedDiscoverDeps {
  client?: HotelQueryClient;
  session?: SessionResolution;
  billing?: BillingAccessResult;
}

interface SignalRow {
  hotelId: string;
  rankKey: number;
  valueLabel: string;
  sampleBasis: string | null;
  rank: number;
}

function signalTable(
  metric: MetricId,
): "hotel_metric_signal_public" | "hotel_metric_signal_premium" {
  return METRIC_LAYERS[metric] === "public"
    ? "hotel_metric_signal_public"
    : "hotel_metric_signal_premium";
}

function fail(): never {
  throw new Error("hotel_search_failed:metric_rank");
}

function readSignal(raw: unknown, metric: MetricId): Omit<SignalRow, "rank"> | null {
  if (!raw || typeof raw !== "object") return null;
  const row = raw as Record<string, unknown>;
  if (row.metric !== metric || typeof row.hotel_id !== "string") return null;
  const rankKey = typeof row.rank_key === "number" ? row.rank_key : Number(row.rank_key);
  if (!Number.isFinite(rankKey)) return null;
  if (typeof row.value_label !== "string" || !isPublishedValue(metric, row.value_label))
    return null;
  const sampleBasis = row.sample_basis === null ? null : row.sample_basis;
  if ((typeof sampleBasis !== "string" && sampleBasis !== null) || !isSampleBasis(sampleBasis)) {
    return null;
  }
  return {
    hotelId: row.hotel_id,
    rankKey,
    valueLabel: row.value_label,
    sampleBasis,
  };
}

function numberRanks(rows: readonly Omit<SignalRow, "rank">[], start = 1): SignalRow[] {
  const seen = new Set<string>();
  return orderByRankKey(rows).map((row, index) => {
    if (seen.has(row.hotelId)) fail();
    seen.add(row.hotelId);
    return { ...row, rank: start + index };
  });
}

function emptyResult(page: number, pageSize: number): HotelSearchResult {
  return { hotels: [], pins: [], total: 0, page, pageSize, hasMore: false };
}

function listFromPage(
  metric: MetricId,
  page: number,
  pageSize: number,
  total: number,
  pageRows: readonly SignalRow[],
  loaded: readonly PublishedHotelView[],
): RankedDiscover {
  const lines = new Map<string, MetricLine>();
  loaded.forEach((row, index) => {
    const signal = pageRows[index];
    if (!signal || signal.hotelId !== row.hotel.id) fail();
    lines.set(row.hotel.id, {
      rank: signal.rank,
      valueLabel: signal.valueLabel,
      sampleBasis: signal.sampleBasis,
    });
  });
  const from = (page - 1) * pageSize;
  return {
    kind: "list",
    metric,
    title: METRIC_TITLES[metric],
    thresholdRule: THRESHOLD_RULES[metric],
    lines,
    result: {
      hotels: loaded.map((row) => row.hotel),
      pins: loaded.map((row) => row.mapPin),
      total,
      page,
      pageSize,
      hasMore: from + loaded.length < total,
    },
  };
}

async function entitledToPremiumView(
  client: HotelQueryClient,
  session: SessionResolution,
  billing: BillingAccessResult | undefined,
): Promise<"yes" | "locked" | "error"> {
  if (session.status === "error") return "error";
  if (session.status !== "authenticated") return "locked";
  if (session.session.role === "admin" || session.session.role === "editor") return "yes";
  const { data, error } = await client.rpc("has_active_pro");
  if (error) return "error";
  if (data === true) return "yes";
  const access = billing ?? (await loadBillingAccess(session.session.userId, client));
  if (access.status === "error") return "error";
  const pass = access.entitlements.some(
    (row) => isActiveEntitlement(row) && row.accessType === "destination",
  );
  return pass ? "yes" : "locked";
}

async function pageSignals(
  client: HotelQueryClient,
  metric: MetricId,
  page: number,
  pageSize: number,
): Promise<{ rows: SignalRow[]; total: number }> {
  const from = (page - 1) * pageSize;
  const { data, error, count } = await client
    .from(signalTable(metric))
    .select("hotel_id, rank_key, value_label, sample_basis, metric", { count: "exact" })
    .eq("metric", metric)
    .order("rank_key", { ascending: false })
    .order("hotel_id", { ascending: true })
    .range(from, from + pageSize - 1);
  if (error || count === null || count === undefined) fail();
  const parsed: Omit<SignalRow, "rank">[] = [];
  for (const raw of data ?? []) {
    const signal = readSignal(raw, metric);
    if (!signal) fail();
    parsed.push(signal);
  }
  return { rows: numberRanks(parsed, from + 1), total: count };
}

async function allSignals(client: HotelQueryClient, metric: MetricId): Promise<SignalRow[]> {
  const { data, error } = await client
    .from(signalTable(metric))
    .select("hotel_id, rank_key, value_label, sample_basis, metric")
    .eq("metric", metric)
    .order("rank_key", { ascending: false })
    .order("hotel_id", { ascending: true })
    .limit(METRIC_ROW_CAP + 1);
  if (error) fail();
  const rows = data ?? [];
  if (rows.length > METRIC_ROW_CAP) fail();
  const parsed: Omit<SignalRow, "rank">[] = [];
  for (const raw of rows) {
    const signal = readSignal(raw, metric);
    if (!signal) fail();
    parsed.push(signal);
  }
  return numberRanks(parsed);
}

export async function searchRankedHotels(
  query: DiscoverQuery,
  deps: RankedDiscoverDeps = {},
): Promise<RankedDiscover> {
  const metric = query.rank;
  if (!metric) fail();
  const client = deps.client ?? (await createClient());
  const pageSize = Math.min(query.pageSize, 50);
  const page = Math.max(1, query.page);
  const title = METRIC_TITLES[metric];
  const thresholdRule = THRESHOLD_RULES[metric];

  if (query.destination) {
    const scope = await resolveDestinationScope(query.destination, client);
    if (scope.status === "error") throw new Error("hotel_search_failed:destination_scope");
    if (scope.status === "empty" || scope.status === "none") {
      return {
        kind: "list",
        metric,
        title,
        thresholdRule,
        lines: new Map(),
        result: emptyResult(page, pageSize),
      };
    }
    const { data, error } = await client.rpc("read_destination_metric_ranking", {
      p_destination_id: scope.rootId,
      p_metric: metric,
    });
    if (error || data == null) fail();
    const ranking = parseRanking(data, metric);
    if (ranking.status === "error") fail();
    if (ranking.status === "locked") return { kind: "locked", metric, title, thresholdRule };
    if (ranking.hotels.length === 0) return { kind: "below_floor", metric, title, thresholdRule };
    if (ranking.hotels.length > METRIC_ROW_CAP) fail();
    const ranked: SignalRow[] = ranking.hotels.map((hotel) => ({
      hotelId: hotel.hotelId,
      rankKey: 0,
      valueLabel: hotel.valueLabel,
      sampleBasis: hotel.sampleBasis,
      rank: hotel.rank,
    }));
    const filteredIds = await retainDiscoverHotelIds(
      query,
      ranked.map((row) => row.hotelId),
      client,
    );
    const allowed = new Set(filteredIds);
    const ordered = ranked.filter((row) => allowed.has(row.hotelId));
    if (ordered.length === 0) {
      return {
        kind: "list",
        metric,
        title,
        thresholdRule,
        lines: new Map(),
        result: emptyResult(page, pageSize),
      };
    }
    const from = (page - 1) * pageSize;
    const pageRows = ordered.slice(from, from + pageSize);
    if (pageRows.length === 0) {
      return listFromPage(metric, page, pageSize, ordered.length, [], []);
    }
    const loaded = await loadPublishedInOrder(
      pageRows.map((row) => row.hotelId),
      client,
    );
    return listFromPage(metric, page, pageSize, ordered.length, pageRows, loaded);
  }

  if (METRIC_LAYERS[metric] === "premium") {
    const session = deps.session ?? (await resolveSession());
    const access = await entitledToPremiumView(client, session, deps.billing);
    if (access === "error") fail();
    if (access === "locked") return { kind: "locked", metric, title, thresholdRule };
  }

  if (!hasDiscoverNarrowing(query)) {
    const { rows, total } = await pageSignals(client, metric, page, pageSize);
    if (total === 0) return { kind: "below_floor", metric, title, thresholdRule };
    if (rows.length === 0) return listFromPage(metric, page, pageSize, total, [], []);
    const loaded = await loadPublishedInOrder(
      rows.map((row) => row.hotelId),
      client,
    );
    return listFromPage(metric, page, pageSize, total, rows, loaded);
  }

  const signals = await allSignals(client, metric);
  if (signals.length === 0) return { kind: "below_floor", metric, title, thresholdRule };
  const filteredIds = new Set(
    await retainDiscoverHotelIds(
      query,
      signals.map((row) => row.hotelId),
      client,
    ),
  );
  const ordered = signals.filter((row) => filteredIds.has(row.hotelId));
  if (ordered.length === 0) {
    return {
      kind: "list",
      metric,
      title,
      thresholdRule,
      lines: new Map(),
      result: emptyResult(page, pageSize),
    };
  }
  const from = (page - 1) * pageSize;
  const pageRows = ordered.slice(from, from + pageSize);
  if (pageRows.length === 0) return listFromPage(metric, page, pageSize, ordered.length, [], []);
  const loaded = await loadPublishedInOrder(
    pageRows.map((row) => row.hotelId),
    client,
  );
  return listFromPage(metric, page, pageSize, ordered.length, pageRows, loaded);
}
