/**
 * First-flow checklist (D082). A failed probe is not an empty step, another
 * creator's row is not progress, and an unfinished Gmail state is not connected.
 */
import { describe, expect, it } from "vitest";

import {
  ACTIVATION_COPY,
  ACTIVATION_HREFS,
  POST_ONBOARDING_PATH,
  gmailProbe,
  homeView,
  ownedExistence,
  resolveOwnProfile,
  type ActivationFacts,
} from "@/lib/onboarding/activation";

const AUTH_A = "11111111-1111-1111-1111-111111111111";
const PROFILE_A = "99999999-9999-9999-9999-999999999999";
const PROFILE_B = "88888888-8888-8888-8888-888888888888";
const AUTH_B = "22222222-2222-2222-2222-222222222222";

const OPEN: ActivationFacts = {
  gmailConfigured: true,
  gmail: "no",
  trip: "no",
  saved: "no",
  followUp: "no",
};

describe("activation probes", () => {
  it("counts only a connected mailbox owned by the session user", () => {
    expect(
      gmailProbe(
        [
          { userId: AUTH_B, connectionState: "connected" },
          { userId: AUTH_A, connectionState: "consent_required" },
          { userId: AUTH_A, connectionState: "reauth_required" },
          { userId: AUTH_A, connectionState: "pending_authorization" },
          { userId: AUTH_A, connectionState: "disconnected" },
        ],
        false,
        AUTH_A,
      ),
    ).toBe("no");

    expect(
      gmailProbe(
        [
          { userId: AUTH_B, connectionState: "connected" },
          { userId: AUTH_A, connectionState: "connected" },
        ],
        false,
        AUTH_A,
      ),
    ).toBe("yes");
  });

  it("a failed mailbox read is an error even when a connected row came back with it", () => {
    expect(gmailProbe([{ userId: AUTH_A, connectionState: "connected" }], true, AUTH_A)).toBe(
      "error",
    );
    expect(gmailProbe(null, false, AUTH_A)).toBe("no");
    expect(gmailProbe([], false, "not-a-user")).toBe("error");
  });

  it("another creator's trip does not complete the step, and a failed read is not zero", () => {
    expect(ownedExistence([{ creatorId: PROFILE_B }], false, PROFILE_A)).toBe("no");
    expect(
      ownedExistence([{ creatorId: PROFILE_B }, { creatorId: PROFILE_A }], false, PROFILE_A),
    ).toBe("yes");
    expect(ownedExistence([{ creatorId: PROFILE_A }], true, PROFILE_A)).toBe("error");
    expect(ownedExistence([], false, null)).toBe("error");
    expect(ownedExistence([], false, PROFILE_A)).toBe("no");
  });

  it("refuses a profile row that belongs to someone else", () => {
    expect(
      resolveOwnProfile({ id: PROFILE_B, user_id: AUTH_B, display_name: "Bee" }, false, AUTH_A),
    ).toEqual({ status: "error" });
    expect(
      resolveOwnProfile({ id: PROFILE_A, user_id: AUTH_A, display_name: "  " }, false, AUTH_A),
    ).toEqual({
      status: "ok",
      profileId: PROFILE_A,
      displayName: null,
    });
    expect(resolveOwnProfile(null, false, AUTH_A)).toEqual({ status: "error" });
    expect(resolveOwnProfile({ id: PROFILE_A, user_id: AUTH_A }, true, AUTH_A)).toEqual({
      status: "error",
    });
  });
});

describe("home checklist", () => {
  it("sends the creator to the existing account page, not a new OAuth or send scope", () => {
    expect(POST_ONBOARDING_PATH).toBe("/app");
    const view = homeView(OPEN);
    expect(view.kind).toBe("next");
    if (view.kind !== "next") return;
    expect(view.current.id).toBe("gmail");
    expect(view.current.href).toBe("/app/account");
    expect(view.current.href).toBe(ACTIVATION_HREFS.gmail);
    const packed = JSON.stringify(view);
    expect(packed).not.toContain("gmail.send");
    expect(packed).not.toContain("/api/integrations/gmail");
    expect(view.steps.map((step) => step.marker)).toEqual([
      "Next",
      "Not yet",
      "Not yet",
      "Not yet",
    ]);
  });

  it("walks gmail, then trip, then discover, and completes save and pipeline together", () => {
    const afterGmail = homeView({ ...OPEN, gmail: "yes" });
    expect(afterGmail.kind).toBe("next");
    if (afterGmail.kind !== "next") return;
    expect(afterGmail.current.href).toBe("/app/trips");

    const afterTrip = homeView({ ...OPEN, gmail: "yes", trip: "yes" });
    expect(afterTrip.kind).toBe("next");
    if (afterTrip.kind !== "next") return;
    expect(afterTrip.current.href).toBe("/app/discover");

    const ready = homeView({ ...OPEN, gmail: "yes", trip: "yes", saved: "yes" });
    expect(ready.kind).toBe("ready");
    if (ready.kind !== "ready") return;
    expect(ready.followUp).toBe("none");
    expect(ready.title).toBe(ACTIVATION_COPY.readyNoneTitle);
    expect(ready.href).toBe("/app/pipeline");
    expect(ready.steps.every((step) => step.marker === "Done")).toBe(true);
  });

  it("does not offer Gmail when the deployment has no Gmail configuration", () => {
    const view = homeView({ ...OPEN, gmailConfigured: false, gmail: "error" });
    expect(view.kind).toBe("next");
    if (view.kind !== "next") return;
    expect(view.steps.map((step) => step.id)).toEqual(["trip", "save", "pipeline"]);
    expect(view.current.id).toBe("trip");
  });

  it("a failed read blocks the checklist instead of telling the creator they have no trip", () => {
    const view = homeView({ ...OPEN, gmail: "yes", trip: "error", saved: "no" });
    expect(view.kind).toBe("blocked");
    if (view.kind !== "blocked") return;
    expect(view.title).toBe(ACTIVATION_COPY.blockedTitle);
    expect(view.body).toContain("not a missing connection");
    expect(view.body).not.toContain("No trips");
    expect(JSON.stringify(view)).not.toContain(ACTIVATION_COPY.tripCta);
  });

  it("a failed follow-up read is not an empty due list", () => {
    const view = homeView({
      ...OPEN,
      gmail: "yes",
      trip: "yes",
      saved: "yes",
      followUp: "error",
    });
    expect(view.kind).toBe("ready");
    if (view.kind !== "ready") return;
    expect(view.followUp).toBe("error");
    expect(view.title).toBe(ACTIVATION_COPY.readyErrorTitle);
    expect(view.title).not.toBe(ACTIVATION_COPY.readyNoneTitle);
    expect(view.body).toContain("not an empty follow-up list");
  });

  it("shows a due follow-up without hiding the unfinished step", () => {
    const view = homeView({ ...OPEN, gmail: "yes", followUp: "yes" });
    expect(view.kind).toBe("next");
    if (view.kind !== "next") return;
    expect(view.current.id).toBe("trip");
    expect(view.followUp).toBe("due");
  });
});
