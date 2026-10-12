/**
 * D09 hotel share link (D089–D091, Accepted).
 *
 * The public payload may contain only the allow-listed fields. A missing
 * audience figure or compensation amount stays unknown. It is never rendered
 * as zero. Audience is self-reported and is not a verification.
 */
import { formatMinor } from "@/lib/collaboration/display";

export const SHARE_FIELD_KEYS = [
  "bio",
  "niche",
  "social_links",
  "audience",
  "past_collaborations",
  "content_examples",
  "compensation",
] as const;

export type ShareFieldKey = (typeof SHARE_FIELD_KEYS)[number];

export const SHARE_FIELD_LABELS: Record<ShareFieldKey, string> = {
  bio: "Bio",
  niche: "Niche",
  social_links: "Social links",
  audience: "Audience metrics",
  past_collaborations: "Past collaborations",
  content_examples: "Examples of delivered content",
  compensation: "Rates or compensation type",
};

const HTTPS_URL = /^https:\/\/[A-Za-z0-9.-]+(?::[0-9]{1,5})?(?:\/[^\s]*)?$/;
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
const FOLLOWERS = /^(0|[1-9][0-9]*)$/;

const BANNED_KEYS = new Set([
  "email",
  "user_id",
  "creator_id",
  "token",
  "token_hash",
  "private_notes",
  "notes",
  "hotel_id",
  "pipeline_item_id",
  "payment_status",
  "would_work_again",
  "terms_matched",
  "mail_account_id",
  "provider_thread_id",
  "phone",
  "quantity",
  "private_value_amount",
  "private_value_currency",
]);

const SOCIAL_KEYS = [
  "instagram_url",
  "instagram_handle",
  "tiktok_url",
  "tiktok_handle",
  "youtube_url",
  "website_url",
] as const;

const COMPENSATION_STRUCTURES = new Set([
  "paid",
  "in_kind",
  "hybrid",
  "unpaid",
  "other",
  "unknown",
]);

export interface PublicSocialLink {
  label: string;
  href: string | null;
  text: string;
}

export interface PublicCollaboration {
  hotelName: string;
  status: string;
  typeLabel: string;
  when: string;
  compensation: string | null;
}

export interface PublicContentExample {
  label: string;
  platform: string;
  href: string;
}

export interface PublicShareView {
  bio?: string;
  niche?: string;
  socialLinks?: PublicSocialLink[];
  audience?: { followers: string; engagement: string };
  collaborations?: PublicCollaboration[];
  examples?: PublicContentExample[];
}

export type PublicShareLoad =
  { status: "ok"; view: PublicShareView } | { status: "not_found" } | { status: "error" };

export type ShareExpiryParse =
  { ok: true; expiresAt: string | null } | { ok: false; message: string };

export function parseShareExpiry(value: unknown, now = Date.now()): ShareExpiryParse {
  const raw = typeof value === "string" ? value.trim() : "";
  if (!raw) return { ok: true, expiresAt: null };
  if (!DATE_ONLY.test(raw)) return { ok: false, message: "Use a date, or leave expiry blank." };
  const [year, month, day] = raw.split("-").map(Number) as [number, number, number];
  const expires = new Date(Date.UTC(year, month - 1, day, 23, 59, 59, 999));
  if (
    expires.getUTCFullYear() !== year ||
    expires.getUTCMonth() !== month - 1 ||
    expires.getUTCDate() !== day
  ) {
    return { ok: false, message: "Use a real date, or leave expiry blank." };
  }
  if (expires.getTime() <= now) {
    return { ok: false, message: "Expiry must be a future date." };
  }
  return { ok: true, expiresAt: expires.toISOString() };
}

export function parseFollowerCount(
  value: unknown,
): { ok: true; value: number | null } | { ok: false } {
  const raw = typeof value === "string" ? value.trim() : "";
  if (!raw) return { ok: true, value: null };
  if (!FOLLOWERS.test(raw)) return { ok: false };
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed < 0) return { ok: false };
  return { ok: true, value: parsed };
}

export function parseEngagement(
  value: unknown,
): { ok: true; value: string | null } | { ok: false } {
  const raw = typeof value === "string" ? value.trim() : "";
  if (!raw) return { ok: true, value: null };
  if (raw.length > 40 || /[\u0000-\u001f]/.test(raw)) return { ok: false };
  return { ok: true, value: raw };
}

/** Null is unknown. A recorded zero stays zero. */
export function formatSelfReportedFollowers(value: number | null): string {
  if (value === null) return "Unknown";
  return String(value);
}

export function formatSelfReportedEngagement(value: string | null): string {
  if (value === null || value.trim() === "") return "Unknown";
  return value;
}

function banned(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  if (Array.isArray(value)) return value.some((item) => banned(item));
  return Object.entries(value).some(([key, child]) => BANNED_KEYS.has(key) || banned(child));
}

function httpsOrNull(value: unknown): string | null | "bad" {
  if (value === null) return null;
  if (typeof value !== "string" || !HTTPS_URL.test(value)) return "bad";
  return value;
}

function textOrNull(value: unknown): string | null | "bad" {
  if (value === null) return null;
  if (typeof value !== "string") return "bad";
  const trimmed = value.trim();
  if (!trimmed) return null;
  return trimmed;
}

function dateOrNull(value: unknown): string | null | "bad" {
  if (value === null) return null;
  if (typeof value !== "string" || !DATE_ONLY.test(value)) return "bad";
  return value;
}

const STATUS_LABELS: Record<string, string> = {
  completed: "Completed",
  cancelled: "Cancelled",
};

const TYPE_LABELS: Record<string, string> = {
  stay: "Stay",
  product: "Product",
  paid: "Paid",
  stay_plus_paid: "Stay plus paid",
  other: "Other",
};

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

function compensationLabel(value: unknown): string | null | "bad" {
  if (!value || typeof value !== "object" || Array.isArray(value)) return "bad";
  const row = value as Record<string, unknown>;
  if (banned(row)) return "bad";
  if (typeof row.structure !== "string" || !COMPENSATION_STRUCTURES.has(row.structure))
    return "bad";
  const amount = row.cash_amount_minor;
  const currency = row.cash_currency;
  if (
    amount !== undefined &&
    (typeof amount !== "number" || !Number.isInteger(amount) || amount < 0)
  ) {
    return "bad";
  }
  if (currency !== undefined && typeof currency !== "string") return "bad";
  const inKind = row.in_kind_description;
  if (inKind !== undefined && typeof inKind !== "string") return "bad";

  if (row.structure === "unknown") return "Unknown";
  if (row.structure === "unpaid") return "Unpaid";
  if (row.structure === "other") return "Other";

  const cash =
    amount === undefined
      ? null
      : formatMinor(amount, typeof currency === "string" ? currency : null);
  const kind = typeof inKind === "string" && inKind.trim() ? inKind.trim() : null;

  if (row.structure === "paid") return cash ?? "Unknown";
  if (row.structure === "in_kind") return kind ?? "Unknown";
  if (row.structure === "hybrid") {
    if (!cash && !kind) return "Unknown";
    if (cash && kind) return `${cash} plus ${kind}`;
    return cash ?? kind ?? "Unknown";
  }
  return "Unknown";
}

function socialLinks(value: unknown): PublicSocialLink[] | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  if (Object.keys(row).sort().join() !== [...SOCIAL_KEYS].sort().join()) return null;
  const links: PublicSocialLink[] = [];
  const pairs: {
    label: string;
    urlKey: (typeof SOCIAL_KEYS)[number];
    handleKey?: (typeof SOCIAL_KEYS)[number];
  }[] = [
    { label: "Instagram", urlKey: "instagram_url", handleKey: "instagram_handle" },
    { label: "TikTok", urlKey: "tiktok_url", handleKey: "tiktok_handle" },
    { label: "YouTube", urlKey: "youtube_url" },
    { label: "Website", urlKey: "website_url" },
  ];
  for (const pair of pairs) {
    const href = httpsOrNull(row[pair.urlKey]);
    if (href === "bad") return null;
    const handle = pair.handleKey ? textOrNull(row[pair.handleKey]) : null;
    if (handle === "bad") return null;
    const text = handle ?? href ?? "Unknown";
    links.push({ label: pair.label, href, text });
  }
  return links;
}

export function mapPublicShare(payload: unknown): PublicShareLoad {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return { status: "error" };
  const row = payload as Record<string, unknown>;
  if (banned(row)) return { status: "error" };
  if (row.result === "not_found") {
    if (Object.keys(row).length !== 1) return { status: "error" };
    return { status: "not_found" };
  }
  if (
    row.result !== "ok" ||
    !row.profile ||
    typeof row.profile !== "object" ||
    Array.isArray(row.profile)
  ) {
    return { status: "error" };
  }
  const profile = row.profile as Record<string, unknown>;
  const allowed = new Set<string>(SHARE_FIELD_KEYS);
  if (Object.keys(profile).some((key) => !allowed.has(key))) return { status: "error" };

  const view: PublicShareView = {};

  if ("bio" in profile) {
    if (profile.bio !== null && typeof profile.bio !== "string") return { status: "error" };
    view.bio =
      typeof profile.bio === "string" && profile.bio.trim() ? profile.bio.trim() : "Unknown";
  }

  if ("niche" in profile) {
    if (!Array.isArray(profile.niche) || profile.niche.some((item) => typeof item !== "string")) {
      return { status: "error" };
    }
    const niches = profile.niche.map((item) => item.trim()).filter((item) => item.length > 0);
    view.niche = niches.length > 0 ? niches.join(", ") : "None listed";
  }

  if ("social_links" in profile) {
    const links = socialLinks(profile.social_links);
    if (!links) return { status: "error" };
    view.socialLinks = links;
  }

  if ("audience" in profile) {
    if (
      !profile.audience ||
      typeof profile.audience !== "object" ||
      Array.isArray(profile.audience)
    ) {
      return { status: "error" };
    }
    const audience = profile.audience as Record<string, unknown>;
    if (audience.attribution !== "self_reported") return { status: "error" };
    if (!("followers" in audience) || !("engagement" in audience)) return { status: "error" };
    const followers = audience.followers;
    if (
      followers !== null &&
      (typeof followers !== "number" || !Number.isSafeInteger(followers) || followers < 0)
    ) {
      return { status: "error" };
    }
    const engagement = audience.engagement;
    if (engagement !== null && typeof engagement !== "string") return { status: "error" };
    view.audience = {
      followers: formatSelfReportedFollowers(followers),
      engagement: formatSelfReportedEngagement(engagement),
    };
  }

  if ("past_collaborations" in profile) {
    if (!Array.isArray(profile.past_collaborations)) return { status: "error" };
    const collaborations: PublicCollaboration[] = [];
    for (const raw of profile.past_collaborations) {
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { status: "error" };
      const item = raw as Record<string, unknown>;
      if (typeof item.hotel_name !== "string" || !item.hotel_name.trim())
        return { status: "error" };
      if (item.status !== "completed" && item.status !== "cancelled") return { status: "error" };
      const type =
        item.collaboration_type === null
          ? "Unknown"
          : typeof item.collaboration_type === "string"
            ? TYPE_LABELS[item.collaboration_type]
            : undefined;
      if (!type) return { status: "error" };
      const start = dateOrNull(item.start_date);
      const end = dateOrNull(item.end_date);
      if (start === "bad" || end === "bad") return { status: "error" };
      const when = start && end ? `${start} – ${end}` : start || end || "Unknown";
      let compensation: string | null = null;
      if ("compensation" in item) {
        const label = compensationLabel(item.compensation);
        if (label === "bad" || label === null) return { status: "error" };
        compensation = label;
      }
      collaborations.push({
        hotelName: item.hotel_name.trim(),
        status: STATUS_LABELS[item.status]!,
        typeLabel: type,
        when,
        compensation,
      });
    }
    view.collaborations = collaborations;
  }

  if ("content_examples" in profile) {
    if (!Array.isArray(profile.content_examples)) return { status: "error" };
    const examples: PublicContentExample[] = [];
    for (const raw of profile.content_examples) {
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { status: "error" };
      const item = raw as Record<string, unknown>;
      if (typeof item.deliverable_type !== "string") return { status: "error" };
      const label = DELIVERABLE_LABELS[item.deliverable_type];
      if (!label) return { status: "error" };
      const href = httpsOrNull(item.proof_url);
      if (href === "bad" || href === null) return { status: "error" };
      const platform = item.platform === null ? "Unknown" : textOrNull(item.platform);
      if (platform === "bad" || platform === null) return { status: "error" };
      examples.push({ label, platform, href });
    }
    view.examples = examples;
  }

  return { status: "ok", view };
}

export interface OwnShareLink {
  createdAt: string;
  expiresAt: string | null;
  revokedAt: string | null;
  usable: boolean;
}

export function emptyOptIns(): Record<ShareFieldKey, boolean> {
  return {
    bio: false,
    niche: false,
    social_links: false,
    audience: false,
    past_collaborations: false,
    content_examples: false,
    compensation: false,
  };
}

export function optInsFromForm(formData: {
  get(name: string): unknown;
}): Record<ShareFieldKey, boolean> {
  const opted = emptyOptIns();
  for (const key of SHARE_FIELD_KEYS) {
    opted[key] = formData.get(`opt_${key}`) === "on";
  }
  return opted;
}
