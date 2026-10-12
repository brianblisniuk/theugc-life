/**
 * Authenticated hotel workspace (PRD §7.3, ROUTES.md §4 — UUID, never slug).
 *
 * Section order is fixed by DESIGN_SYSTEM.md §3:
 *   1. identity/location  2. creator intelligence  3. premium contact
 *   4. the creator's private relationship
 *
 * Premium contacts and Premium Intelligence are both authorized BEFORE they are
 * fetched: when the database says the caller has no access, neither query is
 * issued, so no protected value is loaded, rendered, or serialized. One
 * entitlement answer drives both, so the two sections can never disagree about
 * whether this creator has access.
 *
 * Internal import/provenance fields are never surfaced here.
 */
import { cache } from "react";
import { notFound } from "next/navigation";
import type { Metadata } from "next";

import { AnalyticsPageView } from "@/components/analytics-page-view";
import { ActivityPanel } from "@/components/hotels/activity-panel";
import { AddToTrip } from "@/components/hotels/add-to-trip";
import { ContactCard } from "@/components/hotels/contact-card";
import { HotelMap } from "@/components/hotels/hotel-map";
import {
  IntelligencePanel,
  PremiumIntelligencePanel,
} from "@/components/hotels/intelligence-panel";
import { LockedContactSection } from "@/components/hotels/locked-contact";
import { NoPhoto } from "@/components/hotels/no-photo";
import { StarRating } from "@/components/hotels/star-rating";
import { VerificationBadge } from "@/components/hotels/verification-badge";
import { HotelSectionNav } from "@/components/shell/hotel-section-nav";
import { PageHeader } from "@/components/shell/page-header";
import { resolveSession } from "@/lib/auth/guards";
import { getCollaborationWorkspace } from "@/lib/collaboration/queries";
import { getInboxUnity, listConnectedMailboxes } from "@/lib/inbox-pipeline/queries";
import { contactSectionState } from "@/lib/hotels/access";
import { hotelTypeLabel } from "@/lib/hotels/filters";
import { premiumIntelligenceState } from "@/lib/hotels/intelligence";
import {
  getHotelById,
  getHotelContactsIfAuthorized,
  getHotelIntelligence,
  getHotelPremiumIntelligence,
  loadSessionCreatorBadges,
} from "@/lib/hotels/queries";
import { getCycleCollaboration, getOpenRelationship } from "@/lib/pipeline/queries";
import {
  backLink,
  hotelCrumbs,
  parseHotelOrigin,
  pipelineReturnHref,
} from "@/lib/shell/navigation";
import { listTrips } from "@/lib/trips/queries";

/** Deduped per request so metadata and the page share one fetch. */
const loadHotel = cache(getHotelById);

export async function generateMetadata({
  params,
}: {
  params: Promise<{ id: string }>;
}): Promise<Metadata> {
  const { id } = await params;
  try {
    const loaded = await loadHotel(id);
    return { title: loaded?.hotel.name ?? "Hotel not found" };
  } catch {
    return { title: "Hotel" };
  }
}

function Section({
  id,
  title,
  children,
}: {
  id: string;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section id={id} className="scroll-mt-24 space-y-3">
      <h2 className="text-lg font-semibold text-text">{title}</h2>
      {children}
    </section>
  );
}

const ACTIVE_STATUS_LABEL: Record<string, string> = {
  temporarily_closed: "Temporarily closed",
  closed: "Closed",
};

export default async function HotelDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { id } = await params;
  const origin = parseHotelOrigin(await searchParams);

  const loaded = await loadHotel(id);
  if (!loaded) notFound();
  const hotel = loaded.hotel;

  // Access is resolved first; contacts are only fetched when authorized.
  const [{ access, contacts, failed: contactsFailed }, intelligence, relationship] =
    await Promise.all([
      getHotelContactsIfAuthorized(hotel.id),
      getHotelIntelligence(hotel.id),
      getOpenRelationship(hotel.id),
    ]);

  const location = [hotel.destination?.name, hotel.countryCode].filter(Boolean).join(" · ");
  const type = hotelTypeLabel(hotel.hotelType);
  const statusNote = ACTIVE_STATUS_LABEL[hotel.activeStatus];
  const contactState = contactSectionState({ access, contacts, failed: contactsFailed });

  // Premium intelligence uses the SAME entitlement answer as contacts. It is
  // only queried when that answer is an explicit `allowed`: a denial and a
  // failed check both skip the query, so security stays fail-closed, and the
  // panel can still tell "locked" apart from "we could not check".
  const premium = access.status === "allowed" ? await getHotelPremiumIntelligence(hotel.id) : null;
  const premiumState = premiumIntelligenceState({ access, result: premium });

  // Only a won cycle has a collaboration to show, so only a won cycle pays for
  // the query. Its own tri-state answer is what the panel renders.
  const collaboration =
    relationship.status === "open" && relationship.relationship.status === "won"
      ? await getCycleCollaboration(relationship.relationship.pipelineItemId)
      : ({ status: "none" } as const);
  const workspace =
    relationship.status === "open" &&
    relationship.relationship.status === "won" &&
    collaboration.status === "found"
      ? await getCollaborationWorkspace(relationship.relationship.pipelineItemId)
      : ({ status: "not_found" } as const);
  const inbox =
    relationship.status === "open"
      ? await getInboxUnity(relationship.relationship.pipelineItemId)
      : undefined;
  const mailboxes = relationship.status === "open" ? await listConnectedMailboxes() : undefined;

  const [session, trips] = await Promise.all([resolveSession(), listTrips()]);
  const badges =
    session.status === "authenticated"
      ? await loadSessionCreatorBadges([hotel.id], session.session.userId)
      : { status: "unknown" as const };
  const alreadyOn =
    badges.status === "known" ? (badges.byHotel.get(hotel.id)?.tripIds ?? []) : null;
  const tripChoices =
    trips.status === "ok"
      ? trips.trips.map((trip) => ({
          id: trip.id,
          label: `${trip.name?.trim() || trip.destinationName} · ${trip.startDate} – ${trip.endDate}`,
        }))
      : [];

  const trail = hotelCrumbs(origin, hotel.name);

  return (
    <div className="space-y-8">
      <AnalyticsPageView event="hotel_viewed" />

      <PageHeader title={hotel.name} crumbs={trail} back={backLink(trail)} />
      <HotelSectionNav />

      {/* 1. Identity / location. No photograph is invented (D064). */}
      <header id="identity" className="grid scroll-mt-24 gap-4 sm:grid-cols-[8rem_minmax(0,1fr)]">
        <NoPhoto name={hotel.name} />
        <div className="space-y-3">
          <div className="space-y-1">
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
        </div>
      </header>

      <div id="map" className="scroll-mt-24">
        <HotelMap pins={[loaded.mapPin]} variant="section" />
      </div>

      {/* 2. Creator intelligence — public layer, then the premium layer */}
      <Section id="intelligence" title="Creator intelligence">
        <div className="space-y-4">
          <IntelligencePanel result={intelligence} />
          <PremiumIntelligencePanel state={premiumState} result={premium} />
        </div>
      </Section>

      {/* 3. Premium contact */}
      <Section id="contact" title="Hotel contact">
        {contactState === "contacts" ? (
          <div className="grid gap-4 md:grid-cols-2">
            {contacts.map((contact) => (
              <ContactCard key={contact.id} contact={contact} />
            ))}
          </div>
        ) : contactState === "locked" ? (
          <LockedContactSection />
        ) : contactState === "access-error" ? (
          // The entitlement CHECK failed. We did not learn that this creator
          // lacks access, so we must not imply it — no upgrade CTA here (F1).
          <div className="rounded-[var(--radius-app)] border border-border bg-surface p-6">
            <h3 className="text-base font-semibold text-text">
              Contact access couldn&rsquo;t be checked
            </h3>
            <p className="mt-2 max-w-prose text-sm text-muted">
              We couldn&rsquo;t verify your access right now. Reload the page to try again.
            </p>
          </div>
        ) : contactState === "fetch-error" ? (
          <div className="rounded-[var(--radius-app)] border border-border bg-surface p-6">
            <h3 className="text-base font-semibold text-text">
              Contact details couldn&rsquo;t be loaded
            </h3>
            <p className="mt-2 max-w-prose text-sm text-muted">
              This is a temporary problem on our side, not a missing contact. Reload the page to try
              again.
            </p>
          </div>
        ) : (
          <div className="rounded-[var(--radius-app)] border border-border bg-surface p-6">
            <h3 className="text-base font-semibold text-text">No contact on file yet</h3>
            <p className="mt-2 max-w-prose text-sm text-muted">
              We haven&rsquo;t published a verified contact for this hotel yet. It will appear here
              once our editorial team verifies one.
            </p>
          </div>
        )}
      </Section>

      {/* 4. The creator's private relationship */}
      <Section id="activity" title="Your activity">
        <ActivityPanel
          hotelId={hotel.id}
          relationship={relationship}
          collaboration={collaboration}
          workspace={workspace}
          inbox={inbox}
          mailboxes={mailboxes}
          pipelineHref={pipelineReturnHref(origin)}
        />
        <div id="trip" className="scroll-mt-24">
          <AddToTrip
            hotelId={hotel.id}
            trips={tripChoices}
            tripsLoad={trips.status === "ok" ? "ok" : "error"}
            alreadyOn={alreadyOn}
          />
        </div>
      </Section>
    </div>
  );
}
