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
import { ContactFeature } from "@/components/hotels/contact-feature";
import { HotelMap } from "@/components/hotels/hotel-map";
import { HotelPhotos } from "@/components/hotels/hotel-photos";
import { MetricRing, MetricValue } from "@/components/hotels/metric-ring";
import { OpportunityHistory } from "@/components/hotels/opportunity-history";
import { ButtonLink } from "@/components/ui/button";
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
import { getCycleCollaboration, listHotelOpportunities } from "@/lib/pipeline/queries";
import { isOpenCycle } from "@/lib/pipeline/types";
import { discoverFigures } from "@/lib/screens/discover-figures";
import { discoverReturnHref } from "@/lib/screens/discover-return";
import { eligibleHotelPhotos } from "@/lib/screens/hotel-photos";
import {
  opportunityCards,
  pickHotelOpportunity,
  relationshipFromOpportunities,
  type HotelOpportunity,
} from "@/lib/screens/hotel-opportunities";
import { parseHotelOrigin, pitchHref, pipelineReturnHref } from "@/lib/shell/navigation";
import { tripLimitMessage } from "@/lib/trips/display";
import { listTrips } from "@/lib/trips/queries";
import { NO_RELATIONSHIP } from "@/lib/screens/copy";
import { initialsFromName } from "@/lib/screens/initials";
import { nextStep, type ContactFact, type RelationshipFact } from "@/lib/screens/next-step";
import { planChipFromAccess } from "@/lib/screens/plan-chip";

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
  const [contactPanel, intelligenceAccess, intelligence, opportunityLoad] = await Promise.all([
    getHotelContactsIfAuthorized(hotel.id),
    enforcePremiumHotelAccess(hotel.id),
    getHotelIntelligence(hotel.id),
    listHotelOpportunities(hotel.id),
  ]);
  const requestedOpportunity = Array.isArray(raw.opportunity)
    ? raw.opportunity[0]
    : raw.opportunity;
  const bareOpportunities: HotelOpportunity[] =
    opportunityLoad.status === "ok"
      ? opportunityLoad.opportunities.map((row) => ({ ...row, tripName: null }))
      : [];
  const selectedOpportunity =
    opportunityLoad.status === "ok"
      ? pickHotelOpportunity(bareOpportunities, requestedOpportunity ?? null)
      : null;
  const relationship = relationshipFromOpportunities(
    opportunityLoad.status === "ok"
      ? { status: "ok", opportunities: bareOpportunities }
      : { status: "error" },
    selectedOpportunity,
  );
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

  const tripNameById = new Map(
    trips.status === "ok"
      ? trips.trips.map((trip) => [trip.id, trip.name?.trim() || trip.destinationName] as const)
      : [],
  );
  const opportunities: HotelOpportunity[] = bareOpportunities.map((row) => ({
    ...row,
    tripName: row.tripId ? (tripNameById.get(row.tripId) ?? null) : null,
  }));
  const backParam = Array.isArray(raw.back) ? raw.back[0] : raw.back;
  const discoverBack = origin.kind === "discover" ? discoverReturnHref(backParam) : null;
  const back =
    origin.kind === "discover"
      ? { href: discoverBack ?? "/app/discover", label: "Back to Discover" }
      : origin.kind === "pipeline"
        ? { href: "/app/pipeline", label: "Back to Pipeline" }
        : origin.kind === "inbox"
          ? { href: "/app/pipeline?surface=inbox", label: "Back to Inbox" }
          : origin.kind === "collaboration"
            ? { href: "/app/pipeline?surface=collaborations", label: "Back to Collaborations" }
            : { href: `/app/trips/${origin.tripId}`, label: "Back to trip" };
  const cards = opportunityCards(opportunities, hotel.id, discoverBack, origin);
  const openCount = opportunities.filter((row) => isOpenCycle(row.status)).length;
  const figures = discoverFigures(metricSignals);
  const photos = eligibleHotelPhotos();
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
  const openRow =
    relationship.status === "open"
      ? (opportunities.find((row) => row.id === relationship.relationship.pipelineItemId) ?? null)
      : null;
  const pitchTripId = origin.kind === "trip" ? origin.tripId : (openRow?.tripId ?? null);
  const pitch = pitchHref(hotel.id, pitchTripId, origin, openRow?.id ?? null) ?? "#work";
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
    <div className="s1-hotel">
      <AnalyticsPageView event="hotel_viewed" />

      <header className="s1-pagehead" id="overview">
        <div>
          <p className="s1-eyebrow">HOTEL DETAIL</p>
          <h1>{hotel.name}</h1>
          {location || type ? (
            <p className="s1-lede">{[location, type].filter(Boolean).join(" · ")}</p>
          ) : null}
          <div className="s1-actions">
            {classification ? <span className="v12-badge">{classification}</span> : null}
            <VerificationBadge status={hotel.verificationStatus} />
            {hotel.activeStatus === "active" ? (
              <span className="v12-badge v12-badge-green">Open</span>
            ) : null}
            {statusNote ? <span className="v12-badge v12-badge-amber">{statusNote}</span> : null}
          </div>
          {hotel.address ? <p className="s1-muted">{hotel.address}</p> : null}
          <div className="s1-actions">
            {hotel.websiteUrl ? (
              <a
                className="s1-muted"
                href={hotel.websiteUrl}
                target="_blank"
                rel="noreferrer noopener"
              >
                Website
              </a>
            ) : null}
            {hotel.instagramUrl ? (
              <a
                className="s1-muted"
                href={hotel.instagramUrl}
                target="_blank"
                rel="noreferrer noopener"
              >
                Instagram
              </a>
            ) : null}
          </div>
          {firstHotelNotice && relationship.status === "open" ? (
            <p className="ux-notice" role="status">
              {FIRST_RUN_COPY.savedToast}
            </p>
          ) : null}
        </div>
        <div className="s1-actions">
          <ButtonLink href={back.href}>{back.label}</ButtonLink>
          <a className="v12-btn v12-btn-primary" href="#trip">
            Add to My Trip
          </a>
        </div>
      </header>

      <div className="s1-detail">
        <div>
          <section className="s1-panel" id="intelligence">
            <div className="s1-panel-head">
              <div>
                <p className="s1-eyebrow">CREATOR INTELLIGENCE</p>
                <h2>Creator intelligence</h2>
                <p>Signals based on confirmed creator activity.</p>
              </div>
              <Methodology />
            </div>
            <div className="s1-intel">
              <article>
                <p className="s1-eyebrow">CREATOR REPLY RATE</p>
                <MetricRing figure={figures.replyRate} label="Observed replies" />
              </article>
              <article>
                <p className="s1-eyebrow">TYPICAL REPLY TIME</p>
                <MetricValue figure={figures.replyTime} label="Reported reply window" />
              </article>
              <article>
                <p className="s1-eyebrow">CREATOR ACTIVITY</p>
                <MetricValue figure={figures.activity} label="Aggregated public signal" />
              </article>
            </div>
            <details>
              <summary>More signals</summary>
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
              <RankingBoards
                destinationName={hotel.destination?.name ?? null}
                rankings={metricRankings}
              />
              <DecisionIntelligence
                hotelId={hotel.id}
                strength={strength}
                personal={personal}
                fit={fit}
                decision={fitDecision}
              />
            </details>
          </section>

          <section className="s1-panel" id="identity">
            <div className="s1-panel-head">
              <h2>Get to know the property</h2>
            </div>
            <HotelPhotos name={hotel.name} initials={initials} photos={photos} />
            {photos.length === 0 ? (
              <p className="s1-caption">No verified photograph on file.</p>
            ) : null}
            <div id="map" className="scroll-mt-24">
              <HotelMap pins={[loaded.mapPin]} variant="section" />
            </div>
          </section>

          <section className="s1-panel" id="work">
            <div className="s1-panel-head">
              <div>
                <p className="s1-eyebrow">Your history</p>
                <h2>Your history with this hotel</h2>
              </div>
              {openCount > 1 ? (
                <span className="v12-badge v12-badge-amber">
                  {openCount} separate opportunities
                </span>
              ) : null}
            </div>
            {relationship.status === "none" ? <p>{NO_RELATIONSHIP}</p> : null}
            <OpportunityHistory cards={cards} failed={opportunityLoad.status === "error"} />
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
        <div className="s1-side">
          <ContactFeature
            hotelId={hotel.id}
            state={contactState}
            contacts={contacts}
            cacheEmail={cacheEmail}
            via={via}
            balance={balance}
            cost={cost}
          />
          <NextStepPanel
            model={step}
            hotelId={hotel.id}
            tripNote={
              plan === "Free" ? `Trip limit · ${tripLimitMessage(FREE_LIMITS.activeTrips)}` : null
            }
          />
        </div>
      </div>
    </div>
  );
}
