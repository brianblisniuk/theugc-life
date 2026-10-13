/**
 * Shapes returned by the C02–C05 functions. Parsers drop every key that is
 * not listed here, so an evidence id cannot ride along into the browser.
 */
import { parseConfidence, type NetworkPublicRow } from "./display";

export interface OwnFact {
  factType: string;
  provenanceClass: "machine" | "creator_confirmed";
  sourceFamily: "manual" | "gmail" | "trip";
  eventAt: string | null;
}

export interface OwnNetworkFacts {
  manual: OwnFact[];
  gmail: OwnFact[];
}

export type OwnFactsLoad =
  | { status: "ok"; facts: OwnNetworkFacts }
  | { status: "hidden" }
  | { status: "error" };

export type NetworkLoad =
  | { status: "ok"; row: NetworkPublicRow }
  | { status: "none" }
  | { status: "error" };

export interface RankedHotel {
  hotelId: string;
  confidenceLevel: NetworkPublicRow["confidenceLevel"];
  activityLevel: string | null;
  recencyBand: string | null;
  name: string;
}

export type RankLoad = { status: "ok"; hotels: RankedHotel[] } | { status: "error" };

export type GmailPromptLoad =
  | { status: "pending" }
  | { status: "stale" }
  | { status: "hidden" }
  | { status: "dismissed" }
  | { status: "confirmed_admitted" }
  | { status: "confirmed_not_admitted" }
  | { status: "error" };

const PROMPT = new Set([
  "pending",
  "stale",
  "hidden",
  "dismissed",
  "confirmed_admitted",
  "confirmed_not_admitted",
  "not_found",
]);

export function parseGmailPrompt(data: unknown): GmailPromptLoad {
  if (!data || typeof data !== "object") return { status: "error" };
  const result = (data as { result?: unknown }).result;
  if (result === "not_found" || result === "hidden") return { status: "hidden" };
  if (typeof result === "string" && PROMPT.has(result) && result !== "not_found") {
    return { status: result as GmailPromptLoad["status"] };
  }
  return { status: "error" };
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function parseFact(value: unknown): OwnFact | null {
  if (!value || typeof value !== "object") return null;
  const row = value as Record<string, unknown>;
  const factType = asString(row.fact_type);
  const provenance = row.provenance_class;
  const family = row.source_family;
  if (!factType) return null;
  if (provenance !== "machine" && provenance !== "creator_confirmed") return null;
  if (family !== "manual" && family !== "gmail" && family !== "trip") return null;
  if ("evidence_id" in row || "owner_user_id" in row) return null;
  return {
    factType,
    provenanceClass: provenance,
    sourceFamily: family,
    eventAt: asString(row.event_at),
  };
}

export function parseOwnFacts(data: unknown): OwnFactsLoad {
  if (!data || typeof data !== "object") return { status: "error" };
  const row = data as Record<string, unknown>;
  if (row.result === "not_found") return { status: "hidden" };
  if (row.result !== "ok") return { status: "error" };
  if ("evidence_id" in row || "owner_user_id" in row) return { status: "error" };
  const manual = Array.isArray(row.manual) ? row.manual.map(parseFact).filter((f) => f !== null) : [];
  const gmail = Array.isArray(row.gmail) ? row.gmail.map(parseFact).filter((f) => f !== null) : [];
  if (
    (Array.isArray(row.manual) && manual.length !== row.manual.length) ||
    (Array.isArray(row.gmail) && gmail.length !== row.gmail.length)
  ) {
    return { status: "error" };
  }
  return { status: "ok", facts: { manual, gmail } };
}

export function parseNetworkRow(data: unknown): NetworkPublicRow | null {
  if (!data || typeof data !== "object") return null;
  const row = data as Record<string, unknown>;
  if ("evidence_id" in row || "owner_user_id" in row || "sample_size" in row || "distinct_creators" in row) {
    return null;
  }
  const collaboration = row.has_observed_collaboration;
  if (collaboration !== null && collaboration !== true) return null;
  return {
    confidenceLevel: parseConfidence(row.confidence_level),
    activityLevel: asString(row.activity_level),
    hasObservedCollaboration: collaboration === true ? true : null,
    recencyBand: asString(row.recency_band),
    freshnessBand: asString(row.freshness_band),
  };
}

export interface PilotKpis {
  confirmedFactsPerCreator: { creatorUserId: string; manualFacts: number; gmailConfirmedFacts: number }[];
  gmailConfirmed: number;
  gmailDismissed: number;
  gmailConfirmedPct: number | null;
  gmailDismissedPct: number | null;
  hotelsEmergingOrAbove: number;
  hotelResponseTime: { hotelId: string; band: string }[];
  creatorsWhoViewed: number;
  creatorsWhoReturned: number;
  returnRate: number | null;
}

export type PilotLoad = { status: "ok"; kpis: PilotKpis } | { status: "hidden" } | { status: "error" };

function whole(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : null;
}

export function parsePilotKpis(data: unknown): PilotLoad {
  if (!data || typeof data !== "object") return { status: "error" };
  const row = data as Record<string, unknown>;
  if (row.result === "not_found") return { status: "hidden" };
  if (row.result !== "ok") return { status: "error" };
  if ("evidence_id" in row || "mean_ms" in row || "response_time_ms" in row) return { status: "error" };
  const perCreator = Array.isArray(row.confirmed_facts_per_creator)
    ? row.confirmed_facts_per_creator
    : null;
  const times = Array.isArray(row.hotel_response_time) ? row.hotel_response_time : null;
  const retention = row.retention;
  if (!perCreator || !times || !retention || typeof retention !== "object") return { status: "error" };
  const creators = [];
  for (const item of perCreator) {
    if (!item || typeof item !== "object") return { status: "error" };
    const creator = item as Record<string, unknown>;
    const id = asString(creator.creator_user_id);
    const manual = whole(creator.manual_facts);
    const gmail = whole(creator.gmail_confirmed_facts);
    if (!id || manual === null || gmail === null) return { status: "error" };
    creators.push({ creatorUserId: id, manualFacts: manual, gmailConfirmedFacts: gmail });
  }
  const bands = [];
  for (const item of times) {
    if (!item || typeof item !== "object") return { status: "error" };
    const time = item as Record<string, unknown>;
    const hotelId = asString(time.hotel_id);
    const band = asString(time.response_time_band);
    if (!hotelId || !band || "mean_ms" in time) return { status: "error" };
    bands.push({ hotelId, band });
  }
  const hold = retention as Record<string, unknown>;
  const viewed = whole(hold.creators_who_viewed);
  const returned = whole(hold.creators_who_returned);
  const confirmed = whole(row.gmail_confirmed);
  const dismissed = whole(row.gmail_dismissed);
  const emerging = whole(row.hotels_emerging_or_above);
  if (viewed === null || returned === null || confirmed === null || dismissed === null || emerging === null) {
    return { status: "error" };
  }
  const confirmedPct = row.gmail_confirmed_pct === null ? null : whole(row.gmail_confirmed_pct);
  const dismissedPct = row.gmail_dismissed_pct === null ? null : whole(row.gmail_dismissed_pct);
  if (row.gmail_confirmed_pct !== null && confirmedPct === null) return { status: "error" };
  if (row.gmail_dismissed_pct !== null && dismissedPct === null) return { status: "error" };
  const returnRate = hold.return_rate === null ? null : typeof hold.return_rate === "number" ? hold.return_rate : null;
  if (hold.return_rate !== null && returnRate === null) return { status: "error" };
  return {
    status: "ok",
    kpis: {
      confirmedFactsPerCreator: creators,
      gmailConfirmed: confirmed,
      gmailDismissed: dismissed,
      gmailConfirmedPct: confirmedPct,
      gmailDismissedPct: dismissedPct,
      hotelsEmergingOrAbove: emerging,
      hotelResponseTime: bands,
      creatorsWhoViewed: viewed,
      creatorsWhoReturned: returned,
      returnRate,
    },
  };
}

export interface Provenance {
  factId: string;
  ownerUserId: string;
  factType: string;
  provenanceClass: string;
  sourceFamily: string;
  evidenceKind: string;
  evidenceId: string;
  canonicalHotelId: string | null;
}

export type ProvenanceLoad =
  | { status: "ok"; provenance: Provenance }
  | { status: "hidden" }
  | { status: "error" };

export function parseProvenance(data: unknown): ProvenanceLoad {
  if (!data || typeof data !== "object") return { status: "error" };
  const row = data as Record<string, unknown>;
  if (row.result === "not_found") return { status: "hidden" };
  if (row.result !== "ok") return { status: "error" };
  const factId = asString(row.fact_id);
  const owner = asString(row.owner_user_id);
  const factType = asString(row.fact_type);
  const provenanceClass = asString(row.provenance_class);
  const sourceFamily = asString(row.source_family);
  const evidenceKind = asString(row.evidence_kind);
  const evidenceId = asString(row.evidence_id);
  if (!factId || !owner || !factType || !provenanceClass || !sourceFamily || !evidenceKind || !evidenceId) {
    return { status: "error" };
  }
  return {
    status: "ok",
    provenance: {
      factId,
      ownerUserId: owner,
      factType,
      provenanceClass,
      sourceFamily,
      evidenceKind,
      evidenceId,
      canonicalHotelId: asString(row.canonical_hotel_id),
    },
  };
}
