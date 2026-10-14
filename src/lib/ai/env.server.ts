import "server-only";

/**
 * Server-only Anthropic settings (D141).
 *
 * Absent configuration refuses the call. These values are not part of
 * `serverEnv()`, so a deploy without a key still builds and still serves
 * template drafts.
 */

const KEY_NAME = "ANTHROPIC_API_KEY";

export function readAnthropicApiKey(): string | null {
  const value = process.env[KEY_NAME];
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (trimmed.length < 8) return null;
  return trimmed;
}
