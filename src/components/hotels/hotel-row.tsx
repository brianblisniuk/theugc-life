import Link from "next/link";

import { SaveHotelButton } from "@/components/pipeline/save-hotel-button";
import {
  shouldShowPipelineBadge,
  shouldShowTripBadge,
  type CreatorBadge,
  type PublicCardSignal,
} from "@/lib/hotels/card-signal";
import { hotelTypeLabel } from "@/lib/hotels/filters";
import type { HotelSummary } from "@/lib/hotels/queries";
import { initialsFromName } from "@/lib/screens/initials";
import { ON_TRIP } from "@/lib/screens/copy";
import { pipelineChipLabel } from "@/lib/screens/next-step";
import { isPublishedStarRating } from "@/lib/hotels/publication";

const CLOSED_LABEL: Record<string, string> = {
  temporarily_closed: "Temporarily closed",
};

export function HotelRow({
  hotel,
  signal,
  badge,
  rankLine = null,
}: {
  hotel: HotelSummary;
  signal: PublicCardSignal | null;
  badge: CreatorBadge | null;
  rankLine?: {
    rank: number;
    title: string;
    valueLabel: string;
    sampleBasis: string | null;
  } | null;
}) {
  const href = `/app/hotels/${hotel.id}`;
  const location = [hotel.destination?.name, hotel.countryCode].filter(Boolean).join(", ");
  const type = hotelTypeLabel(hotel.hotelType);
  const place = [location, type].filter(Boolean).join(" · ");
  const initials = initialsFromName(hotel.name);
  const classification =
    hotel.starRating !== null && isPublishedStarRating(hotel.starRating)
      ? `${hotel.starRating}-star classification`
      : null;
  const signals = [
    signal?.activity ?? null,
    signal?.collaborationObserved ? "Creator collaboration observed" : null,
  ].filter((item): item is string => Boolean(item));
  const pipeline =
    badge && shouldShowPipelineBadge(badge) && badge.pipeline.kind === "status"
      ? badge.pipeline.label
      : null;
  const onTrip = shouldShowTripBadge(badge);
  const saved = Boolean(pipeline);

  return (
    <>
      <Link className="ux-row-link" href={href}>
        <span className="ux-photo">
          <span className="sr-only">No photograph. Initials </span>
          {initials}
        </span>
        <span className="ux-stack-sm">
          <span className="ux-name">{hotel.name}</span>
          {place ? <span className="ux-meta">{place}</span> : null}
          {classification ? <span className="ux-meta">{classification}</span> : null}
          {signals.length > 0 ? <span className="ux-signal">{signals.slice(0, 2).join(" · ")}</span> : null}
          {CLOSED_LABEL[hotel.activeStatus] ? (
            <span className="ux-meta" style={{ color: "var(--warning)", fontWeight: 600 }}>
              {CLOSED_LABEL[hotel.activeStatus]}
            </span>
          ) : null}
          {rankLine ? (
            <span className="ux-meta" data-testid="hotel-rank-line">
              {rankLine.rank}. {rankLine.title}: {rankLine.valueLabel}
              {rankLine.sampleBasis ? ` · ${rankLine.sampleBasis}` : ""}
            </span>
          ) : null}
          {pipeline || onTrip ? (
            <span className="ux-wrap">
              {pipeline ? <span className="ux-tag ux-tag-private">{pipelineChipLabel(pipeline)}</span> : null}
              {onTrip ? <span className="ux-tag ux-tag-private">{ON_TRIP}</span> : null}
            </span>
          ) : null}
        </span>
      </Link>
      <div className="ux-stack-sm" style={{ alignItems: "flex-end" }}>
        {saved ? (
          <button type="button" className="ux-btn" aria-pressed="true">
            Saved
          </button>
        ) : (
          <SaveHotelButton hotelId={hotel.id} idle="Save" pendingLabel="Saving…" />
        )}
      </div>
    </>
  );
}
