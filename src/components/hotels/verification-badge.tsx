/**
 * Editorial verification badge (DESIGN_SYSTEM.md §5, §7).
 *
 * Status is always conveyed by TEXT, with color only as reinforcement, so it
 * remains readable for color-blind users and in high-contrast modes.
 */
import { verificationLabel } from "@/lib/hotels/filters";

/**
 * Border + icon carry the colour; the LABEL uses the default text token so it
 * always meets contrast requirements (a small coloured caption on a tinted
 * surface does not).
 */
const TONE: Record<string, { border: string; icon: string }> = {
  verified: { border: "border-success/50", icon: "text-success" },
  needs_review: { border: "border-warning/50", icon: "text-warning" },
  stale: { border: "border-warning/50", icon: "text-warning" },
  unverified: { border: "border-border", icon: "text-muted" },
};

export function VerificationBadge({
  status,
  className = "",
}: {
  status: string | null;
  className?: string;
}) {
  const tone = TONE[status ?? "unverified"] ?? TONE.unverified!;
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-[var(--radius-app)] border px-2 py-0.5 text-xs font-medium text-text ${tone.border} ${className}`}
    >
      <span aria-hidden="true" className={tone.icon}>
        {status === "verified" ? "✓" : "•"}
      </span>
      {verificationLabel(status)}
    </span>
  );
}
