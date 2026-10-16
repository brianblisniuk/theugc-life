export function Stat({ label, value, note }: { label: string; value: string; note?: string }) {
  return (
    <article className="v12-stat">
      <div className="v12-stat-label">{label}</div>
      <div className="v12-stat-value">{value}</div>
      {note ? <div className="v12-stat-note">{note}</div> : null}
    </article>
  );
}
