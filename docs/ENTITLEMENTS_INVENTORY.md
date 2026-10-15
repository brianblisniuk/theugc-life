# Entitlements inventory

Canonical map of existing modules, routes, and server actions to Free, Destination Pass, and Creator Pro.

The code is `src/lib/entitlements/inventory.ts`. This file restates it. A test fails if an id or a question below drifts from that module.

Access is an `access_entitlements` row (D007). A purchase, a subscription, or a webhook body is not access. A missing, expired, revoked, pending, or not-yet-started row is Free. It is never Pro.

A failed entitlement read is an error, not Free and not a denial (D059).

Migration `0051_outside_free_allowance.sql` corrects the outside Free counters (D056). D083–D085 are not used: assigning a tier that is not already written would invent one.

## Rules already written

| Rule | Free | Destination Pass | Creator Pro |
|---|---|---|---|
| Worldwide discovery, hotel basics, map, public intelligence | Yes | Yes | Yes |
| Premium intelligence | No | Entitled destination, including descendants | Worldwide |
| Metric activity ranking | Yes, including anonymous | Yes | Yes |
| Metric response rankings | No | Entitled destination, including descendants | Worldwide |
| Discover and Pipeline metric order | Public metric only | Premium metrics inside the Pass | Premium metrics worldwide |
| Hotel contact email | No, until this user unlocks that hotel | A Pass does not reveal it | A Pro row does not reveal it |
| Open relationships | 10 | Unlimited inside the destination; outside, only outside-coverage rows count toward 10 | Unlimited |
| Engaged pipeline | 5 | Same exemption; in-destination rows do not consume the outside allowance | Unlimited |
| Active trips | 1 | Exempt when the trip destination is covered; covered trips do not consume the outside allowance | Unlimited |
| Own pipeline, trips, inbox, collaborations, compensation, profile | Owner, including after expiry | Owner | Owner. Does not reach another creator |

Sources: PRD §5.1–§5.3.1, §10.2, §12.8, §15; D014, D042, D049, D050, D056, D058, D078, D079, D080, D081; PERMISSIONS.md §7, §8, §9, §11, §12.

## Entries

| Id | Module | Rule |
|---|---|---|
| `discover.catalogue` | Discover | all tiers |
| `discover.map` | Map | all tiers |
| `hotel.basics` | Hotel Detail | all tiers |
| `hotel.map` | Map | all tiers |
| `hotel.public_intelligence` | Intelligence | all tiers, including anonymous |
| `hotel.premium_intelligence` | Intelligence | Pass inside destination, Pro worldwide |
| `hotel.metric_activity` | Intelligence | all tiers, including anonymous (D120) |
| `hotel.metric_response` | Intelligence | Pass inside destination, Pro worldwide (D120) |
| `hotel.premium_contacts` | Hotel Detail | credit unlock for this user, or staff (D100) |
| `credits.plan_config` | Credits | system grant. Amounts are config (D131). A price is not a grant |
| `plans.full_ai_email` | Plans | Pro and Max. Free keeps manual templates. The flag allows the Claude draft (D142) |
| `plans.max_flags` | Plans | Max only. Priority AI is a fuller draft. Advanced signals add fit detail. Flags do not change Discover or Pipeline order (D133, D142, D150) |
| `pipeline.save` | Pipeline | Free limit 10; Pass exempt inside; outside counts only outside-coverage rows; Pro exempt |
| `pipeline.engage` | Pipeline | Free limit 5; same outside-coverage count |
| `pipeline.own` | Pipeline | owner, every tier |
| `trips.active` | Trips | Free limit 1; Pass exempt when covered; outside counts only outside-coverage trips |
| `trips.own` | Trips | owner, including after expiry |
| `inbox.own` | Inbox | owner. Not a separate plan |
| `collaborations.lifecycle` | Collaborations | owner, on a relationship they already have |
| `collaborations.compensation` | Collaborations | owner. Not a charge |
| `collaborations.contracts` | Collaborations | owner, Free (D114, D098). A private draft, not a message and not legal advice |
| `collaborations.deliverable_reminders` | Collaborations | owner, every tier (D115). In-app only |
| `gmail.connect` | Gmail | owner, Free (D098) |
| `gmail.send` | Gmail | Pro and Max (D156, D171). Free and a Destination Pass cannot. An explicit send, not a draft. Follow-ups are opted in per thread, at most two, with a delay of 1 to 30 days. Scheduling and sending spend no credits |
| `gmail.sync` | Gmail | owner. Login and scheduled sync pause on Free (D102). Stored mail stays |
| `jobs.scheduled` | Operations | system grant. Bearer jobs. A plan does not call them. A pending deletion blocks new Gmail connect, send, and sync (D178) |
| `gmail.collaboration_detection` | Gmail | owner. Detection pauses on Free (D102, D107). Suggestions until the creator confirms |
| `onboarding.activation` | Onboarding | owner, Free (D095, D098) |
| `home.dashboard` | Home | owner, Free (D098). Gmail suggestion ids on Home follow D107 and D112 |
| `account.settings` | Account | owner, Free (D098) |
| `auth.session` | Auth | all tiers (D098) |
| `profile.own` | Profile | owner. Free can manage their own profile, including `updateCreatorProfile` and `setPublicProfileEnabled` |
| `profile.basic_vs_full` | Profile | owner, full editor is Free (D098) |
| `profile.personal_analytics` | Profile | owner, Free (D097, D098) |
| `profile.past_collaborations` | Profile | owner, Free, private list (D097, D098) |
| `profile.field_opt_ins` | Profile | owner, Free (D098) |
| `profile.share_link` | Profile | owner, Free (D098). D089–D091 unchanged |
| `profile.share_public` | Profile | public page, no plan (D098) |
| `profile.public_card` | Profile | public page when the creator turned it on (D096, D097, D098) |
| `profile.portfolio` | Profile | owner, Free (D125, D098). Layout and explicit approval. Not the social profile |
| `billing.own` | Billing | owner reads entitlement rows only |
| `commerce.grant` | Billing | system grant. A purchase is not access |
| `marketing.public` | Marketing | public page |
| `ops.health` | Operations | public page. The body is status ok and nothing else |
| `pitch.drafts` | Pitch | owner, every tier (D098, D110). Copy and a mailto draft are not a sent pitch |
| `admin.staff` | Admin | staff role. Pro does not grant it |

## Enforcement

Premium intelligence calls `has_premium_hotel_access`. Contacts do not. A contact is visible when `has_unlocked_hotel_contact` is true for this user, or the caller is admin or editor. The hotel page asks those questions separately.

Save, engage, and active-trip limits are the existing RPCs. The number they receive is `workspaceLimit(...)`, which reads `FREE_LIMITS`. The database still decides the Pass hierarchy. A caller cannot pass a plan flag.

Own-row surfaces stay on RLS. A Pro entitlement does not select another creator's rows.

## Contradictory gates fixed

Migration `0051_outside_free_allowance.sql` fixes one contradictory gate. When a save, an engagement, or an active trip was outside coverage, `save_hotel_to_pipeline`, `transition_pipeline_item`, `create_trip`, and `update_trip` counted in-destination rows toward the Free allowance. A Destination Pass holder who used the in-destination exemption lost the outside Free allowance a Free account would keep. That contradicted D056, PRD §5.2, and PERMISSIONS.md §8. Those counters now count only outside-coverage rows. Pro stays exempt worldwide. Missing, expired, revoked, pending, and not-yet-started rows stay Free.

## D098 — features without a written tier are Free

D098 (Accepted, 13 Oct 2026) closes the inventory questions that had no written tier. Those features are Free. Owner-only features stay owner-only: a Pro entitlement does not read another creator’s rows. Premium intelligence and the D056 workspace limits are unchanged. D100 changes contacts: a Pass or Pro row is not an email. D131 closes the credit amounts, so `questionsForBrian()` is empty. `profile.public_card` is the social profile at `/creators/[username]`. Max matches Pro on worldwide paid rows (D133).

## D125 — the travel portfolio is owner-private and Free

`profile.portfolio` is the layout and the per-collaboration approval. No written tier assigns it to Pass or Pro, so it is Free (D098) and still owner-only. A Pro row does not read another creator’s drafts. The hotel share page stays `profile.share_public`. Publishing an entry does not turn on the social profile.

## D114 — agreement drafts are owner-private and Free

`collaborations.contracts` is the won-deal agreement draft. No written tier assigns it to Pass or Pro, so it is Free (D098) and still owner-only. A Pro row does not read another creator's template or draft.

## D131 — plan amounts

`credits.plan_config` is the live amounts. Free is 5 credits per rolling week and does not stack past 5. Pro is 150 credits a month at $20/mo billed annually or $30/mo monthly. Max replaces Pro+ at 500 credits a month, $50/mo billed annually or $60/mo monthly. Packs are 50 for $10, 150 for $20, and 500 for $40. Cache TTL stays 365 days. A miss is still not charged. Unlock cost stays 1. The numbers are config. Checkout is a hosted Rebill link (D137). A payment is not access until `apply_rebill_event` writes an entitlement (D138).

Free CRM stays 10 saved hotels, 5 active pipeline items, and 1 active trip. Pro and Max are exempt worldwide. A Destination Pass is unchanged.

`plans.full_ai_email` is on for Pro and Max and off for Free and for a Destination Pass. The assistant calls Claude only when that flag is on. `plans.max_flags` is priority AI, advanced signals, priority support, and a future-premium placeholder. Priority AI is more context and a richer draft on the same Sonnet model. Those flags do not change a ranking and do not send mail.
