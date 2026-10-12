/**
 * Owner reads for the hotel share link. The cookie client is the caller.
 * A failed read is not an empty opt-in list and not a missing link.
 */
import "server-only";

import { createClient } from "@/lib/supabase/server";

import { emptyOptIns, type OwnShareLink, type ShareFieldKey } from "./share-contract";

export type { OwnShareLink };

export interface ShareDeliverable {
  id: string;
  label: string;
  platform: string | null;
  proofUrl: string | null;
}

export type ShareSettingsLoad =
  | {
      status: "ok";
      optIns: Record<ShareFieldKey, boolean>;
      link: OwnShareLink | null;
      sharedCollaborationIds: string[];
      sharedDeliverableIds: string[];
      deliverables: ShareDeliverable[];
      followers: string;
      engagement: string;
    }
  | { status: "error" };

const DELIVERABLE_LABELS: Record<string, string> = {
  reel: "Reel",
  story: "Story",
  post: "Post",
  tiktok: "TikTok",
  youtube: "YouTube",
  photo_set: "Photo set",
  ugc_video: "UGC video",
  other: "Other",
};

function asText(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

export async function getShareSettings(): Promise<ShareSettingsLoad> {
  try {
    const supabase = await createClient();
    const [optIns, link, collaborationMarks, deliverableMarks, deliverables, audience] =
      await Promise.all([
        supabase.from("creator_profile_field_opt_ins").select("field_key, opted_in, revoked_at"),
        supabase.rpc("read_own_creator_share_link"),
        supabase.from("creator_collaboration_share_marks").select("collaboration_id"),
        supabase.from("creator_deliverable_share_marks").select("deliverable_id"),
        supabase
          .from("collaboration_deliverables")
          .select("id, deliverable_type, platform, proof_url")
          .order("created_at", { ascending: false }),
        supabase
          .from("creator_self_reported_audience")
          .select("follower_count, engagement")
          .maybeSingle(),
      ]);

    if (
      optIns.error ||
      link.error ||
      collaborationMarks.error ||
      deliverableMarks.error ||
      deliverables.error ||
      audience.error
    ) {
      return { status: "error" };
    }

    const flags = emptyOptIns();
    for (const row of optIns.data ?? []) {
      const key = row.field_key as ShareFieldKey;
      if (!(key in flags)) continue;
      flags[key] = row.opted_in === true && row.revoked_at == null;
    }

    const linkRow = link.data as {
      result?: string;
      created_at?: string;
      expires_at?: string | null;
      revoked_at?: string | null;
      usable?: boolean;
    } | null;
    let ownLink: OwnShareLink | null = null;
    if (linkRow?.result === "ok") {
      if (typeof linkRow.created_at !== "string" || typeof linkRow.usable !== "boolean") {
        return { status: "error" };
      }
      ownLink = {
        createdAt: linkRow.created_at,
        expiresAt: asText(linkRow.expires_at),
        revokedAt: asText(linkRow.revoked_at),
        usable: linkRow.usable,
      };
    } else if (linkRow?.result !== "none") {
      return { status: "error" };
    }

    const examples: ShareDeliverable[] = [];
    for (const row of deliverables.data ?? []) {
      const label = DELIVERABLE_LABELS[row.deliverable_type as string];
      if (!label || typeof row.id !== "string") return { status: "error" };
      examples.push({
        id: row.id,
        label,
        platform: asText(row.platform),
        proofUrl: asText(row.proof_url),
      });
    }

    const followers = audience.data?.follower_count;
    return {
      status: "ok",
      optIns: flags,
      link: ownLink,
      sharedCollaborationIds: (collaborationMarks.data ?? [])
        .map((row) => row.collaboration_id)
        .filter((id): id is string => typeof id === "string"),
      sharedDeliverableIds: (deliverableMarks.data ?? [])
        .map((row) => row.deliverable_id)
        .filter((id): id is string => typeof id === "string"),
      deliverables: examples,
      followers: typeof followers === "number" ? String(followers) : "",
      engagement: asText(audience.data?.engagement) ?? "",
    };
  } catch {
    return { status: "error" };
  }
}
