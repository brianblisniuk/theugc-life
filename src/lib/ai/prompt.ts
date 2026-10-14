/**
 * Outreach prompt (D142, D144).
 *
 * The object has no email field. A value that contains @ is dropped, except
 * an https portfolio URL. Selected mail is the only place a third-party
 * message can appear, and only when the caller already filtered it.
 */

import { AI_LIMITS, contextCharsFor, type AssistantTier } from "./limits";
import type { PitchBrief } from "./structured";

export interface SelectedMail {
  id: string;
  text: string;
}

export interface OutreachFacts {
  language: string | null;
  brief?: PitchBrief | null;
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

/**
 * Fixed server prompt (D166). It does not interpolate creator text.
 * Language, tone, and key points travel in the user message.
 */
export const PITCH_SYSTEM_PROMPT = [
  "You draft one collaboration pitch from a travel creator to one hotel.",
  "Use only the facts in the user message. If a fact is missing, omit it.",
  "Do not invent stays, audience metrics, dates, brand relationships, deliverables, or hotel claims.",
  "The message must be a collaboration pitch to that hotel.",
  "When the user message says Priority: yes, include one concrete reason to collaborate, still using only the facts.",
  "Write in the language named in the user message.",
  "Return JSON only, with keys subject and body.",
  "No markdown.",
].join(" ");

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
  const system = PITCH_SYSTEM_PROMPT;
  const budget = contextCharsFor(tier);
  const mail = facts.selectedMail
    .slice(0, AI_LIMITS.selectedMailMax)
    .map((item) => item.text.replace(/\s+/g, " ").trim().slice(0, AI_LIMITS.selectedMailChars))
    .filter((text) => text.length > 0);

  const brief = facts.brief;
  const hotelLine = `Hotel: ${clean(facts.hotelName, 200) ?? "the hotel"}`;
  const parts = [
    hotelLine,
    `Language: ${brief?.language ?? "English"}`,
    `Tone: ${brief?.tone ?? "professional"}`,
    tier === "max" ? "Priority: yes" : "Priority: no",
    brief && brief.keyPoints.length > 0 ? `Key points: ${brief.keyPoints.join("; ")}` : null,
    ...linesFor(facts, tier).filter((line) => !line.startsWith("Hotel:")),
  ].filter((part): part is string => typeof part === "string" && part.length > 0);
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
    user = hotelLine.slice(0, budget);
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
