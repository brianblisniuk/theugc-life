/**
 * Collaboration-detection adapter (D107, D003 is not an AI vendor).
 *
 * Only the heuristic adapter is wired. It does not call a network. The
 * heuristic itself lives in `refresh_gmail_collaboration_suggestions`:
 * a qualified creator pitch, a B06 human reply that is not an auto-responder,
 * and a non-stale `agreement_observed` reading. This module is the gate that
 * refuses any other classifier before that function runs.
 */

export const HEURISTIC_COLLABORATION_CLASSIFIER = "heuristic" as const;

export type CollaborationClassifierName = typeof HEURISTIC_COLLABORATION_CLASSIFIER;

/** Unset means heuristic. Anything else is not approved. */
export function collaborationClassifierName(raw: string | undefined): CollaborationClassifierName {
  const value = raw === undefined ? HEURISTIC_COLLABORATION_CLASSIFIER : raw.trim();
  if (value === "" || value === HEURISTIC_COLLABORATION_CLASSIFIER) {
    return HEURISTIC_COLLABORATION_CLASSIFIER;
  }
  throw new Error("GMAIL_COLLAB_CLASSIFIER is not approved. Only the heuristic adapter is wired.");
}

export function assertCollaborationClassifier(raw?: string): void {
  const value = raw === undefined ? process.env.GMAIL_COLLAB_CLASSIFIER : raw;
  collaborationClassifierName(value);
}
