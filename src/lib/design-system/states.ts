/**
 * Mandatory V12.1 states and provenance labels.
 * Copy is English. Insufficient data is never phrased as a zero percent.
 * None of these strings start a charge, a send, or a provider call.
 */

export const PROVENANCE_BADGES = [
  { id: "gmail", label: "Verified via Gmail" },
  { id: "manual", label: "Manually recorded" },
  { id: "sample", label: "Sample only" },
  { id: "pending", label: "Verification pending" },
] as const;

export type ProvenanceId = (typeof PROVENANCE_BADGES)[number]["id"];

export const MANDATORY_STATES = [
  {
    id: "loading",
    title: "Loading",
    body: "Loading this section.",
    action: null,
  },
  {
    id: "empty",
    title: "Empty",
    body: "Nothing here yet.",
    action: null,
  },
  {
    id: "insufficient-data",
    title: "Insufficient data",
    body: "There is not enough published evidence to show this. That is not a measured zero.",
    action: null,
  },
  {
    id: "locked",
    title: "Locked",
    body: "This stays hidden until you unlock it. Names and email addresses are not on this screen.",
    action: null,
  },
  {
    id: "insufficient-credits",
    title: "Insufficient credits",
    body: "You do not have a credit for this unlock. A failed lookup is not charged, and opening a hotel you already unlocked is not charged again.",
    action: { href: "/app/billing", label: "View billing" },
  },
  {
    id: "success",
    title: "Success",
    body: "This finished.",
    action: null,
  },
  {
    id: "partial-success",
    title: "Partial success",
    body: "Part of this finished. The rest still needs another try.",
    action: null,
  },
  {
    id: "failed",
    title: "Failed",
    body: "This did not finish. You can try again. A failed lookup is not charged.",
    action: { href: null, label: "Retry" },
  },
  {
    id: "saved",
    title: "Saved",
    body: "Saved.",
    action: null,
  },
  {
    id: "unsaved",
    title: "Unsaved",
    body: "Unsaved changes.",
    action: null,
  },
  {
    id: "verification-pending",
    title: "Verification pending",
    body: "This still needs a check. It is not verified.",
    action: null,
  },
  {
    id: "access-changed",
    title: "Access changed",
    body: "Your access changed. Reload this page to see what you can open now.",
    action: null,
  },
  {
    id: "disconnected-email",
    title: "Disconnected email",
    body: "Gmail is not connected. You can keep working and record what happened by hand.",
    action: { href: "/app/account", label: "Review email connection" },
  },
  {
    id: "manual-only",
    title: "Manual only",
    body: "Sending from Gmail is not available here. Record the message yourself. Nothing on this screen sends mail.",
    action: null,
  },
] as const;

export type MandatoryStateId = (typeof MANDATORY_STATES)[number]["id"];

export function mandatoryState(id: MandatoryStateId) {
  const state = MANDATORY_STATES.find((item) => item.id === id);
  if (!state) throw new Error(`Unknown state ${id}`);
  return state;
}

export function provenanceBadge(id: ProvenanceId) {
  const badge = PROVENANCE_BADGES.find((item) => item.id === id);
  if (!badge) throw new Error(`Unknown provenance ${id}`);
  return badge;
}

/** True when copy pretends missing evidence is a zero percent. */
export function readsAsFakeZero(text: string): boolean {
  return /0\s*%/.test(text);
}
