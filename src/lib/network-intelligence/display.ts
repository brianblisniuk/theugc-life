/**
 * C02–C05 display decisions (D099).
 *
 * The database view is the gate. These functions only choose which already
 * suppressed fields are safe to render. A missing row is not zero, and an
 * insufficient band does not become a precise metric.
 */

export const GMAIL_CONFIRM_PROMPT = "¿Esto pasó así?";

export const NETWORK_BUILDING_COPY = {
  title: "Todavía no hay un dato de red",
  description:
    "La red anónima aparece cuando al menos tres creadoras distintas dejaron hechos confirmados. Mientras tanto, no hay una cifra.",
} as const;

export const NETWORK_INSUFFICIENT_COPY = {
  title: "Hay actividad, pero no alcanza",
  description:
    "Menos de cinco hechos confirmados no se muestran como un número. Insuficiente no es cero y no es un hotel malo.",
} as const;

export const NETWORK_ERROR_COPY = {
  title: "La red anónima no se pudo cargar",
  description: "Recargá la página para intentar de nuevo. Esto no dice que el hotel no tenga datos.",
} as const;

export const GMAIL_CONFIRMED_ADMITTED =
  "Confirmaste que sí. Quedó como dato de Gmail, separado de lo que registraste a mano.";

export const GMAIL_CONFIRMED_NOT_ADMITTED =
  "Confirmaste que sí. No entró a la red: no hay un hotel canónico único para este correo.";

export const GMAIL_DISMISSED = "Dijiste que no. Esta lectura no entra a la red.";

export const GMAIL_STALE =
  "Esta lectura está desactualizada y no entra a la red hasta que vuelva a estar vigente.";

export const PRIORITY_SAVED =
  "Marcaste este hotel como prioridad. Eso no cambia el dato de la red.";

export interface NetworkPublicRow {
  confidenceLevel: "insufficient" | "emerging" | "moderate" | "strong" | null;
  activityLevel: string | null;
  hasObservedCollaboration: boolean | null;
  recencyBand: string | null;
  freshnessBand: string | null;
}

export type NetworkPanelState = "signal" | "insufficient" | "building" | "error";

const CONFIDENCE = new Set(["insufficient", "emerging", "moderate", "strong"]);

export function confidenceBand(sampleSize: number): NetworkPublicRow["confidenceLevel"] {
  if (!Number.isInteger(sampleSize) || sampleSize < 0) return null;
  if (sampleSize >= 50) return "strong";
  if (sampleSize >= 15) return "moderate";
  if (sampleSize >= 5) return "emerging";
  return "insufficient";
}

/** A published row still hides precise fields while the band is insufficient. */
export function networkPanelState(
  result: { status: "ok"; row: NetworkPublicRow } | { status: "none" } | { status: "error" },
): NetworkPanelState {
  if (result.status === "error") return "error";
  if (result.status === "none") return "building";
  const row = result.row;
  if (row.confidenceLevel === "insufficient" || row.confidenceLevel === null) return "insufficient";
  const hasSignal =
    Boolean(row.activityLevel) ||
    Boolean(row.recencyBand) ||
    Boolean(row.freshnessBand) ||
    row.hasObservedCollaboration === true;
  return hasSignal ? "signal" : "insufficient";
}

export function activityLabel(level: string | null): string | null {
  if (level === "emerging") return "Actividad emergente";
  if (level === "medium") return "Actividad moderada";
  if (level === "high") return "Actividad fuerte";
  return null;
}

export function recencyLabel(band: string | null): string | null {
  if (band === "past_month") return "Actividad en el último mes";
  if (band === "past_quarter") return "Actividad en el último trimestre";
  if (band === "older") return "Actividad anterior";
  return null;
}

export function responseTimeBandLabel(band: string | null): string | null {
  if (band === "under_24h") return "Menos de 24 h";
  if (band === "1_3_days") return "1–3 días";
  if (band === "3_7_days") return "3–7 días";
  if (band === "1_2_weeks") return "1–2 semanas";
  if (band === "2_plus_weeks") return "2 semanas o más";
  return null;
}

const FACT_LABEL: Record<string, string> = {
  pitch_sent: "Pitch enviado",
  followup_sent: "Seguimiento enviado",
  reply_received: "Respuesta recibida",
  positive_reply: "Respuesta positiva",
  negative_reply: "Respuesta negativa",
  offer_received: "Oferta recibida",
  negotiation_started: "Negociación iniciada",
  deal_won: "Acuerdo registrado",
  deal_lost: "Cierre sin acuerdo",
  collaboration_started: "Colaboración iniciada",
  collaboration_completed: "Colaboración completada",
  creator_closed_pipeline: "Ciclo cerrado",
  collaboration_type_observed: "Tipo de colaboración",
  gmail_thread_commercial_state: "Lectura del hilo",
  gmail_human_reply_observed: "Respuesta humana observada",
  gmail_reply_latency: "Tiempo de respuesta observado",
};

export function factTypeLabel(factType: string): string {
  return FACT_LABEL[factType] ?? "Hecho confirmado";
}

export function parseConfidence(value: unknown): NetworkPublicRow["confidenceLevel"] {
  return typeof value === "string" && CONFIDENCE.has(value)
    ? (value as NetworkPublicRow["confidenceLevel"])
    : null;
}

export function gmailPromptCopy(result: string): string | null {
  if (result === "confirmed_admitted") return GMAIL_CONFIRMED_ADMITTED;
  if (result === "confirmed_not_admitted") return GMAIL_CONFIRMED_NOT_ADMITTED;
  if (result === "dismissed") return GMAIL_DISMISSED;
  if (result === "stale") return GMAIL_STALE;
  return null;
}
