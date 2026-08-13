/**
 * Authenticated hotel workspace (PRD §7.3, ROUTES.md §4 — UUID, never slug).
 *
 * Section order is fixed by DESIGN_SYSTEM.md §3:
 *   1. identity/location  2. creator intelligence  3. premium contact
 *   4. the creator's private relationship
 *
 * Premium contacts are authorized BEFORE they are fetched: when the database
 * says the caller has no access, the contact query is never issued, so no
 * email/phone/LinkedIn value is loaded, rendered, or serialized.
 *
 * Internal import/provenance fields are never surfaced here.
 */
import { cache } from "react";
import Link from "next/link";
import { notFound } from "next/navigation";
import type { Metadata } from "next";

import { AnalyticsPageView } from "@/components/analytics-page-view";
import { ActivityPanel } from "@/components/hotels/activity-panel";
import { ContactCard } from "@/components/hotels/contact-card";
import { IntelligencePanel } from "@/components/hotels/intelligence-panel";
import { LockedContactSection } from "@/components/hotels/locked-contact";
import { StarRating } from "@/components/hotels/star-rating";
import { VerificationBadge } from "@/components/hotels/verification-badge";
import { hotelTypeLabel } from "@/lib/hotels/filters";
import {
  getHotelById,
  getHotelContactsIfAuthorized,
  getHotelIntelligence,
} from "@/lib/hotels/queries";

/** Deduped per request so metadata and the page share one fetch. */
const loadHotel = cache(getHotelById);

export async function generateMetadata({
  params,
}: {
  params: Promise<{ id: string }>;
}): Promise<Metadata> {
  const { id } = await params;
  try {
    const hotel = await loadHotel(id);
    return { title: hotel?.name ?? "Hotel not found" };
  } catch {
    return { title: "Hotel" };
  }
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="space-y-3">
      <h2 className="text-lg font-semibold text-text">{title}</h2>
      {children}
    </section>
  );
}

const ACTIVE_STATUS_LABEL: Record<string, string> = {
  temporarily_closed: "Temporarily closed",
  closed: "Closed",
};

export default async function HotelDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  const hotel = await loadHotel(id);
  if (!hotel) notFound();

  // Access is resolved first; contacts are only fetched when authorized.
  const [{ access, contacts, failed: contactsFailed }, intelligence] = await Promise.all([
    getHotelContactsIfAuthorized(hotel.id),
    getHotelIntelligence(hotel.id),
  ]);

  const location = [hotel.destination?.name, hotel.countryCode].filter(Boolean).join(" · ");
  const type = hotelTypeLabel(hotel.hotelType);
  const statusNote = ACTIVE_STATUS_LABEL[hotel.activeStatus];

  return (
    <div className="space-y-8">
      <AnalyticsPageView event="hotel_viewed" />

      <p className="text-sm">
        <Link href="/app/discover" className="text-muted underline hover:text-text">
          ← Back to Discover
        </Link>
      </p>

      {/* 1. Identity / location */}
      <header className="space-y-3">
        <div className="space-y-1">
          <h1 className="text-2xl font-semibold text-text">{hotel.name}</h1>
          {location ? <p className="text-sm text-muted">{location}</p> : null}
          {hotel.address ? <p className="text-sm text-muted">{hotel.address}</p> : null}
        </div>

        <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
          <VerificationBadge status={hotel.verificationStatus} />
          {type ? <span className="text-sm text-muted">{type}</span> : null}
          <StarRating rating={hotel.starRating} />
          {statusNote ? (
            <span className="rounded-[var(--radius-app)] border border-warning/40 px-2 py-0.5 text-xs font-medium text-warning">
              {statusNote}
            </span>
          ) : null}
        </div>

        {(hotel.websiteUrl || hotel.instagramUrl) && (
          <div className="flex flex-wrap gap-3 text-sm">
            {hotel.websiteUrl ? (
              <a
                href={hotel.websiteUrl}
                target="_blank"
                rel="noreferrer noopener"
                className="underline hover:no-underline"
              >
                {`Official website for ${hotel.name}`}
              </a>
            ) : null}
            {hotel.instagramUrl ? (
              <a
                href={hotel.instagramUrl}
                target="_blank"
                rel="noreferrer noopener"
                className="underline hover:no-underline"
              >
                {`Instagram profile for ${hotel.name}`}
              </a>
            ) : null}
          </div>
        )}
      </header>

      {/* 2. Creator intelligence */}
      <Section title="Creator intelligence">
        <IntelligencePanel intelligence={intelligence} />
      </Section>

      {/* 3. Premium contact */}
      <Section title="Hotel contact">
        {access.canViewContacts ? (
          contacts.length > 0 ? (
            <div className="grid gap-4 md:grid-cols-2">
              {contacts.map((contact) => (
                <ContactCard key={contact.id} contact={contact} />
              ))}
            </div>
          ) : contactsFailed ? (
            // A failed fetch must never be reported as "this hotel has no
            // contact" — that would be a false product fact for a paying user.
            <div className="rounded-[var(--radius-app)] border border-border bg-surface p-6">
              <h3 className="text-base font-semibold text-text">
                Contact details couldn’t be loaded
              </h3>
              <p className="mt-2 max-w-prose text-sm text-muted">
                This is a temporary problem on our side, not a missing contact. Reload the page to
                try again.
              </p>
            </div>
          ) : (
            <div className="rounded-[var(--radius-app)] border border-border bg-surface p-6">
              <h3 className="text-base font-semibold text-text">No contact on file yet</h3>
              <p className="mt-2 max-w-prose text-sm text-muted">
                We haven’t published a verified contact for this hotel yet. It will appear here once
                our editorial team verifies one.
              </p>
            </div>
          )
        ) : (
          <LockedContactSection />
        )}
      </Section>

      {/* 4. The creator's private relationship */}
      <Section title="Your activity">
        <ActivityPanel />
      </Section>
    </div>
  );
}
