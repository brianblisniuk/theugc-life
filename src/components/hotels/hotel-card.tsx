/**
 * Discover result card (PRD §7.2).
 *
 * Shows identity + location + editorial verification only. Premium contact data
 * must never appear on a card, and — because creator intelligence is currently
 * empty — no activity label is rendered at all rather than implying a zero
 * (PRD §12.7: absence of data is not negative data).
 */
import Link from "next/link";

import { StarRating } from "@/components/hotels/star-rating";
import { VerificationBadge } from "@/components/hotels/verification-badge";
import { hotelTypeLabel } from "@/lib/hotels/filters";
import type { HotelSummary } from "@/lib/hotels/queries";

export function HotelCard({ hotel }: { hotel: HotelSummary }) {
  const href = `/app/hotels/${hotel.id}`;
  const location = [hotel.destination?.name, hotel.countryCode].filter(Boolean).join(" · ");
  const type = hotelTypeLabel(hotel.hotelType);

  return (
    <article className="flex h-full flex-col justify-between gap-3 rounded-[var(--radius-app)] border border-border bg-surface p-4">
      <div className="space-y-2">
        <h3 className="text-base font-semibold text-text">
          <Link href={href} className="hover:underline">
            {hotel.name}
          </Link>
        </h3>

        {location ? <p className="text-sm text-muted">{location}</p> : null}

        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          {type ? <span className="text-xs text-muted">{type}</span> : null}
          <StarRating rating={hotel.starRating} />
        </div>

        <div className="flex flex-wrap items-center gap-2 pt-1">
          <VerificationBadge status={hotel.verificationStatus} />
          {hotel.websiteUrl ? <span className="text-xs text-muted">Website on file</span> : null}
        </div>
      </div>

      <div>
        <Link
          href={href}
          aria-label={`View hotel ${hotel.name}`}
          className="inline-flex rounded-[var(--radius-app)] border border-border px-3 py-1.5 text-sm font-medium text-text hover:bg-background"
        >
          View hotel
        </Link>
      </div>
    </article>
  );
}
