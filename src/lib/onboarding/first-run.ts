/**
 * First useful minute (D095, Accepted). Supersedes the Proposed D082 checklist.
 *
 * The destination, the saved hotel, and the optional pitch are done only when
 * a row the creator owns says so. A failed read is not "not done". Dismissing
 * the checklist hides it. It does not mark a step done. Gmail is not a step:
 * the hotels on the first screen come from the published catalog.
 */
import { isUuid } from "@/lib/hotels/ids";

export const POST_ONBOARDING_PATH = "/app/onboarding";

export const FIRST_RUN_HREFS = {
  destination: "/app/onboarding",
  hotels: "/app/onboarding/hotels",
  discover: "/app/discover",
  pipeline: "/app/pipeline",
} as const;

export type Probe = "yes" | "no" | "error";

export type FirstRunFacts = {
  destination: Probe;
  saved: Probe;
  /** Optional. A pitch note or a creator-recorded pitch. */
  pitch: Probe;
  followUp: Probe;
  dismissed: boolean;
};

export type FirstRunStepId = "destination" | "hotel" | "pitch";

export type FirstRunStep = {
  id: FirstRunStepId;
  title: string;
  detail: string;
  href: string;
  done: boolean;
  optional: boolean;
};

export type HomeView =
  | { kind: "blocked"; title: string; body: string }
  | {
      kind: "checklist";
      steps: FirstRunStep[];
      remaining: number;
      followUp: "due" | "error" | null;
    }
  | {
      kind: "hidden";
      followUp: "due" | "none" | "error";
    };

export const FIRST_RUN_COPY = {
  blockedTitle: "No pudimos revisar tu inicio",
  blockedBody:
    "Algo falló al leer tu cuenta. Recargá la página. Esto no es un destino vacío ni un pipeline vacío.",
  destinationTitle: "Elegiste tu destino",
  destinationDetail: "Sirve para mostrarte hoteles de nuestra base. Podés cambiarlo.",
  hotelTitle: "Guardaste tu primer hotel",
  hotelDetail: "El hotel queda en tu pipeline, con el contacto que podés ver.",
  pitchTitle: "Preparaste el primer pitch",
  pitchDetail: "Opcional. Una nota en el hotel cuenta como pitch preparado.",
  savedToast: "Listo. Ya tenés tu primer hotel en el pipeline.",
  databaseNote: "Estos hoteles salen de nuestra base, no de tu Gmail.",
  genericContact: "Contacto genérico",
  insufficientTitle: "Todavía no tenemos hoteles publicados para ese destino",
  insufficientBody:
    "No inventamos hoteles. Podés mirar un destino cercano o agregar el primero desde Descubrir.",
} as const;

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

const STEP_COPY: Record<FirstRunStepId, { title: string; detail: string; href: string; optional: boolean }> =
  {
    destination: {
      title: FIRST_RUN_COPY.destinationTitle,
      detail: FIRST_RUN_COPY.destinationDetail,
      href: FIRST_RUN_HREFS.destination,
      optional: false,
    },
    hotel: {
      title: FIRST_RUN_COPY.hotelTitle,
      detail: FIRST_RUN_COPY.hotelDetail,
      href: FIRST_RUN_HREFS.hotels,
      optional: false,
    },
    pitch: {
      title: FIRST_RUN_COPY.pitchTitle,
      detail: FIRST_RUN_COPY.pitchDetail,
      href: FIRST_RUN_HREFS.pipeline,
      optional: true,
    },
  };

function step(id: FirstRunStepId, done: boolean): FirstRunStep {
  const meta = STEP_COPY[id];
  return { id, ...meta, done };
}

/** Remaining required steps. The optional pitch is not one of them. */
export function remainingRequired(facts: Pick<FirstRunFacts, "destination" | "saved">): number {
  return (facts.destination === "yes" ? 0 : 1) + (facts.saved === "yes" ? 0 : 1);
}

export function homeView(facts: FirstRunFacts): HomeView {
  if (
    facts.destination === "error" ||
    facts.saved === "error" ||
    facts.pitch === "error" ||
    facts.followUp === "error"
  ) {
    return {
      kind: "blocked",
      title: FIRST_RUN_COPY.blockedTitle,
      body: FIRST_RUN_COPY.blockedBody,
    };
  }

  const followUp = facts.followUp === "yes" ? "due" : "none";
  if (facts.dismissed) {
    return { kind: "hidden", followUp };
  }

  const steps = [
    step("destination", facts.destination === "yes"),
    step("hotel", facts.saved === "yes"),
    step("pitch", facts.pitch === "yes"),
  ];
  return {
    kind: "checklist",
    steps,
    remaining: remainingRequired(facts),
    followUp: followUp === "due" ? "due" : null,
  };
}

export function greeting(name: string | null, remaining: number): string {
  const who = name?.trim() ? name.trim() : "creador";
  if (remaining <= 0) return `Hola, ${who}.`;
  if (remaining === 1) return `Hola, ${who}. Te falta 1 paso.`;
  return `Hola, ${who}. Te faltan ${remaining} pasos.`;
}
