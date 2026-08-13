/**
 * Editorial verification badge (DESIGN_SYSTEM.md §5, §7).
 *
 * Status is always conveyed by TEXT, with color only as reinforcement, so it
 * remains readable for color-blind users and in high-contrast modes.
 */
import { verificationLabel } from "@/lib/hotels/filters";

const TONE: Record<string, string> = {
  verified: "border-success/40 text-success",
  needs_review: "border-warning/40 text-warning",
  stale: "border-warning/40 text-warning",
  unverified: "border-border text-muted",
};

export function VerificationBadge({
  status,
  className = "",
}: {
  status: string | null;
  className?: string;
}) {
  const tone = TONE[status ?? "unverified"] ?? TONE.unverified;
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-[var(--radius-app)] border px-2 py-0.5 text-xs font-medium ${tone} ${className}`}
    >
      <span aria-hidden="true">{status === "verified" ? "✓" : "•"}</span>
      {verificationLabel(status)}
    </span>
  );
}
