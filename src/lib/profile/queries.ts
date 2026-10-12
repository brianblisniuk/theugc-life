/**
 * Private profile reads (D08).
 *
 * The cookie-bound client is the caller, so RLS applies. Counts and past
 * collaborations come from security-invoker functions that do not accept a
 * user id. A failed read is not an empty profile and not a zero.
 */
import "server-only";

import { createClient } from "@/lib/supabase/server";
import { isUuid } from "@/lib/hotels/ids";

import { mapPastCollaborations, mapPersonalCounts } from "./contract";
import type { CreatorProfileFields, PastCollaborationsLoad, PersonalCountsLoad } from "./contract";

const PROFILE_COLUMNS =
  "display_name, username, bio, home_city, home_country, profile_photo_url, primary_language, languages, creator_niches, content_formats, instagram_url, instagram_handle, tiktok_url, tiktok_handle, youtube_url, website_url";

export type { CreatorProfileFields } from "./contract";

export type ProfileLoad =
  { status: "ok"; profile: CreatorProfileFields } | { status: "missing" } | { status: "error" };

function asText(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function asList(value: unknown): string {
  if (!Array.isArray(value)) return "";
  return value.filter((item): item is string => typeof item === "string").join(", ");
}

export async function getOwnProfile(userId: string): Promise<ProfileLoad> {
  if (!isUuid(userId)) return { status: "error" };
  try {
    const supabase = await createClient();
    const { data, error } = await supabase
      .from("creator_profiles")
      .select(PROFILE_COLUMNS)
      .eq("user_id", userId)
      .maybeSingle();
    if (error) return { status: "error" };
    if (!data) return { status: "missing" };
    const row = data as Record<string, unknown>;
    return {
      status: "ok",
      profile: {
        displayName: asText(row.display_name),
        username: asText(row.username),
        bio: asText(row.bio),
        homeCity: asText(row.home_city),
        homeCountry: asText(row.home_country),
        profilePhotoUrl: asText(row.profile_photo_url),
        primaryLanguage: asText(row.primary_language),
        languages: asList(row.languages),
        creatorNiches: asList(row.creator_niches),
        contentFormats: asList(row.content_formats),
        instagramUrl: asText(row.instagram_url),
        instagramHandle: asText(row.instagram_handle),
        tiktokUrl: asText(row.tiktok_url),
        tiktokHandle: asText(row.tiktok_handle),
        youtubeUrl: asText(row.youtube_url),
        websiteUrl: asText(row.website_url),
      },
    };
  } catch {
    return { status: "error" };
  }
}

export async function getPersonalCounts(): Promise<PersonalCountsLoad> {
  try {
    const supabase = await createClient();
    const { data, error } = await supabase.rpc("creator_personal_counts");
    if (error) return { status: "error" };
    return mapPersonalCounts(data);
  } catch {
    return { status: "error" };
  }
}

export async function getPastCollaborations(
  hotelId: string | null,
): Promise<PastCollaborationsLoad> {
  if (hotelId !== null && !isUuid(hotelId)) return { status: "error" };
  try {
    const supabase = await createClient();
    const { data, error } = await supabase.rpc("creator_past_collaborations", {
      p_hotel_id: hotelId,
    });
    if (error) return { status: "error" };
    return mapPastCollaborations(data);
  } catch {
    return { status: "error" };
  }
}
