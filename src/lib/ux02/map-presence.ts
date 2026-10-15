/**
 * Map slot beside Discover.
 * A search failure is not a map failure. A missing key is not an empty list.
 * Pins, when shown, are whatever the caller already limited to this page.
 */

export type MapPresence = "ready" | "unavailable" | "waiting" | "empty";

export function mapPresence(input: {
  listFailed: boolean;
  pinCount: number;
  apiKeyPresent: boolean;
  scriptFailed: boolean;
}): MapPresence {
  if (input.listFailed) return "waiting";
  if (input.pinCount <= 0) return "empty";
  if (!input.apiKeyPresent || input.scriptFailed) return "unavailable";
  return "ready";
}
