/**
 * Four visual steps from Getting Started. Contact review is not stored, so it
 * is never marked done.
 */
export type PathMark = "done" | "current" | "upcoming";

export const FIRST_PITCH_STEPS = [
  { title: "Choose your goal", detail: "Which creator task matters right now?" },
  { title: "Find the right hotel", detail: "Discover or use an existing Trip shortlist." },
  {
    title: "Review the contact",
    detail: "Know exactly what unlocking provides. This page does not mark that review done.",
  },
  { title: "Prepare your first pitch", detail: "Finish a useful draft, not endless setup." },
] as const;

export function firstPitchMarks(input: {
  destination: boolean;
  saved: boolean;
  pitch: boolean;
} | null): PathMark[] {
  if (!input) return ["upcoming", "upcoming", "upcoming", "upcoming"];
  const goal: PathMark = input.destination ? "done" : "current";
  const hotel: PathMark = input.saved ? "done" : input.destination ? "current" : "upcoming";
  const contact: PathMark = "upcoming";
  const pitch: PathMark = input.pitch
    ? "done"
    : input.destination && input.saved
      ? "current"
      : "upcoming";
  return [goal, hotel, contact, pitch];
}
