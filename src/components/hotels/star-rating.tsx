/**
 * Hospitality classification (D060). Not a guest-review score.
 * Fractional or out-of-scope ratings render nothing — they are not rounded
 * and they are not shown as zero.
 */
import { hospitalityClassificationLabel } from "@/lib/hotels/publication";

export function StarRating({ rating }: { rating: number | null }) {
  const label = hospitalityClassificationLabel(rating);
  if (!label) return null;
  return <span className="text-xs text-muted">{label}</span>;
}
