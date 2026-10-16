const TONES = {
  neutral: "",
  green: "is-green",
  amber: "is-amber",
  blue: "is-blue",
  gray: "is-gray",
  red: "is-red",
  lime: "is-lime",
} as const;

export type PillTone = keyof typeof TONES;

export function Pill({
  tone = "neutral",
  children,
}: {
  tone?: PillTone;
  children: React.ReactNode;
}) {
  return <span className={["v12-pill", TONES[tone]].filter(Boolean).join(" ")}>{children}</span>;
}
