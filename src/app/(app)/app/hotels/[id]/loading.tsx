function Block({ className = "" }: { className?: string }) {
  return <div className={`ux-sk-line ${className}`} />;
}

export default function Loading() {
  return (
    <div className="ux-hotel" aria-busy="true">
      <span role="status" aria-live="polite" className="sr-only">
        Loading hotel…
      </span>
      <div className="ux-hotel-main">
        <Block className="" />
        <div className="ux-hero" />
        <div className="ux-sk-line" style={{ width: "40%" }} />
      </div>
      <div className="ux-side" />
    </div>
  );
}
