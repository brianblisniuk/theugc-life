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
| Premium intelligence and premium contacts | No | Entitled destination, including descendants | Worldwide |
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
| `hotel.premium_contacts` | Hotel Detail | same helper as premium intelligence |
| `pipeline.save` | Pipeline | Free limit 10; Pass exempt inside; outside counts only outside-coverage rows; Pro exempt |
| `pipeline.engage` | Pipeline | Free limit 5; same outside-coverage count |
| `pipeline.own` | Pipeline | owner, every tier |
| `trips.active` | Trips | Free limit 1; Pass exempt when covered; outside counts only outside-coverage trips |
| `trips.own` | Trips | owner, including after expiry |
| `inbox.own` | Inbox | owner. Not a separate plan |
| `collaborations.lifecycle` | Collaborations | owner, on a relationship they already have |
| `collaborations.compensation` | Collaborations | owner. Not a charge |
| `gmail.connect` | Gmail | UNDECIDED |
| `gmail.sync` | Gmail | UNDECIDED |
| `onboarding.activation` | Onboarding | UNDECIDED |
| `home.dashboard` | Home | UNDECIDED |
| `account.settings` | Account | UNDECIDED |
| `auth.session` | Auth | UNDECIDED |
| `profile.own` | Profile | owner. Free can manage their own profile, including `updateCreatorProfile` |
| `profile.basic_vs_full` | Profile | UNDECIDED |
| `profile.personal_analytics` | Profile | UNDECIDED |
| `profile.past_collaborations` | Profile | UNDECIDED |
| `profile.field_opt_ins` | Profile | UNDECIDED |
| `billing.own` | Billing | owner reads entitlement rows only |
| `commerce.grant` | Billing | system grant. A purchase is not access |
| `marketing.public` | Marketing | public page |
| `admin.staff` | Admin | staff role. Pro does not grant it |

## Enforcement

Premium contacts and premium intelligence both call `has_premium_hotel_access`, named by the inventory. The hotel page still uses one answer for both sections.

Save, engage, and active-trip limits are the existing RPCs. The number they receive is `workspaceLimit(...)`, which reads `FREE_LIMITS`. The database still decides the Pass hierarchy. A caller cannot pass a plan flag.

Own-row surfaces stay on RLS. A Pro entitlement does not select another creator's rows.

## Contradictory gates fixed

Migration `0051_outside_free_allowance.sql` fixes one contradictory gate. When a save, an engagement, or an active trip was outside coverage, `save_hotel_to_pipeline`, `transition_pipeline_item`, `create_trip`, and `update_trip` counted in-destination rows toward the Free allowance. A Destination Pass holder who used the in-destination exemption lost the outside Free allowance a Free account would keep. That contradicted D056, PRD §5.2, and PERMISSIONS.md §8. Those counters now count only outside-coverage rows. Pro stays exempt worldwide. Missing, expired, revoked, pending, and not-yet-started rows stay Free. UNDECIDED features are unchanged.

## Questions for Brian

These features have no written tier. Current behavior is unchanged.

- `gmail.connect` — Is connecting and disconnecting Gmail a Free capability, or does a Destination Pass or Pro gate it? No accepted decision assigns a tier. Current behavior is unchanged: a signed-in creator can connect and disconnect only their own mailbox.
- `gmail.sync` — Is Gmail historical import and incremental sync a Free capability, or a Pass/Pro capability? No accepted decision assigns a tier. Current behavior is unchanged: sync follows the creator's own mailbox and consent, not an entitlement row.
- `onboarding.activation` — Does the onboarding checklist, or any step in it, require a Destination Pass or Pro? D082 is Proposed and does not assign a tier. Current behavior is unchanged: the checklist does not block the rest of the app.
- `home.dashboard` — Is Home available on Free, or does some block on it require a Pass or Pro? No accepted decision assigns Home a tier. Current behavior is unchanged: any signed-in creator can open it.
- `account.settings` — Is the account page available on Free? No accepted decision assigns it a tier. Current behavior is unchanged: any signed-in creator can open their own account page.
- `auth.session` — Confirm sign-in, sign-up, and password reset stay outside Pass and Pro. No accepted decision assigns them a tier. Current behavior is unchanged.
- `profile.basic_vs_full` — What does Basic withhold on Free that a Destination Pass or Pro profile includes? PRD §10.2 says a Free creator can manage their own profile, and §5.3.1 does not name the locked fields. Current behavior is unchanged.
- `profile.personal_analytics` — Are creator-recorded personal counts a Free capability, or does a Destination Pass or Pro gate them? D087 is Proposed and does not assign a tier. Current behavior is unchanged: the signed-in creator reads only their own counts.
- `profile.past_collaborations` — Are past collaborations a Free capability, or does a Destination Pass or Pro gate the private list? D088 is Proposed and does not assign a tier. Current behavior is unchanged: the signed-in creator reads only their own completed and cancelled collaborations.
- `profile.field_opt_ins` — Does a per-field profile opt-in require a Destination Pass or Pro, or is it available on Free? D086 is Proposed and does not assign a tier. Current behavior is unchanged: the row is owner-only, no row means not shared, and this block does not add a hotel read.
