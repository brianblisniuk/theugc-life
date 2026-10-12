"use server";

/**
 * Save the caller's private profile fields.
 *
 * The form does not post a user id. The session is resolved here, and the
 * update names that user. public_profile_enabled, portfolio_visibility,
 * and creator_profile_field_opt_ins are not in the write.
 */
import { revalidatePath } from "next/cache";

import { resolveSession } from "@/lib/auth/guards";
import { createClient } from "@/lib/supabase/server";

import { parseProfileForm } from "./contract";

export type ProfileSaveResult =
  | { result: "saved" }
  | { result: "invalid_input"; message: string }
  | { result: "username_taken" }
  | { result: "error" };

function readField(formData: FormData, name: string): string {
  const value = formData.get(name);
  return typeof value === "string" ? value : "";
}

export async function updateCreatorProfile(formData: FormData): Promise<ProfileSaveResult> {
  const resolution = await resolveSession();
  if (resolution.status !== "authenticated") return { result: "error" };

  const parsed = parseProfileForm({
    displayName: readField(formData, "displayName"),
    username: readField(formData, "username"),
    bio: readField(formData, "bio"),
    homeCity: readField(formData, "homeCity"),
    homeCountry: readField(formData, "homeCountry"),
    profilePhotoUrl: readField(formData, "profilePhotoUrl"),
    primaryLanguage: readField(formData, "primaryLanguage"),
    languages: readField(formData, "languages"),
    creatorNiches: readField(formData, "creatorNiches"),
    contentFormats: readField(formData, "contentFormats"),
    instagramUrl: readField(formData, "instagramUrl"),
    instagramHandle: readField(formData, "instagramHandle"),
    tiktokUrl: readField(formData, "tiktokUrl"),
    tiktokHandle: readField(formData, "tiktokHandle"),
    youtubeUrl: readField(formData, "youtubeUrl"),
    websiteUrl: readField(formData, "websiteUrl"),
  });
  if (!parsed.ok) return { result: "invalid_input", message: parsed.message };

  const value = parsed.value;
  try {
    const supabase = await createClient();
    const { error } = await supabase
      .from("creator_profiles")
      .update({
        display_name: value.displayName,
        username: value.username,
        bio: value.bio,
        home_city: value.homeCity,
        home_country: value.homeCountry,
        profile_photo_url: value.profilePhotoUrl,
        primary_language: value.primaryLanguage,
        languages: value.languages,
        creator_niches: value.creatorNiches,
        content_formats: value.contentFormats,
        instagram_url: value.instagramUrl,
        instagram_handle: value.instagramHandle,
        tiktok_url: value.tiktokUrl,
        tiktok_handle: value.tiktokHandle,
        youtube_url: value.youtubeUrl,
        website_url: value.websiteUrl,
      })
      .eq("user_id", resolution.session.userId);

    if (error) {
      if (error.code === "23505") return { result: "username_taken" };
      return { result: "error" };
    }
  } catch {
    return { result: "error" };
  }

  revalidatePath("/app/profile");
  return { result: "saved" };
}
