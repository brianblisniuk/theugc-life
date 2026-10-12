/**
 * D08 private profile fields and personal counts (D086–D088, Proposed).
 *
 * The editor writes columns that already exist on creator_profiles. It does
 * not write public_profile_enabled, portfolio_visibility, or field opt-ins,
 * and it does not issue a hotel share link.
 *
 * Counts are integers the creator recorded. A missing read is not zero.
 * Nothing here is a rate.
 */
import { isUuid } from "@/lib/hotels/ids";
import { hotelHref } from "@/lib/shell/navigation";

const HTTPS_URL = /^https:\/\/[A-Za-z0-9.-]+(?::[0-9]{1,5})?(?:\/[^\s]*)?$/;
const USERNAME = /^[a-z0-9_]+$/i;
const HANDLE = /^[A-Za-z0-9._]{1,30}$/;

export const PROFILE_LIMITS = {
  displayName: 80,
  usernameMin: 3,
  usernameMax: 30,
  bio: 500,
  place: 80,
  language: 40,
  url: 500,
  token: 40,
  tokens: 12,
} as const;

export interface CreatorProfileFields {
  displayName: string;
  username: string;
  bio: string;
  homeCity: string;
  homeCountry: string;
  profilePhotoUrl: string;
  primaryLanguage: string;
  languages: string;
  creatorNiches: string;
  contentFormats: string;
  instagramUrl: string;
  instagramHandle: string;
  tiktokUrl: string;
  tiktokHandle: string;
  youtubeUrl: string;
  websiteUrl: string;
}

export interface ProfileWrite {
  displayName: string;
  username: string;
  bio: string | null;
  homeCity: string | null;
  homeCountry: string | null;
  profilePhotoUrl: string | null;
  primaryLanguage: string | null;
  languages: string[];
  creatorNiches: string[];
  contentFormats: string[];
  instagramUrl: string | null;
  instagramHandle: string | null;
  tiktokUrl: string | null;
  tiktokHandle: string | null;
  youtubeUrl: string | null;
  websiteUrl: string | null;
}

export type ProfileParse = { ok: true; value: ProfileWrite } | { ok: false; message: string };

export interface PersonalCounts {
  outreach: number;
  replies: number;
  agreements: number;
  completedCollaborations: number;
  deliverablesDone: number;
}

export type PersonalCountsLoad =
  { status: "ok"; counts: PersonalCounts } | { status: "not_found" } | { status: "error" };

export interface PastCollaborationView {
  id: string;
  hotelId: string;
  hotelName: string;
  href: string;
  statusLabel: string;
  typeLabel: string | null;
  when: string | null;
  againLabel: string;
  termsLabel: string | null;
}

export type PastCollaborationsLoad =
  { status: "ok"; items: PastCollaborationView[] } | { status: "not_found" } | { status: "error" };

const COUNT_KEYS = [
  "outreach",
  "replies",
  "agreements",
  "completed_collaborations",
  "deliverables_done",
] as const;

const FORBIDDEN_PAYLOAD_KEYS = [
  "rate",
  "reply_rate",
  "unpaid",
  "amount",
  "amount_minor",
  "cash_amount_minor",
  "private_value_amount",
  "ghosted",
  "declined",
  "decline",
  "private_notes",
] as const;

const PAST_STATUSES = {
  completed: "Completed",
  cancelled: "Cancelled",
} as const;

const TYPE_LABELS: Record<string, string> = {
  stay: "Stay",
  product: "Product",
  paid: "Paid",
  stay_plus_paid: "Stay plus paid",
  other: "Other",
};

const TERMS_LABELS: Record<string, string> = {
  yes: "Terms matched",
  partially: "Terms partly matched",
  no: "Terms did not match",
};

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

type TextField = { ok: false; message: string } | { ok: true; value: string | null };
type ListField = { ok: false; message: string } | { ok: true; value: string[] };

function optionalText(value: unknown, max: number, label: string): TextField {
  const raw = text(value);
  if (!raw) return { ok: true, value: null };
  if (raw.length > max)
    return { ok: false, message: `${label} must be ${max} characters or fewer.` };
  return { ok: true, value: raw };
}

function optionalUrl(value: unknown, label: string): TextField {
  const raw = text(value);
  if (!raw) return { ok: true, value: null };
  if (raw.length > PROFILE_LIMITS.url || !HTTPS_URL.test(raw)) {
    return { ok: false, message: `${label} must be an https link.` };
  }
  return { ok: true, value: raw };
}

function optionalHandle(value: unknown, label: string): TextField {
  let raw = text(value);
  if (!raw) return { ok: true, value: null };
  if (raw.startsWith("@")) raw = raw.slice(1);
  if (!HANDLE.test(raw)) {
    return { ok: false, message: `${label} can use letters, numbers, dots, and underscores.` };
  }
  return { ok: true, value: raw };
}

function tokenList(value: unknown, label: string): ListField {
  const raw = text(value);
  if (!raw) return { ok: true, value: [] };
  const parts = raw
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
  if (parts.length > PROFILE_LIMITS.tokens) {
    return { ok: false, message: `${label} can list at most ${PROFILE_LIMITS.tokens} entries.` };
  }
  const seen = new Set<string>();
  const out: string[] = [];
  for (const part of parts) {
    if (part.length > PROFILE_LIMITS.token) {
      return {
        ok: false,
        message: `Each ${label.toLowerCase()} entry must be ${PROFILE_LIMITS.token} characters or fewer.`,
      };
    }
    if (/[\u0000-\u001f]/.test(part)) {
      return { ok: false, message: `Remove line breaks from ${label.toLowerCase()}.` };
    }
    const key = part.toLocaleLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(part);
  }
  return { ok: true, value: out };
}

export function parseProfileForm(fields: Record<string, unknown>): ProfileParse {
  const displayName = text(fields.displayName);
  if (!displayName) return { ok: false, message: "Add a display name." };
  if (displayName.length > PROFILE_LIMITS.displayName) {
    return { ok: false, message: "Display name must be 80 characters or fewer." };
  }

  const username = text(fields.username);
  if (username.length < PROFILE_LIMITS.usernameMin) {
    return { ok: false, message: "Username must be at least 3 characters." };
  }
  if (username.length > PROFILE_LIMITS.usernameMax || !USERNAME.test(username)) {
    return { ok: false, message: "Use letters, numbers, or underscores only." };
  }

  const bio = optionalText(fields.bio, PROFILE_LIMITS.bio, "Bio");
  if (!bio.ok) return bio;
  const homeCity = optionalText(fields.homeCity, PROFILE_LIMITS.place, "Home city");
  if (!homeCity.ok) return homeCity;
  const homeCountry = optionalText(fields.homeCountry, PROFILE_LIMITS.place, "Home country");
  if (!homeCountry.ok) return homeCountry;
  const primaryLanguage = optionalText(
    fields.primaryLanguage,
    PROFILE_LIMITS.language,
    "Primary language",
  );
  if (!primaryLanguage.ok) return primaryLanguage;
  const profilePhotoUrl = optionalUrl(fields.profilePhotoUrl, "Profile photo");
  if (!profilePhotoUrl.ok) return profilePhotoUrl;
  const instagramUrl = optionalUrl(fields.instagramUrl, "Instagram");
  if (!instagramUrl.ok) return instagramUrl;
  const tiktokUrl = optionalUrl(fields.tiktokUrl, "TikTok");
  if (!tiktokUrl.ok) return tiktokUrl;
  const youtubeUrl = optionalUrl(fields.youtubeUrl, "YouTube");
  if (!youtubeUrl.ok) return youtubeUrl;
  const websiteUrl = optionalUrl(fields.websiteUrl, "Website");
  if (!websiteUrl.ok) return websiteUrl;
  const instagramHandle = optionalHandle(fields.instagramHandle, "Instagram handle");
  if (!instagramHandle.ok) return instagramHandle;
  const tiktokHandle = optionalHandle(fields.tiktokHandle, "TikTok handle");
  if (!tiktokHandle.ok) return tiktokHandle;
  const languages = tokenList(fields.languages, "Languages");
  if (!languages.ok) return languages;
  const creatorNiches = tokenList(fields.creatorNiches, "Niches");
  if (!creatorNiches.ok) return creatorNiches;
  const contentFormats = tokenList(fields.contentFormats, "Content formats");
  if (!contentFormats.ok) return contentFormats;

  return {
    ok: true,
    value: {
      displayName,
      username,
      bio: bio.value,
      homeCity: homeCity.value,
      homeCountry: homeCountry.value,
      profilePhotoUrl: profilePhotoUrl.value,
      primaryLanguage: primaryLanguage.value,
      languages: languages.value,
      creatorNiches: creatorNiches.value,
      contentFormats: contentFormats.value,
      instagramUrl: instagramUrl.value,
      instagramHandle: instagramHandle.value,
      tiktokUrl: tiktokUrl.value,
      tiktokHandle: tiktokHandle.value,
      youtubeUrl: youtubeUrl.value,
      websiteUrl: websiteUrl.value,
    },
  };
}

export const PERSONAL_COUNT_ROWS: readonly {
  key: keyof PersonalCounts;
  label: string;
}[] = [
  { key: "outreach", label: "Outreach" },
  { key: "replies", label: "Replies" },
  { key: "agreements", label: "Agreements" },
  { key: "completedCollaborations", label: "Completed collaborations" },
  { key: "deliverablesDone", label: "Deliverables approved" },
];

function readCount(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) return null;
  return value;
}

function forbidden(row: Record<string, unknown>): boolean {
  return FORBIDDEN_PAYLOAD_KEYS.some((key) => key in row);
}

export function mapPersonalCounts(payload: unknown): PersonalCountsLoad {
  if (!payload || typeof payload !== "object") return { status: "error" };
  const row = payload as Record<string, unknown>;
  if (forbidden(row)) return { status: "error" };
  if (row.result === "not_found") {
    for (const key of COUNT_KEYS) {
      if (row[key] !== null) return { status: "error" };
    }
    return { status: "not_found" };
  }
  if (row.result !== "ok") return { status: "error" };
  const outreach = readCount(row.outreach);
  const replies = readCount(row.replies);
  const agreements = readCount(row.agreements);
  const completedCollaborations = readCount(row.completed_collaborations);
  const deliverablesDone = readCount(row.deliverables_done);
  if (
    outreach === null ||
    replies === null ||
    agreements === null ||
    completedCollaborations === null ||
    deliverablesDone === null
  ) {
    return { status: "error" };
  }
  return {
    status: "ok",
    counts: { outreach, replies, agreements, completedCollaborations, deliverablesDone },
  };
}

/** Integers only. A zero is a recorded absence, shown as a count, never a rate. */
export function personalCountEntries(counts: PersonalCounts): { label: string; value: string }[] {
  return PERSONAL_COUNT_ROWS.map((row) => ({
    label: row.label,
    value: String(counts[row.key]),
  }));
}

function whenOf(start: unknown, end: unknown): string | null {
  const startOk = typeof start === "string" && /^\d{4}-\d{2}-\d{2}$/.test(start);
  const endOk = typeof end === "string" && /^\d{4}-\d{2}-\d{2}$/.test(end);
  if (startOk && endOk) return `${start} – ${end}`;
  if (startOk) return start;
  if (endOk) return end;
  return null;
}

export function mapPastCollaborations(payload: unknown): PastCollaborationsLoad {
  if (!payload || typeof payload !== "object") return { status: "error" };
  const row = payload as Record<string, unknown>;
  if (forbidden(row)) return { status: "error" };
  if (row.result === "not_found") {
    if (row.collaborations !== null) return { status: "error" };
    return { status: "not_found" };
  }
  if (row.result !== "ok" || !Array.isArray(row.collaborations)) return { status: "error" };

  const items: PastCollaborationView[] = [];
  for (const raw of row.collaborations) {
    if (!raw || typeof raw !== "object") return { status: "error" };
    const item = raw as Record<string, unknown>;
    if (forbidden(item)) return { status: "error" };
    if (typeof item.id !== "string" || !isUuid(item.id)) return { status: "error" };
    if (typeof item.hotel_id !== "string" || !isUuid(item.hotel_id)) return { status: "error" };
    if (typeof item.hotel_name !== "string" || !item.hotel_name.trim()) return { status: "error" };
    if (item.status !== "completed" && item.status !== "cancelled") return { status: "error" };
    const href = hotelHref(item.hotel_id, { kind: "pipeline" });
    if (!href) return { status: "error" };
    const typeLabel =
      item.collaboration_type === null
        ? null
        : typeof item.collaboration_type === "string"
          ? (TYPE_LABELS[item.collaboration_type] ?? null)
          : null;
    if (item.collaboration_type !== null && typeLabel === null) return { status: "error" };
    let againLabel = "Not recorded";
    if (item.would_work_again === true) againLabel = "Would work again";
    else if (item.would_work_again === false) againLabel = "Would not work again";
    else if (item.would_work_again !== null) return { status: "error" };
    const termsLabel =
      item.terms_matched === "unknown" || item.terms_matched === null
        ? null
        : typeof item.terms_matched === "string"
          ? (TERMS_LABELS[item.terms_matched] ?? null)
          : null;
    if (item.terms_matched !== null && item.terms_matched !== "unknown" && termsLabel === null) {
      return { status: "error" };
    }
    items.push({
      id: item.id,
      hotelId: item.hotel_id,
      hotelName: item.hotel_name.trim(),
      href,
      statusLabel: PAST_STATUSES[item.status],
      typeLabel,
      when: whenOf(item.start_date, item.end_date),
      againLabel,
      termsLabel,
    });
  }
  return { status: "ok", items };
}
