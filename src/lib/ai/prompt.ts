/**
 * Outreach prompt (D142, D144).
 *
 * The object has no email field. A value that contains @ is dropped, except
 * an https portfolio URL. Selected mail is the only place a third-party
 * message can appear, and only when the caller already filtered it.
 */

import { AI_LIMITS, contextCharsFor, type AssistantTier } from "./limits";

export interface SelectedMail {
  id: string;
  text: string;
}

export interface OutreachFacts {
  language: string | null;
  creatorName: string | null;
  niche: string | null;
  instagramHandle: string | null;
  hotelName: string;
  destinationName: string | null;
  tripName: string | null;
  tripStart: string | null;
  tripEnd: string | null;
  portfolioTitle: string | null;
  portfolioUrl: string | null;
  contactName: string | null;
  intelligenceNote: string | null;
  pastCollaboration: string | null;
  pipelineStatus: string | null;
  selectedMail: readonly SelectedMail[];
}

export interface BuiltPrompt {
  system: string;
  user: string;
  tier: AssistantTier;
}

const PIPELINE = new Set([
  "saved",
  "pitched",
  "follow_up",
  "replied",
  "negotiating",
  "won",
  "lost",
  "closed",
]);

function clean(value: string | null | undefined, max: number): string | null {
  if (typeof value !== "string") return null;
  const text = value
    .replace(/[\u0000\r\n]/g, " ")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
  if (!text || text.includes("@")) return null;
  return text.length <= max ? text : text.slice(0, max).trim();
}

function httpsUrl(value: string | null | undefined): string | null {
  const url = clean(value, 300);
  if (!url || !url.startsWith("https://")) return null;
  return url;
}

/**
 * Keep a body only when this caller selected it and owns it.
 * Anything else is dropped before a prompt exists.
 */
export function onlyOwnedSelected(
  candidates: readonly {
    id: string;
    text: string;
    selected: boolean;
    ownerId: string;
  }[],
  callerId: string,
): SelectedMail[] {
  const kept: SelectedMail[] = [];
  for (const candidate of candidates) {
    if (!candidate.selected || candidate.ownerId !== callerId) continue;
    const text = candidate.text.replace(/\u0000/g, "").trim();
    if (!text) continue;
    kept.push({
      id: candidate.id,
      text: text.slice(0, AI_LIMITS.selectedMailChars),
    });
    if (kept.length >= AI_LIMITS.selectedMailMax) break;
  }
  return kept;
}

function languageName(value: string | null): string {
  const language = clean(value, 40);
  return language ?? "English";
}

function linesFor(facts: OutreachFacts, tier: AssistantTier): string[] {
  const hotel = clean(facts.hotelName, 200) ?? "the hotel";
  const lines = [
    `Hotel: ${hotel}`,
    facts.destinationName ? `Destination: ${clean(facts.destinationName, 120)}` : null,
    facts.creatorName ? `Creator: ${clean(facts.creatorName, 120)}` : null,
    facts.niche ? `Niche: ${clean(facts.niche, 80)}` : null,
    facts.instagramHandle ? `Instagram: ${clean(facts.instagramHandle, 40)}` : null,
    facts.contactName ? `Contact name: ${clean(facts.contactName, 120)}` : null,
    facts.tripName ? `Trip: ${clean(facts.tripName, 120)}` : null,
    facts.tripStart && facts.tripEnd
      ? `Dates: ${clean(facts.tripStart, 20)} to ${clean(facts.tripEnd, 20)}`
      : null,
    facts.pipelineStatus && PIPELINE.has(facts.pipelineStatus)
      ? `Pipeline status: ${facts.pipelineStatus}`
      : null,
    facts.pastCollaboration ? `History: ${clean(facts.pastCollaboration, 240)}` : null,
    facts.portfolioTitle ? `Portfolio: ${clean(facts.portfolioTitle, 200)}` : null,
    facts.portfolioUrl ? `Portfolio URL: ${httpsUrl(facts.portfolioUrl)}` : null,
  ];
  if (tier === "max" && facts.intelligenceNote) {
    lines.push(`Public activity: ${clean(facts.intelligenceNote, 300)}`);
  } else if (facts.intelligenceNote) {
    lines.push(`Public activity: ${clean(facts.intelligenceNote, 120)}`);
  }
  return lines.filter(
    (line): line is string => typeof line === "string" && !line.endsWith(": null"),
  );
}

export function buildOutreachPrompt(facts: OutreachFacts, tier: AssistantTier): BuiltPrompt {
  const language = languageName(facts.language);
  const richer =
    tier === "max"
      ? " Write one concrete reason to collaborate, still using only the facts below."
      : "";
  const system = [
    "You draft one outreach email from a travel creator to a hotel.",
    "Use only the facts in the user message. If a fact is missing, omit it.",
    "Do not invent stays, audience metrics, dates, brand relationships, deliverables, or hotel claims.",
    `Write in ${language}.`,
    "Return JSON only, with keys subject and body.",
    "No markdown.",
    richer.trim(),
  ]
    .filter((part) => part.length > 0)
    .join(" ");

  const budget = contextCharsFor(tier);
  const mail = facts.selectedMail
    .slice(0, AI_LIMITS.selectedMailMax)
    .map((item) => item.text.replace(/\s+/g, " ").trim().slice(0, AI_LIMITS.selectedMailChars))
    .filter((text) => text.length > 0);

  const parts = [...linesFor(facts, tier)];
  if (mail.length > 0) {
    parts.push(`Selected mail the creator chose to include: ${mail.join(" | ")}`);
  }

  let user = "";
  for (const part of parts) {
    const next = user.length === 0 ? part : `${user}\n${part}`;
    if (next.length > budget) {
      if (user.length === 0) user = part.slice(0, budget);
      break;
    }
    user = next;
  }
  if (!user.startsWith("Hotel:")) {
    const hotel = clean(facts.hotelName, 200) ?? "the hotel";
    user = `Hotel: ${hotel}`.slice(0, budget);
  }

  return { system, user, tier };
}

export function parseDraftText(raw: string): { subject: string; body: string } | null {
  const trimmed = raw
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "");
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const record = parsed as { subject?: unknown; body?: unknown };
  if (typeof record.subject !== "string" || typeof record.body !== "string") return null;
  const subject = record.subject.replace(/[\u0000\r\n]/g, " ").trim();
  const body = record.body
    .replace(/\u0000/g, "")
    .replace(/\r\n/g, "\n")
    .trim();
  if (subject.length < 1 || subject.length > 200) return null;
  if (body.length < 1 || body.length > 8000) return null;
  return { subject, body };
}
