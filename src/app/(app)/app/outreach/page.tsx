/**
 * Outreach list (V12.2, D184). Campaigns are the caller's. An empty list is
 * not a failed read, and a failed read is not an empty list.
 */
import type { Metadata } from "next";
import Link from "next/link";

import { V12Icon } from "@/components/icons/v12-icons";
import { CreateOutreachForm } from "@/components/outreach/campaign-forms";
import { Badge } from "@/components/ui/badge";
import { ButtonLink } from "@/components/ui/button";
import { EmptyState, ErrorState } from "@/components/ui/states";
import { campaignRemainderNotice, listCampaigns } from "@/lib/outreach/queries";
import { listDestinations, listTrips } from "@/lib/trips/queries";

export const metadata: Metadata = { title: "Outreach" };

export default async function OutreachPage() {
  const [campaigns, trips, destinations] = await Promise.all([
    listCampaigns(),
    listTrips(),
    listDestinations(),
  ]);

  const tripChoices =
    trips.status === "ok"
      ? trips.trips.map((trip) => ({
          id: trip.id,
          label: `${trip.name?.trim() || trip.destinationName} · ${trip.startDate}`,
        }))
      : [];
  const destinationChoices =
    destinations.status === "ok"
      ? destinations.destinations.map((destination) => ({
          id: destination.id,
          name: destination.name,
        }))
      : [];

  return (
    <div className="v12-stack">
      <header className="v12-pagehead">
        <div>
          <div className="v12-eyebrow">Outreach / Creator workspace</div>
          <h1>Turn your shortlist into conversations.</h1>
          <p>
            Organize focused hotel initiatives with or without an upcoming trip. Each hotel gets a
            personalized pitch.
          </p>
        </div>
        <div className="v12-head-actions">
          <ButtonLink href="/app/pipeline">
            <V12Icon name="arrow" size={15} />
            Open Pipeline
          </ButtonLink>
          <ButtonLink href="#new-outreach" variant="primary">
            <V12Icon name="plus" size={15} />
            New outreach
          </ButtonLink>
        </div>
      </header>

      {campaigns.status === "error" ? (
        <ErrorState
          title="We couldn’t load outreach"
          description="Something went wrong on our side. Reload to try again. This is not an empty list."
        />
      ) : campaigns.campaigns.length === 0 ? (
        <EmptyState
          title="No outreach yet"
          description="A campaign can start from a trip, or with no trip and no invented dates."
        />
      ) : (
        <>
          <section className="v12-panel v12-panel-pad" aria-label="Active outreach">
            <div className="v12-panel-head">
              <div>
                <p className="v12-eyebrow">ACTIVE OUTREACH</p>
                <h2>{campaigns.campaigns[0]!.name}</h2>
                <p>
                  {campaigns.campaigns[0]!.tripName ||
                    campaigns.campaigns[0]!.destinationName ||
                    "No trip yet"}
                  . Open the workspace for the hotels, the next move, and the volume note.
                </p>
              </div>
              <ButtonLink href={`/app/outreach/${campaigns.campaigns[0]!.id}`} variant="primary">
                <V12Icon name="arrow" size={15} />
                Open outreach
              </ButtonLink>
            </div>
            <div className="v12-stats v12-stats-3">
              <Link
                href={`/app/outreach/${campaigns.campaigns[0]!.id}#hotel-opportunities`}
                className="v12-stat"
              >
                <span className="v12-stat-label">Hotel opportunities</span>
                <div className="v12-stat-note">Each hotel keeps its own stage</div>
              </Link>
              <Link
                href={`/app/outreach/${campaigns.campaigns[0]!.id}#next-move`}
                className="v12-stat"
              >
                <span className="v12-stat-label">Your next move</span>
                <div className="v12-stat-note">Finish a reply before adding volume</div>
              </Link>
              <Link
                href={`/app/outreach/${campaigns.campaigns[0]!.id}#volume`}
                className="v12-stat"
              >
                <span className="v12-stat-label">Volume without losing trust</span>
                <div className="v12-stat-note">No send-all on this workspace</div>
              </Link>
            </div>
          </section>
          <ul className="v12-plain-list">
            {campaigns.campaigns.map((campaign) => {
              const place = campaign.tripName || campaign.destinationName;
              return (
                <li key={campaign.id} className="v12-navtile">
                  <div>
                    <strong>
                      <Link href={`/app/outreach/${campaign.id}`}>{campaign.name}</Link>
                    </strong>
                    <p>
                      {campaign.tripId ? `Linked trip${place ? ` · ${place}` : ""}` : "No trip yet"}
                      {campaign.tripStart && campaign.tripEnd
                        ? ` · ${campaign.tripStart}–${campaign.tripEnd}`
                        : ""}
                    </p>
                  </div>
                  <Badge tone={campaign.tripId ? "green" : "gray"}>
                    {campaign.tripId ? "Linked trip" : "No trip"}
                  </Badge>
                </li>
              );
            })}
          </ul>
        </>
      )}
      {campaigns.status === "ok" && campaigns.truncated ? (
        <p>{campaignRemainderNotice(campaigns.total, campaigns.campaigns.length)}</p>
      ) : null}

      <section className="v12-card v12-card-pad" id="new-outreach">
        <h2>New outreach</h2>
        <p>
          Linking a trip copies its shortlist once. Hotels you add later stay off until you import
          them.
        </p>
        {trips.status === "error" || destinations.status === "error" ? (
          <ErrorState
            title="We couldn’t load trips or destinations"
            description="Reload to try again."
          />
        ) : (
          <CreateOutreachForm trips={tripChoices} destinations={destinationChoices} />
        )}
      </section>
    </div>
  );
}
