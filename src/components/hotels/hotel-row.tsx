import Link from "next/link";

import { SaveHotelButton } from "@/components/pipeline/save-hotel-button";
import { MetricRing, MetricValue } from "@/components/hotels/metric-ring";
import {
  pipelineBadgeLabel,
  shouldShowPipelineBadge,
  shouldShowTripBadge,
  type CreatorBadge,
  type PublicCardSignal,
} from "@/lib/hotels/card-signal";
import { hotelTypeLabel } from "@/lib/hotels/filters";
import type { HotelSummary } from "@/lib/hotels/queries";
import { initialsFromName } from "@/lib/screens/initials";
import { ON_TRIP } from "@/lib/screens/copy";
import { activityTag, type DiscoverFigures } from "@/lib/screens/discover-figures";
import { isPublishedStarRating } from "@/lib/hotels/publication";

const CLOSED_LABEL: Record<string, string> = {
  temporarily_closed: "Temporarily closed",
};

const EMPTY_FIGURES: DiscoverFigures = {
  replyRate: { state: "error" },
  replyTime: { state: "error" },
  activity: { state: "error" },
};

export function HotelRow({
  hotel,
  signal,
  badge,
  rankLine = null,
  href,
  figures = EMPTY_FIGURES,
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
  href: string;
  figures?: DiscoverFigures;
}) {
  const location = [hotel.destination?.name, hotel.countryCode].filter(Boolean).join(" · ");
  const type = hotelTypeLabel(hotel.hotelType);
  const place = [location, type].filter(Boolean).join(" · ");
  const initials = initialsFromName(hotel.name);
  const classification =
    hotel.starRating !== null && isPublishedStarRating(hotel.starRating)
      ? `${hotel.starRating}-star classification`
      : null;
  const tag = activityTag(figures.activity, signal?.activity ?? null);
  const pipeline = shouldShowPipelineBadge(badge) ? pipelineBadgeLabel(badge) : null;
  const onTrip = shouldShowTripBadge(badge);
  const saved = badge?.pipeline.kind === "status" || badge?.pipeline.kind === "several";

  return (
    <>
      <Link className="s1-identity" href={href}>
        <span className="s1-hotelmark">
          <span className="sr-only">No photograph. Initials </span>
          {initials}
        </span>
        <span>
          <span className="s1-name">{hotel.name}</span>
          {place ? <span className="s1-place">{place}</span> : null}
          {classification ? <span className="s1-place">{classification}</span> : null}
          {tag.state === "value" ? <span className="s1-tag">✧ {tag.text}</span> : null}
          {tag.state === "insufficient" ? (
            <span className="s1-tag">✧ Insufficient data</span>
          ) : null}
          {tag.state === "error" ? <span className="s1-tag">✧ Couldn&rsquo;t load activity</span> : null}
          {CLOSED_LABEL[hotel.activeStatus] ? (
            <span className="s1-place">{CLOSED_LABEL[hotel.activeStatus]}</span>
          ) : null}
          {rankLine ? (
            <span className="s1-place" data-testid="hotel-rank-line">
              {rankLine.rank}. {rankLine.title}: {rankLine.valueLabel}
              {rankLine.sampleBasis ? ` · ${rankLine.sampleBasis}` : ""}
            </span>
          ) : null}
          {pipeline || onTrip ? (
            <span className="s1-chips">
              {pipeline ? <span className="v12-badge v12-badge-lime">{pipeline}</span> : null}
              {onTrip ? <span className="v12-badge">{ON_TRIP}</span> : null}
            </span>
          ) : null}
        </span>
      </Link>
      <MetricRing figure={figures.replyRate} label="Reply rate" />
      <MetricValue figure={figures.replyTime} label="Typical reply time" />
      <div className="s1-row-actions" style={{ justifyContent: "space-between" }}>
        <Link className="v12-btn v12-btn-small" href={href}>
          View hotel
        </Link>
        {saved ? (
          <Link className="s1-icon-save" href="/app/pipeline" aria-pressed="true" aria-label="Saved. View in Pipeline">
            <Bookmark filled />
          </Link>
        ) : (
          <SaveHotelButton hotelId={hotel.id} idle="Save" pendingLabel="Saving…" appearance="icon" />
        )}
      </div>
    </>
  );
}

function Bookmark({ filled }: { filled?: boolean }) {
  return (
    <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true" fill={filled ? "currentColor" : "none"} stroke="currentColor" strokeWidth="1.7">
      <path d="M6 3h12v18l-6-4-6 4z" />
    </svg>
  );
}
