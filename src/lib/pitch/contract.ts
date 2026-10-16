/**
 * Pitch template contract (canon v1.1 F02, D110).
 *
 * A draft is text the creator can copy or open in their own mail client.
 * Filling a template is variable substitution. A missing fact is omitted.
 * Nothing here records a sent pitch, and nothing here calls a model.
 */

export const FACT_KEYS = [
  "creator_name",
  "niche",
  "instagram_handle",
  "hotel_name",
  "destination_name",
  "trip_name",
  "trip_start",
  "trip_end",
  "portfolio_title",
  "portfolio_url",
  "contact_name",
  "intelligence_note",
  "past_collaboration",
] as const;

export type FactKey = (typeof FACT_KEYS)[number];

export const SYSTEM_TEMPLATE_KEYS = ["introduction", "stay", "follow_up", "return_visit"] as const;

export type SystemTemplateKey = (typeof SYSTEM_TEMPLATE_KEYS)[number];

export const PITCH_DELIVERIES = ["unsent", "copied", "mailto_opened"] as const;
export type PitchDelivery = (typeof PITCH_DELIVERIES)[number];

export const PITCH_LIMITS = {
  name: 80,
  subject: 200,
  body: 8000,
  mailtoBody: 1500,
} as const;

const FACT_KEY_SET = new Set<string>(FACT_KEYS);

const FOLLOW_UP_STATUSES = new Set(["pitched", "follow_up", "replied", "negotiating"]);

const COLLABORATION_LABEL: Record<string, string> = {
  stay: "stay",
  product: "product",
  paid: "paid",
  stay_plus_paid: "stay plus paid",
  other: "other",
};

const TOKEN = /\{\{\s*([a-z0-9_]+)\s*\}\}/g;

export function isFactKey(value: string): value is FactKey {
  return FACT_KEY_SET.has(value);
}

export function isSystemTemplateKey(value: string): value is SystemTemplateKey {
  return (SYSTEM_TEMPLATE_KEYS as readonly string[]).includes(value);
}

export type PitchFacts = Partial<Record<FactKey, string>>;

/** One line of text the creator already supplied or the catalogue already shows. */
export function pitchFact(value: string | null | undefined, max = 300): string | null {
  if (typeof value !== "string") return null;
  const clean = value
    .replace(/[\u0000\r\n]/g, " ")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
  if (!clean) return null;
  return clean.length <= max ? clean : clean.slice(0, max).trim();
}

export function instagramHandle(value: string | null | undefined): string | null {
  const handle = pitchFact(value, 40);
  if (!handle) return null;
  const stripped = handle.replace(/^@+/, "");
  if (!/^[A-Za-z0-9._]{1,40}$/.test(stripped)) return null;
  return stripped;
}

export function httpsUrl(value: string | null | undefined): string | null {
  const url = pitchFact(value, 500);
  if (!url || !url.startsWith("https://")) return null;
  return url;
}

/**
 * A confirmed collaboration is agreed, scheduled, active, or completed.
 * Cancelled is not a collaboration to mention. An unknown type stays generic.
 */
export function pastCollaborationSentence(
  status: string | null,
  collaborationType: string | null,
): string | null {
  if (
    status !== "agreed" &&
    status !== "scheduled" &&
    status !== "active" &&
    status !== "completed"
  ) {
    return null;
  }
  const label =
    collaborationType === null ? null : (COLLABORATION_LABEL[collaborationType] ?? null);
  if (!label) return "We already have a collaboration on record with this hotel.";
  return `We already have a ${label} collaboration on record with this hotel.`;
}

/**
 * Which system template fits the facts on hand.
 * A saved or planned hotel has not been pitched. Won without a collaboration
 * row does not become a return visit.
 */
export function suggestSystemTemplate(input: {
  relationshipStatus: string | null;
  hasTripDates: boolean;
  hasConfirmedCollaboration: boolean;
}): SystemTemplateKey {
  if (input.hasConfirmedCollaboration) return "return_visit";
  if (input.relationshipStatus && FOLLOW_UP_STATUSES.has(input.relationshipStatus)) {
    return "follow_up";
  }
  if (input.hasTripDates) return "stay";
  return "introduction";
}

function paragraph(lines: string[]): string {
  return lines.filter((line) => line.trim().length > 0).join("\n\n");
}

/** System wording. Optional sentences are included only when the fact exists. */
export function systemTemplate(
  key: SystemTemplateKey,
  facts: PitchFacts,
): {
  subject: string;
  body: string;
} {
  const hotel = facts.hotel_name ? "{{hotel_name}}" : "the hotel";
  const subject =
    key === "follow_up"
      ? `Following up with ${hotel}`
      : key === "stay"
        ? facts.trip_start && facts.trip_end
          ? `${hotel} · {{trip_start}} to {{trip_end}}`
          : `A stay at ${hotel}`
        : key === "return_visit"
          ? `Working together again at ${hotel}`
          : facts.hotel_name
            ? "Collaboration idea for {{hotel_name}}"
            : "Collaboration idea";

  const greeting = facts.contact_name ? "Hi {{contact_name}}," : "Hi,";
  const who: string[] = [];
  if (facts.creator_name) who.push("I'm {{creator_name}}.");
  if (facts.niche) who.push("I make {{niche}} content.");
  if (facts.instagram_handle) who.push("I'm on Instagram as @{{instagram_handle}}.");

  const trip =
    facts.trip_start && facts.trip_end
      ? facts.trip_name
        ? "I will be there for {{trip_name}} ({{trip_start}} to {{trip_end}})."
        : "I will be there {{trip_start}} to {{trip_end}}."
      : null;

  const place = facts.destination_name
    ? `I would like to create content at ${hotel} in {{destination_name}}.`
    : `I would like to create content at ${hotel}.`;

  const ask =
    key === "follow_up"
      ? `I'm following up on my note to ${hotel}.`
      : key === "return_visit"
        ? facts.past_collaboration
          ? "{{past_collaboration}}"
          : `I would like to work together again at ${hotel}.`
        : place;

  const lines = [
    greeting,
    who.join(" "),
    trip ?? "",
    ask,
    facts.portfolio_title ? "A sample of my work: {{portfolio_title}}." : "",
    facts.portfolio_url ? "{{portfolio_url}}" : "",
    facts.intelligence_note ? "{{intelligence_note}}" : "",
    key === "return_visit" ? "" : facts.past_collaboration ? "{{past_collaboration}}" : "",
    key === "follow_up"
      ? "If the timing is off, a short reply still helps."
      : "Would a collaboration be possible?",
    facts.creator_name ? "Thank you,\n{{creator_name}}" : "Thank you.",
  ];

  return { subject, body: paragraph(lines) };
}

/**
 * Single pass. Inserted values are not scanned again, so a hotel name that
 * contains a token cannot pull another fact. Unknown tokens are removed.
 */
export function fillTemplate(
  template: string,
  facts: PitchFacts,
): { text: string; used: FactKey[] } {
  const used: FactKey[] = [];
  const replaced = template.replace(TOKEN, (_match, raw: string) => {
    if (!isFactKey(raw)) return "";
    const value = facts[raw]?.trim() ?? "";
    if (!value) return "";
    used.push(raw);
    return value.replaceAll("{{", "{ {");
  });
  return { text: tidyPitch(replaced), used: [...new Set(used)] };
}

export function tidyPitch(value: string): string {
  return value
    .replace(/\r\n/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function suggestPitch(input: {
  facts: PitchFacts;
  relationshipStatus: string | null;
  systemKey?: SystemTemplateKey | null;
  creatorTemplate?: { subject: string; body: string } | null;
}): { subject: string; body: string; used: FactKey[]; systemKey: SystemTemplateKey | null } {
  if (input.creatorTemplate) {
    const subject = fillTemplate(input.creatorTemplate.subject, input.facts);
    const body = fillTemplate(input.creatorTemplate.body, input.facts);
    return {
      subject: clipRendered(subject.text, PITCH_LIMITS.subject) || "Collaboration idea",
      body: clipRendered(body.text, PITCH_LIMITS.body),
      used: [...new Set([...subject.used, ...body.used])],
      systemKey: null,
    };
  }
  const key =
    input.systemKey ??
    suggestSystemTemplate({
      relationshipStatus: input.relationshipStatus,
      hasTripDates: Boolean(input.facts.trip_start && input.facts.trip_end),
      hasConfirmedCollaboration: Boolean(input.facts.past_collaboration),
    });
  const source = systemTemplate(key, input.facts);
  const subject = fillTemplate(source.subject, input.facts);
  const body = fillTemplate(source.body, input.facts);
  return {
    subject: clipRendered(subject.text, PITCH_LIMITS.subject) || "Collaboration idea",
    body: clipRendered(body.text, PITCH_LIMITS.body),
    used: [...new Set([...subject.used, ...body.used])],
    systemKey: key,
  };
}

function clipRendered(value: string, max: number): string {
  const trimmed = value.trim();
  if (trimmed.length <= max) return trimmed;
  return trimmed.slice(0, max).trim();
}

export function omissionNote(input: {
  facts: PitchFacts;
  intelligenceUnavailable: boolean;
  contactUnchecked: boolean;
  contactLocked: boolean;
}): string {
  const missing: string[] = [];
  if (!input.facts.creator_name) missing.push("your name");
  if (!input.facts.niche) missing.push("a niche");
  if (!input.facts.trip_start || !input.facts.trip_end) missing.push("trip dates");
  if (!input.facts.portfolio_title && !input.facts.portfolio_url)
    missing.push("a portfolio sample");
  if (!input.facts.contact_name && !input.contactUnchecked) missing.push("a contact name");
  if (!input.facts.intelligence_note && !input.intelligenceUnavailable) {
    missing.push("public creator activity");
  }
  if (!input.facts.past_collaboration) missing.push("a confirmed collaboration with this hotel");

  const parts: string[] = [];
  if (missing.length > 0) {
    parts.push(`Left out because it isn’t on record: ${missing.join(", ")}.`);
  }
  if (input.intelligenceUnavailable) {
    parts.push("Creator intelligence couldn’t be loaded, so this draft does not mention it.");
  }
  if (input.contactUnchecked) {
    parts.push("The contact couldn’t be checked, so this draft is not addressed.");
  } else if (input.contactLocked) {
    parts.push("The contact name stays out until you unlock it on the hotel page.");
  }
  return parts.join(" ");
}

/**
 * Opens the creator's own mail client. The address is the path, not the body.
 * A newline in the address is rejected so it cannot add a header.
 */
export function buildMailto(input: {
  email: string | null;
  subject: string;
  body: string;
}): string {
  const subject = input.subject.replace(/[\r\n]/g, " ").slice(0, PITCH_LIMITS.subject);
  const body = input.body.replace(/\r\n/g, "\n").slice(0, PITCH_LIMITS.mailtoBody);
  const params = new URLSearchParams();
  params.set("subject", subject);
  params.set("body", body);
  return `mailto:${sanitizeMailtoAddress(input.email)}?${params.toString()}`;
}

export function sanitizeMailtoAddress(email: string | null): string {
  if (!email) return "";
  const trimmed = email.trim();
  if (!trimmed || trimmed.length > 320) return "";
  if (/[\u0000\r\n\t ,]/.test(trimmed)) return "";
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed)) return "";
  return trimmed;
}

export function copyText(subject: string, body: string): string {
  return `${subject.trim()}\n\n${body.trim()}`.trim();
}

export type PitchFieldError = { ok: false; message: string };
export type PitchTemplateInput = { ok: true; name: string; subject: string; body: string };
export type PitchDraftInput = {
  ok: true;
  hotelId: string;
  draftId: string | null;
  tripId: string | null;
  templateId: string | null;
  systemKey: SystemTemplateKey | null;
  subject: string;
  body: string;
  opportunityId: string | null;
};

function requiredText(
  value: string,
  label: string,
  max: number,
): { ok: true; value: string } | PitchFieldError {
  const trimmed = value.replace(/\r\n/g, "\n").trim();
  if (!trimmed) return { ok: false, message: `${label} is required.` };
  if (trimmed.length > max) return { ok: false, message: `${label} is too long.` };
  return { ok: true, value: trimmed };
}

export function parsePitchTemplateFields(fields: {
  name: string;
  subject: string;
  body: string;
}): PitchTemplateInput | PitchFieldError {
  const name = requiredText(fields.name, "Name", PITCH_LIMITS.name);
  if (!name.ok) return name;
  if (name.value !== name.value.trim()) return { ok: false, message: "Name is required." };
  const subject = requiredText(fields.subject, "Subject", PITCH_LIMITS.subject);
  if (!subject.ok) return subject;
  const body = requiredText(fields.body, "Body", PITCH_LIMITS.body);
  if (!body.ok) return body;
  return { ok: true, name: name.value, subject: subject.value, body: body.value };
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function optionalUuid(value: string): { ok: true; value: string | null } | PitchFieldError {
  const trimmed = value.trim();
  if (!trimmed) return { ok: true, value: null };
  if (!UUID_RE.test(trimmed)) return { ok: false, message: "That selection is not valid." };
  return { ok: true, value: trimmed };
}

export function parsePitchDraftFields(fields: {
  hotelId: string;
  draftId: string;
  tripId: string;
  templateId: string;
  systemKey: string;
  subject: string;
  body: string;
  opportunityId?: string;
}): PitchDraftInput | PitchFieldError {
  const hotelId = optionalUuid(fields.hotelId);
  if (!hotelId.ok) return hotelId;
  if (!hotelId.value) return { ok: false, message: "Hotel is required." };
  const draftId = optionalUuid(fields.draftId);
  if (!draftId.ok) return draftId;
  const opportunityId = optionalUuid(fields.opportunityId ?? "");
  if (!opportunityId.ok) return opportunityId;
  const tripId = optionalUuid(fields.tripId);
  if (!tripId.ok) return tripId;
  const templateId = optionalUuid(fields.templateId);
  if (!templateId.ok) return templateId;
  const systemRaw = fields.systemKey.trim();
  if (systemRaw && !isSystemTemplateKey(systemRaw)) {
    return { ok: false, message: "That template is not available." };
  }
  if (templateId.value && systemRaw) {
    return { ok: false, message: "Choose one template." };
  }
  const subject = requiredText(fields.subject, "Subject", PITCH_LIMITS.subject);
  if (!subject.ok) return subject;
  const body = requiredText(fields.body, "Body", PITCH_LIMITS.body);
  if (!body.ok) return body;
  return {
    ok: true,
    hotelId: hotelId.value,
    draftId: draftId.value,
    tripId: tripId.value,
    templateId: templateId.value,
    systemKey: systemRaw ? (systemRaw as SystemTemplateKey) : null,
    subject: subject.value,
    body: body.value,
    opportunityId: opportunityId.value,
  };
}

export function parseDelivery(value: string): "copied" | "mailto_opened" | PitchFieldError {
  if (value === "copied" || value === "mailto_opened") return value;
  return { ok: false, message: "That action is not available." };
}
