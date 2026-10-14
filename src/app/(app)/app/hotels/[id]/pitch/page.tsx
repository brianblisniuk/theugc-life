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

import { loadAssistantChrome } from "@/lib/ai/queries";
import { EmptyState } from "@/components/empty-state";
import { PitchComposer } from "@/components/pitch/composer";
import { PageHeader } from "@/components/shell/page-header";
import { requireUser } from "@/lib/auth/guards";
import { hasSendScope } from "@/lib/gmail/contract";
import { listGmailAccounts } from "@/lib/gmail/connection.server";
import { getHotelById } from "@/lib/hotels/queries";
import { isUuid } from "@/lib/hotels/ids";
import { isSystemTemplateKey, omissionNote } from "@/lib/pitch/contract";
import { createPitchPersonalizer } from "@/lib/pitch/personalizer";
import { loadPitchContext } from "@/lib/pitch/queries";
import { hotelCrumbs, hotelHref, parseHotelOrigin } from "@/lib/shell/navigation";

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

  const assistant = await loadAssistantChrome();
  const mailboxes = await listGmailAccounts(session.userId);
  const connected = mailboxes.filter((account) => account.connectionState === "connected");
  const sender = connected.find((account) => hasSendScope(account.grantedScopes)) ?? connected[0] ?? null;
  const context = await loadPitchContext({
    userId: session.userId,
    hotelId: hotel.id,
    hotelName: hotel.name,
    destinationName: hotel.destination?.name ?? null,
    requestedTripId: requestedTrip && isUuid(requestedTrip) ? requestedTrip : null,
    preferDraftTrip: !fresh && !requestedTrip,
  });

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

  const showSaved = Boolean(context.draft) && !fresh && !templateParam && !requestedTrip;
  const subject = showSaved && context.draft ? context.draft.subject : suggestion.subject;
  const body = showSaved && context.draft ? context.draft.body : suggestion.body;
  const draftId = context.draft?.id ?? null;
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

  const back = hotelHref(hotel.id, origin);
  const crumbs = hotelCrumbs(origin, hotel.name);
  const note = omissionNote({
    facts: context.facts,
    intelligenceUnavailable: context.intelligenceUnavailable,
    contactUnchecked: context.contactUnchecked,
    contactLocked: context.contactLocked,
  });

  const suggestionParams = new URLSearchParams();
  if (tripId) suggestionParams.set("trip", tripId);
  suggestionParams.set("fresh", "1");
  if (explicitSystem) suggestionParams.set("template", explicitSystem);
  if (creatorTemplate) suggestionParams.set("template", creatorTemplate.id);

  return (
    <div className="space-y-6">
      <PageHeader
        title={`Pitch ${hotel.name}`}
        crumbs={[
          ...crumbs.slice(0, -1),
          { label: hotel.name, href: back ?? undefined },
          { label: "Pitch" },
        ]}
        description="A draft from the facts already on your account. You edit it, then copy it, open it in your mail app, or send it from your connected Gmail. Sending does not mark the hotel as pitched."
      />
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
          const params = new URLSearchParams();
          if (tripId) params.set("trip", tripId);
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
          draftId={showSaved ? draftId : draftId}
          tripId={tripId}
          trips={context.trips}
          templateId={templateId}
          systemKey={activeSystemKey}
          subject={subject}
          body={body}
          recipientEmail={context.recipientEmail}
          suggestionHref={`/app/hotels/${hotel.id}/pitch?${suggestionParams.toString()}`}
          assistant={assistant}
          canSend={assistant.status === "on"}
          mailAccountId={sender?.mailAccountId ?? null}
          hasSendScope={sender ? hasSendScope(sender.grantedScopes) : false}
        />
      )}
    </div>
  );
}
