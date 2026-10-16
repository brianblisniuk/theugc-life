export function Panel({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <section className={["v12-panel", "v12-pad", className ?? ""].filter(Boolean).join(" ")}>
      {children}
    </section>
  );
}
