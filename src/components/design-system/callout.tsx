const TONES = {
  info: "",
  warn: "is-warn",
  neutral: "is-neutral",
} as const;

export function Callout({
  tone = "info",
  title,
  children,
}: {
  tone?: keyof typeof TONES;
  title?: string;
  children: React.ReactNode;
}) {
  return (
    <div className={["v12-callout", TONES[tone]].filter(Boolean).join(" ")} role="note">
      {title ? <strong>{title}</strong> : null} {children}
    </div>
  );
}
