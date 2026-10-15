/**
 * Authenticated hotel workspace (PRD §7.3, ROUTES.md §4 — UUID, never slug).
 *
 * Section order is fixed by DESIGN_SYSTEM.md §3:
 *   1. identity/location  2. creator intelligence  3. premium contact
 *   4. the creator's private relationship
 *
 * Contacts and Premium Intelligence are authorized separately. A contact is
 * loaded only after an unlock (or for admin/editor). Premium intelligence still
 * uses has_premium_hotel_access. A Pass does not reveal an email.
 *
 * Internal import/provenance fields are never surfaced here.
 */
import { cache } from "react";
import { notFound } from "next/navigation";
import type { Metadata } from "next";

import { AnalyticsPageView } from "@/components/analytics-page-view";
import { ActivityPanel } from "@/components/hotels/activity-panel";
import { AddToTrip } from "@/components/hotels/add-to-trip";
import { ReportContact } from "@/components/contacts/report-contact";
import { UnlockContact } from "@/components/contacts/unlock-contact";
import { ContactCard } from "@/components/hotels/contact-card";
import { HotelMap } from "@/components/hotels/hotel-map";
import { NetworkIntelligencePanel, PersonalFacts } from "@/components/intelligence/network-panel";
import {
  IntelligencePanel,
  PremiumIntelligencePanel,
} from "@/components/hotels/intelligence-panel";
import { DecisionIntelligence } from "@/components/intelligence/decision-panel";
import { MetricCells, RankingBoards } from "@/components/hotels/metric-signals";
import { NextStepPanel } from "@/components/hotels/next-step-panel";
import { Methodology } from "@/components/hotels/methodology";
import { VerificationBadge } from "@/components/hotels/verification-badge";
import { PastCollaborations } from "@/components/profile/past-collaborations";
import { HotelSectionNav } from "@/components/shell/hotel-section-nav";
import { resolveSession } from "@/lib/auth/guards";
import { loadBillingAccess } from "@/lib/billing/queries";
import { FREE_LIMITS } from "@/lib/config";
import { getCollaborationWorkspace } from "@/lib/collaboration/queries";
import { listCollaborationContracts } from "@/lib/contracts/queries";
import { getCollaborationSuggestions } from "@/lib/gmail/collaboration/queries";
import { getInboxUnity, listConnectedMailboxes } from "@/lib/inbox-pipeline/queries";
import { enforcePremiumHotelAccess } from "@/lib/entitlements/gate";
import { contactSectionState } from "@/lib/hotels/access";
import { hotelTypeLabel } from "@/lib/hotels/filters";
import { isPublishedStarRating } from "@/lib/hotels/publication";
import { premiumIntelligenceState } from "@/lib/hotels/intelligence";
import {
  getHotelById,
  getHotelContactsIfAuthorized,
  getHotelIntelligence,
  getHotelPremiumIntelligence,
  loadSessionCreatorBadges,
} from "@/lib/hotels/queries";
import {
  getDestinationRank,
  getGmailNetworkPrompt,
  getNetworkHotel,
  getOwnNetworkFacts,
  getOwnNetworkPriority,
  recordNetworkView,
} from "@/lib/network-intelligence/queries";
import { networkPanelState } from "@/lib/network-intelligence/display";
import { METRIC_READ_NOTICE, type MetricId, type RankingLoad } from "@/lib/metrics/contract";
import {
  getCreatorFit,
  getHotelMetricConfidence,
  getOwnFitDecision,
  getOwnPersonalAggregate,
} from "@/lib/intelligence/queries";
import { getDestinationMetricRankings, getHotelMetricSignals } from "@/lib/metrics/queries";
import { getPastCollaborations } from "@/lib/profile/queries";
import { FIRST_RUN_COPY } from "@/lib/onboarding/first-run";
import { getCycleCollaboration, getOpenRelationship } from "@/lib/pipeline/queries";
import {
  hotelCrumbs,
  parseHotelOrigin,
  pitchHref,
  pipelineReturnHref,
} from "@/lib/shell/navigation";
import { tripLimitMessage } from "@/lib/trips/display";
import { listTrips } from "@/lib/trips/queries";
import {
  CONTACT_ERROR_BODY,
  CONTACT_ERROR_TITLE,
  NO_CONTACT_TITLE,
  NO_RELATIONSHIP,
} from "@/lib/ux02/copy";
import { initialsFromName } from "@/lib/ux02/initials";
import { nextStep, type ContactFact, type RelationshipFact } from "@/lib/ux02/next-step";
import { planChipFromAccess } from "@/lib/ux02/plan-chip";

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
  const raw = await searchParams;
  const origin = parseHotelOrigin(raw);
  const firstHotelNotice = raw.notice === "first-hotel";

  const loaded = await loadHotel(id);
  if (!loaded) notFound();
  const hotel = loaded.hotel;

  // Contacts follow unlock ownership. Intelligence keeps the Pass/Pro gate.
  const [contactPanel, intelligenceAccess, intelligence, relationship] = await Promise.all([
    getHotelContactsIfAuthorized(hotel.id),
    enforcePremiumHotelAccess(hotel.id),
    getHotelIntelligence(hotel.id),
    getOpenRelationship(hotel.id),
  ]);
  const { access, contacts, failed: contactsFailed, via, cacheEmail, balance, cost } = contactPanel;

  const location = [hotel.destination?.name, hotel.countryCode].filter(Boolean).join(" · ");
  const type = hotelTypeLabel(hotel.hotelType);
  const statusNote = ACTIVE_STATUS_LABEL[hotel.activeStatus];
  const contactState = contactSectionState({
    access,
    contacts: contacts.length > 0 || cacheEmail ? [{}] : [],
    failed: contactsFailed,
  });

  // Premium intelligence is not a contact unlock. Denied and error both skip
  // the query, so security stays fail-closed.
  const premium =
    intelligenceAccess.status === "allowed" ? await getHotelPremiumIntelligence(hotel.id) : null;
  const premiumState = premiumIntelligenceState({ access: intelligenceAccess, result: premium });

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
  const contracts =
    relationship.status === "open" &&
    relationship.relationship.status === "won" &&
    collaboration.status === "found"
      ? await listCollaborationContracts(relationship.relationship.pipelineItemId)
      : ({ status: "hidden" } as const);
  const inbox =
    relationship.status === "open"
      ? await getInboxUnity(relationship.relationship.pipelineItemId)
      : undefined;
  const mailboxes = relationship.status === "open" ? await listConnectedMailboxes() : undefined;
  const gmailPrompt =
    relationship.status === "open"
      ? await getGmailNetworkPrompt(relationship.relationship.pipelineItemId)
      : undefined;
  const collaborationSuggestions =
    relationship.status === "open"
      ? await getCollaborationSuggestions(relationship.relationship.pipelineItemId)
      : undefined;
  const [network, ownFacts] = await Promise.all([
    getNetworkHotel(hotel.id),
    getOwnNetworkFacts(hotel.id),
  ]);
  const destinationId = hotel.destination?.id ?? null;
  const rank = destinationId
    ? await getDestinationRank(destinationId)
    : { status: "ok" as const, hotels: [] };
  const [metricSignals, strength, personal, fit, fitDecision] = await Promise.all([
    getHotelMetricSignals(hotel.id),
    getHotelMetricConfidence(hotel.id),
    getOwnPersonalAggregate(hotel.id),
    destinationId ? getCreatorFit(destinationId) : Promise.resolve({ status: "hidden" as const }),
    getOwnFitDecision(hotel.id),
  ]);
  const metricRankings: Record<MetricId, RankingLoad> = destinationId
    ? await getDestinationMetricRankings(destinationId)
    : {
        response_rate: { status: "error", notice: METRIC_READ_NOTICE },
        response_time: { status: "error", notice: METRIC_READ_NOTICE },
        creator_activity: { status: "error", notice: METRIC_READ_NOTICE },
      };
  const prioritized = await getOwnNetworkPriority(hotel.id);
  if (network.status === "ok" && networkPanelState(network) !== "error") {
    await recordNetworkView(hotel.id);
  }

  const [session, trips, pastCollaborations] = await Promise.all([
    resolveSession(),
    listTrips(),
    getPastCollaborations(hotel.id),
  ]);
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
  const contactFact: ContactFact =
    contactState === "locked"
      ? "locked"
      : contactState === "contacts"
        ? "ready"
        : contactState === "empty"
          ? "empty"
          : "error";
  const relationshipFact: RelationshipFact =
    relationship.status === "error"
      ? { status: "error" }
      : relationship.status === "none"
        ? { status: "none" }
        : { status: "open", stage: relationship.relationship.status };
  const billing =
    session.status === "authenticated"
      ? await loadBillingAccess(session.session.userId)
      : ({ status: "error" } as const);
  const plan = session.status === "authenticated" ? planChipFromAccess(billing) : null;
  const pitch = pitchHref(hotel.id) ?? "#work";
  const step = nextStep({
    relationship: relationshipFact,
    contact: contactFact,
    balance,
    cost,
    pitchHref: pitch,
    plan,
  });
  const classification =
    hotel.starRating !== null && isPublishedStarRating(hotel.starRating)
      ? `${hotel.starRating}-star classification`
      : null;
  const initials = initialsFromName(hotel.name);

  return (
    <div className="ux-hotel">
      <div className="ux-hotel-main">
      <AnalyticsPageView event="hotel_viewed" />

      <header className="ux-stack" id="overview">
        <p className="ux-eyebrow">Hotel information</p>
        <nav className="ux-wrap ux-meta" aria-label="Breadcrumb">
          {trail.map((crumb, index) =>
            crumb.href ? (
              <a key={crumb.href} href={crumb.href}>
                {crumb.label}
                {index < trail.length - 1 ? <span aria-hidden="true"> / </span> : null}
              </a>
            ) : (
              <span key={crumb.label} aria-current="page">
                {crumb.label}
              </span>
            ),
          )}
        </nav>
        <h1 className="ux-h1">{hotel.name}</h1>
        {location || type ? <p className="ux-lede">{[location, type].filter(Boolean).join(" · ")}</p> : null}
        <div className="ux-hero" id="identity">
          <strong>{initials}</strong>
          <span>No verified photograph on file.</span>
          <span className="sr-only">No photograph</span>
        </div>
        <div className="ux-wrap">
          {classification ? <span className="ux-tag">{classification}</span> : null}
          <VerificationBadge status={hotel.verificationStatus} />
          {hotel.activeStatus === "active" ? <span className="ux-tag">Open</span> : null}
          {statusNote ? <span className="ux-tag ux-tag-warning">{statusNote}</span> : null}
        </div>
        {hotel.address ? <p className="ux-meta">{hotel.address}</p> : null}
        <div className="ux-wrap">
          {hotel.websiteUrl ? (
            <a className="ux-meta" href={hotel.websiteUrl} target="_blank" rel="noreferrer noopener">
              Website
            </a>
          ) : null}
          {hotel.instagramUrl ? (
            <a className="ux-meta" href={hotel.instagramUrl} target="_blank" rel="noreferrer noopener">
              Instagram
            </a>
          ) : null}
        </div>
        {firstHotelNotice && relationship.status === "open" ? (
          <p className="ux-notice" role="status">
            {FIRST_RUN_COPY.savedToast}
          </p>
        ) : null}
      </header>
      <HotelSectionNav />

      <div id="map" className="scroll-mt-24">
        <HotelMap pins={[loaded.mapPin]} variant="section" />
      </div>

      {/* 2. Creator intelligence — public layer, then the premium layer */}
      <section className="ux-stack" id="intelligence">
        <div className="ux-results">
          <div className="ux-stack-sm">
            <p className="ux-eyebrow">Creator network</p>
            <h2 className="ux-name">Creator intelligence</h2>
            <p className="ux-meta">Signals based on confirmed creator activity.</p>
          </div>
          <Methodology />
        </div>
        <MetricCells signals={metricSignals} strength={strength} />
        <IntelligencePanel result={intelligence} />
        <PremiumIntelligencePanel state={premiumState} result={premium} />
        <NetworkIntelligencePanel
          hotelId={hotel.id}
          network={network}
          rank={rank}
          prioritized={prioritized}
        />
        <PersonalFacts load={ownFacts} />
        <RankingBoards destinationName={hotel.destination?.name ?? null} rankings={metricRankings} />
        <DecisionIntelligence
          hotelId={hotel.id}
          strength={strength}
          personal={personal}
          fit={fit}
          decision={fitDecision}
        />
      </section>

      {/* 3. Premium contact */}
      <Section id="contact" title="Hotel contact">
        {contactState === "contacts" ? (
          <div className="space-y-4">
            {via === "unlock" ? (
              <p className="text-sm font-semibold text-text">Already unlocked</p>
            ) : null}
            <div className="grid gap-4 md:grid-cols-2">
              {contacts.map((contact) => (
                <ContactCard key={contact.id} contact={contact} />
              ))}
            </div>
            {contacts.length === 0 && cacheEmail ? (
              <p className="text-sm text-text">
                <a className="underline" href={`mailto:${cacheEmail}`}>
                  {cacheEmail}
                </a>
              </p>
            ) : null}
            {via === "unlock" ? <ReportContact hotelId={hotel.id} /> : null}
          </div>
        ) : contactState === "locked" ? (
          <div className="space-y-4">
            <UnlockContact
              hotelId={hotel.id}
              unlocked={false}
              balance={balance}
              cost={cost}
              showEmail
            />
          </div>
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
            <h3 className="text-base font-semibold text-text">{CONTACT_ERROR_TITLE}</h3>
            <p className="mt-2 max-w-prose text-sm text-muted">{CONTACT_ERROR_BODY}</p>
            <a className="ux-btn" href="">
              Retry
            </a>
          </div>
        ) : (
          <div className="space-y-3 rounded-[var(--radius-app)] border border-border bg-surface p-6">
            {via === "unlock" ? (
              <p className="text-sm font-semibold text-text">Already unlocked</p>
            ) : null}
            <h3 className="text-base font-semibold text-text">{NO_CONTACT_TITLE}</h3>
            <p className="max-w-prose text-sm text-muted">
              {via === "unlock"
                ? "This unlock did not return an email. Reporting it is how a courtesy credit starts."
                : "We haven’t published a verified contact for this hotel yet."}
            </p>
            {via === "unlock" ? <ReportContact hotelId={hotel.id} /> : null}
          </div>
        )}
      </Section>

      {/* 4. The creator's private relationship */}
      <section className="ux-stack" id="work">
        <p className="ux-eyebrow">Your history</p>
        <h2 className="ux-name">Your work with this hotel</h2>
        {relationship.status === "none" ? <p>{NO_RELATIONSHIP}</p> : null}
        <PastCollaborations
          load={pastCollaborations}
          heading="Past collaborations with this hotel"
          linkToHotel={false}
          hideWhenEmpty
        />
        <ActivityPanel
          hotelId={hotel.id}
          relationship={relationship}
          collaboration={collaboration}
          workspace={workspace}
          contracts={contracts}
          inbox={inbox}
          mailboxes={mailboxes}
          gmailPrompt={gmailPrompt}
          collaborationSuggestions={collaborationSuggestions}
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
      </section>
      </div>
      <NextStepPanel
        model={step}
        hotelId={hotel.id}
        tripNote={plan === "Free" ? `Trip limit · ${tripLimitMessage(FREE_LIMITS.activeTrips)}` : null}
      />
    </div>
  );
}
