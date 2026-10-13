export const COLLABORATION_SUGGESTION_KINDS = [
  "pitch_sent",
  "human_reply",
  "collaboration",
] as const;

export type CollaborationSuggestionKind = (typeof COLLABORATION_SUGGESTION_KINDS)[number];

export interface CollaborationSuggestion {
  id: string;
  kind: CollaborationSuggestionKind;
}

export type CollaborationSuggestionLoad =
  | { status: "ok"; suggestions: CollaborationSuggestion[] }
  | { status: "paused" }
  | { status: "hidden" }
  | { status: "error" };

export function parseCollaborationSuggestions(data: unknown): CollaborationSuggestionLoad {
  if (!data || typeof data !== "object") return { status: "error" };
  const result = (data as { result?: unknown }).result;
  if (result === "paused") return { status: "paused" };
  if (result === "not_found") return { status: "hidden" };
  if (result !== "ok") return { status: "error" };
  const raw = (data as { suggestions?: unknown }).suggestions;
  if (!Array.isArray(raw)) return { status: "error" };
  const suggestions: CollaborationSuggestion[] = [];
  for (const row of raw) {
    if (!row || typeof row !== "object") return { status: "error" };
    const id = (row as { id?: unknown }).id;
    const kind = (row as { kind?: unknown }).kind;
    if (
      typeof id !== "string" ||
      !COLLABORATION_SUGGESTION_KINDS.includes(kind as CollaborationSuggestionKind)
    ) {
      return { status: "error" };
    }
    suggestions.push({ id, kind: kind as CollaborationSuggestionKind });
  }
  return { status: "ok", suggestions };
}
