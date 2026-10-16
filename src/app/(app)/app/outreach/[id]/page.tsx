/**
 * One outreach campaign (V12.2, D184, D182).
 * Hotels are a view of the catalog. Each opportunity keeps its own stage.
 * Counts are the rows on this campaign. A share is omitted when there are
 * no hotels.
 */
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";

import {
  AddHotelButton,
  DeleteOutreachForm,
  ImportShortlistForm,
  OpenOpportunityForm,
  OpportunityDatesForm,
} from "@/components/outreach/campaign-forms";
import { SuggestionDecisionForm } from "@/components/trips/stay-forms";
import { Badge } from "@/components/ui/badge";
import { ButtonLink } from "@/components/ui/button";
import { EmptyState, ErrorState, InsufficientDataState } from "@/components/ui/states";
import { buildDiscoverHref, parseDiscoverQuery, sanitizeSearchTerm } from "@/lib/hotels/filters";
import { searchHotels } from "@/lib/hotels/queries";
import {
  countOutreach,
  formatShare,
  loggedHotelShare,
  nextActionLabel,
  nextOutreachMove,
  parseOutreachFocus,
  rowMatchesFocus,
  stageTone,
  stageWord,
} from "@/lib/outreach/board";
import {
  getCampaign,
  listCampaignHotels,
  listCampaignOpportunities,
  listCampaigns,
  listDraftHotelIds,
  listTripHotelIds,
} from "@/lib/outreach/queries";
import { hotelHref, pitchHref } from "@/lib/shell/navigation";
import { formatStay } from "@/lib/trips/nights";
import { listStaySuggestions } from "@/lib/trips/queries";

export const metadata: Metadata = { title: "Outreach" };

function first(value: string | string[] | undefined): string | null {
  if (Array.isArray(value)) return value[0] ?? null;
  return value ?? null;
}

const FILTERS = [
  { id: "all", label: "All" },
  { id: "pitch", label: "Needs pitch" },
  { id: "follow_up", label: "Follow-up" },
  { id: "conversation", label: "In conversation" },
] as const;

export default async function OutreachDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { id } = await params;
  const raw = await searchParams;
  const focus = parseOutreachFocus(first(raw.focus));
  const hotelQuery = sanitizeSearchTerm(first(raw.q));
  const loaded = await getCampaign(id);
  if (loaded.status === "error") {
    return (
      <ErrorState
        title="We couldn’t load this outreach"
        description="Reload to try again. This is not an empty campaign."
      />
    );
  }
  if (!loaded.campaign) notFound();
  const campaign = loaded.campaign;

  const [hotels, others] = await Promise.all([listCampaignHotels(campaign.id), listCampaigns()]);
  const hotelIds = hotels.status === "ok" ? hotels.hotels.map((hotel) => hotel.hotelId) : [];
  const [opportunities, drafts, tripHotels] = await Promise.all([
    listCampaignOpportunities({
      initiativeId: campaign.id,
      hotelIds,
      tripId: campaign.tripId,
    }),
    listDraftHotelIds(hotelIds),
    campaign.tripId
      ? listTripHotelIds(campaign.tripId)
      : Promise.resolve({ status: "ok" as const, hotelIds: [] }),
  ]);

  const suggestions = await listStaySuggestions({
    tripHotelIds: [],
    pipelineItemIds:
      opportunities.status === "ok" ? opportunities.opportunities.map((item) => item.id) : [],
  });

  let hotelMatches: { id: string; name: string }[] = [];
  let hotelSearchFailed = false;
  if (hotelQuery) {
    try {
      const result = await searchHotels(parseDiscoverQuery({ q: hotelQuery, pageSize: "8" }));
      hotelMatches = result.hotels.map((hotel) => ({ id: hotel.id, name: hotel.name }));
    } catch {
      hotelSearchFailed = true;
    }
  }

  const draftSet = new Set(drafts.status === "ok" ? drafts.hotelIds : []);
  const counts =
    hotels.status === "ok" && opportunities.status === "ok" && drafts.status === "ok"
      ? countOutreach(hotels.hotels, opportunities.opportunities, draftSet)
      : null;
  const share = counts ? loggedHotelShare(counts) : null;
  const onCampaign = new Set(hotelIds);
  const missingImport =
    campaign.tripId && tripHotels.status === "ok"
      ? tripHotels.hotelIds.filter((hotelId) => !onCampaign.has(hotelId)).length
      : null;

  const opportunityRows =
    opportunities.status === "ok"
      ? opportunities.opportunities.map((item) => ({
          key: item.id,
          hotelId: item.hotelId,
          hotelName: item.hotelName,
          displayRef: item.displayRef,
          status: item.status,
          hasDraft: draftSet.has(item.hotelId),
          stayStart: item.stayStart,
          stayEnd: item.stayEnd,
          pipelineItemId: item.id,
        }))
      : [];
  const hotelsWithoutOpportunity =
    hotels.status === "ok" && opportunities.status === "ok"
      ? hotels.hotels.filter(
          (hotel) => !opportunities.opportunities.some((item) => item.hotelId === hotel.hotelId),
        )
      : [];
  const visibleOpportunities = opportunityRows.filter((row) =>
    rowMatchesFocus({ hotelId: row.hotelId, status: row.status, hasDraft: row.hasDraft }, focus),
  );
  const visibleUnopened = focus === "all" || focus === "pitch" ? hotelsWithoutOpportunity : [];
  const move =
    opportunities.status === "ok"
      ? nextOutreachMove(
          opportunities.opportunities
            .filter((item) => item.status !== "closed")
            .map((item) => ({
              hotelId: item.hotelId,
              hotelName: item.hotelName,
              displayRef: item.displayRef,
              status: item.status,
              pipelineItemId: item.id,
            })),
        )
      : null;

  const place = campaign.tripName || campaign.destinationName || campaign.name;
  const otherCampaigns =
    others.status === "ok" ? others.campaigns.filter((item) => item.id !== campaign.id) : [];

  function openHref(status: string, hotelId: string): string | null {
    if (status === "replied" || status === "negotiating") {
      return hotelHref(hotelId, { kind: "inbox" }, "inbox");
    }
    if (status === "won") return hotelHref(hotelId, { kind: "collaboration" }, "collaboration");
    if (status === "saved" || status === "planned" || !status) {
      return pitchHref(hotelId, campaign.tripId);
    }
    return hotelHref(hotelId, { kind: "pipeline" }, "work");
  }

  const nextHref = move ? openHref(move.status, move.hotelId) : null;

  return (
    <div className="v12-stack">
      <header className="v12-pagehead">
        <div>
          <div className="v12-eyebrow">Outreach / Creator workspace</div>
          <h1>{campaign.name}</h1>
          <p>Reach the hotels on this initiative. Review each one. Nothing is sent in bulk.</p>
        </div>
        <div className="v12-head-actions">
          <ButtonLink href="/app/pipeline">Open Pipeline</ButtonLink>
          <ButtonLink href="/app/outreach#new-outreach" variant="primary">
            New outreach
          </ButtonLink>
        </div>
      </header>

      <div className="v12-context">
        <div>
          <strong>{campaign.tripId ? `Linked to ${place}` : "No trip linked"}</strong>
          <p>
            {campaign.tripId
              ? "Trip hotels already included. Newly saved hotels stay off until you import them."
              : "This outreach has no trip. Leave dates empty when you do not have them."}
          </p>
        </div>
        {campaign.tripId ? (
          <ButtonLink href={`/app/trips/${campaign.tripId}`} size="small">
            Open My Trip
          </ButtonLink>
        ) : (
          <ButtonLink href="/app/trips" size="small">
            My Trips
          </ButtonLink>
        )}
      </div>

      <section className="v12-hero">
        <div>
          <div className="v12-eyebrow">Active outreach{place ? ` / ${place}` : ""}</div>
          <h2>{campaign.name}</h2>
          <p>
            Each hotel keeps its own opportunity. A second one needs different dates, another trip,
            or a closed previous row.
          </p>
          <div className="v12-row">
            <Badge tone={campaign.tripId ? "green" : "gray"}>
              {campaign.tripId ? "Linked trip" : "No trip"}
            </Badge>
            <Badge tone="gray">No bulk-send</Badge>
          </div>
        </div>
        <div className="v12-hero-meter">
          {counts && share !== null ? (
            <>
              <div className="v12-row v12-between">
                <strong>
                  {counts.hotelsLogged} / {counts.selectedHotels}
                </strong>
                <span>Hotels with a recorded pitch</span>
              </div>
              <div className="v12-progress" aria-hidden="true">
                <span style={{ width: `${Math.min(share, 100)}%` }} />
              </div>
              <p>{formatShare(share)}% of the hotels on this outreach</p>
            </>
          ) : counts && counts.selectedHotels === 0 ? (
            <InsufficientDataState description="There are no hotels on this outreach yet, so there is no share to show." />
          ) : (
            <ErrorState
              title="We couldn’t count this outreach"
              description="Reload to try again. This is not zero."
            />
          )}
        </div>
      </section>

      {counts ? (
        <div className="v12-stats">
          <div className="v12-stat">
            <div className="v12-stat-label">Selected hotels</div>
            <div className="v12-stat-num">{counts.selectedHotels}</div>
            <div className="v12-stat-note">On this campaign</div>
          </div>
          <div className="v12-stat">
            <div className="v12-stat-label">Drafts prepared</div>
            <div className="v12-stat-num">{counts.draftsPrepared}</div>
            <div className="v12-stat-note">Saved proposals</div>
          </div>
          <div className="v12-stat">
            <div className="v12-stat-label">Outreach logged</div>
            <div className="v12-stat-num">{counts.outreachLogged}</div>
            <div className="v12-stat-note">Recorded on an opportunity</div>
          </div>
          <div className="v12-stat v12-stat-tint">
            <div className="v12-stat-label">Replies reported</div>
            <div className="v12-stat-num">{counts.repliesReported}</div>
            <div className="v12-stat-note">Replied, negotiating, or agreed</div>
          </div>
        </div>
      ) : null}

      <div className="v12-split">
        <section className="v12-card">
          <div className="v12-view-head">
            <div>
              <h2>Hotel opportunities</h2>
              <p>A campaign is a view of work, not a second hotel database.</p>
            </div>
            {hotels.status === "ok" ? (
              <Badge tone="green">{hotels.hotels.length} hotels</Badge>
            ) : null}
          </div>
          <div className="v12-filters">
            {FILTERS.map((item) => {
              const href =
                item.id === "all"
                  ? `/app/outreach/${campaign.id}`
                  : `/app/outreach/${campaign.id}?focus=${item.id}`;
              return (
                <Link
                  key={item.id}
                  href={href}
                  className="v12-chip"
                  aria-current={focus === item.id ? "true" : undefined}
                >
                  {item.label}
                </Link>
              );
            })}
          </div>
          {hotels.status === "error" ||
          opportunities.status === "error" ||
          drafts.status === "error" ? (
            <div className="v12-card-pad">
              <ErrorState
                title="We couldn’t load the hotels"
                description="Reload to try again. This is not an empty campaign."
              />
            </div>
          ) : visibleOpportunities.length === 0 && visibleUnopened.length === 0 ? (
            <div className="v12-card-pad">
              <EmptyState
                title={focus === "all" ? "No hotels on this outreach" : "Nothing in this view"}
                description={
                  focus === "all"
                    ? "Add a hotel below. Adding one does not open an opportunity."
                    : "The other views may still have hotels."
                }
              />
            </div>
          ) : (
            <div className="v12-table-wrap">
              <table className="v12-table">
                <thead>
                  <tr>
                    <th scope="col">Hotel</th>
                    <th scope="col">Status</th>
                    <th scope="col">Next action</th>
                    <th scope="col">Open</th>
                  </tr>
                </thead>
                <tbody>
                  {visibleOpportunities.map((row) => {
                    const href = openHref(row.status, row.hotelId);
                    const when =
                      row.stayStart && row.stayEnd ? formatStay(row.stayStart, row.stayEnd) : null;
                    return (
                      <tr key={row.key}>
                        <td>
                          <strong>{row.hotelName}</strong>
                          <div className="v12-note">
                            {row.displayRef}
                            {when ? ` · ${when}` : ""}
                          </div>
                        </td>
                        <td>
                          <Badge tone={stageTone(row.status)}>{stageWord(row.status)}</Badge>
                        </td>
                        <td>{nextActionLabel(row.status, row.hasDraft)}</td>
                        <td>
                          {href ? (
                            <ButtonLink href={href} size="small">
                              {row.status === "saved" || row.status === "planned"
                                ? "Prepare"
                                : "Open"}
                            </ButtonLink>
                          ) : null}
                        </td>
                      </tr>
                    );
                  })}
                  {visibleUnopened.map((hotel) => {
                    const href = pitchHref(hotel.hotelId, campaign.tripId);
                    return (
                      <tr key={hotel.id}>
                        <td>
                          <strong>{hotel.hotelName}</strong>
                          <div className="v12-note">Shortlist · no opportunity yet</div>
                        </td>
                        <td>
                          <Badge tone="gray">Not opened</Badge>
                        </td>
                        <td>{nextActionLabel(null, draftSet.has(hotel.hotelId))}</td>
                        <td>
                          {href ? (
                            <ButtonLink href={href} size="small">
                              Prepare
                            </ButtonLink>
                          ) : null}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </section>

        <aside className="v12-stack">
          <section className="v12-card v12-card-pad">
            <div className="v12-eyebrow">Your next move</div>
            {move ? (
              <>
                <h2>{move.sentence}</h2>
                <p>
                  {move.displayRef ? `${move.displayRef} · ` : ""}
                  {move.hotelName}. {stageWord(move.status)}.
                </p>
                {nextHref ? (
                  <ButtonLink href={nextHref} variant="primary" block>
                    {move.status === "replied" ? "Open conversation" : "Open"}
                  </ButtonLink>
                ) : null}
              </>
            ) : (
              <p>No open next step on this outreach.</p>
            )}
          </section>
          <section className="v12-card v12-card-pad">
            <div className="v12-eyebrow">Reputation first</div>
            <h2>Volume without losing trust.</h2>
            <p>
              Personalize each proposal. Pause follow-ups after a reply, a bounce, or an opt-out.
            </p>
            <div className="v12-callout v12-callout-warn">
              There is no send-all action. Review the recipient before anything leaves your account.
            </div>
          </section>
        </aside>
      </div>

      {suggestions.status === "error" ? (
        <ErrorState title="We couldn’t load date suggestions" description="Reload to try again." />
      ) : suggestions.suggestions.length > 0 ? (
        <section className="v12-card v12-card-pad">
          <h2>Gmail suggested other dates</h2>
          <ul className="v12-plain-list">
            {suggestions.suggestions.map((suggestion) => {
              const opportunity = opportunityRows.find(
                (row) => row.pipelineItemId === suggestion.pipelineItemId,
              );
              const when = formatStay(suggestion.checkIn, suggestion.checkOut);
              return (
                <li key={suggestion.id} className="v12-list-item">
                  <strong>{opportunity?.hotelName ?? "Suggested dates"}</strong>
                  <p>
                    {opportunity?.displayRef ? `${opportunity.displayRef} · ` : ""}
                    {when ?? `${suggestion.checkIn}–${suggestion.checkOut}`}
                  </p>
                  <SuggestionDecisionForm suggestionId={suggestion.id} initiativeId={campaign.id} />
                </li>
              );
            })}
          </ul>
        </section>
      ) : null}

      <section className="v12-card v12-card-pad">
        <h2>Dates and another opportunity</h2>
        <p>
          Opportunity dates are the commercial window. They are not copied from the trip-hotel stay.
          A second opportunity on the same trip needs dates that do not overlap, or the previous
          opportunity has to be closed.
        </p>
        {opportunities.status === "ok"
          ? opportunities.opportunities.map((item) => (
              <div key={item.id} className="v12-list-item">
                <strong>
                  {item.displayRef} · {item.hotelName}
                </strong>
                <OpportunityDatesForm
                  pipelineItemId={item.id}
                  tripId={item.tripId}
                  initiativeId={campaign.id}
                  stayStart={item.stayStart}
                  stayEnd={item.stayEnd}
                />
                <OpenOpportunityForm
                  hotelId={item.hotelId}
                  tripId={campaign.tripId ?? item.tripId}
                  initiativeId={campaign.id}
                  label="Another opportunity"
                />
              </div>
            ))
          : null}
        {hotelsWithoutOpportunity.map((hotel) => (
          <div key={hotel.id} className="v12-list-item">
            <strong>{hotel.hotelName}</strong>
            <OpenOpportunityForm
              hotelId={hotel.hotelId}
              tripId={campaign.tripId}
              initiativeId={campaign.id}
              label="Open opportunity"
            />
          </div>
        ))}
      </section>

      <section className="v12-card v12-card-pad">
        <h2>Add a hotel</h2>
        {campaign.tripId ? (
          <div className="v12-row">
            <ImportShortlistForm initiativeId={campaign.id} />
            {missingImport !== null ? (
              <p>
                {missingImport === 0
                  ? "Every current shortlist hotel is already on this outreach."
                  : `${missingImport} shortlist ${missingImport === 1 ? "hotel is" : "hotels are"} not on this outreach yet.`}
              </p>
            ) : (
              <ErrorState
                title="We couldn’t compare the shortlist"
                description="Reload to try again."
              />
            )}
          </div>
        ) : (
          <p>This outreach has no trip, so there is no shortlist to import.</p>
        )}
        <form
          action={`/app/outreach/${campaign.id}`}
          method="get"
          className="v12-form-grid"
          role="search"
        >
          {focus !== "all" ? <input type="hidden" name="focus" value={focus} /> : null}
          <label className="v12-field" htmlFor="outreach-q">
            <span>Search the catalog</span>
            <input id="outreach-q" name="q" type="search" defaultValue={hotelQuery ?? ""} />
          </label>
          <button type="submit" className="v12-btn">
            Search
          </button>
        </form>
        {hotelSearchFailed ? (
          <ErrorState title="We couldn’t search hotels" description="Try again." />
        ) : (
          <ul className="v12-plain-list">
            {hotelMatches.map((hotel) => (
              <li key={hotel.id} className="v12-list-item">
                <div className="v12-row">
                  <span>{hotel.name}</span>
                  <AddHotelButton initiativeId={campaign.id} hotelId={hotel.id} />
                </div>
              </li>
            ))}
          </ul>
        )}
        {campaign.destinationId ? (
          <ButtonLink href={buildDiscoverHref({})} size="small">
            Explore hotels
          </ButtonLink>
        ) : null}
      </section>

      {otherCampaigns.length > 0 ? (
        <section>
          <h2>Another initiative can be independent.</h2>
          <ul className="v12-plain-list">
            {otherCampaigns.map((item) => (
              <li key={item.id} className="v12-navtile">
                <div>
                  <strong>{item.name}</strong>
                  <p>{item.tripId ? "Linked to a trip" : "No trip yet"}</p>
                </div>
                <ButtonLink href={`/app/outreach/${item.id}`} size="small">
                  Open
                </ButtonLink>
              </li>
            ))}
          </ul>
        </section>
      ) : others.status === "error" ? (
        <ErrorState
          title="We couldn’t load your other outreach"
          description="Reload to try again."
        />
      ) : null}

      <section className="v12-card v12-card-pad">
        <DeleteOutreachForm initiativeId={campaign.id} />
      </section>
    </div>
  );
}
