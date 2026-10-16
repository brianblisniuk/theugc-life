export function Skeleton({ label = "Loading" }: { label?: string }) {
  return (
    <div className="v12-skeleton" aria-busy="true" aria-live="polite">
      <span className="v12-sr">{label}</span>
      <span className="v12-sk-line" />
      <span className="v12-sk-line is-short" />
      <span className="v12-sk-line" />
    </div>
  );
}
