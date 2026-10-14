/**
 * Pipeline order for one H01 metric (D130).
 *
 * The caller's own hotel ids are the only candidates. Premium order uses
 * `hotel_metric_signal_premium` after a Pass, Pro, or staff check. A locked
 * caller does not receive hotel ids. Below-floor hotels are absent from the
 * order. The sort is rank_key descending, then hotel id.
 */
import "server-only";

import type { SessionResolution } from "@/lib/auth/guards";
import { loadBillingAccess, type BillingAccessResult } from "@/lib/billing/queries";
import { isActiveEntitlement } from "@/lib/billing/view";

import { METRIC_LAYERS, isPublishedValue, isSampleBasis, type MetricId } from "./contract";
import { orderByRankKey } from "./order";

const CHUNK = 100;

export interface PipelineHotelRef {
  hotelId: string;
  destinationId: string | null;
}

export interface RankedPipelineHotel {
  hotelId: string;
  rank: number;
  valueLabel: string;
  sampleBasis: string | null;
}

export type PipelineRankOutcome =
  | { status: "ok"; hotels: readonly RankedPipelineHotel[] }
  | { status: "locked" }
  | { status: "not_enough_data" }
  | { status: "error" };

interface SignalClient {
  from: (table: string) => {
    select: (columns: string) => SignalFilter;
  };
  rpc: (
    fn: string,
    args?: Record<string, unknown>,
  ) => PromiseLike<{ data: unknown; error: { code?: string } | null }>;
}

interface SignalFilter {
  eq: (column: string, value: string) => SignalFilter;
  in: (column: string, values: readonly string[]) => SignalFilter;
  order: (column: string, options: { ascending: boolean }) => SignalFilter;
  limit: (
    count: number,
  ) => PromiseLike<{ data: unknown[] | null; error: { code?: string } | null }>;
}

export interface PipelineRankAuth {
  session: SessionResolution;
  billing?: BillingAccessResult;
}

function signalTable(metric: MetricId): string {
  return METRIC_LAYERS[metric] === "public"
    ? "hotel_metric_signal_public"
    : "hotel_metric_signal_premium";
}

async function entitledHotelIds(
  client: SignalClient,
  hotels: readonly PipelineHotelRef[],
  auth: PipelineRankAuth,
): Promise<
  { status: "ok"; ids: ReadonlySet<string> } | { status: "locked" } | { status: "error" }
> {
  const all = new Set(hotels.map((hotel) => hotel.hotelId));
  const session = auth.session;
  if (session.status === "error") return { status: "error" };
  if (session.status !== "authenticated") return { status: "locked" };
  if (session.session.role === "admin" || session.session.role === "editor") {
    return { status: "ok", ids: all };
  }

  const pro = await client.rpc("has_active_pro");
  if (pro.error) return { status: "error" };
  if (pro.data === true) return { status: "ok", ids: all };

  const billing =
    auth.billing ?? (await loadBillingAccess(session.session.userId, client as never));
  if (billing.status === "error") return { status: "error" };
  const hasPass = billing.entitlements.some(
    (row) => isActiveEntitlement(row) && row.accessType === "destination",
  );
  if (!hasPass) return { status: "locked" };

  const destinations = [
    ...new Set(
      hotels
        .map((hotel) => hotel.destinationId)
        .filter((id): id is string => typeof id === "string" && id.length > 0),
    ),
  ];
  const allowed = new Set<string>();
  for (const destinationId of destinations) {
    const access = await client.rpc("has_active_destination_access", { dest_id: destinationId });
    if (access.error) return { status: "error" };
    if (access.data !== true) continue;
    for (const hotel of hotels) {
      if (hotel.destinationId === destinationId) allowed.add(hotel.hotelId);
    }
  }
  if (allowed.size === 0) return { status: "locked" };
  return { status: "ok", ids: allowed };
}

function parseSignal(
  raw: unknown,
  metric: MetricId,
  allowed: ReadonlySet<string>,
):
  | { hotelId: string; rankKey: number; valueLabel: string; sampleBasis: string | null }
  | "skip"
  | "bad" {
  if (!raw || typeof raw !== "object") return "bad";
  const row = raw as Record<string, unknown>;
  if (row.metric !== metric || typeof row.hotel_id !== "string") return "bad";
  if (!allowed.has(row.hotel_id)) return "skip";
  const rankKey = typeof row.rank_key === "number" ? row.rank_key : Number(row.rank_key);
  if (!Number.isFinite(rankKey)) return "bad";
  if (typeof row.value_label !== "string" || !isPublishedValue(metric, row.value_label))
    return "bad";
  const sampleBasis = row.sample_basis === null ? null : row.sample_basis;
  if ((typeof sampleBasis !== "string" && sampleBasis !== null) || !isSampleBasis(sampleBasis)) {
    return "bad";
  }
  return { hotelId: row.hotel_id, rankKey, valueLabel: row.value_label, sampleBasis };
}

export async function rankOwnedHotels(
  client: SignalClient,
  metric: MetricId,
  hotels: readonly PipelineHotelRef[],
  auth: PipelineRankAuth,
): Promise<PipelineRankOutcome> {
  const unique = new Map<string, PipelineHotelRef>();
  for (const hotel of hotels) unique.set(hotel.hotelId, hotel);
  const refs = [...unique.values()];
  if (refs.length === 0) return { status: "not_enough_data" };

  let allowed: ReadonlySet<string>;
  if (METRIC_LAYERS[metric] === "public") {
    allowed = new Set(refs.map((hotel) => hotel.hotelId));
  } else {
    const entitlement = await entitledHotelIds(client, refs, auth);
    if (entitlement.status !== "ok") return entitlement;
    allowed = entitlement.ids;
  }

  const parsed: {
    hotelId: string;
    rankKey: number;
    valueLabel: string;
    sampleBasis: string | null;
  }[] = [];
  const ids = [...allowed];
  for (let index = 0; index < ids.length; index += CHUNK) {
    const chunk = ids.slice(index, index + CHUNK);
    const { data, error } = await client
      .from(signalTable(metric))
      .select("hotel_id, rank_key, value_label, sample_basis, metric")
      .eq("metric", metric)
      .in("hotel_id", chunk)
      .order("rank_key", { ascending: false })
      .order("hotel_id", { ascending: true })
      .limit(chunk.length + 1);
    if (error || !data) return { status: "error" };
    if (data.length > chunk.length) return { status: "error" };
    for (const raw of data) {
      const signal = parseSignal(raw, metric, allowed);
      if (signal === "bad") return { status: "error" };
      if (signal === "skip") continue;
      parsed.push(signal);
    }
  }

  const seen = new Set<string>();
  const ordered = orderByRankKey(parsed).filter((row) => {
    if (seen.has(row.hotelId)) return false;
    seen.add(row.hotelId);
    return true;
  });
  if (ordered.length !== parsed.length) return { status: "error" };
  if (ordered.length === 0) return { status: "not_enough_data" };
  return {
    status: "ok",
    hotels: ordered.map((row, index) => ({
      hotelId: row.hotelId,
      rank: index + 1,
      valueLabel: row.valueLabel,
      sampleBasis: row.sampleBasis,
    })),
  };
}
