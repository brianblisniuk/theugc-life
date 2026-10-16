/**
 * Pitch draft for one hotel (canon v1.1 F02, D110).
 *
 * The suggestion is a template fill. Copy and a mailto link stay on the
 * device. Send is a separate explicit action through the creator's own
 * Gmail, and it does not mark a pitch.
 */
import Link from "next/link";
import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { AI_LIMITS } from "@/lib/ai/limits";
import { loadAssistantChrome, loadOwnAiBudget } from "@/lib/ai/queries";
import { EmptyState } from "@/components/empty-state";
import { PitchComposer } from "@/components/pitch/composer";
import { FollowUpPanel } from "@/components/pitch/follow-up-panel";
import { PageHeader } from "@/components/shell/page-header";
import { requireUser } from "@/lib/auth/guards";
import { hasSendScope } from "@/lib/gmail/contract";
import { listGmailAccounts } from "@/lib/gmail/connection.server";
import { getHotelById } from "@/lib/hotels/queries";
import { isUuid } from "@/lib/hotels/ids";
import { isSystemTemplateKey, omissionNote } from "@/lib/pitch/contract";
import {
  draftScopeNote,
  portfolioLine,
  readOpportunityParam,
  recipientLine,
  reviewChecks,
  shownDisplayRef,
  travelWindow,
  visiblePitchDraft,
} from "@/lib/pitch/studio";
import { pipelineStatusLabel } from "@/lib/pipeline/types";
import { createPitchPersonalizer } from "@/lib/pitch/personalizer";
import { loadPitchContext } from "@/lib/pitch/queries";
import { loadHotelFollowUps } from "@/lib/gmail/followup/queries";
import { discoverReturnHref } from "@/lib/screens/discover-return";
import {
  chooserPitchParams,
  hotelCrumbs,
  hotelHref,
  parseHotelOrigin,
  pitchContextParams,
  withOpportunityQuery,
} from "@/lib/shell/navigation";

export const metadata: Metadata = { title: "Pitch" };

function first(value: string | string[] | undefined): string | null {
  if (Array.isArray(value)) return value[0] ?? null;
  return value ?? null;
}

export default async function HotelPitchPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { id } = await params;
  if (!isUuid(id)) notFound();
  const session = await requireUser(`/app/hotels/${id}/pitch`);

  const personalizer = createPitchPersonalizer(process.env.PITCH_PERSONALIZER);
  if (!personalizer) {
    return (
      <EmptyState
        title="Pitch drafts are unavailable"
        description="This workspace only fills templates. An outside model is not connected."
      />
    );
  }

  const loaded = await getHotelById(id);
  if (!loaded) notFound();
  const hotel = loaded.hotel;
  const raw = await searchParams;
  const origin = parseHotelOrigin(raw);
  const requestedTrip = first(raw.trip);
  const fresh = first(raw.fresh) === "1";
  const templateParam = first(raw.template);
  const requestedItem = readOpportunityParam(first(raw.opportunity), first(raw.item));

  const assistant = await loadAssistantChrome();
  const budget =
    assistant.status === "on"
      ? await loadOwnAiBudget(assistant.priority ? "max" : "pro")
      : { paused: false, sendsPaused: false, warning: false };
  const mailboxes = await listGmailAccounts(session.userId);
  const connected = mailboxes.filter((account) => account.connectionState === "connected");
  const sender =
    connected.find((account) => hasSendScope(account.grantedScopes)) ?? connected[0] ?? null;
  const context = await loadPitchContext({
    userId: session.userId,
    hotelId: hotel.id,
    hotelName: hotel.name,
    destinationName: hotel.destination?.name ?? null,
    requestedTripId: requestedTrip && isUuid(requestedTrip) ? requestedTrip : null,
    preferDraftTrip: !fresh && !requestedTrip,
    requestedPipelineItemId: requestedItem && isUuid(requestedItem) ? requestedItem : null,
  });

  if (requestedItem && !isUuid(requestedItem)) {
    return (
      <EmptyState
        title="That opportunity isn’t open on this hotel"
        description="Choose one of your open opportunities from Pipeline. A display id is not a link."
      />
    );
  }

  if (context.status !== "ok") {
    return (
      <EmptyState
        title="We couldn’t prepare a pitch"
        description="Something went wrong reading your profile, trips, or this hotel. Reload the page to try again."
      />
    );
  }

  const creatorTemplate =
    context.templates.find((template) => template.id === templateParam) ?? null;
  const explicitSystem = templateParam && isSystemTemplateKey(templateParam) ? templateParam : null;

  const suggestion = personalizer.suggest({
    facts: context.facts,
    relationshipStatus: context.relationshipStatus,
    systemKey: explicitSystem,
    creatorTemplate: creatorTemplate
      ? { subject: creatorTemplate.subject, body: creatorTemplate.body }
      : null,
  });

  const visible = visiblePitchDraft({
    draft: context.draft,
    fresh,
    templateRequested: Boolean(templateParam),
    suggestion,
  });
  const showSaved = visible.draftId !== null;
  const subject = visible.subject;
  const body = visible.body;
  const draftId = visible.draftId;
  const tripId = context.selectedTripId;
  const savedTemplateId =
    showSaved &&
    context.draft?.templateId &&
    context.templates.some((template) => template.id === context.draft?.templateId)
      ? context.draft.templateId
      : null;
  const templateId = creatorTemplate?.id ?? savedTemplateId;
  const activeSystemKey = templateId
    ? null
    : explicitSystem
      ? explicitSystem
      : showSaved
        ? (context.draft?.systemTemplateKey ?? null)
        : suggestion.systemKey;

  const discoverBack = origin.kind === "discover" ? discoverReturnHref(first(raw.back)) : null;
  const hotelBack = hotelHref(hotel.id, origin);
  const back = hotelBack
    ? withOpportunityQuery(hotelBack, context.selectedOpportunity?.id ?? null, tripId)
    : null;
  const backWithDiscover =
    back && discoverBack
      ? `${back}${back.includes("?") ? "&" : "?"}back=${encodeURIComponent(discoverBack)}`
      : back;
  const crumbs = hotelCrumbs(origin, hotel.name).map((crumb) =>
    crumb.label === "Discover" && discoverBack ? { ...crumb, href: discoverBack } : crumb,
  );
  const note = omissionNote({
    facts: context.facts,
    intelligenceUnavailable: context.intelligenceUnavailable,
    contactUnchecked: context.contactUnchecked,
    contactLocked: context.contactLocked,
  });

  const suggestionParams = pitchContextParams({
    origin,
    tripId,
    opportunityId: context.selectedOpportunity?.id ?? null,
    back: first(raw.back),
  });
  suggestionParams.set("fresh", "1");
  if (explicitSystem) suggestionParams.set("template", explicitSystem);
  if (creatorTemplate) suggestionParams.set("template", creatorTemplate.id);
  const oauthReturnPath = `/app/hotels/${hotel.id}/pitch?${pitchContextParams({
    origin,
    tripId,
    opportunityId: context.selectedOpportunity?.id ?? null,
    back: first(raw.back),
  }).toString()}`;

  const selectedTrip = context.trips.find((trip) => trip.id === tripId) ?? null;
  const stay = travelWindow({
    stayStart: context.selectedOpportunity?.stayStart ?? null,
    stayEnd: context.selectedOpportunity?.stayEnd ?? null,
    tripStart: selectedTrip?.startDate ?? null,
    tripEnd: selectedTrip?.endDate ?? null,
  });
  const displayRef = shownDisplayRef(context.selectedOpportunity?.displayRef ?? null);
  const scopeNote = draftScopeNote(context.opportunities.length);
  const checks = reviewChecks({ hotelName: hotel.name, subject, body });
  const stage = context.selectedOpportunity?.status
    ? pipelineStatusLabel(context.selectedOpportunity.status)
    : null;

  return (
    <div className="space-y-6">
      <PageHeader
        title={`Pitch ${hotel.name}`}
        crumbs={[
          ...crumbs.slice(0, -1),
          { label: hotel.name, href: backWithDiscover ?? undefined },
          { label: "Pitch" },
        ]}
        back={backWithDiscover ? { href: backWithDiscover, label: hotel.name } : null}
        description="A draft from the facts already on your account. You edit it, then copy it, open it in your mail app, or send it from your connected Gmail. Sending does not mark the hotel as pitched. AI drafts use the same Claude path, budget, and rate limit."
      />
      {context.opportunityChoice === "missing" ? (
        <EmptyState
          title="That opportunity isn’t open on this hotel"
          description="Choose one of your open opportunities from Pipeline. A display id is not a link."
        />
      ) : context.opportunityChoice === "many" ? (
        <section className="space-y-3" aria-label="Choose an opportunity">
          <h2 className="text-lg font-semibold text-text">Choose the opportunity</h2>
          <p className="max-w-prose text-sm text-muted">
            This hotel has more than one open opportunity. Open one to see its draft. Saving here
            does not replace another opportunity.
          </p>
          <ul className="space-y-2">
            {context.opportunitiesCapped ? (
              <li className="text-sm text-muted">
                This list is capped. It is not every open opportunity.
              </li>
            ) : null}
            {context.opportunities.map((opportunity) => {
              const params = chooserPitchParams(origin, opportunity, first(raw.back));
              const ref = shownDisplayRef(opportunity.displayRef);
              return (
                <li key={opportunity.id} className="v12-card px-4 py-3">
                  <Link
                    href={`/app/hotels/${hotel.id}/pitch?${params.toString()}`}
                    className="font-semibold text-text hover:underline"
                  >
                    {ref ?? "Opportunity"} · {pipelineStatusLabel(opportunity.status)}
                  </Link>
                </li>
              );
            })}
          </ul>
        </section>
      ) : (
        <>
          <section className="v12-card v12-card-pad space-y-2" aria-label="What we know">
            <p className="text-xs font-semibold uppercase tracking-wide text-muted">What we know</p>
            <h2 className="text-xl font-semibold text-text">{hotel.name}</h2>
            <p className="text-sm text-muted">
              {displayRef ?? "No open opportunity"}
              {stage ? ` · ${stage}` : ""}
            </p>
            <p className="text-sm text-text">
              Travel window: {stay.label}
              {stay.source === "trip" ? " · From the selected trip" : ""}
              {stay.source === "opportunity" ? " · On this opportunity" : ""}
              {stay.source === "unconfirmed" ? ". Don’t invent dates." : ""}
            </p>
            <p className="text-sm text-text">
              Recipient:{" "}
              {recipientLine({
                email: context.recipientEmail,
                locked: context.contactLocked,
                unchecked: context.contactUnchecked,
              })}
            </p>
            <p className="text-sm text-text">
              Portfolio: {portfolioLine(context.facts.portfolio_title)}
            </p>
            {context.facts.intelligence_note ? (
              <p className="text-sm text-text">{context.facts.intelligence_note}</p>
            ) : (
              <p className="text-sm text-muted">
                {context.intelligenceUnavailable
                  ? "Creator intelligence is temporarily unavailable."
                  : "Insufficient data"}
              </p>
            )}
            {context.opportunitiesCapped ? (
              <p className="text-sm text-muted">
                This list is capped. It is not every open opportunity.
              </p>
            ) : null}
            {context.selectedOpportunity?.status === "closed" ? (
              <p className="text-sm text-muted">This opportunity is closed. Its draft stays on it.</p>
            ) : null}
            {scopeNote ? <p className="text-sm text-muted">{scopeNote}</p> : null}
            {context.opportunityChoice === "none" ? (
              <p className="text-sm text-muted">
                No open opportunity. Saving a draft does not create one and does not mark a pitch.
              </p>
            ) : null}
          </section>
          <p className="max-w-prose text-sm text-muted">{note}</p>
          <div className="flex flex-wrap gap-2 text-sm">
            {(["introduction", "stay", "follow_up", "return_visit"] as const).map((key) => {
              const params = new URLSearchParams(suggestionParams);
              params.set("template", key);
              params.set("fresh", "1");
              const label =
                key === "return_visit"
                  ? "Return"
                  : key === "follow_up"
                    ? "Follow-up"
                    : key[0]!.toUpperCase() + key.slice(1);
              return (
                <Link
                  key={key}
                  href={`/app/hotels/${hotel.id}/pitch?${params.toString()}`}
                  className="rounded-[var(--radius-app)] border border-border px-3 py-1 text-text"
                >
                  {label}
                </Link>
              );
            })}
            {context.templates.map((template) => {
              const params = pitchContextParams({
                origin,
                tripId,
                opportunityId: context.selectedOpportunity?.id ?? null,
                back: first(raw.back),
              });
              params.set("template", template.id);
              params.set("fresh", "1");
              return (
                <Link
                  key={template.id}
                  href={`/app/hotels/${hotel.id}/pitch?${params.toString()}`}
                  className="rounded-[var(--radius-app)] border border-border px-3 py-1 text-text"
                >
                  {template.name}
                </Link>
              );
            })}
            <Link href="/app/profile/pitches" className="px-3 py-1 text-muted underline">
              Templates
            </Link>
          </div>
          {suggestion.body.trim().length === 0 && !showSaved && assistant.status !== "on" ? (
            <p className="text-sm text-muted">This template has nothing to fill in yet.</p>
          ) : (
            <PitchComposer
              key={`${draftId ?? "new"}-${tripId ?? "none"}-${templateId ?? activeSystemKey ?? "auto"}-${fresh ? "fresh" : "kept"}`}
              hotelId={hotel.id}
              hotelName={hotel.name}
              draftId={draftId}
              oauthReturnPath={oauthReturnPath}
              tripId={tripId}
              trips={context.trips}
              templateId={templateId}
              systemKey={activeSystemKey}
              subject={subject}
              body={body}
              recipientEmail={context.recipientEmail}
              suggestionHref={`/app/hotels/${hotel.id}/pitch?${suggestionParams.toString()}`}
              assistant={assistant}
              budgetWarning={budget.warning}
              accountPaused={budget.paused}
              sendsPaused={budget.sendsPaused}
              canSend={assistant.status === "on" && !budget.paused && !budget.sendsPaused}
              mailAccountId={sender?.mailAccountId ?? null}
              hasSendScope={sender ? hasSendScope(sender.grantedScopes) : false}
              pipelineItemId={context.selectedOpportunity?.id ?? null}
            />
          )}
          <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_280px]">
            <FollowUps
              userId={session.userId}
              hotelId={hotel.id}
              hotelName={hotel.name}
              assistantOn={assistant.status === "on"}
              canSchedule={assistant.status === "on" && !budget.paused}
            />
            <aside className="space-y-4">
              <section className="v12-card v12-card-pad space-y-2">
                <h2 className="text-base font-semibold text-text">Check before you continue</h2>
                <ul className="space-y-1 text-sm text-text">
                  {checks.map((check) => (
                    <li key={check.id}>
                      {check.ok ? "Ready" : "Check"}: {check.label}
                    </li>
                  ))}
                </ul>
                <p className="text-sm text-muted">{note}</p>
              </section>
              <section className="v12-card v12-card-pad space-y-2">
                <h2 className="text-base font-semibold text-text">How this pitch continues</h2>
                {assistant.status === "on" ? (
                  <p className="text-sm text-text">
                    AI drafting is on for this account. It uses Claude Sonnet, the monthly budget,
                    the shared pool, and {AI_LIMITS.generationsPerMinute} generations a minute. A
                    draft is not a send.
                  </p>
                ) : (
                  <p className="text-sm text-text">
                    This account prepares templates, saves drafts, and copies them. AI drafting is
                    not on.
                  </p>
                )}
                <Link href="/app/billing" className="text-sm font-semibold text-text underline">
                  Billing
                </Link>
              </section>
              {context.otherDraftUnread ? (
                <p className="text-sm text-muted" role="status">
                  Another draft couldn’t be read. This is not an empty list.
                </p>
              ) : context.otherDraft ? (
                <section className="v12-card v12-card-pad space-y-2">
                  <h2 className="text-base font-semibold text-text">Another open draft</h2>
                  <p className="text-sm text-text">{context.otherDraft.hotelName}</p>
                  <Link
                    href={`/app/hotels/${context.otherDraft.hotelId}/pitch?from=pipeline`}
                    className="text-sm font-semibold text-text underline"
                  >
                    Open
                  </Link>
                </section>
              ) : null}
            </aside>
          </div>
        </>
      )}
    </div>
  );
}

async function FollowUps({
  userId,
  hotelId,
  hotelName,
  assistantOn,
  canSchedule,
}: {
  userId: string;
  hotelId: string;
  hotelName: string;
  assistantOn: boolean;
  canSchedule: boolean;
}) {
  const loaded = await loadHotelFollowUps(userId, hotelId);
  if (loaded.status === "error") {
    return (
      <p className="text-sm text-muted">
        Follow-ups couldn’t be read. Reload the page to try again. Nothing was sent.
      </p>
    );
  }
  if (loaded.threads.length === 0) {
    return (
      <p className="text-sm text-muted">
        A follow-up can be scheduled after you send a pitch from your Gmail. Nothing is scheduled.
      </p>
    );
  }
  return (
    <div className="space-y-4">
      {loaded.threads.map((thread) => (
        <FollowUpPanel
          key={thread.eventId}
          hotelId={hotelId}
          hotelName={hotelName}
          eventId={thread.eventId}
          originalSubject={thread.originalSubject}
          recipient={thread.recipient}
          next={thread.next}
          history={thread.followups}
          timeZone={loaded.timeZone}
          assistantOn={assistantOn}
          canSchedule={canSchedule}
        />
      ))}
    </div>
  );
}
