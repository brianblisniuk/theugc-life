/**
 * Discover result row (PRD §7.2, D058).
 *
 * Public identity, disclosed public intelligence, and the viewer's own
 * pipeline/trip badges. Premium contacts and premium metrics are not props.
 * A null badge load is unknown and renders no "not saved" / "not on a trip".
 */
import Link from "next/link";

import { NoPhoto } from "@/components/hotels/no-photo";
import { SaveHotelButton } from "@/components/pipeline/save-hotel-button";
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
    <article className="grid grid-cols-1 gap-3 border-b border-[#ececec] py-3 sm:grid-cols-[7rem_minmax(0,1fr)_auto] sm:items-center sm:gap-4">
      <NoPhoto name={hotel.name} />
      <div className="min-w-0 space-y-1">
        <h3 className="text-lg font-extrabold tracking-tight text-text">
          <Link href={href} className="hover:underline">
            {hotel.name}
          </Link>
        </h3>
        {location || type ? (
          <p className="text-[13px] text-[#555]">{[location, type].filter(Boolean).join(" · ")}</p>
        ) : null}
        <StarRating rating={hotel.starRating} />
        {CLOSED_LABEL[hotel.activeStatus] ? (
          <p className="text-xs text-text">{CLOSED_LABEL[hotel.activeStatus]}</p>
        ) : null}
        {showSignal && signal ? (
          <p className="text-sm font-semibold text-[#0b6b4b]">
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
          <p className="text-xs text-[#555]">
            {[pipeline, onTrip ? "On a trip" : null].filter(Boolean).join(" · ")}
          </p>
        ) : null}
      </div>
      <div className="flex flex-col items-end gap-2">
        {pipeline ? (
          <Link
            href={`${href}?from=pipeline`}
            className="inline-flex rounded-md bg-accent px-4 py-2 text-sm font-semibold text-accent-contrast"
          >
            Guardado
          </Link>
        ) : (
          <SaveHotelButton hotelId={hotel.id} idle="Guardar" pendingLabel="Guardando…" />
        )}
      </div>
    </article>
  );
}
