/**
 * D125 travel portfolio.
 *
 * Suggestions come from confirmed collaborations the caller owns. A missing
 * profile is not an empty list. A payload that carries compensation, a
 * contact, or a note is rejected, so a failed read stays a notice.
 */
export const PORTFOLIO_TEMPLATES = ["journey", "destinations", "highlights"] as const;

export type PortfolioTemplate = (typeof PORTFOLIO_TEMPLATES)[number];

export const PORTFOLIO_TEMPLATE_LABELS: Record<PortfolioTemplate, string> = {
  journey: "Journey",
  destinations: "Destinations",
  highlights: "Highlights",
};

export const PORTFOLIO_COPY = {
  error: "We couldn’t load your portfolio. This is not an empty portfolio.",
  emptySuggestions: "No confirmed collaboration is waiting for a decision.",
} as const;

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const CONFIRMED = new Set(["agreed", "scheduled", "active", "completed"]);

const TYPES = new Set(["stay", "product", "paid", "stay_plus_paid", "other"]);

const ENTRY_KEYS = [
  "collaboration_id",
  "hotel_name",
  "destination_name",
  "collaboration_type",
  "status",
  "start_date",
  "end_date",
] as const;

const WITHHELD_KEYS = [...ENTRY_KEYS, "decision"] as const;

const BANNED = new Set([
  "email",
  "compensation",
  "cash_amount_minor",
  "cash_currency",
  "private_notes",
  "notes",
  "private_value_amount",
  "private_value_currency",
  "provider_thread_id",
  "token",
  "would_work_again",
  "terms_matched",
]);

export interface PortfolioEntry {
  collaborationId: string;
  hotelName: string;
  destinationName: string | null;
  collaborationType: string | null;
  status: "agreed" | "scheduled" | "active" | "completed" | "cancelled";
  startDate: string | null;
  endDate: string | null;
}

export interface WithheldPortfolioEntry extends PortfolioEntry {
  decision: "published" | "dismissed";
}

export interface OwnPortfolio {
  template: PortfolioTemplate | null;
  suggestions: PortfolioEntry[];
  published: PortfolioEntry[];
  dismissed: PortfolioEntry[];
  withheld: WithheldPortfolioEntry[];
}

export type OwnPortfolioLoad =
  { status: "ok"; portfolio: OwnPortfolio } | { status: "missing" } | { status: "error" };

export type PortfolioListOutcome = "error" | "empty" | "items";

/** A failed read is never the empty copy. */
export function portfolioListOutcome(input: {
  failed: boolean;
  suggestionCount: number;
}): PortfolioListOutcome {
  if (input.failed) return "error";
  if (input.suggestionCount === 0) return "empty";
  return "items";
}

function banned(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  if (Array.isArray(value)) return value.some((item) => banned(item));
  return Object.entries(value).some(([key, child]) => BANNED.has(key) || banned(child));
}

function dateOrNull(value: unknown): string | null | "bad" {
  if (value === null) return null;
  if (typeof value !== "string" || !DATE_ONLY.test(value)) return "bad";
  return value;
}

function textOrNull(value: unknown): string | null | "bad" {
  if (value === null) return null;
  if (typeof value !== "string") return "bad";
  const trimmed = value.trim();
  if (!trimmed) return null;
  return trimmed;
}

function sameKeys(row: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(row).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function mapEntry(
  raw: unknown,
  keys: readonly string[],
  statuses: Set<string>,
): (PortfolioEntry & { decision?: "published" | "dismissed" }) | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const row = raw as Record<string, unknown>;
  if (!sameKeys(row, keys)) return null;
  if (typeof row.collaboration_id !== "string" || !UUID.test(row.collaboration_id)) return null;
  if (typeof row.hotel_name !== "string" || !row.hotel_name.trim()) return null;
  const destination = textOrNull(row.destination_name);
  if (destination === "bad") return null;
  if (row.collaboration_type !== null && typeof row.collaboration_type !== "string") return null;
  if (typeof row.collaboration_type === "string" && !TYPES.has(row.collaboration_type)) return null;
  if (typeof row.status !== "string" || !statuses.has(row.status)) return null;
  const start = dateOrNull(row.start_date);
  const end = dateOrNull(row.end_date);
  if (start === "bad" || end === "bad") return null;
  const entry: PortfolioEntry & { decision?: "published" | "dismissed" } = {
    collaborationId: row.collaboration_id,
    hotelName: row.hotel_name.trim(),
    destinationName: destination,
    collaborationType: row.collaboration_type,
    status: row.status as PortfolioEntry["status"],
    startDate: start,
    endDate: end,
  };
  if ("decision" in row) {
    if (row.decision !== "published" && row.decision !== "dismissed") return null;
    entry.decision = row.decision;
  }
  return entry;
}

function mapList(
  value: unknown,
  withheld: boolean,
): PortfolioEntry[] | WithheldPortfolioEntry[] | null {
  if (!Array.isArray(value)) return null;
  const keys = withheld ? WITHHELD_KEYS : ENTRY_KEYS;
  const statuses = withheld ? new Set(["cancelled"]) : CONFIRMED;
  const items: Array<PortfolioEntry & { decision?: "published" | "dismissed" }> = [];
  for (const raw of value) {
    const entry = mapEntry(raw, keys, statuses);
    if (!entry) return null;
    items.push(entry);
  }
  return items as PortfolioEntry[] | WithheldPortfolioEntry[];
}

export function mapOwnPortfolio(payload: unknown): OwnPortfolioLoad {
  if (payload === null) return { status: "missing" };
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return { status: "error" };
  if (banned(payload)) return { status: "error" };
  const row = payload as Record<string, unknown>;
  const keys = ["template", "suggestions", "published", "dismissed", "withheld"];
  if (!sameKeys(row, keys)) return { status: "error" };
  if (
    row.template !== null &&
    (typeof row.template !== "string" ||
      !PORTFOLIO_TEMPLATES.includes(row.template as PortfolioTemplate))
  ) {
    return { status: "error" };
  }
  const suggestions = mapList(row.suggestions, false);
  const published = mapList(row.published, false);
  const dismissed = mapList(row.dismissed, false);
  const withheld = mapList(row.withheld, true);
  if (!suggestions || !published || !dismissed || !withheld) return { status: "error" };
  return {
    status: "ok",
    portfolio: {
      template: row.template as PortfolioTemplate | null,
      suggestions: suggestions as PortfolioEntry[],
      published: published as PortfolioEntry[],
      dismissed: dismissed as PortfolioEntry[],
      withheld: withheld as WithheldPortfolioEntry[],
    },
  };
}

export function isPortfolioTemplate(value: string): value is PortfolioTemplate {
  return (PORTFOLIO_TEMPLATES as readonly string[]).includes(value);
}
