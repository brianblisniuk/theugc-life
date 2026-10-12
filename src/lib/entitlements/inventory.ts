/**
 * Canonical Pass/Pro feature inventory (E04).
 *
 * One module names every existing module, route, and server action, and the
 * tier rule already written in the PRD or DECISIONS.md. Call sites read the
 * limit and the premium helper from here. This module does not grant access.
 *
 * Access is an entitlement row. A purchase, a subscription, or a webhook body
 * is not access (D007). A missing, expired, revoked, pending, or not-yet-started
 * row is Free. It is never Pro.
 *
 * A feature with no written tier is `undecided`. Its current behavior stays.
 * The question for Brian is on the entry. This module does not invent a tier.
 */
import { FREE_LIMITS } from "@/lib/config";

/** Self-scoped database helper. Both premium surfaces use this one function. */
export const PREMIUM_HOTEL_RPC = "has_premium_hotel_access" as const;

export type LimitKey = keyof typeof FREE_LIMITS;

/**
 * Written tier rule.
 *
 * `all_tiers` — Free, Pass, and Pro are the same. A paid row adds nothing.
 * `premium_scoped` — Free no; Pass inside the entitled destination hierarchy;
 *   Pro worldwide (D050, D056, D058, PERMISSIONS.md §7 and §9).
 * `workspace_limited` — Free is capped by FREE_LIMITS. Pass is exempt inside
 *   the entitled destination and Free outside. Pro is exempt worldwide
 *   (D042, D056).
 * `owner_private` — the signed-in owner, at every tier including Free and
 *   after expiry (D014). Another user's Pro row does not grant it.
 * `staff_role` — admin or editor (PERMISSIONS.md §11). A creator plan does not.
 * `public_page` — no session and no plan.
 * `system_grant` — a trusted writer may insert an entitlement row. The row is
 *   the access. A creator plan does not call this, and a purchase alone is not.
 * `undecided` — no written tier. Current behavior stays.
 */
export type TierRule =
  | { kind: "all_tiers" }
  | { kind: "premium_scoped" }
  | { kind: "workspace_limited"; limitKey: LimitKey }
  | { kind: "owner_private" }
  | { kind: "staff_role" }
  | { kind: "public_page" }
  | { kind: "system_grant" }
  | { kind: "undecided" };

export type AnonAccess = "allow" | "deny";

/**
 * How the running server enforces the entry. The Postgres suite probes this
 * kind. `kept_current` means this block added no plan check.
 */
export type Enforcement =
  | { kind: "hotel_select" }
  | { kind: "public_intelligence" }
  | { kind: "premium_contacts" }
  | { kind: "premium_intelligence" }
  | { kind: "save_limit" }
  | { kind: "engage_limit" }
  | { kind: "trip_limit" }
  | { kind: "owner_rows"; tables: readonly string[] }
  | { kind: "staff_write" }
  | { kind: "purchase_is_not_access" }
  | { kind: "kept_current" };

export interface InventoryEntry {
  id: string;
  module: string;
  summary: string;
  routes: readonly string[];
  /** App Router files this entry covers. Every page and route file is on at least one entry. */
  sourceFiles: readonly string[];
  serverActions: readonly string[];
  rpcs: readonly string[];
  rule: TierRule;
  /** Anonymous catalogue access. App routes still require a session in middleware. */
  anon: AnonAccess;
  enforcement: Enforcement;
  sources: readonly string[];
  /** Required when rule.kind is undecided. A question for Brian, not a tier. */
  question?: string;
}

export const INVENTORY: readonly InventoryEntry[] = [
  {
    id: "discover.catalogue",
    module: "Discover",
    summary:
      "Published hotel discovery is worldwide for Free, Pass, and Pro. A Pass never hides a hotel.",
    routes: ["/app/discover"],
    sourceFiles: ["src/app/(app)/app/discover/page.tsx", "src/lib/hotels/queries.ts"],
    serverActions: [],
    rpcs: [],
    rule: { kind: "all_tiers" },
    anon: "allow",
    enforcement: { kind: "hotel_select" },
    sources: ["PRD §5.1", "PRD §5.3.1", "D049", "D016"],
  },
  {
    id: "discover.map",
    module: "Map",
    summary:
      "Discover pins are the published hotels on the current page. Free, Pass, and Pro see the same set. The map does not read premium intelligence, contacts, pipeline, or trips.",
    routes: ["/app/discover"],
    sourceFiles: [
      "src/app/(app)/app/discover/page.tsx",
      "src/components/hotels/hotel-map.tsx",
      "src/lib/maps/pins.ts",
    ],
    serverActions: [],
    rpcs: [],
    rule: { kind: "all_tiers" },
    anon: "allow",
    enforcement: { kind: "hotel_select" },
    sources: ["D079", "D049", "D054"],
  },
  {
    id: "hotel.basics",
    module: "Hotel Detail",
    summary: "Hotel basics are open to Free, Pass, and Pro. The hotel is not the premium object.",
    routes: ["/app/hotels/[id]"],
    sourceFiles: ["src/app/(app)/app/hotels/[id]/page.tsx", "src/lib/hotels/queries.ts"],
    serverActions: [],
    rpcs: [],
    rule: { kind: "all_tiers" },
    anon: "allow",
    enforcement: { kind: "hotel_select" },
    sources: ["PRD §5.3.1", "PRD §7.3", "D049"],
  },
  {
    id: "hotel.map",
    module: "Map",
    summary:
      "Hotel Detail shows one pin for that published hotel. Plan gating of other sections is unchanged.",
    routes: ["/app/hotels/[id]"],
    sourceFiles: ["src/app/(app)/app/hotels/[id]/page.tsx", "src/components/hotels/hotel-map.tsx"],
    serverActions: [],
    rpcs: [],
    rule: { kind: "all_tiers" },
    anon: "allow",
    enforcement: { kind: "hotel_select" },
    sources: ["D079", "D049"],
  },
  {
    id: "hotel.public_intelligence",
    module: "Intelligence",
    summary:
      "Public intelligence is the safe aggregate. Anonymous visitors, Free, Pass, and Pro see the same projection.",
    routes: ["/app/hotels/[id]"],
    sourceFiles: [
      "src/app/(app)/app/hotels/[id]/page.tsx",
      "src/lib/hotels/queries.ts",
      "src/components/hotels/intelligence-panel.tsx",
    ],
    serverActions: [],
    rpcs: [],
    rule: { kind: "all_tiers" },
    anon: "allow",
    enforcement: { kind: "public_intelligence" },
    sources: ["PRD §5.3.1", "PRD §12.8", "D050", "D058", "PERMISSIONS.md §9"],
  },
  {
    id: "hotel.premium_intelligence",
    module: "Intelligence",
    summary:
      "Premium intelligence is denied on Free, allowed for a Pass inside its destination hierarchy, and worldwide for Pro.",
    routes: ["/app/hotels/[id]"],
    sourceFiles: [
      "src/app/(app)/app/hotels/[id]/page.tsx",
      "src/lib/hotels/queries.ts",
      "src/lib/entitlements/gate.ts",
    ],
    serverActions: [],
    rpcs: [PREMIUM_HOTEL_RPC],
    rule: { kind: "premium_scoped" },
    anon: "deny",
    enforcement: { kind: "premium_intelligence" },
    sources: ["PRD §5.2", "PRD §5.3", "PRD §5.3.1", "D050", "D056", "D058", "PERMISSIONS.md §9"],
  },
  {
    id: "hotel.premium_contacts",
    module: "Hotel Detail",
    summary:
      "Premium contacts use the same entitlement answer as premium intelligence. Payment does not unlock them.",
    routes: ["/app/hotels/[id]"],
    sourceFiles: [
      "src/app/(app)/app/hotels/[id]/page.tsx",
      "src/lib/hotels/queries.ts",
      "src/lib/entitlements/gate.ts",
      "src/components/hotels/contact-card.tsx",
    ],
    serverActions: [],
    rpcs: [PREMIUM_HOTEL_RPC],
    rule: { kind: "premium_scoped" },
    anon: "deny",
    enforcement: { kind: "premium_contacts" },
    sources: ["PRD §5.1", "PRD §5.3.1", "D056", "PERMISSIONS.md §7"],
  },
  {
    id: "pipeline.save",
    module: "Pipeline",
    summary:
      "Free may hold 10 open hotel relationships. A Pass is exempt inside the entitled destination, and those rows do not consume the outside Free allowance. Pro is exempt worldwide. Closed cycles do not count.",
    routes: ["/app/pipeline", "/app/hotels/[id]"],
    sourceFiles: ["src/lib/pipeline/actions.ts", "src/lib/pipeline/queries.ts"],
    serverActions: ["saveHotelAction"],
    rpcs: ["save_hotel_to_pipeline"],
    rule: { kind: "workspace_limited", limitKey: "savedHotels" },
    anon: "deny",
    enforcement: { kind: "save_limit" },
    sources: ["PRD §5.1", "PRD §5.3.1", "D042", "D056"],
  },
  {
    id: "pipeline.engage",
    module: "Pipeline",
    summary:
      "Free may advance 5 relationships past saved. In-destination Pass rows do not consume the outside Free allowance. Pro is exempt worldwide. Saved does not consume this allowance.",
    routes: ["/app/pipeline", "/app/hotels/[id]"],
    sourceFiles: ["src/lib/pipeline/actions.ts", "src/lib/pipeline/queries.ts"],
    serverActions: ["transitionPipelineItemAction", "progressPipelineDealAction"],
    rpcs: ["transition_pipeline_item", "progress_pipeline_deal"],
    rule: { kind: "workspace_limited", limitKey: "activePipelineItems" },
    anon: "deny",
    enforcement: { kind: "engage_limit" },
    sources: ["PRD §5.1", "PRD §5.3.1", "D042", "D056"],
  },
  {
    id: "pipeline.own",
    module: "Pipeline",
    summary:
      "A creator reads and notes their own pipeline at every tier. Expiry does not remove those rows. Another creator's Pro entitlement does not.",
    routes: ["/app/pipeline"],
    sourceFiles: [
      "src/app/(app)/app/pipeline/page.tsx",
      "src/lib/pipeline/actions.ts",
      "src/lib/pipeline/queries.ts",
    ],
    serverActions: ["updatePipelineNotesAction"],
    rpcs: ["update_pipeline_private_notes"],
    rule: { kind: "owner_private" },
    anon: "deny",
    enforcement: { kind: "owner_rows", tables: ["pipeline_items"] },
    sources: ["D014", "D056", "PERMISSIONS.md §6", "PERMISSIONS.md §8"],
  },
  {
    id: "trips.active",
    module: "Trips",
    summary:
      "Free may keep 1 active trip. A Pass is exempt when the trip's destination is covered, and covered trips do not consume the outside Free allowance. Pro is exempt worldwide.",
    routes: ["/app/trips", "/app/trips/[id]"],
    sourceFiles: ["src/lib/trips/actions.ts", "src/lib/trips/queries.ts"],
    serverActions: ["createTripAction", "updateTripAction"],
    rpcs: ["create_trip", "update_trip"],
    rule: { kind: "workspace_limited", limitKey: "activeTrips" },
    anon: "deny",
    enforcement: { kind: "trip_limit" },
    sources: ["PRD §5.1", "PRD §5.2", "PRD §5.3.1", "D042", "D056"],
  },
  {
    id: "trips.own",
    module: "Trips",
    summary:
      "Trip rows, shortlist, and pipeline links are the owner's. They remain after entitlement expiry.",
    routes: ["/app/trips", "/app/trips/[id]"],
    sourceFiles: [
      "src/app/(app)/app/trips/page.tsx",
      "src/app/(app)/app/trips/[id]/page.tsx",
      "src/lib/trips/actions.ts",
    ],
    serverActions: [
      "deleteTripAction",
      "addTripHotelAction",
      "removeTripHotelAction",
      "linkPipelineItemAction",
    ],
    rpcs: ["delete_trip", "add_trip_hotel", "remove_trip_hotel", "link_pipeline_item_to_trip"],
    rule: { kind: "owner_private" },
    anon: "deny",
    enforcement: { kind: "owner_rows", tables: ["trips"] },
    sources: ["PRD §7.5", "D014", "PERMISSIONS.md §8"],
  },
  {
    id: "inbox.own",
    module: "Inbox",
    summary:
      "Inbox is the creator's own pipeline links and suggestions. It is not a separate plan and it does not read another creator's mailbox.",
    routes: ["/app/inbox", "/app/pipeline?surface=inbox"],
    sourceFiles: [
      "src/app/(app)/app/inbox/page.tsx",
      "src/lib/inbox-pipeline/actions.ts",
      "src/app/(app)/app/pipeline/page.tsx",
    ],
    serverActions: [
      "bindInboxThreadAction",
      "unbindInboxThreadAction",
      "dismissInboxSuggestionAction",
      "acceptInboxSuggestionAction",
    ],
    rpcs: [
      "bind_pipeline_inbox_thread",
      "unbind_pipeline_inbox_thread",
      "dismiss_pipeline_inbox_suggestion",
      "accept_pipeline_inbox_suggestion",
    ],
    rule: { kind: "owner_private" },
    anon: "deny",
    enforcement: { kind: "owner_rows", tables: ["pipeline_inbox_bindings"] },
    sources: ["D080", "D081", "D014", "PRD §5.3.1"],
  },
  {
    id: "collaborations.lifecycle",
    module: "Collaborations",
    summary:
      "The collaboration lifecycle runs on a relationship the creator already owns. Expiry does not delete it. It is not a second entitlement.",
    routes: ["/app/collaborations", "/app/pipeline?surface=collaborations", "/app/hotels/[id]"],
    sourceFiles: [
      "src/app/(app)/app/collaborations/page.tsx",
      "src/lib/pipeline/actions.ts",
      "src/components/pipeline/collaboration-lifecycle.tsx",
    ],
    serverActions: ["progressCollaborationAction"],
    rpcs: ["progress_collaboration"],
    rule: { kind: "owner_private" },
    anon: "deny",
    enforcement: { kind: "owner_rows", tables: ["collaborations"] },
    sources: ["D045", "D056", "D014", "D081"],
  },
  {
    id: "collaborations.compensation",
    module: "Collaborations",
    summary:
      "Agreed compensation and deliverables are the owning creator's records. They are not a charge and not another user's Pro.",
    routes: ["/app/hotels/[id]"],
    sourceFiles: ["src/lib/collaboration/actions.ts", "src/lib/collaboration/queries.ts"],
    serverActions: [
      "saveCompensationAction",
      "saveDeliverableAction",
      "deleteDeliverableAction",
      "prefillCompensationAction",
    ],
    rpcs: [
      "upsert_collaboration_compensation",
      "upsert_collaboration_deliverable",
      "delete_collaboration_deliverable",
      "prefill_collaboration_compensation_suggestion",
    ],
    rule: { kind: "owner_private" },
    anon: "deny",
    enforcement: { kind: "owner_rows", tables: ["collaboration_agreed_compensations"] },
    sources: ["D078", "D014"],
  },
  {
    id: "gmail.connect",
    module: "Gmail",
    summary:
      "Connect, consent, and disconnect are authenticated and owner-scoped. No accepted decision assigns them to Free, Pass, or Pro.",
    routes: [
      "/app/account",
      "/api/integrations/gmail/oauth/start",
      "/api/integrations/gmail/oauth/callback",
    ],
    sourceFiles: [
      "src/app/(app)/app/account/page.tsx",
      "src/lib/gmail/actions.ts",
      "src/app/api/integrations/gmail/oauth/start/route.ts",
      "src/app/api/integrations/gmail/oauth/callback/route.ts",
    ],
    serverActions: ["grantGmailConsentAction", "disconnectGmailAction"],
    rpcs: [],
    rule: { kind: "undecided" },
    anon: "deny",
    enforcement: { kind: "owner_rows", tables: ["mail_accounts"] },
    sources: ["D018", "D067"],
    question:
      "Is connecting and disconnecting Gmail a Free capability, or does a Destination Pass or Pro gate it? No accepted decision assigns a tier. Current behavior is unchanged: a signed-in creator can connect and disconnect only their own mailbox.",
  },
  {
    id: "gmail.sync",
    module: "Gmail",
    summary:
      "Historical import and incremental sync run for a mailbox the creator owns. No accepted decision assigns a tier. This block does not add a plan check.",
    routes: [],
    sourceFiles: ["src/lib/gmail/sync/worker.server.ts", "src/lib/gmail/sync/on-login.server.ts"],
    serverActions: [],
    rpcs: [],
    rule: { kind: "undecided" },
    anon: "deny",
    enforcement: { kind: "owner_rows", tables: ["mail_accounts"] },
    sources: ["D068", "D076", "D067"],
    question:
      "Is Gmail historical import and incremental sync a Free capability, or a Pass/Pro capability? No accepted decision assigns a tier. Current behavior is unchanged: sync follows the creator's own mailbox and consent, not an entitlement row.",
  },
  {
    id: "onboarding.activation",
    module: "Onboarding",
    summary:
      "The first-flow checklist is derived from rows the creator owns. D082 is Proposed and assigns no tier. The checklist does not block the app.",
    routes: ["/onboarding", "/app"],
    sourceFiles: [
      "src/app/(auth)/onboarding/page.tsx",
      "src/app/(app)/app/page.tsx",
      "src/lib/onboarding/activation.ts",
    ],
    serverActions: [],
    rpcs: [],
    rule: { kind: "undecided" },
    anon: "deny",
    enforcement: { kind: "kept_current" },
    sources: ["D082", "PRD §7.1"],
    question:
      "Does the onboarding checklist, or any step in it, require a Destination Pass or Pro? D082 is Proposed and does not assign a tier. Current behavior is unchanged: the checklist does not block the rest of the app.",
  },
  {
    id: "home.dashboard",
    module: "Home",
    summary:
      "Home is the signed-in creator's operating page. PRD §7.1 does not assign a plan. It shows that creator's own trips and pipeline.",
    routes: ["/app"],
    sourceFiles: ["src/app/(app)/app/page.tsx"],
    serverActions: [],
    rpcs: [],
    rule: { kind: "undecided" },
    anon: "deny",
    enforcement: { kind: "kept_current" },
    sources: ["PRD §6", "PRD §7.1", "D081"],
    question:
      "Is Home available on Free, or does some block on it require a Pass or Pro? No accepted decision assigns Home a tier. Current behavior is unchanged: any signed-in creator can open it.",
  },
  {
    id: "account.settings",
    module: "Account",
    summary:
      "Account is the signed-in creator's own settings. No accepted decision assigns a plan.",
    routes: ["/app/account"],
    sourceFiles: ["src/app/(app)/app/account/page.tsx"],
    serverActions: [],
    rpcs: [],
    rule: { kind: "undecided" },
    anon: "deny",
    enforcement: { kind: "kept_current" },
    sources: ["docs/ROUTES.md §4"],
    question:
      "Is the account page available on Free? No accepted decision assigns it a tier. Current behavior is unchanged: any signed-in creator can open their own account page.",
  },
  {
    id: "auth.session",
    module: "Auth",
    summary:
      "Sign-in, sign-up, sign-out, and password reset are not given a commercial tier. They are not entitlement checks.",
    routes: ["/login", "/signup", "/forgot-password", "/reset-password", "/auth/callback"],
    sourceFiles: [
      "src/app/(auth)/login/page.tsx",
      "src/app/(auth)/signup/page.tsx",
      "src/app/(auth)/forgot-password/page.tsx",
      "src/app/(auth)/reset-password/page.tsx",
      "src/app/auth/callback/route.ts",
      "src/lib/auth/actions.ts",
    ],
    serverActions: ["signIn", "signUp", "signOut", "requestPasswordReset", "updatePassword"],
    rpcs: [],
    rule: { kind: "undecided" },
    anon: "allow",
    enforcement: { kind: "kept_current" },
    sources: ["PRD §4.1", "PRD §4.2", "docs/ROUTES.md §3"],
    question:
      "Confirm sign-in, sign-up, and password reset stay outside Pass and Pro. No accepted decision assigns them a tier. Current behavior is unchanged.",
  },
  {
    id: "profile.own",
    module: "Profile",
    summary:
      "A Free creator can manage their own profile. Private profile rows and non-public portfolio assets are owner-only.",
    routes: ["/app/profile", "/app/profile/portfolio", "/onboarding"],
    sourceFiles: [
      "src/app/(app)/app/profile/page.tsx",
      "src/app/(app)/app/profile/portfolio/page.tsx",
      "src/lib/auth/actions.ts",
    ],
    serverActions: ["completeOnboarding"],
    rpcs: [],
    rule: { kind: "owner_private" },
    anon: "deny",
    enforcement: { kind: "owner_rows", tables: ["creator_profiles", "portfolio_assets"] },
    sources: ["PRD §10.2", "PRD §7.6", "PERMISSIONS.md §5"],
  },
  {
    id: "profile.basic_vs_full",
    module: "Profile",
    summary:
      "The plan matrix says Free profile/portfolio is Basic and Pass/Pro is Yes. Nothing written says what Basic withholds. The editor is unchanged.",
    routes: ["/app/profile", "/app/profile/portfolio"],
    sourceFiles: [
      "src/app/(app)/app/profile/page.tsx",
      "src/app/(app)/app/profile/portfolio/page.tsx",
    ],
    serverActions: [],
    rpcs: [],
    rule: { kind: "undecided" },
    anon: "deny",
    enforcement: { kind: "kept_current" },
    sources: ["PRD §5.3.1", "PRD §10.2", "PRD §7.6"],
    question:
      "What does Basic withhold on Free that a Destination Pass or Pro profile includes? PRD §10.2 says a Free creator can manage their own profile, and §5.3.1 does not name the locked fields. Current behavior is unchanged.",
  },
  {
    id: "billing.own",
    module: "Billing",
    summary:
      "A creator reads their own entitlement rows. The page does not read another account, and it does not treat a purchase as access.",
    routes: ["/app/billing"],
    sourceFiles: ["src/app/(app)/app/billing/page.tsx", "src/lib/billing/queries.ts"],
    serverActions: [],
    rpcs: [],
    rule: { kind: "owner_private" },
    anon: "deny",
    enforcement: { kind: "owner_rows", tables: ["access_entitlements"] },
    sources: ["D007", "PERMISSIONS.md §12", "PRD §15"],
  },
  {
    id: "commerce.grant",
    module: "Billing",
    summary:
      "The billing webhook may write an entitlement row. The row is the access. A purchase without that row grants nothing. This block does not change prices or Rebill.",
    routes: ["/api/billing/webhook", "/pricing"],
    sourceFiles: [
      "src/app/api/billing/webhook/route.ts",
      "src/app/(public)/pricing/page.tsx",
      "src/lib/billing/grant.ts",
    ],
    serverActions: [],
    rpcs: ["grant_access_entitlement"],
    rule: { kind: "system_grant" },
    anon: "deny",
    enforcement: { kind: "purchase_is_not_access" },
    sources: ["D007", "PRD §15", "PERMISSIONS.md §12"],
  },
  {
    id: "marketing.public",
    module: "Marketing",
    summary: "The public landing page does not check a plan.",
    routes: ["/"],
    sourceFiles: ["src/app/(public)/page.tsx"],
    serverActions: [],
    rpcs: [],
    rule: { kind: "public_page" },
    anon: "allow",
    enforcement: { kind: "kept_current" },
    sources: ["docs/ROUTES.md §2", "PRD §4.1"],
  },
  {
    id: "admin.staff",
    module: "Admin",
    summary:
      "Admin and editor are staff roles. Creator Pro does not grant hotel writes, entitlement writes, or the admin shell.",
    routes: ["/admin"],
    sourceFiles: ["src/app/admin/page.tsx", "src/app/admin/layout.tsx"],
    serverActions: [],
    rpcs: [],
    rule: { kind: "staff_role" },
    anon: "deny",
    enforcement: { kind: "staff_write" },
    sources: ["PERMISSIONS.md §11", "PRD §4.6"],
  },
];

const byId = new Map<string, InventoryEntry>();
for (const entry of INVENTORY) {
  if (byId.has(entry.id)) throw new Error(`duplicate entitlement feature: ${entry.id}`);
  if (entry.rule.kind === "undecided" && !entry.question) {
    throw new Error(`${entry.id} is UNDECIDED without a question`);
  }
  byId.set(entry.id, entry);
}

const actionOwner = new Map<string, string>();
for (const entry of INVENTORY) {
  for (const name of entry.serverActions) {
    const prior = actionOwner.get(name);
    if (prior) throw new Error(`${name} is listed on both ${prior} and ${entry.id}`);
    actionOwner.set(name, entry.id);
  }
}

export function featureById(id: string): InventoryEntry {
  const entry = byId.get(id);
  if (!entry) throw new Error(`unknown entitlement feature: ${id}`);
  return entry;
}

/** Load-time binding. Importing a server-action module fails if its feature was dropped. */
export function bindServerActions(ids: readonly string[]): readonly InventoryEntry[] {
  return ids.map((id) => featureById(id));
}

/** Free allowance for a workspace feature. The number still lives in FREE_LIMITS. */
export function workspaceLimit(
  featureId: "pipeline.save" | "pipeline.engage" | "trips.active",
): number {
  const entry = featureById(featureId);
  if (entry.rule.kind !== "workspace_limited") {
    throw new Error(`${featureId} is not a workspace limit`);
  }
  return FREE_LIMITS[entry.rule.limitKey];
}

export interface AccessContext {
  /** Active Pro entitlement row for this caller. Not a purchase. */
  pro: boolean;
  /** Active destination entitlement covers this resource's destination, including descendants. */
  destinationCovers: boolean;
  /** Caller is still under the Free count. Ignored when the feature is not limited. */
  withinFreeLimit: boolean;
  /** Caller owns the private row. */
  owner: boolean;
  /** Caller is admin or editor. A Pro entitlement does not set this. */
  staff: boolean;
}

export type AccessDecision = "allow" | "deny" | "undecided";

/**
 * Apply the written rule. Empty coverage is Free.
 * Undecided stays undecided for every coverage, including Pro.
 */
export function decideAccess(entry: InventoryEntry, ctx: AccessContext): AccessDecision {
  switch (entry.rule.kind) {
    case "all_tiers":
    case "public_page":
      return "allow";
    case "premium_scoped":
      return ctx.pro || ctx.destinationCovers ? "allow" : "deny";
    case "workspace_limited":
      if (ctx.pro || ctx.destinationCovers) return "allow";
      return ctx.withinFreeLimit ? "allow" : "deny";
    case "owner_private":
      return ctx.owner ? "allow" : "deny";
    case "staff_role":
      return ctx.staff ? "allow" : "deny";
    case "system_grant":
      // A creator context never is the grant. Coverage, including Pro, does not
      // turn a purchase into access.
      return "deny";
    case "undecided":
      return "undecided";
    default: {
      const _exhaustive: never = entry.rule;
      return _exhaustive;
    }
  }
}

export interface EntitlementFact {
  accessType: string;
  status: string;
  startsAt: string | null;
  expiresAt: string | null;
  destinationId: string | null;
}

function instant(value: string | null): number | null {
  if (!value) return null;
  const parsed = new Date(value).getTime();
  return Number.isNaN(parsed) ? null : parsed;
}

/**
 * Active row, same clock as `_has_active_pro` / `_has_active_destination_access`:
 * status active, already started, and not expired. Anything else is Free.
 */
export function isActiveEntitlementFact(row: EntitlementFact, now: Date = new Date()): boolean {
  if (row.status !== "active") return false;
  const startsAt = instant(row.startsAt);
  if (row.startsAt && startsAt === null) return false;
  if (startsAt !== null && startsAt > now.getTime()) return false;
  if (!row.expiresAt) return true;
  const expiresAt = instant(row.expiresAt);
  if (expiresAt === null) return false;
  return expiresAt > now.getTime();
}

export interface Coverage {
  pro: boolean;
  destinationCovers: boolean;
}

/**
 * Coverage from entitlement rows only.
 * `access_type` `pro` is Pro. `destination` is a Pass, and only where
 * `destinationCovers` says the hierarchy includes the resource.
 * A `free` row, an unknown type, and a purchase are not Pro.
 */
export function coverageFromEntitlementRows(
  rows: readonly EntitlementFact[],
  now: Date,
  destinationCovers: (destinationId: string) => boolean,
): Coverage {
  let pro = false;
  let covers = false;
  for (const row of rows) {
    if (!isActiveEntitlementFact(row, now)) continue;
    if (row.accessType === "pro") pro = true;
    if (
      row.accessType === "destination" &&
      row.destinationId &&
      destinationCovers(row.destinationId)
    ) {
      covers = true;
    }
  }
  return { pro, destinationCovers: covers };
}

export function questionsForBrian(): readonly { id: string; question: string }[] {
  return INVENTORY.flatMap((entry) =>
    entry.rule.kind === "undecided" && entry.question
      ? [{ id: entry.id, question: entry.question }]
      : [],
  );
}

export function serverActionIndex(): ReadonlyMap<string, string> {
  return actionOwner;
}
