/**
 * Discover result row (PRD §7.2, D058).
 *
 * Public identity, disclosed public intelligence, and the viewer's own
 * pipeline/trip badges. Premium contacts and premium metrics are not props.
 * A null badge load is unknown and renders no "not saved" / "not on a trip".
 */
import Link from "next/link";

import { NoPhoto } from "@/components/hotels/no-photo";
import { StarRating } from "@/components/hotels/star-rating";
import {
  hasPublicCardSignal,
  shouldShowPipelineBadge,
  shouldShowTripBadge,
  type CreatorBadge,
  type PublicCardSignal,
} from "@/lib/hotels/card-signal";
import { hotelTypeLabel } from "@/lib/hotels/filters";
import type { HotelSummary } from "@/lib/hotels/queries";

const CLOSED_LABEL: Record<string, string> = {
  temporarily_closed: "Temporarily closed",
};

export function HotelCard({
  hotel,
  signal,
  badge,
}: {
  hotel: HotelSummary;
  signal: PublicCardSignal | null;
  /** Null when the viewer's own state could not be read. */
  badge: CreatorBadge | null;
}) {
  const href = `/app/hotels/${hotel.id}`;
  const location = [hotel.destination?.name, hotel.countryCode].filter(Boolean).join(" · ");
  const type = hotelTypeLabel(hotel.hotelType);
  const showSignal = hasPublicCardSignal(signal);
  const pipeline =
    badge && shouldShowPipelineBadge(badge) && badge.pipeline.kind === "status"
      ? badge.pipeline.label
      : null;
  const onTrip = shouldShowTripBadge(badge);

  return (
    <article className="grid grid-cols-[4.5rem_minmax(0,1fr)] gap-3 py-3">
      <NoPhoto name={hotel.name} />
      <div className="min-w-0 space-y-1">
        <h3 className="text-base font-semibold text-text">
          <Link href={href} className="hover:underline">
            {hotel.name}
          </Link>
        </h3>
        {location ? <p className="text-sm text-muted">{location}</p> : null}
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          {type ? <span className="text-xs text-muted">{type}</span> : null}
          <StarRating rating={hotel.starRating} />
          {CLOSED_LABEL[hotel.activeStatus] ? (
            <span className="text-xs text-text">{CLOSED_LABEL[hotel.activeStatus]}</span>
          ) : null}
        </div>
        {showSignal && signal ? (
          <p className="text-sm text-text">
            {[
              signal.activity,
              signal.recency,
              signal.collaborationObserved ? "Creator collaboration observed" : null,
            ]
              .filter(Boolean)
              .join(" · ")}
          </p>
        ) : null}
        {pipeline || onTrip ? (
          <p className="text-xs text-muted">
            {[pipeline, onTrip ? "On a trip" : null].filter(Boolean).join(" · ")}
          </p>
        ) : null}
        <p>
          <Link href={href} className="text-sm font-medium text-text underline hover:no-underline">
            View hotel
          </Link>
        </p>
      </div>
    </article>
  );
}
