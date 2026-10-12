/**
 * Empty / error / list decisions for Inbox and Collaborations (D082).
 *
 * A failed read is not an empty list. Another creator's row is not rendered.
 * Compensation amounts and message bodies are not part of these models.
 */
import { isUuid } from "@/lib/hotels/ids";
import { collaborationStatusLabel, collaborationTypeLabel } from "@/lib/pipeline/types";

export const LIST_CAP = 50;

export const COLLABORATION_LIST_COLUMNS =
  "id, creator_id, hotel_id, status, collaboration_type, start_date, end_date, hotel:hotels(id, name)";

export const INBOX_LIST_COLUMNS =
  "id, creator_id, pipeline_item_id, pipeline_item:pipeline_items(hotel_id, hotel:hotels(id, name)), mail_account:mail_accounts(email_address, user_id)";

export const GMAIL_PROBE_COLUMNS = "user_id, connection_state";

export const PROFILE_COLUMNS = "id, user_id, display_name";

export const SURFACE_ERROR = {
  home: {
    title: "We couldn’t load Home",
    body: "Something went wrong on our side. Try again. This is not an empty page.",
  },
  trips: {
    title: "We couldn’t load your trips",
    body: "Something went wrong on our side. Try again. This is not an empty trip list.",
  },
  pipeline: {
    title: "We couldn’t load your pipeline",
    body: "Something went wrong on our side. Try again. This is not an empty pipeline.",
  },
  inbox: {
    title: "We couldn’t load your inbox",
    body: "Something went wrong on our side. Try again. This is not an empty inbox.",
  },
  collaborations: {
    title: "We couldn’t load your collaborations",
    body: "Something went wrong on our side. Try again. This is not an empty collaboration list.",
  },
  discover: {
    title: "We couldn’t load Discover",
    body: "Something went wrong on our side. Try again. This is not an empty catalog.",
  },
  hotel: {
    title: "We couldn’t open this hotel",
    body: "Something went wrong on our side. Try again. This does not mean the hotel is missing.",
  },
} as const;

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export type MailboxFact = "connected" | "absent" | "error" | "unconfigured";

export type CollaborationItem = {
  id: string;
  hotelId: string | null;
  hotelName: string;
  statusLabel: string;
  typeLabel: string | null;
  when: string | null;
};

export type InboxItem = {
  id: string;
  hotelId: string | null;
  hotelName: string;
  email: string | null;
};

export type OwnedListState<T> =
  | { kind: "error"; title: string; body: string }
  | { kind: "empty"; title: string; body: string; cta: { href: string; label: string } | null }
  | { kind: "items"; items: T[]; summary: string };

function one(value: unknown): Record<string, unknown> | null {
  const row = Array.isArray(value) ? value[0] : value;
  if (!row || typeof row !== "object") return null;
  return row as Record<string, unknown>;
}

function hotelOf(value: unknown): { id: string | null; name: string } {
  const hotel = one(value);
  const id = hotel && typeof hotel.id === "string" && isUuid(hotel.id) ? hotel.id : null;
  const name =
    hotel && typeof hotel.name === "string" && hotel.name.trim()
      ? hotel.name.trim()
      : "Saved hotel";
  return { id, name };
}

function whenOf(start: unknown, end: unknown): string | null {
  if (typeof start !== "string" || typeof end !== "string") return null;
  if (!DATE_RE.test(start) || !DATE_RE.test(end)) return null;
  return `${start} – ${end}`;
}

type Classified<T> = { kind: "own"; item: T } | { kind: "foreign" } | { kind: "unreadable" };

function classifyCollaboration(raw: unknown, viewerId: string): Classified<CollaborationItem> {
  const row = one(raw);
  if (!row || typeof row.creator_id !== "string" || typeof row.id !== "string" || !isUuid(row.id)) {
    return { kind: "unreadable" };
  }
  if (!isUuid(row.creator_id)) return { kind: "unreadable" };
  if (row.creator_id !== viewerId) return { kind: "foreign" };
  const hotel = hotelOf(one(row.hotel));
  const type =
    typeof row.collaboration_type === "string" &&
    row.collaboration_type in { stay: 1, product: 1, paid: 1, stay_plus_paid: 1, other: 1 }
      ? collaborationTypeLabel(row.collaboration_type)
      : null;
  return {
    kind: "own",
    item: {
      id: row.id,
      hotelId: hotel.id,
      hotelName: hotel.name,
      statusLabel: collaborationStatusLabel(typeof row.status === "string" ? row.status : null),
      typeLabel: type,
      when: whenOf(row.start_date, row.end_date),
    },
  };
}

function classifyInbox(raw: unknown, viewerId: string, authUserId: string): Classified<InboxItem> {
  const row = one(raw);
  if (!row || typeof row.creator_id !== "string" || typeof row.id !== "string" || !isUuid(row.id)) {
    return { kind: "unreadable" };
  }
  if (!isUuid(row.creator_id)) return { kind: "unreadable" };
  if (row.creator_id !== viewerId) return { kind: "foreign" };
  const pipelineItem = one(row.pipeline_item);
  const hotel = hotelOf(pipelineItem ? one(pipelineItem.hotel) : null);
  const hotelIdFromItem =
    pipelineItem && typeof pipelineItem.hotel_id === "string" && isUuid(pipelineItem.hotel_id)
      ? pipelineItem.hotel_id
      : hotel.id;
  const mail = one(row.mail_account);
  const mailUserId = mail && typeof mail.user_id === "string" ? mail.user_id : null;
  const email =
    mail &&
    mailUserId === authUserId &&
    typeof mail.email_address === "string" &&
    mail.email_address.trim()
      ? mail.email_address.trim()
      : null;
  return {
    kind: "own",
    item: {
      id: row.id,
      hotelId: hotelIdFromItem,
      hotelName: hotel.name,
      email,
    },
  };
}

function summary(shown: number, total: number, noun: string): string {
  const label = total === 1 ? noun : `${noun}s`;
  if (total > shown) return `Showing ${shown} of ${total} ${label}.`;
  return `${total} ${label}.`;
}

function settle<T>(input: {
  failed: boolean;
  identityFailed: boolean;
  total: number | null;
  rawRows: unknown[];
  viewerId: string | null;
  classify: (raw: unknown, viewerId: string) => Classified<T>;
  empty: { title: string; body: string; cta: { href: string; label: string } | null };
  error: { title: string; body: string };
  noun: string;
}): OwnedListState<T> {
  if (
    input.failed ||
    input.identityFailed ||
    input.viewerId === null ||
    !isUuid(input.viewerId) ||
    input.total === null
  ) {
    return { kind: "error", ...input.error };
  }

  const classified = input.rawRows.map((raw) => input.classify(raw, input.viewerId as string));
  if (classified.some((row) => row.kind === "unreadable")) {
    return { kind: "error", ...input.error };
  }
  const dropped = classified.filter((row) => row.kind === "foreign").length;
  const items = classified.flatMap((row) => (row.kind === "own" ? [row.item] : []));

  // A positive count whose page is entirely someone else's rows is not an
  // empty list. The count says rows exist; none of them belong to this viewer.
  if (dropped > 0 && items.length === 0) {
    if (input.total > 0) return { kind: "error", ...input.error };
    return { kind: "empty", ...input.empty };
  }

  if (dropped > 0) {
    return {
      kind: "items",
      items,
      summary: summary(items.length, items.length, input.noun),
    };
  }

  if (items.length === 0 && input.total === 0) return { kind: "empty", ...input.empty };
  if (items.length === 0 && input.total > 0) return { kind: "error", ...input.error };
  return {
    kind: "items",
    items,
    summary: summary(items.length, input.total, input.noun),
  };
}

const COLLAB_EMPTY = {
  title: "No collaborations yet",
  body: "A collaboration appears here after you mark a pipeline cycle won. An empty list is not a failed load.",
  cta: { href: "/app/pipeline", label: "Open your pipeline" },
};

const COLLAB_ERROR = {
  title: "We couldn’t load your collaborations",
  body: "We couldn’t load your collaborations. This is not an empty list. Reload the page to try again.",
};

export function collaborationListState(input: {
  failed: boolean;
  identityFailed: boolean;
  total: number | null;
  rawRows: unknown[];
  viewerId: string | null;
}): OwnedListState<CollaborationItem> {
  return settle({
    ...input,
    classify: classifyCollaboration,
    empty: COLLAB_EMPTY,
    error: COLLAB_ERROR,
    noun: "collaboration",
  });
}

function inboxEmpty(mailbox: MailboxFact): {
  title: string;
  body: string;
  cta: { href: string; label: string } | null;
} {
  if (mailbox === "unconfigured") {
    return {
      title: "No inbox links yet",
      body: "Gmail is not configured on this deployment, so there is no connection to start. Links you add later will show here.",
      cta: null,
    };
  }
  if (mailbox === "absent") {
    return {
      title: "Connect Gmail to build your inbox",
      body: "Inbox links are threads you attach to a pipeline hotel, using the Gmail connection you already have. Nothing is sent.",
      cta: { href: "/app/account", label: "Connect Gmail" },
    };
  }
  return {
    title: "No inbox links yet",
    body: "A link appears here when you attach a stored thread to a pipeline hotel. This list does not read or send mail on its own.",
    cta: { href: "/app/pipeline", label: "Open your pipeline" },
  };
}

const INBOX_ERROR = {
  title: "We couldn’t load your inbox",
  body: "We couldn’t load your inbox links. This is not an empty inbox. Reload the page to try again.",
};

export function inboxListState(input: {
  failed: boolean;
  identityFailed: boolean;
  total: number | null;
  rawRows: unknown[];
  viewerId: string | null;
  authUserId: string;
  mailbox: MailboxFact;
}): OwnedListState<InboxItem> {
  if (
    input.mailbox === "error" &&
    input.rawRows.length === 0 &&
    input.total === 0 &&
    !input.failed
  ) {
    return { kind: "error", ...INBOX_ERROR };
  }
  return settle({
    failed: input.failed,
    identityFailed: input.identityFailed,
    total: input.total,
    rawRows: input.rawRows,
    viewerId: input.viewerId,
    classify: (raw, viewerId) => classifyInbox(raw, viewerId, input.authUserId),
    empty: inboxEmpty(input.mailbox === "error" ? "connected" : input.mailbox),
    error: INBOX_ERROR,
    noun: "inbox link",
  });
}
