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
| `hotel.premium_contacts` | Hotel Detail | credit unlock for this user, or staff (D100) |
| `credits.pending_numbers` | Credits | undecided until the owner sets the amounts (D101) |
| `pipeline.save` | Pipeline | Free limit 10; Pass exempt inside; outside counts only outside-coverage rows; Pro exempt |
| `pipeline.engage` | Pipeline | Free limit 5; same outside-coverage count |
| `pipeline.own` | Pipeline | owner, every tier |
| `trips.active` | Trips | Free limit 1; Pass exempt when covered; outside counts only outside-coverage trips |
| `trips.own` | Trips | owner, including after expiry |
| `inbox.own` | Inbox | owner. Not a separate plan |
| `collaborations.lifecycle` | Collaborations | owner, on a relationship they already have |
| `collaborations.compensation` | Collaborations | owner. Not a charge |
| `collaborations.contracts` | Collaborations | owner, Free (D114, D098). A private draft, not a message and not legal advice |
| `gmail.connect` | Gmail | owner, Free (D098) |
| `gmail.sync` | Gmail | owner. Login and scheduled sync pause on Free (D102). Stored mail stays |
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

D098 (Accepted, 13 Oct 2026) closes the inventory questions that had no written tier. Those features are Free. Owner-only features stay owner-only: a Pro entitlement does not read another creator’s rows. Premium intelligence and the D056 workspace limits are unchanged. D100 changes contacts: a Pass or Pro row is not an email. `questionsForBrian()` returns one question, `credits.pending_numbers`. `profile.public_card` is the social profile at `/creators/[username]`.

## D114 — agreement drafts are owner-private and Free

`collaborations.contracts` is the won-deal agreement draft. No written tier assigns it to Pass or Pro, so it is Free (D098) and still owner-only. A Pro row does not read another creator's template or draft.

## D101 — pending credit numbers

`credits.pending_numbers` is the only undecided entry. Free credits, Pro and Pro+ monthly credits, pack sizes, cache TTL, and the not-found charge are placeholders in `CREDITS_CONFIG` and `credit_config`. They are not a price. The question for Brian is on the entry.
