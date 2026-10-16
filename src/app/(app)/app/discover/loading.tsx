export default function Loading() {
  return (
    <div className="v12-stack" aria-busy="true">
      <span role="status" aria-live="polite" className="sr-only">
        Loading hotels…
      </span>
      <header className="v12-pagehead">
        <div>
          <div className="ux-sk-line" style={{ width: 180, height: 14 }} />
          <div className="ux-sk-line" style={{ width: 280, height: 36, marginTop: 10 }} />
        </div>
      </header>
      <section className="s1-panel s1-map" aria-hidden="true">
        <div className="ux-map-canvas" style={{ height: 245 }} />
      </section>
      <div className="ux-sk-line" style={{ width: "100%", height: 72 }} />
      <div className="ux-sk-line" style={{ width: "100%", height: 72 }} />
      <div className="ux-sk-line" style={{ width: "100%", height: 72 }} />
    </div>
  );
}
