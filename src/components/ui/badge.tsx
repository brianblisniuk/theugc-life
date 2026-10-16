export type BadgeTone = "neutral" | "green" | "amber" | "blue" | "red" | "gray" | "lime";

const TONE: Record<BadgeTone, string> = {
  neutral: "",
  green: "v12-badge-green",
  amber: "v12-badge-amber",
  blue: "v12-badge-blue",
  red: "v12-badge-red",
  gray: "v12-badge-gray",
  lime: "v12-badge-lime",
};

export function Badge({
  tone = "neutral",
  children,
}: {
  tone?: BadgeTone;
  children: React.ReactNode;
}) {
  return <span className={`v12-badge ${TONE[tone]}`.trim()}>{children}</span>;
}

/** Provenance. Gmail evidence and a creator's own note are never the same badge. */
export function SourceBadge({ source }: { source: "gmail" | "manual" }) {
  if (source === "gmail") return <Badge tone="green">Verified via Gmail</Badge>;
  return <Badge tone="amber">Manually recorded</Badge>;
}
