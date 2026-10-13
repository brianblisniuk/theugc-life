/**
 * First useful minute (D095). A failed probe is not an empty step, another
 * creator's row is not progress, and dismissing the checklist does not mark
 * a step done. Gmail is not a step.
 */
import { describe, expect, it } from "vitest";

import {
  FIRST_RUN_COPY,
  FIRST_RUN_HREFS,
  POST_ONBOARDING_PATH,
  gmailProbe,
  greeting,
  homeView,
  ownedExistence,
  remainingRequired,
  resolveOwnProfile,
  type FirstRunFacts,
} from "@/lib/onboarding/activation";

const AUTH_A = "11111111-1111-1111-1111-111111111111";
const PROFILE_A = "99999999-9999-9999-9999-999999999999";
const PROFILE_B = "88888888-8888-8888-8888-888888888888";
const AUTH_B = "22222222-2222-2222-2222-222222222222";

const OPEN: FirstRunFacts = {
  destination: "no",
  saved: "no",
  pitch: "no",
  followUp: "no",
  dismissed: false,
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

  it("another creator's row does not complete the step, and a failed read is not zero", () => {
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
  it("asks for a destination and a hotel, and treats the pitch as optional", () => {
    expect(POST_ONBOARDING_PATH).toBe("/app/onboarding");
    const view = homeView(OPEN);
    expect(view.kind).toBe("checklist");
    if (view.kind !== "checklist") return;
    expect(view.steps.map((step) => step.id)).toEqual(["destination", "hotel", "pitch"]);
    expect(view.steps.map((step) => step.optional)).toEqual([false, false, true]);
    expect(view.steps.map((step) => step.done)).toEqual([false, false, false]);
    expect(view.steps[0]?.href).toBe(FIRST_RUN_HREFS.destination);
    expect(view.steps[1]?.href).toBe(FIRST_RUN_HREFS.hotels);
    expect(view.remaining).toBe(2);
    expect(view.followUp).toBeNull();
    const packed = JSON.stringify(view);
    expect(packed).not.toContain("gmail.send");
    expect(packed).not.toContain("/api/integrations/gmail");
    expect(packed).not.toContain(FIRST_RUN_COPY.savedToast);
  });

  it("does not count the optional pitch toward the remaining steps", () => {
    expect(remainingRequired({ destination: "yes", saved: "no" })).toBe(1);
    expect(remainingRequired({ destination: "yes", saved: "yes" })).toBe(0);
    const view = homeView({ ...OPEN, destination: "yes", saved: "yes", pitch: "no" });
    expect(view.kind).toBe("checklist");
    if (view.kind !== "checklist") return;
    expect(view.remaining).toBe(0);
    expect(view.steps.find((step) => step.id === "pitch")?.done).toBe(false);
    expect(greeting("Sofi", 2)).toBe("Hola, Sofi. Te faltan 2 pasos.");
    expect(greeting("Sofi", 1)).toBe("Hola, Sofi. Te falta 1 paso.");
    expect(greeting("  ", 0)).toBe("Hola, creador.");
  });

  it("hiding the checklist does not mark an unfinished step done", () => {
    const view = homeView({ ...OPEN, dismissed: true, followUp: "yes" });
    expect(view.kind).toBe("hidden");
    if (view.kind !== "hidden") return;
    expect(view.followUp).toBe("due");
    expect(remainingRequired(OPEN)).toBe(2);
    expect(JSON.stringify(view)).not.toContain("done");
  });

  it("a failed read blocks the checklist instead of saying the destination is empty", () => {
    const view = homeView({ ...OPEN, destination: "error", dismissed: true });
    expect(view.kind).toBe("blocked");
    if (view.kind !== "blocked") return;
    expect(view.title).toBe(FIRST_RUN_COPY.blockedTitle);
    expect(view.body).toContain("no es un destino vacío");
    expect(view.body).not.toContain(FIRST_RUN_COPY.insufficientTitle);
  });

  it("a failed follow-up read is not an empty due list", () => {
    const view = homeView({
      ...OPEN,
      destination: "yes",
      saved: "yes",
      followUp: "error",
    });
    expect(view.kind).toBe("blocked");
    if (view.kind !== "blocked") return;
    expect(view.body).toContain("no es un destino vacío");
    expect(view.title).not.toContain("nada");
  });

  it("shows a due follow-up beside the unfinished hotel step", () => {
    const view = homeView({ ...OPEN, destination: "yes", followUp: "yes" });
    expect(view.kind).toBe("checklist");
    if (view.kind !== "checklist") return;
    expect(view.steps.find((step) => step.id === "hotel")?.done).toBe(false);
    expect(view.followUp).toBe("due");
    expect(view.remaining).toBe(1);
  });
});
