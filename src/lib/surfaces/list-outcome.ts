/**
 * Empty and error stay distinct on every list (D082).
 * A failed read is never the empty copy.
 */

export function tripListOutcome(input: {
  failed: boolean;
  count: number;
}): "error" | "empty" | "items" {
  if (input.failed) return "error";
  if (input.count === 0) return "empty";
  return "items";
}

export function discoverListOutcome(input: {
  failed: boolean;
  count: number;
  filtered: boolean;
  page: number;
}): "error" | "items" | "past_end" | "filtered_empty" | "empty" {
  if (input.failed) return "error";
  if (input.count > 0) return "items";
  if (input.page > 1) return "past_end";
  if (input.filtered) return "filtered_empty";
  return "empty";
}

export const TRIP_LIST_COPY = {
  errorTitle: "We couldn’t load your trips",
  errorBody: "Something went wrong on our side. Reload the page to try again.",
  emptyTitle: "No trips yet",
  emptyBody:
    "Create a trip for the destination you’re pitching. The Free plan includes one active trip.",
} as const;

export const DISCOVER_LIST_COPY = {
  errorTitle: "We couldn’t load hotels just now",
  errorBody: "Something went wrong fetching results. Try again, or adjust your filters.",
  emptyTitle: "No published hotels yet",
  emptyBody: "Hotels appear here once they are in the published catalog.",
} as const;

export const PROFILE_LIST_COPY = {
  error: "We couldn’t load your profile. This is not an empty profile.",
  shareError: "Share settings couldn’t be loaded. This is not an empty share link.",
} as const;

export const REVOKED_INBOX_COPY = {
  title: "Gmail authorization stopped",
  body: "Google stopped accepting the stored authorization. This is not an empty inbox. Reconnect Gmail, then try again.",
} as const;

export const SYNC_ERROR_INBOX_COPY = {
  title: "Gmail sync did not finish",
  body: "The last sync failed. This is not an empty inbox. Try again. A retry does not store a second copy of mail that is already stored.",
} as const;
