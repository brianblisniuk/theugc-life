export function Card({
  children,
  title,
  description,
}: {
  children?: React.ReactNode;
  title?: string;
  description?: string;
}) {
  return (
    <section className="v12-card v12-card-pad">
      {title ? (
        <h2 style={{ margin: "0 0 8px", fontSize: 21, letterSpacing: "-0.72px" }}>{title}</h2>
      ) : null}
      {description ? (
        <p style={{ margin: "0 0 12px", color: "var(--muted)" }}>{description}</p>
      ) : null}
      {children}
    </section>
  );
}
