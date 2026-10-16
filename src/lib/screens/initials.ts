/**
 * Compact initials for a hotel that has no verified photograph.
 * This is a placeholder, not an image URL and not a stock photo.
 */

const PARTICLES = new Set(["de", "del", "do", "da", "la", "las", "los", "the", "of", "and"]);

function bare(word: string): string {
  return word
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{M}/gu, "");
}

/** First letter of the first two significant words. One word uses two letters. */
export function initialsFromName(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return "·";
  const significant = words.filter((word, index) => index === 0 || !PARTICLES.has(bare(word)));
  const first = significant[0] ?? words[0]!;
  const second = significant[1];
  if (!second) return first.slice(0, 2).toUpperCase();
  return `${first.charAt(0)}${second.charAt(0)}`.toUpperCase();
}
