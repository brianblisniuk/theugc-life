/**
 * Authenticated shell routes (PRD §6, D081 Accepted).
 *
 * Primary navigation stays Home, Discover, Pipeline, Trips, and Profile.
 * Inbox and Collaborations are pipeline surfaces, not new primary items and
 * not new records. Hotel Detail is a child page. `from` and `trip` choose
 * the breadcrumb only. They do not authorize a read.
 */
import { isUuid } from "@/lib/hotels/ids";

export const PRIMARY_NAV = [
  { href: "/app", label: "Home" },
  { href: "/app/discover", label: "Discover" },
  { href: "/app/pipeline", label: "Pipeline" },
  { href: "/app/trips", label: "Trips" },
  { href: "/app/profile", label: "Profile" },
] as const;

export const UTILITY_NAV = [
  { href: "/app/account", label: "Account" },
  { href: "/app/billing", label: "Billing" },
] as const;

/** Four Hotel Detail tabs. Map, inbox, collaboration, and trip stay anchors inside them. */
export const HOTEL_TABS = [
  { id: "overview", label: "Overview" },
  { id: "intelligence", label: "Intelligence" },
  { id: "contact", label: "Contact" },
  { id: "work", label: "My work" },
] as const;

export type HotelTabId = (typeof HOTEL_TABS)[number]["id"];

export const HOTEL_SECTIONS = [
  { id: "overview", label: "Overview" },
  { id: "identity", label: "Overview" },
  { id: "map", label: "Map" },
  { id: "intelligence", label: "Intelligence" },
  { id: "contact", label: "Contact" },
  { id: "work", label: "My work" },
  { id: "activity", label: "Activity" },
  { id: "inbox", label: "Inbox" },
  { id: "collaboration", label: "Collaboration" },
  { id: "trip", label: "Trip" },
] as const;

export type HotelSectionId = (typeof HOTEL_SECTIONS)[number]["id"];

export function hotelTabForHash(hash: string): HotelTabId {
  if (hash === "intelligence") return "intelligence";
  if (hash === "contact") return "contact";
  if (
    hash === "work" ||
    hash === "activity" ||
    hash === "inbox" ||
    hash === "collaboration" ||
    hash === "trip"
  ) {
    return "work";
  }
  return "overview";
}

export type PipelineSurface = "all" | "inbox" | "collaborations";

export type HotelOrigin =
  | { kind: "discover" }
  | { kind: "pipeline" }
  | { kind: "inbox" }
  | { kind: "collaboration" }
  | { kind: "trip"; tripId: string };

export interface Crumb {
  label: string;
  href?: string;
}

export interface ShellLink {
  href: string;
  label: string;
  ariaLabel: string;
}

/** Navigation notes. They are not counts and they are not error copy. */
export const SHELL_NOTES = {
  inboxNeedsCycle: "An inbox link attaches to an open pipeline cycle for this hotel.",
  collaborationNeedsWin: "A collaboration opens here once this hotel is won.",
} as const;

export const WORKSPACES = [
  { href: "/app/discover", label: "Discover", note: "Published hotels and the map" },
  { href: "/app/trips", label: "Trips", note: "Destination, dates, and shortlist" },
  { href: "/app/pipeline", label: "Pipeline", note: "Private hotel tracking" },
  {
    href: "/app/pipeline?surface=inbox",
    label: "Inbox",
    note: "Gmail readings beside each open cycle",
  },
  {
    href: "/app/pipeline?surface=collaborations",
    label: "Collaborations",
    note: "Won deals, deliverables, and agreed compensation",
  },
] as const;

function first(value: string | string[] | undefined | null): string | null {
  if (Array.isArray(value)) return value[0] ?? null;
  if (typeof value !== "string") return null;
  return value;
}

function isUnder(pathname: string, prefix: string): boolean {
  return pathname === prefix || pathname.startsWith(`${prefix}/`);
}

export function normalizePipelineSurface(
  raw: string | string[] | undefined | null,
): PipelineSurface {
  const value = first(raw);
  if (value === "inbox" || value === "collaborations") return value;
  return "all";
}

/**
 * Collaborations are the won cycles (D045). A conflicting status query does
 * not widen that list. Inbox keeps the caller's status filter.
 */
export function pipelineQueryStatus(
  surface: PipelineSurface,
  status: string | null,
): string | null {
  if (surface === "collaborations") return "won";
  return status;
}

export function pipelineSurfaces(): { id: PipelineSurface; href: string; label: string }[] {
  return [
    { id: "all", href: "/app/pipeline", label: "All" },
    { id: "inbox", href: "/app/pipeline?surface=inbox", label: "Inbox" },
    {
      id: "collaborations",
      href: "/app/pipeline?surface=collaborations",
      label: "Collaborations",
    },
  ];
}

export function pipelineSurfaceHeading(surface: PipelineSurface): {
  title: string;
  description: string;
} {
  if (surface === "inbox") {
    return {
      title: "Inbox",
      description:
        "Each open cycle can hold one Gmail thread. The reading is a suggestion beside your pipeline status. Connecting a mailbox is on Account. Opening this page does not start a sync.",
    };
  }
  if (surface === "collaborations") {
    return {
      title: "Collaborations",
      description:
        "Won deals. Deliverable deadlines and in-app reminders are listed here. Compensation for each piece opens on the hotel.",
    };
  }
  return {
    title: "Pipeline",
    description: "Every hotel you are tracking, most recent activity first. Only you can see this.",
  };
}

export function parseHotelOrigin(raw: Record<string, string | string[] | undefined>): HotelOrigin {
  const from = first(raw.from);
  if (from === "pipeline") return { kind: "pipeline" };
  if (from === "inbox") return { kind: "inbox" };
  if (from === "collaboration") return { kind: "collaboration" };
  if (from === "trip") {
    const tripId = first(raw.trip);
    if (tripId && isUuid(tripId)) return { kind: "trip", tripId };
  }
  return { kind: "discover" };
}

export function activePrimaryHref(pathname: string, origin: HotelOrigin | null): string | null {
  if (pathname === "/app") return "/app";
  if (isUnder(pathname, "/app/discover")) return "/app/discover";
  if (isUnder(pathname, "/app/pipeline")) return "/app/pipeline";
  if (isUnder(pathname, "/app/trips")) return "/app/trips";
  if (isUnder(pathname, "/app/profile")) return "/app/profile";
  if (isUnder(pathname, "/app/hotels")) {
    if (origin?.kind === "trip") return "/app/trips";
    if (origin && origin.kind !== "discover") return "/app/pipeline";
    return "/app/discover";
  }
  return null;
}

export function activeUtilityHref(pathname: string): string | null {
  if (isUnder(pathname, "/app/account")) return "/app/account";
  if (isUnder(pathname, "/app/billing")) return "/app/billing";
  return null;
}

export function isHotelSection(value: string): value is HotelSectionId {
  return HOTEL_SECTIONS.some((section) => section.id === value);
}

export function hotelHref(
  hotelId: string,
  origin: HotelOrigin,
  section?: HotelSectionId,
): string | null {
  if (!isUuid(hotelId)) return null;
  if (origin.kind === "trip" && !isUuid(origin.tripId)) return null;
  const params = new URLSearchParams();
  if (origin.kind === "pipeline") params.set("from", "pipeline");
  else if (origin.kind === "inbox") params.set("from", "inbox");
  else if (origin.kind === "collaboration") params.set("from", "collaboration");
  else if (origin.kind === "trip") {
    params.set("from", "trip");
    params.set("trip", origin.tripId);
  }
  const query = params.toString();
  const path = `/app/hotels/${hotelId}${query ? `?${query}` : ""}`;
  return section ? `${path}#${section}` : path;
}

export function tripHotelHref(tripId: string, hotelId: string): string | null {
  if (!isUuid(tripId)) return null;
  return hotelHref(hotelId, { kind: "trip", tripId });
}

/** Pitch draft for one hotel. An optional trip must be a UUID. It does not authorize the read. */
export function pitchHref(hotelId: string, tripId?: string | null): string | null {
  if (!isUuid(hotelId)) return null;
  if (tripId && !isUuid(tripId)) return null;
  const params = new URLSearchParams();
  if (tripId) params.set("trip", tripId);
  const query = params.toString();
  return `/app/hotels/${hotelId}/pitch${query ? `?${query}` : ""}`;
}

export function hotelCrumbs(origin: HotelOrigin, hotelName: string): Crumb[] {
  const home: Crumb = { label: "Home", href: "/app" };
  const current: Crumb = { label: hotelName.trim() || "Hotel" };
  switch (origin.kind) {
    case "discover":
      return [home, { label: "Discover", href: "/app/discover" }, current];
    case "pipeline":
      return [home, { label: "Pipeline", href: "/app/pipeline" }, current];
    case "inbox":
      return [
        home,
        { label: "Pipeline", href: "/app/pipeline" },
        { label: "Inbox", href: "/app/pipeline?surface=inbox" },
        current,
      ];
    case "collaboration":
      return [
        home,
        { label: "Pipeline", href: "/app/pipeline" },
        { label: "Collaborations", href: "/app/pipeline?surface=collaborations" },
        current,
      ];
    case "trip":
      return [
        home,
        { label: "Trips", href: "/app/trips" },
        { label: "Trip", href: `/app/trips/${origin.tripId}` },
        current,
      ];
  }
}

export function backLink(crumbs: readonly Crumb[]): { href: string; label: string } | null {
  for (let i = crumbs.length - 1; i >= 0; i -= 1) {
    const crumb = crumbs[i];
    if (crumb?.href) return { href: crumb.href, label: crumb.label };
  }
  return null;
}

export function pipelineReturnHref(origin: HotelOrigin): string {
  if (origin.kind === "inbox") return "/app/pipeline?surface=inbox";
  if (origin.kind === "collaboration") return "/app/pipeline?surface=collaborations";
  return "/app/pipeline";
}

export function pipelineRowLinks(
  item: { status: string; hotelId: string | null; hotelName?: string | null },
  surface: PipelineSurface,
): ShellLink[] {
  if (!item.hotelId || !isUuid(item.hotelId)) return [];
  const name = item.hotelName?.trim() || "hotel";
  const origin: HotelOrigin =
    surface === "inbox"
      ? { kind: "inbox" }
      : surface === "collaborations"
        ? { kind: "collaboration" }
        : { kind: "pipeline" };
  // D081: a closed cycle has no inbox link on any surface, including when the
  // row is already listed under ?surface=inbox.
  const inboxLink = item.status !== "closed";
  const section: HotelSectionId | undefined =
    surface === "inbox" && inboxLink
      ? "inbox"
      : surface === "collaborations"
        ? "collaboration"
        : undefined;
  const primary = hotelHref(item.hotelId, origin, section);
  if (!primary) return [];
  const primaryLabel = surface === "all" ? "Manage" : "Open";
  const links: ShellLink[] = [
    { href: primary, label: primaryLabel, ariaLabel: `${primaryLabel} ${name}` },
  ];
  if (surface !== "inbox" && inboxLink) {
    const href = hotelHref(item.hotelId, { kind: "inbox" }, "inbox");
    if (href) links.push({ href, label: "Inbox", ariaLabel: `Inbox for ${name}` });
  }
  if (surface !== "collaborations" && item.status === "won") {
    const href = hotelHref(item.hotelId, { kind: "collaboration" }, "collaboration");
    if (href) links.push({ href, label: "Collaboration", ariaLabel: `Collaboration for ${name}` });
  }
  return links;
}

export function listCrumbs(current: string, parent?: { href: string; label: string }): Crumb[] {
  const home: Crumb = { label: "Home", href: "/app" };
  if (!parent) return [home, { label: current }];
  return [home, parent, { label: current }];
}

/** Live routes only. Outreach and Contract Review stay out of this shell. */
export const SIDEBAR_NAV = [
  {
    label: "Your workspace",
    items: [
      { href: "/app", label: "Home", icon: "home" },
      { href: "/app/discover", label: "Discover", icon: "discover" },
      { href: "/app/trips", label: "My Trips", icon: "trips" },
    ],
  },
  {
    label: "Outreach & relationships",
    items: [
      { href: "/app/pipeline", label: "Pipeline", icon: "pipeline" },
      { href: "/app/inbox", label: "Inbox", icon: "inbox" },
    ],
  },
  {
    label: "Your business",
    items: [
      { href: "/app/collaborations", label: "Collaborations", icon: "collaborations" },
      { href: "/app/profile", label: "My Profile", icon: "profile" },
    ],
  },
  {
    label: "Account",
    items: [
      { href: "/app/plans", label: "Plans & Credits", icon: "plans" },
      { href: "/app/billing", label: "Billing & Activity", icon: "billing" },
      { href: "/app/onboarding", label: "Getting Started", icon: "start" },
      { href: "/app/account", label: "Account", icon: "account" },
    ],
  },
] as const;

export const MOBILE_NAV = [
  { href: "/app", label: "Home", icon: "home" },
  { href: "/app/discover", label: "Explore", icon: "discover" },
  { href: "/app/trips", label: "Trips", icon: "trips" },
  { href: "/app/inbox", label: "Inbox", icon: "inbox" },
  { href: "/app/pipeline", label: "Pipeline", icon: "pipeline" },
] as const;

export const SHELL_ICONS = [
  "home",
  "discover",
  "trips",
  "pipeline",
  "inbox",
  "collaborations",
  "profile",
  "billing",
  "plans",
  "start",
  "account",
] as const;

export type ShellIcon = (typeof SHELL_ICONS)[number];

export function shellHeading(pathname: string): { title: string; subtle: string } {
  if (pathname === "/app") return { title: "Home", subtle: "Your daily priorities" };
  if (isUnder(pathname, "/app/discover"))
    return { title: "Discover", subtle: "Hotels worth a closer look" };
  if (isUnder(pathname, "/app/trips"))
    return { title: "My Trips", subtle: "Dates, shortlist, and nights" };
  if (isUnder(pathname, "/app/pipeline"))
    return { title: "Pipeline", subtle: "Each commercial attempt" };
  if (isUnder(pathname, "/app/inbox"))
    return { title: "Inbox", subtle: "Replies that need a decision" };
  if (isUnder(pathname, "/app/collaborations")) {
    return { title: "Collaborations", subtle: "Deliverables and deadlines" };
  }
  if (isUnder(pathname, "/app/profile"))
    return { title: "My Profile", subtle: "How hotels see your work" };
  if (isUnder(pathname, "/app/plans"))
    return { title: "Plans & Credits", subtle: "Plans and available capabilities" };
  if (isUnder(pathname, "/app/billing"))
    return { title: "Billing & Activity", subtle: "Credit and billing transparency" };
  if (isUnder(pathname, "/app/account"))
    return { title: "Account", subtle: "Sign-in and connected email" };
  if (isUnder(pathname, "/app/onboarding"))
    return { title: "Getting Started", subtle: "Your first useful step" };
  if (isUnder(pathname, "/app/design")) return { title: "UI guide", subtle: "Midnight components" };
  if (isUnder(pathname, "/app/hotels")) return { title: "Hotel", subtle: "Detail" };
  return { title: "theugc.life", subtle: "Creator workspace" };
}

export function shellCrumbs(pathname: string, origin: HotelOrigin | null): Crumb[] {
  const root: Crumb = { label: "Workspace", href: "/app" };
  if (pathname === "/app") return [{ label: "Workspace" }];
  if (isUnder(pathname, "/app/trips/") && pathname !== "/app/trips") {
    return [root, { label: "My Trips", href: "/app/trips" }, { label: "Trip" }];
  }
  if (pathname === "/app/profile/portfolio") {
    return [root, { label: "My Profile", href: "/app/profile" }, { label: "Portfolio" }];
  }
  if (pathname === "/app/profile/pitches") {
    return [root, { label: "My Profile", href: "/app/profile" }, { label: "Pitch templates" }];
  }
  if (isUnder(pathname, "/app/onboarding/hotels")) {
    return [root, { label: "Getting Started", href: "/app/onboarding" }, { label: "Hotels" }];
  }
  if (isUnder(pathname, "/app/hotels")) {
    const current: Crumb = { label: pathname.includes("/pitch") ? "Pitch" : "Hotel" };
    if (origin?.kind === "trip") return [root, { label: "My Trips", href: "/app/trips" }, current];
    if (origin?.kind === "inbox") return [root, { label: "Inbox", href: "/app/inbox" }, current];
    if (origin?.kind === "collaboration") {
      return [root, { label: "Collaborations", href: "/app/collaborations" }, current];
    }
    if (origin?.kind === "pipeline")
      return [root, { label: "Pipeline", href: "/app/pipeline" }, current];
    return [root, { label: "Discover", href: "/app/discover" }, current];
  }
  return [root, { label: shellHeading(pathname).title }];
}

/** Longest matching sidebar href. Home is only the exact /app path. */
export function activeSidebarHref(pathname: string, origin: HotelOrigin | null): string | null {
  if (pathname === "/app") return "/app";
  if (isUnder(pathname, "/app/discover")) return "/app/discover";
  if (isUnder(pathname, "/app/trips")) return "/app/trips";
  if (isUnder(pathname, "/app/pipeline")) return "/app/pipeline";
  if (isUnder(pathname, "/app/inbox")) return "/app/inbox";
  if (isUnder(pathname, "/app/collaborations")) return "/app/collaborations";
  if (isUnder(pathname, "/app/profile")) return "/app/profile";
  if (isUnder(pathname, "/app/plans")) return "/app/plans";
  if (isUnder(pathname, "/app/billing")) return "/app/billing";
  if (isUnder(pathname, "/app/account")) return "/app/account";
  if (isUnder(pathname, "/app/onboarding")) return "/app/onboarding";
  if (isUnder(pathname, "/app/hotels")) {
    if (origin?.kind === "trip") return "/app/trips";
    if (origin?.kind === "inbox") return "/app/inbox";
    if (origin?.kind === "collaboration") return "/app/collaborations";
    if (origin && origin.kind !== "discover") return "/app/pipeline";
    return "/app/discover";
  }
  return null;
}

export function workspaceInitials(email: string | null): string {
  const local = (email ?? "").split("@")[0]?.replace(/[^a-zA-Z0-9]/g, "") ?? "";
  if (local.length >= 2) return local.slice(0, 2).toUpperCase();
  if (local.length === 1) return local.toUpperCase();
  return "·";
}
