/**
 * Four visual steps from Getting Started. Contact review is done when this
 * creator owns a contact unlock. A failed unlock read is not "not reviewed".
 */
export type PathMark = "done" | "current" | "upcoming";

export const FIRST_PITCH_STEPS = [
  { title: "Choose your goal", detail: "Which creator task matters right now?" },
  { title: "Find the right hotel", detail: "Discover or use an existing Trip shortlist." },
  { title: "Review the contact", detail: "Know exactly what unlocking provides." },
  { title: "Prepare your first pitch", detail: "Finish a useful draft, not endless setup." },
] as const;

export function firstPitchMarks(
  input: {
    destination: boolean;
    saved: boolean;
    pitch: boolean;
    /** True when this account owns a contact unlock. "unknown" is a failed read. */
    contact: boolean | "unknown";
  } | null,
): PathMark[] {
  if (!input) return ["upcoming", "upcoming", "upcoming", "upcoming"];
  const contactDone = input.contact === true;
  const goal: PathMark = input.destination ? "done" : "current";
  const hotel: PathMark = input.saved ? "done" : input.destination ? "current" : "upcoming";
  const contact: PathMark = contactDone
    ? "done"
    : input.contact === "unknown"
      ? "upcoming"
      : input.destination && input.saved
        ? "current"
        : "upcoming";
  const pitch: PathMark = input.pitch
    ? "done"
    : input.destination && input.saved && contactDone
      ? "current"
      : "upcoming";
  return [goal, hotel, contact, pitch];
}
