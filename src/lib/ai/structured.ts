/**
 * Structured pitch brief (D166).
 *
 * The model never receives a free-form instruction box. Tone, language, and
 * key points are the only creator text, and each one has a closed shape.
 */

export const PITCH_TONES = ["professional", "warm", "direct", "concise"] as const;

export type PitchTone = (typeof PITCH_TONES)[number];

export const PITCH_LANGUAGES = [
  "English",
  "Spanish",
  "Portuguese",
  "French",
  "German",
  "Italian",
] as const;

export type PitchLanguage = (typeof PITCH_LANGUAGES)[number];

const POINT = /^[\p{L}\p{N} .,;:'"!?()\-]{1,160}$/u;

export interface PitchBrief {
  tone: PitchTone;
  language: PitchLanguage;
  keyPoints: readonly string[];
}

export type BriefResult =
  | { ok: true; brief: PitchBrief }
  | { ok: false; message: string };

export function parsePitchBrief(input: {
  tone: string;
  language: string;
  keyPoints: readonly string[];
}): BriefResult {
  if (!PITCH_TONES.includes(input.tone as PitchTone)) {
    return { ok: false, message: "Choose a tone." };
  }
  if (!PITCH_LANGUAGES.includes(input.language as PitchLanguage)) {
    return { ok: false, message: "Choose a language." };
  }
  const points: string[] = [];
  for (const raw of input.keyPoints) {
    const point = raw.replace(/[\u0000\r\n]/g, " ").replace(/[ \t]{2,}/g, " ").trim();
    if (!point) continue;
    if (point.includes("@") || !POINT.test(point)) {
      return { ok: false, message: "Keep each point to one short sentence, without an email address." };
    }
    if (!points.includes(point)) points.push(point);
    if (points.length > 5) {
      return { ok: false, message: "Use at most five key points." };
    }
  }
  if (points.length < 1) {
    return { ok: false, message: "Add at least one key point." };
  }
  return {
    ok: true,
    brief: {
      tone: input.tone as PitchTone,
      language: input.language as PitchLanguage,
      keyPoints: points,
    },
  };
}
