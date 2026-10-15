function RowSkeleton() {
  return (
    <div className="ux-row" style={{ gridTemplateColumns: "120px minmax(0, 1fr)" }}>
      <div className="ux-sk-photo" />
      <div>
        <div className="ux-sk-line" style={{ width: "66%" }} />
        <div className="ux-sk-line" style={{ width: "45%" }} />
      </div>
    </div>
  );
}

export default function Loading() {
  return (
    <div className="ux-discover" aria-busy="true">
      <span role="status" aria-live="polite" className="sr-only">
        Loading hotels…
      </span>
      <div className="ux-list">
        <div className="ux-sk-line" style={{ width: 180, height: 32 }} />
        <div className="ux-sk-line" style={{ width: "70%" }} />
        <ul className="ux-rows">
          {Array.from({ length: 6 }).map((_, index) => (
            <li key={index}>
              <RowSkeleton />
            </li>
          ))}
        </ul>
      </div>
      <div className="ux-map-col">
        <div className="ux-map" />
      </div>
    </div>
  );
}
