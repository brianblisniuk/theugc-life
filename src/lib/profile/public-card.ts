/**
 * D096–D097 public card. The page renders only this projection.
 *
 * A missing or private profile is null, not a zeroed card. Hotel names,
 * contacts, amounts, rates, and past collaborations are not fields.
 */
const TEXT_KEYS = [
  "display_name",
  "username",
  "bio",
  "home_city",
  "home_country",
  "profile_photo_url",
  "primary_language",
  "instagram_url",
  "instagram_handle",
  "tiktok_url",
  "tiktok_handle",
  "youtube_url",
  "website_url",
] as const;

const LIST_KEYS = ["languages", "creator_niches", "content_formats"] as const;

const COUNT_KEYS = [
  "outreach",
  "replies",
  "agreements",
  "completed_collaborations",
  "deliverables_done",
] as const;

export const PUBLIC_CARD_KEYS = [...TEXT_KEYS, ...LIST_KEYS, ...COUNT_KEYS] as const;

export type PublicCard = {
  displayName: string | null;
  username: string;
  bio: string | null;
  homeCity: string | null;
  homeCountry: string | null;
  profilePhotoUrl: string | null;
  primaryLanguage: string | null;
  languages: string[];
  niches: string[];
  contentFormats: string[];
  instagramUrl: string | null;
  instagramHandle: string | null;
  tiktokUrl: string | null;
  tiktokHandle: string | null;
  youtubeUrl: string | null;
  websiteUrl: string | null;
  counts: {
    outreach: number;
    replies: number;
    agreements: number;
    completedCollaborations: number;
    deliverablesDone: number;
  };
};

function text(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function list(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string" && item.trim().length > 0);
}

function count(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) return null;
  return value;
}

/**
 * Copy only the public fields. Any other key, including a hotel name or an
 * email, is dropped. A non-integer count rejects the whole card.
 */
export function projectPublicCard(raw: unknown): PublicCard | null {
  if (raw === null || raw === undefined) return null;
  if (typeof raw !== "object" || Array.isArray(raw)) return null;
  const row = raw as Record<string, unknown>;
  const username = text(row.username);
  if (!username) return null;
  const counts = {
    outreach: count(row.outreach),
    replies: count(row.replies),
    agreements: count(row.agreements),
    completedCollaborations: count(row.completed_collaborations),
    deliverablesDone: count(row.deliverables_done),
  };
  if (
    counts.outreach === null ||
    counts.replies === null ||
    counts.agreements === null ||
    counts.completedCollaborations === null ||
    counts.deliverablesDone === null
  ) {
    return null;
  }
  return {
    displayName: text(row.display_name),
    username,
    bio: text(row.bio),
    homeCity: text(row.home_city),
    homeCountry: text(row.home_country),
    profilePhotoUrl: text(row.profile_photo_url),
    primaryLanguage: text(row.primary_language),
    languages: list(row.languages),
    niches: list(row.creator_niches),
    contentFormats: list(row.content_formats),
    instagramUrl: text(row.instagram_url),
    instagramHandle: text(row.instagram_handle),
    tiktokUrl: text(row.tiktok_url),
    tiktokHandle: text(row.tiktok_handle),
    youtubeUrl: text(row.youtube_url),
    websiteUrl: text(row.website_url),
    counts: {
      outreach: counts.outreach,
      replies: counts.replies,
      agreements: counts.agreements,
      completedCollaborations: counts.completedCollaborations,
      deliverablesDone: counts.deliverablesDone,
    },
  };
}
