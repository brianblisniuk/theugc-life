/**
 * Pitch reads for the signed-in creator (D110).
 *
 * The cookie-bound client is the caller, so RLS is the row boundary. A failed
 * read is an error, not an empty draft and not a missing fact.
 */
import "server-only";

import { createClient } from "@/lib/supabase/server";
import { isUuid } from "@/lib/hotels/ids";
import {
  activityLabel,
  intelligencePanelState,
  recencyLabel,
  type IntelligenceSignal,
} from "@/lib/hotels/intelligence";
import { getHotelContactsIfAuthorized, getHotelIntelligence } from "@/lib/hotels/queries";
import { getOwnProfile } from "@/lib/profile/queries";
import { listTrips } from "@/lib/trips/queries";

import {
  httpsUrl,
  instagramHandle,
  pastCollaborationSentence,
  pitchFact,
  type FactKey,
  type PitchDelivery,
  type PitchFacts,
  type SystemTemplateKey,
} from "./contract";

export interface PitchTripChoice {
  id: string;
  label: string;
  startDate: string;
  endDate: string;
  name: string | null;
}

export interface PitchTemplateRow {
  id: string;
  name: string;
  subject: string;
  body: string;
}

export interface PitchDraftRow {
  id: string;
  subject: string;
  body: string;
  tripId: string | null;
  templateId: string | null;
  systemTemplateKey: SystemTemplateKey | null;
  delivery: PitchDelivery;
}

export type PitchContextLoad =
  | {
      status: "ok";
      facts: PitchFacts;
      trips: PitchTripChoice[];
      templates: PitchTemplateRow[];
      draft: PitchDraftRow | null;
      recipientEmail: string | null;
      contactLocked: boolean;
      contactUnchecked: boolean;
      intelligenceUnavailable: boolean;
      relationshipStatus: string | null;
      selectedTripId: string | null;
      primaryLanguage: string | null;
    }
  | { status: "error" };

function asText(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function publicNote(signal: IntelligenceSignal): string | null {
  const parts: string[] = [];
  const activity = activityLabel(signal.activityLevel);
  const recency = recencyLabel(signal.recencyBand);
  if (activity) parts.push(activity);
  if (recency) parts.push(recency);
  if (signal.hasObservedCollaboration === true) parts.push("A collaboration has been recorded");
  if (parts.length === 0) return null;
  return pitchFact(`Public creator activity: ${parts.join(". ")}.`);
}

function firstNiche(value: string): string | null {
  const first = value
    .split(",")
    .map((part) => part.trim())
    .find((part) => part.length > 0);
  return pitchFact(first ?? null, 80);
}

export async function loadPitchContext(input: {
  userId: string;
  hotelId: string;
  hotelName: string;
  destinationName: string | null;
  requestedTripId: string | null;
  /** When the URL does not name a trip, a saved draft's trip fills the suggestion. */
  preferDraftTrip: boolean;
  /** One opportunity. A foreign id returns no status rather than another row. */
  opportunityId?: string | null;
}): Promise<PitchContextLoad> {
  if (!isUuid(input.userId) || !isUuid(input.hotelId)) return { status: "error" };
  if (input.requestedTripId && !isUuid(input.requestedTripId)) return { status: "error" };

  try {
    const supabase = await createClient();
    const owner = await supabase
      .from("creator_profiles")
      .select("id")
      .eq("user_id", input.userId)
      .maybeSingle();
    if (owner.error || typeof owner.data?.id !== "string") return { status: "error" };
    const creatorId = owner.data.id;

    const [
      profile,
      trips,
      intelligence,
      contacts,
      pipeline,
      collaboration,
      portfolio,
      templates,
      drafts,
    ] = await Promise.all([
      getOwnProfile(input.userId),
      listTrips(),
      getHotelIntelligence(input.hotelId),
      getHotelContactsIfAuthorized(input.hotelId),
      (() => {
        let pipelineQuery = supabase
          .from("pipeline_items")
          .select("id, status")
          .eq("hotel_id", input.hotelId)
          .neq("status", "closed");
        if (input.opportunityId && isUuid(input.opportunityId)) {
          pipelineQuery = pipelineQuery.eq("id", input.opportunityId);
        }
        return pipelineQuery.limit(1);
      })(),
      supabase
        .from("collaborations")
        .select("status, collaboration_type")
        .eq("hotel_id", input.hotelId)
        .in("status", ["agreed", "scheduled", "active", "completed"])
        .order("updated_at", { ascending: false })
        .limit(1),
      supabase
        .from("portfolio_assets")
        .select("title, external_url")
        .eq("creator_id", creatorId)
        .order("sort_order", { ascending: true })
        .order("id", { ascending: true })
        .limit(1),
      supabase
        .from("pitch_templates")
        .select("id, name, subject, body")
        .is("archived_at", null)
        .order("updated_at", { ascending: false })
        .limit(50),
      supabase
        .from("pitch_drafts")
        .select("id, subject, body, trip_id, template_id, system_template_key, delivery")
        .eq("hotel_id", input.hotelId)
        .order("updated_at", { ascending: false })
        .limit(1),
    ]);

    if (profile.status === "error" || trips.status === "error") return { status: "error" };
    if (
      pipeline.error ||
      collaboration.error ||
      portfolio.error ||
      templates.error ||
      drafts.error
    ) {
      return { status: "error" };
    }
    if (profile.status !== "ok") return { status: "error" };

    const tripChoices: PitchTripChoice[] = trips.trips.map((trip) => ({
      id: trip.id,
      label: `${trip.name?.trim() || trip.destinationName} · ${trip.startDate} – ${trip.endDate}`,
      startDate: trip.startDate,
      endDate: trip.endDate,
      name: trip.name,
    }));
    const draftTripId = asText((drafts.data?.[0] as { trip_id?: unknown } | undefined)?.trip_id);
    const requested = tripChoices.find((trip) => trip.id === input.requestedTripId) ?? null;
    const fromDraft =
      input.preferDraftTrip && draftTripId
        ? (tripChoices.find((trip) => trip.id === draftTripId) ?? null)
        : null;
    const selected = requested ?? fromDraft;

    const facts: PitchFacts = {};
    const put = (key: FactKey, value: string | null) => {
      if (value) facts[key] = value;
    };
    put("creator_name", pitchFact(profile.profile.displayName, 120));
    put("niche", firstNiche(profile.profile.creatorNiches));
    put("instagram_handle", instagramHandle(profile.profile.instagramHandle));
    put("hotel_name", pitchFact(input.hotelName, 200));
    put("destination_name", pitchFact(input.destinationName, 120));
    if (selected) {
      put("trip_name", pitchFact(selected.name, 120));
      put("trip_start", pitchFact(selected.startDate, 20));
      put("trip_end", pitchFact(selected.endDate, 20));
    }

    const asset = (portfolio.data ?? [])[0] as
      { title?: unknown; external_url?: unknown } | undefined;
    if (asset) {
      put("portfolio_title", pitchFact(asText(asset.title), 200));
      put("portfolio_url", httpsUrl(asText(asset.external_url)));
    }

    const collab = (collaboration.data ?? [])[0] as
      { status?: unknown; collaboration_type?: unknown } | undefined;
    if (collab) {
      put(
        "past_collaboration",
        pastCollaborationSentence(asText(collab.status), asText(collab.collaboration_type)),
      );
    }

    let intelligenceUnavailable = false;
    if (intelligence.status === "error") {
      intelligenceUnavailable = true;
    } else if (intelligence.status === "ok" && intelligencePanelState(intelligence) === "signal") {
      put("intelligence_note", publicNote(intelligence.signal));
    }

    let recipientEmail: string | null = null;
    let contactLocked = false;
    let contactUnchecked = false;
    if (contacts.access.status === "error" || contacts.failed) {
      contactUnchecked = true;
    } else if (contacts.access.status === "denied") {
      contactLocked = true;
    } else {
      const named = contacts.contacts.find((contact) => contact.displayName?.trim());
      put("contact_name", pitchFact(named?.displayName ?? null, 120));
      const email =
        contacts.contacts.find((contact) => contact.email)?.email ?? contacts.cacheEmail;
      recipientEmail = email;
    }

    const statusRow = (pipeline.data ?? [])[0] as { status?: unknown } | undefined;
    const relationshipStatus = asText(statusRow?.status);

    const templateRows: PitchTemplateRow[] = [];
    for (const row of templates.data ?? []) {
      const record = row as { id?: unknown; name?: unknown; subject?: unknown; body?: unknown };
      if (
        typeof record.id !== "string" ||
        typeof record.name !== "string" ||
        typeof record.subject !== "string" ||
        typeof record.body !== "string"
      ) {
        return { status: "error" };
      }
      templateRows.push({
        id: record.id,
        name: record.name,
        subject: record.subject,
        body: record.body,
      });
    }

    const draftRaw = (drafts.data ?? [])[0] as
      | {
          id?: unknown;
          subject?: unknown;
          body?: unknown;
          trip_id?: unknown;
          template_id?: unknown;
          system_template_key?: unknown;
          delivery?: unknown;
        }
      | undefined;
    let draft: PitchDraftRow | null = null;
    if (draftRaw) {
      if (
        typeof draftRaw.id !== "string" ||
        typeof draftRaw.subject !== "string" ||
        typeof draftRaw.body !== "string" ||
        (draftRaw.delivery !== "unsent" &&
          draftRaw.delivery !== "copied" &&
          draftRaw.delivery !== "mailto_opened")
      ) {
        return { status: "error" };
      }
      const systemKey = asText(draftRaw.system_template_key);
      draft = {
        id: draftRaw.id,
        subject: draftRaw.subject,
        body: draftRaw.body,
        tripId: asText(draftRaw.trip_id),
        templateId: asText(draftRaw.template_id),
        systemTemplateKey:
          systemKey === "introduction" ||
          systemKey === "stay" ||
          systemKey === "follow_up" ||
          systemKey === "return_visit"
            ? systemKey
            : null,
        delivery: draftRaw.delivery,
      };
    }

    return {
      status: "ok",
      facts,
      trips: tripChoices,
      templates: templateRows,
      draft,
      recipientEmail,
      contactLocked,
      contactUnchecked,
      intelligenceUnavailable,
      relationshipStatus,
      selectedTripId: selected?.id ?? null,
      primaryLanguage: profile.profile.primaryLanguage,
    };
  } catch {
    return { status: "error" };
  }
}

export async function listOwnPitchTemplates(): Promise<
  { status: "ok"; templates: PitchTemplateRow[] } | { status: "error" }
> {
  try {
    const supabase = await createClient();
    const { data, error } = await supabase
      .from("pitch_templates")
      .select("id, name, subject, body")
      .is("archived_at", null)
      .order("updated_at", { ascending: false })
      .limit(50);
    if (error) return { status: "error" };
    const templates: PitchTemplateRow[] = [];
    for (const row of data ?? []) {
      const record = row as { id?: unknown; name?: unknown; subject?: unknown; body?: unknown };
      if (
        typeof record.id !== "string" ||
        typeof record.name !== "string" ||
        typeof record.subject !== "string" ||
        typeof record.body !== "string"
      ) {
        return { status: "error" };
      }
      templates.push({
        id: record.id,
        name: record.name,
        subject: record.subject,
        body: record.body,
      });
    }
    return { status: "ok", templates };
  } catch {
    return { status: "error" };
  }
}
