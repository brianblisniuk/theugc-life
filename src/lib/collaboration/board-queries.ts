/**
 * Owner read of collaborations, deliverables, and agreed compensation.
 * The cookie-bound client is the boundary. A failed child read is not zero.
 */
import "server-only";

import { isUuid } from "@/lib/hotels/ids";
import { resolveOwnProfile } from "@/lib/onboarding/first-run";
import { createClient } from "@/lib/supabase/server";

import {
  BOARD_READ_LIMIT,
  assembleCollaborationBoard,
  mapOutreachActivity,
  type CollaborationBoard,
} from "./board";

const COLLABORATION_COLUMNS =
  "id, creator_id, hotel_id, pipeline_item_id, status, collaboration_type, start_date, end_date, hotel:hotels(id, name)";

const DELIVERABLE_COLUMNS =
  "id, creator_id, collaboration_id, pipeline_item_id, deliverable_type, quantity, platform, due_on, status, proof_url, notes";

const COMPENSATION_COLUMNS =
  "creator_id, collaboration_id, structure, cash_amount_minor, cash_currency, in_kind_description, in_kind_estimate_minor, in_kind_estimate_currency, payment_status";

export async function loadCollaborationBoard(authUserId: string): Promise<CollaborationBoard> {
  if (!isUuid(authUserId)) {
    return assembleCollaborationBoard({
      viewerId: null,
      failed: true,
      total: null,
      collaborations: [],
      deliverables: [],
      compensations: [],
      pipelineItems: [],
      childFailed: true,
    });
  }
  try {
    const supabase = await createClient();
    const profileResult = await supabase
      .from("creator_profiles")
      .select("id, user_id, display_name")
      .eq("user_id", authUserId)
      .maybeSingle();
    const profile = resolveOwnProfile(profileResult.data, profileResult.error !== null, authUserId);
    if (profile.status !== "ok") {
      return assembleCollaborationBoard({
        viewerId: null,
        failed: false,
        total: 0,
        collaborations: [],
        deliverables: [],
        compensations: [],
        pipelineItems: [],
        childFailed: true,
      });
    }
    const counted = await supabase
      .from("collaborations")
      .select("id", { count: "exact", head: true })
      .eq("creator_id", profile.profileId);
    const listed = await supabase
      .from("collaborations")
      .select(COLLABORATION_COLUMNS)
      .eq("creator_id", profile.profileId)
      .order("created_at", { ascending: false })
      .limit(BOARD_READ_LIMIT);
    const deliverables = await supabase
      .from("collaboration_deliverables")
      .select(DELIVERABLE_COLUMNS)
      .eq("creator_id", profile.profileId)
      .order("created_at", { ascending: false })
      .limit(BOARD_READ_LIMIT);
    const compensations = await supabase
      .from("collaboration_agreed_compensations")
      .select(COMPENSATION_COLUMNS)
      .eq("creator_id", profile.profileId)
      .order("created_at", { ascending: false })
      .limit(BOARD_READ_LIMIT);
    const failed =
      counted.error !== null ||
      typeof counted.count !== "number" ||
      listed.error !== null ||
      !Array.isArray(listed.data);
    const childFailed =
      deliverables.error !== null ||
      !Array.isArray(deliverables.data) ||
      compensations.error !== null ||
      !Array.isArray(compensations.data);
    const pipelineIds = failed
      ? []
      : [
          ...new Set(
            (listed.data as { pipeline_item_id?: unknown }[])
              .map((row) => row.pipeline_item_id)
              .filter((id): id is string => typeof id === "string" && isUuid(id)),
          ),
        ];
    const pipeline =
      pipelineIds.length === 0
        ? { data: [], error: null }
        : await supabase
            .from("pipeline_items")
            .select("id, creator_id, display_ref")
            .eq("creator_id", profile.profileId)
            .in("id", pipelineIds);
    const board = assembleCollaborationBoard({
      viewerId: profile.profileId,
      failed,
      total: typeof counted.count === "number" ? counted.count : null,
      collaborations: Array.isArray(listed.data) ? listed.data : [],
      deliverables: Array.isArray(deliverables.data) ? deliverables.data : [],
      compensations: Array.isArray(compensations.data) ? compensations.data : [],
      pipelineItems: Array.isArray(pipeline.data) ? pipeline.data : [],
      childFailed: childFailed || pipeline.error !== null || !Array.isArray(pipeline.data),
    });
    if (board.kind !== "items") return board;
    const pipelineItemIds = [
      ...new Set(
        board.cards
          .map((card) => card.pipelineItemId)
          .filter((id): id is string => typeof id === "string"),
      ),
    ];
    if (pipelineItemIds.length === 0) {
      return { ...board, timeline: { kind: "ok", events: [], capped: false } };
    }
    const events = await supabase
      .from("outreach_events")
      .select("creator_id, pipeline_item_id, event_type, event_at")
      .eq("creator_id", profile.profileId)
      .in("pipeline_item_id", pipelineItemIds)
      .order("event_at", { ascending: false })
      .limit(BOARD_READ_LIMIT);
    if (events.error !== null || !Array.isArray(events.data)) {
      return { ...board, timeline: { kind: "error" } };
    }
    const timeline = mapOutreachActivity(events.data, profile.profileId);
    if (timeline.kind === "error") return { ...board, timeline };
    return {
      ...board,
      timeline: { ...timeline, capped: events.data.length >= BOARD_READ_LIMIT },
    };
  } catch {
    return assembleCollaborationBoard({
      viewerId: null,
      failed: true,
      total: null,
      collaborations: [],
      deliverables: [],
      compensations: [],
      pipelineItems: [],
      childFailed: true,
    });
  }
}
