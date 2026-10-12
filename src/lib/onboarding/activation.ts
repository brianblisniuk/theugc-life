/**
 * Derived first-flow checklist (D082, Proposed).
 *
 * Nothing here is stored. A step is complete only when an existing row the
 * caller owns says so. A failed read is not "not connected" and not "no trip".
 * Saving a hotel writes the pipeline row, so the save step and the pipeline
 * step become done together. There is no "opened the pipeline" flag.
 */
import { isUuid } from "@/lib/hotels/ids";

export const POST_ONBOARDING_PATH = "/app";

export const ACTIVATION_HREFS = {
  gmail: "/app/account",
  trip: "/app/trips",
  save: "/app/discover",
  pipeline: "/app/pipeline",
} as const;

export type Probe = "yes" | "no" | "error";

export type ActivationFacts = {
  /** The deployment has the existing Gmail OAuth configuration. Not a user fact. */
  gmailConfigured: boolean;
  gmail: Probe;
  trip: Probe;
  /** At least one pipeline item. That row is the saved hotel. */
  saved: Probe;
  /** At least one pipeline item with a next follow-up. Independent of the checklist. */
  followUp: Probe;
};

export type ActivationStepId = "gmail" | "trip" | "save" | "pipeline";

export type ActivationStep = {
  id: ActivationStepId;
  title: string;
  href: string;
  cta: string;
  done: boolean;
  marker: "Done" | "Next" | "Not yet";
};

export type HomeView =
  | { kind: "blocked"; title: string; body: string }
  | {
      kind: "next";
      steps: ActivationStep[];
      current: ActivationStep;
      followUp: "due" | "error" | null;
    }
  | {
      kind: "ready";
      steps: ActivationStep[];
      followUp: "due" | "none" | "error";
      title: string;
      body: string;
      href: string;
      cta: string;
    };

export const ACTIVATION_COPY = {
  blockedTitle: "We couldn’t check your setup",
  blockedBody:
    "Something went wrong reading your account. Reload the page to try again. This is not a missing connection, an empty trip, or an empty pipeline.",
  gmailTitle: "Connect Gmail",
  gmailCta: "Connect Gmail",
  gmailBody:
    "Use the Gmail connection already on your account. A mailbox counts once it is connected. An unfinished authorization does not.",
  tripTitle: "Create your first trip",
  tripCta: "Create a trip",
  tripBody: "A trip holds the destination and the hotels you are pitching.",
  saveTitle: "Save a hotel from Discover",
  saveCta: "Discover hotels",
  saveBody: "Saving a published hotel puts it in your pipeline.",
  pipelineTitle: "Open that hotel in your pipeline",
  pipelineCta: "Open your pipeline",
  pipelineBody: "The saved hotel is already a pipeline row. Open it there to continue.",
  readyNoneTitle: "No follow-up is due",
  readyNoneBody:
    "Gmail, a trip, and a saved hotel are in place. A follow-up shows here when a saved hotel has a next step.",
  readyDueTitle: "A follow-up is due",
  readyDueBody: "Open your pipeline to continue that hotel.",
  readyErrorTitle: "We couldn’t load follow-ups",
  readyErrorBody:
    "Your setup is in place. This is not an empty follow-up list. Reload the page to try again.",
  noticeDueTitle: "A follow-up is also due",
  noticeDueBody: "You can open your pipeline now, and finish the step above when you are ready.",
  noticeErrorTitle: "We couldn’t check follow-ups",
  noticeErrorBody:
    "This is not “nothing is due”. Reload the page to try again. Your setup steps above are unchanged.",
} as const;

const STEP_META: Record<
  ActivationStepId,
  { title: string; href: string; cta: string; body: string }
> = {
  gmail: {
    title: ACTIVATION_COPY.gmailTitle,
    href: ACTIVATION_HREFS.gmail,
    cta: ACTIVATION_COPY.gmailCta,
    body: ACTIVATION_COPY.gmailBody,
  },
  trip: {
    title: ACTIVATION_COPY.tripTitle,
    href: ACTIVATION_HREFS.trip,
    cta: ACTIVATION_COPY.tripCta,
    body: ACTIVATION_COPY.tripBody,
  },
  save: {
    title: ACTIVATION_COPY.saveTitle,
    href: ACTIVATION_HREFS.save,
    cta: ACTIVATION_COPY.saveCta,
    body: ACTIVATION_COPY.saveBody,
  },
  pipeline: {
    title: ACTIVATION_COPY.pipelineTitle,
    href: ACTIVATION_HREFS.pipeline,
    cta: ACTIVATION_COPY.pipelineCta,
    body: ACTIVATION_COPY.pipelineBody,
  },
};

export function gmailProbe(
  rows: readonly { userId: string; connectionState: string }[] | null,
  failed: boolean,
  authUserId: string,
): Probe {
  if (failed || !isUuid(authUserId)) return "error";
  if (!rows) return "no";
  const ownConnected = rows.some(
    (row) => row.userId === authUserId && row.connectionState === "connected",
  );
  return ownConnected ? "yes" : "no";
}

/**
 * Existence of a creator-owned row. A failed read, or no resolved profile id,
 * is `error` — never `no`. Another creator's id does not count.
 */
export function ownedExistence(
  rows: readonly { creatorId: string }[] | null,
  failed: boolean,
  profileId: string | null,
): Probe {
  if (failed || profileId === null || !isUuid(profileId)) return "error";
  if (!rows) return "no";
  return rows.some((row) => row.creatorId === profileId) ? "yes" : "no";
}

export function resolveOwnProfile(
  row: unknown,
  failed: boolean,
  authUserId: string,
): { status: "ok"; profileId: string; displayName: string | null } | { status: "error" } {
  if (failed || !isUuid(authUserId) || row === null || typeof row !== "object") {
    return { status: "error" };
  }
  const record = row as Record<string, unknown>;
  if (record.user_id !== authUserId) return { status: "error" };
  if (typeof record.id !== "string" || !isUuid(record.id)) return { status: "error" };
  const name = typeof record.display_name === "string" ? record.display_name.trim() : "";
  return {
    status: "ok",
    profileId: record.id,
    displayName: name.length > 0 ? name : null,
  };
}

function step(
  id: ActivationStepId,
  done: boolean,
  marker: ActivationStep["marker"],
): ActivationStep {
  const meta = STEP_META[id];
  return { id, title: meta.title, href: meta.href, cta: meta.cta, done, marker };
}

export function homeView(facts: ActivationFacts): HomeView {
  const gmailBroken = facts.gmailConfigured && facts.gmail === "error";
  if (gmailBroken || facts.trip === "error" || facts.saved === "error") {
    return {
      kind: "blocked",
      title: ACTIVATION_COPY.blockedTitle,
      body: ACTIVATION_COPY.blockedBody,
    };
  }

  const gmailDone = facts.gmailConfigured && facts.gmail === "yes";
  const tripDone = facts.trip === "yes";
  const savedDone = facts.saved === "yes";
  const ids: ActivationStepId[] = facts.gmailConfigured
    ? ["gmail", "trip", "save", "pipeline"]
    : ["trip", "save", "pipeline"];
  const doneOf: Record<ActivationStepId, boolean> = {
    gmail: gmailDone,
    trip: tripDone,
    save: savedDone,
    pipeline: savedDone,
  };
  const currentId = ids.find((id) => !doneOf[id]);
  const steps = ids.map((id) =>
    step(id, doneOf[id], doneOf[id] ? "Done" : id === currentId ? "Next" : "Not yet"),
  );

  if (!currentId) {
    const followUp =
      facts.followUp === "yes" ? "due" : facts.followUp === "error" ? "error" : "none";
    if (followUp === "error") {
      return {
        kind: "ready",
        steps,
        followUp,
        title: ACTIVATION_COPY.readyErrorTitle,
        body: ACTIVATION_COPY.readyErrorBody,
        href: ACTIVATION_HREFS.pipeline,
        cta: ACTIVATION_COPY.pipelineCta,
      };
    }
    if (followUp === "due") {
      return {
        kind: "ready",
        steps,
        followUp,
        title: ACTIVATION_COPY.readyDueTitle,
        body: ACTIVATION_COPY.readyDueBody,
        href: ACTIVATION_HREFS.pipeline,
        cta: ACTIVATION_COPY.pipelineCta,
      };
    }
    return {
      kind: "ready",
      steps,
      followUp,
      title: ACTIVATION_COPY.readyNoneTitle,
      body: ACTIVATION_COPY.readyNoneBody,
      href: ACTIVATION_HREFS.pipeline,
      cta: ACTIVATION_COPY.pipelineCta,
    };
  }

  const current = steps.find((item) => item.id === currentId);
  if (!current) {
    return {
      kind: "blocked",
      title: ACTIVATION_COPY.blockedTitle,
      body: ACTIVATION_COPY.blockedBody,
    };
  }
  return {
    kind: "next",
    steps,
    current: { ...current, marker: "Next" },
    followUp: facts.followUp === "error" ? "error" : facts.followUp === "yes" ? "due" : null,
  };
}

export function currentStepBody(id: ActivationStepId): string {
  return STEP_META[id].body;
}
