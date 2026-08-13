/**
 * Star rating display. The rating is announced as text for assistive tech; the
 * star glyphs are decorative only (DESIGN_SYSTEM.md §7).
 */
export function StarRating({ rating }: { rating: number | null }) {
  if (rating === null) return null;
  const rounded = Math.round(rating * 10) / 10;
  const filled = Math.floor(rounded);
  const half = rounded - filled >= 0.5;

  return (
    <span className="inline-flex items-center gap-1 text-xs text-muted">
      <span aria-hidden="true" className="text-warning">
        {"★".repeat(filled)}
        {half ? "☆" : ""}
      </span>
      <span>{rounded} out of 5 stars</span>
    </span>
  );
}
