/**
 * What a Discover card is allowed to say (D010, D012, D058).
 *
 * Public cards show only signals the public projection already disclosed.
 * Null is withheld, not "low", not "0%", and not "no collaboration".
 * Premium fields are not part of this shape, so a card cannot render them
 * by having an entitled viewer.
 *
 * Per-creator badges are assembled from rows the caller claims to have read.
 * `viewerId` is `creator_profiles.id` (`current_creator_id()`), the value
 * stored on `pipeline_items.creator_id` and `trips.creator_id`. It is not
 * `auth.uid()`. A row whose creator id is not that profile is dropped. That
 * is defense in depth: RLS is the boundary, and this function refuses to
 * display a foreign pipeline status or trip even if a row is handed to it.
 */
import { activityLabel, recencyLabel } from "./intelligence";
import { pipelineStatusLabel } from "@/lib/pipeline/types";

export interface PublicIntelligenceFields {
  activityLevel: string | null;
  recencyBand: string | null;
  hasObservedCollaboration: boolean | null;
}

export interface PublicCardSignal {
  activity: string | null;
  recency: string | null;
  collaborationObserved: boolean;
}

export function publicCardSignal(row: PublicIntelligenceFields | null): PublicCardSignal {
  if (!row) {
    return { activity: null, recency: null, collaborationObserved: false };
  }
  return {
    activity: activityLabel(row.activityLevel),
    recency: recencyLabel(row.recencyBand),
    collaborationObserved: row.hasObservedCollaboration === true,
  };
}

export function hasPublicCardSignal(signal: PublicCardSignal | null): boolean {
  if (!signal) return false;
  return Boolean(signal.activity || signal.recency || signal.collaborationObserved);
}

/** Columns Discover may read from the public projection. No premium metric. */
export const PUBLIC_CARD_INTELLIGENCE_COLUMNS = [
  "hotel_id",
  "activity_level",
  "recency_band",
  "has_observed_collaboration",
] as const;

export type PipelineBadge =
  | { kind: "status"; label: string }
  | { kind: "several"; count: number }
  | { kind: "none" }
  | { kind: "unknown" };

export interface CreatorBadge {
  pipeline: PipelineBadge;
  /** Trip ids owned by the viewer that already shortlist this hotel. */
  tripIds: readonly string[];
}

export interface PipelineBadgeRow {
  hotelId: string;
  creatorId: string;
  status: string;
}

export interface TripBadgeRow {
  hotelId: string;
  creatorId: string;
  tripId: string;
}

/**
 * Build per-hotel badges for one viewer.
 *
 * D182 allows several open opportunities for one hotel. Two or more open rows
 * are a count, not one chosen status and not an error. A foreign creator's
 * row is ignored, including its trip id.
 */
export function assembleCreatorBadges(input: {
  hotelIds: readonly string[];
  viewerId: string;
  pipelineRows: readonly PipelineBadgeRow[];
  tripRows: readonly TripBadgeRow[];
}): Map<string, CreatorBadge> {
  const pipeline = new Map<string, string[]>();
  for (const row of input.pipelineRows) {
    if (row.creatorId !== input.viewerId) continue;
    if (row.status === "closed") continue;
    const statuses = pipeline.get(row.hotelId) ?? [];
    statuses.push(row.status);
    pipeline.set(row.hotelId, statuses);
  }

  const trips = new Map<string, Set<string>>();
  for (const row of input.tripRows) {
    if (row.creatorId !== input.viewerId) continue;
    const ids = trips.get(row.hotelId) ?? new Set<string>();
    ids.add(row.tripId);
    trips.set(row.hotelId, ids);
  }

  const byHotel = new Map<string, CreatorBadge>();
  for (const hotelId of input.hotelIds) {
    const statuses = pipeline.get(hotelId) ?? [];
    let pipelineBadge: PipelineBadge;
    if (statuses.length === 1) {
      pipelineBadge = { kind: "status", label: pipelineStatusLabel(statuses[0]!) };
    } else if (statuses.length === 0) {
      pipelineBadge = { kind: "none" };
    } else {
      pipelineBadge = { kind: "several", count: statuses.length };
    }
    byHotel.set(hotelId, {
      pipeline: pipelineBadge,
      tripIds: [...(trips.get(hotelId) ?? [])],
    });
  }
  return byHotel;
}

export function shouldShowPipelineBadge(badge: CreatorBadge | null): boolean {
  return badge?.pipeline.kind === "status" || badge?.pipeline.kind === "several";
}

export function pipelineBadgeLabel(badge: CreatorBadge | null): string | null {
  if (!badge) return null;
  if (badge.pipeline.kind === "status") return badge.pipeline.label;
  if (badge.pipeline.kind === "several") {
    return `${badge.pipeline.count} opportunities`;
  }
  return null;
}

export function shouldShowTripBadge(badge: CreatorBadge | null): boolean {
  return (badge?.tripIds.length ?? 0) > 0;
}
