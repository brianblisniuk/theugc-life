# theugc.life — PERMISSIONS.md
Version: 1.0
Security model: Supabase Auth + PostgreSQL RLS + server-side entitlement checks.

## 1. Non-negotiable rules

- UI hiding is never authorization.
- Client-supplied `role`, `plan`, `destination_id`, `creator_id`, or `user_id` is untrusted.
- Premium contacts require server-side authorization.
- Public intelligence never queries raw creator events.
- Creator-private rows are owner-only by default.
- Admin/editor privileges are server-verified.
- Service-role credentials never ship to browser.
- A failed authorization or entitlement lookup is a technical error, never a
  domain answer. It must not resolve to the least-privileged role, to "not
  saved", to zero, or to a plan the creator is not on.
- RLS scope is not query scope. A self-service surface must name the account it
  is asking about, with an id taken from the server session, even when a policy
  would already limit the rows. Policies that intentionally admit a second
  audience — `access_entitlements_select` admits admin/editor for
  reconciliation — otherwise widen every query that forgets to say who it means.
- An authenticated user with no `public.users` row is an integrity
  inconsistency, not a new account. `handle_new_user()` provisions the
  application row inside the `auth.users` insert transaction and nothing
  provisions asynchronously, so a missing row resolves to an error. Nothing in
  the application repairs it; the signup trigger is the only provisioning path.
- Table privileges are stated by migrations, never inherited from hosted
  defaults (D046). RLS decides which rows; the ACL decides whether the
  operation may be attempted at all; both must hold independently.

## 2. Actors

### Anonymous
Public pages only.

### Free Creator
Authenticated creator with limited workspace.

### Destination Creator
Authenticated creator with an active destination entitlement.

### Pro Creator
Authenticated creator with active worldwide Pro entitlement.

### Editor
Hotel/contact editorial maintenance. Does not automatically receive broad access to creator private notes.

### Admin
Business/account/entitlement/platform operations. Sensitive creator access should be minimized.

## 3. Access helper functions

Implement centralized server/database helpers conceptually equivalent to:

- `current_user_role()`
- `current_creator_id()`
- `has_active_pro(user_id)`
- `has_active_destination_access(user_id, destination_id)`
- `has_premium_hotel_access(user_id, hotel_id)`
- `is_admin_or_editor(user_id)`
- `destination_is_descendant(child_id, ancestor_id)`

Do not duplicate entitlement logic across React components.

## 4. Public data

Anonymous read allowed only for approved public projections:
- public hotel basic data
- public destination basic data
- safe public intelligence
- opted-in creator public profile/portfolio
- public share cards
- published reports

Anonymous read forbidden:
- hotel_contacts
- access_entitlements
- purchases/subscriptions
- pipeline_items
- trips unless a future explicit public projection exists
- outreach_events
- collaborations
- contact_signals
- verification internal notes
- admin flags

**As implemented (V1).** `anon` holds `SELECT` on exactly four relations:
`hotels`, `destinations`, `brands` and `hotel_public_intelligence`, plus
`creator_profiles` and `portfolio_assets` where the row is opted into public
display. Everything else in the forbidden list above is enforced by the absence
of a privilege, not only by policy. Share cards and published reports appear in
the allowed list as intended future projections; neither has a public surface
today, and `share_cards` is owner-read-only.

## 5. Creator ownership policies

For `creator_profiles`, creator may select/update own row where `user_id = auth.uid()`.

For creator-owned child tables, resolve ownership through creator profile:
- portfolio_assets
- trips
- trip_hotels
- pipeline_items
- outreach_events
- collaborations
- milestones where read is allowed
- share_cards management

A creator may never choose another creator's ID during insert. Server should derive it from authenticated identity.

### 5.1 What the browser may actually do (as implemented)

Ownership decides which ROWS a creator reaches. It does not follow that the
browser may write them. The CRM tables are **read-only to the browser**:

| Table | Browser (`authenticated`) | How mutations happen |
|---|---|---|
| `trips`, `trip_hotels` | select, insert, update, delete (own rows) | direct, under RLS |
| `portfolio_assets` | select, insert, update, delete (own rows) | direct, under RLS |
| `creator_profiles` | select, insert, update (own row) | direct, under RLS |
| `pipeline_items` | **select only** | trusted RPC |
| `outreach_events` | **select only** | trusted RPC |
| `collaborations` | **select only** | trusted RPC |
| `milestones`, `share_cards`, `referrals`, `public_creator_profile_views` | **select only** | no client write surface exists |

Client `INSERT` / `UPDATE` / `DELETE` on `pipeline_items` and `outreach_events`
was revoked in migration 0020, and on `collaborations` in 0021. Every state
change on those three tables goes through a service-role-only RPC
(`save_hotel_to_pipeline`, `transition_pipeline_item`, `progress_pipeline_deal`,
`progress_collaboration`) which, in one transaction, locks the creator,
re-derives ownership from the session user, validates the transition, enforces
the Free limits and appends the event ledger entry. A direct client write would
bypass all of it, which is why the privilege does not exist.

The RLS policies on those tables are retained as defence in depth, not as the
mechanism: both layers must hold independently (D046).

## 6. Private notes

`pipeline_items.private_notes` are especially sensitive.
- owner read (the browser holds no write privilege on `pipeline_items`; notes
  editing is not implemented in V1, and when it ships it must go through the
  trusted RPC path like every other pipeline mutation)
- excluded from product analytics payloads
- excluded from logs
- excluded from public/admin list views
- admin access only through a separately approved support mechanism if ever required

## 7. Hotel/contact access

### Hotel basics
Public where hotel is publishable.

### Contacts
- Anonymous: deny
- Free: deny
- Destination: allow only if active entitlement covers hotel's destination through hierarchy
- Pro: allow worldwide
- Admin/editor: allow for operational duties

Contact authorization must happen before returning contact fields. Do not return locked contact data and merely blur it in browser.

## 8. CRM plan behavior

Private historical workspace survives entitlement expiry.

### Free
May use configured free limits. Limits are application/business rules in addition to RLS ownership.

### Destination
Full approved CRM behavior for entitled destination hotels. Existing historical pipeline remains readable after pass expiry; premium contact/intelligence access is removed.

### Pro
Worldwide.

If a Destination Pass expires, do not revoke ownership/read access to creator's own pipeline/trips.

## 9. Intelligence access

### What the browser can reach today

**Only the safe coarse projection, `public.hotel_public_intelligence`.**

Migration 0022 revoked all client access to the base aggregate tables:
`hotel_intelligence` and `destination_intelligence` are readable by
`service_role` only. **No plan will ever change that** — not Pro, not a
Destination Pass, and not the future Premium Intelligence layer, which gets its
own projection rather than a grant on these tables. Their RLS policies are
retained as defence in depth, but no client role holds a privilege to reach them
at all.

The projection exposes exactly seven columns — `hotel_id`, `hotel_slug`,
`activity_level`, `confidence_level`, `reply_rate`,
`has_confirmed_collaboration`, `recency_band` — with no creator id, no pipeline
id, no exact counts and no raw timestamps, and it applies progressive
disclosure by confidence band (D044):

| Confidence | Disclosed |
|---|---|
| insufficient | confidence only |
| emerging | + activity level, + collaboration boolean |
| moderate | + coarse recency band |
| strong | + reply rate |

A suppressed answer is `NULL`, never `false`. "We are not telling you" and "the
answer is no" are different statements and are never collapsed.

### Premium Intelligence — approved, not yet built (D050)

The V1 contract has **two** browser-safe projections: **Public Intelligence**
(everyone) and **Premium Intelligence** (entitled destination, or worldwide on
Pro). See PRD §12.8.

**Today only the public one exists**, and it is graduated by confidence rather
than by plan — so reply rate currently reaches every browser role at `strong`
confidence. Closing that gap is implementation work
([`V1_CONTRACT_IMPLEMENTATION_BACKLOG.md`](V1_CONTRACT_IMPLEMENTATION_BACKLOG.md)),
not a permissions change to make here.

Binding constraints on that implementation:

- **Privacy is identical across plans.** Contributor anonymity, minimum
  observation thresholds, confidence thresholds, suppression rules and
  NULL-vs-zero semantics are the same for Free, Destination Pass and Pro.
  Premium buys more of the safe aggregate, never weaker privacy.
- **Premium Intelligence gets its own scoped projection**, with its own
  suppression rules, entitlement-gated in the database.
- It must **never** be implemented by granting a browser role access to
  `hotel_intelligence`, `destination_intelligence`, `outreach_events`,
  `collaborations`, or any creator-level or raw aggregate source. Those stay
  `service_role`-only (D046, migration 0022). No subscription changes that.
- Entitlement gating belongs in RLS/helpers, not in the UI — the existing
  `has_premium_hotel_access` pattern is the model, not a new client-side check.

Hotel **discovery** is never entitlement-gated: there is one canonical inventory
and every publishable hotel is discoverable worldwide (D049). Entitlements gate
Premium Intelligence and actionable contacts, not the catalogue.

No plan bypasses privacy thresholds.

## 10. Signals

Creators can insert a `contact_signal` only when:
- authenticated;
- `creator_id` resolves to self;
- referenced hotel/contact exists;
- signal type is allowed.

Creators cannot edit master contact truth from a signal.

Creators should not browse other creators' signals.

Editors/admins can review signals.

## 11. Verification and admin operations

Editors:
- CRUD editorial hotel/contact fields according to admin UI.
- create verification events.
- review operational flags.
- no entitlement management unless explicitly granted.

Admins:
- user/account lookup
- entitlement operations
- payment reconciliation
- hotel/contact operations
- flags/verifications

All sensitive admin mutations should record actor and timestamp.

## 12. Commerce

Creator can read own purchases/subscriptions/entitlements.
Creator cannot create an active paid entitlement directly.
Paid entitlements are created/updated only by trusted server/payment webhook/admin operation.

Webhook handler uses service role/server credentials and validated provider signature/authentication.

## 13. RLS test matrix

Automated permission tests must cover:

1. Anonymous cannot select hotel contact.
2. Free cannot select hotel contact.
3. Destination user can select entitled hotel contact.
4. Destination user cannot select non-entitled contact.
5. Parent destination pass covers configured descendant hotel.
6. Pro can select worldwide contact.
7. Creator A cannot read Creator B pipeline.
8. Creator A cannot update Creator B trip.
9. Creator A cannot insert outreach event with Creator B identity.
10. Anonymous cannot read outreach_events.
11. Public intelligence contains no creator IDs.
12. Editor cannot read private notes through ordinary editorial endpoints.
13. Expired pass loses premium contact but retains own pipeline.
14. Cancelled Pro retains access until entitlement expiry.
15. Refunded/revoked entitlement removes premium access.
16. Admin route rejects creator role even if UI URL is manually entered.
17. `authenticated` holds no INSERT/UPDATE/DELETE on `pipeline_items`,
    `outreach_events` or `collaborations`, while SELECT of own rows still works.
18. No client role holds any privilege on `hotel_intelligence` or
    `destination_intelligence`.
19. No client role holds TRUNCATE on any relation in `public`.
20. The full privilege matrix matches the declared contract, and a relation
    outside the contract fails the suite (drift detection).
21. An admin resolves as admin, an editor as editor, a creator as creator, from
    the database — never from `user_metadata` or any client-supplied value.
22. A failed role lookup resolves to a technical error, not to `creator`, and
    the admin surface is not rendered under a guessed role.
23. Role and status escalation from the `authenticated` role is rejected.
24. `/app/billing` reports only the signed-in account's entitlements: an
    admin or editor with none of their own sees the Free state even though
    `access_entitlements_select` permits them to read every row.
25. Admin and editor can still read every entitlement row through an explicit
    reconciliation query, and a regular creator still cannot.

## 14. Free-limit enforcement

Free limits (saved hotels, active pipeline, active trips) must be checked transactionally server-side. Race conditions must not allow arbitrary bypass.

Configuration values live in one typed configuration source, not scattered literals.

## 15. Storage permissions

Portfolio storage:
- creator may upload/delete own objects
- public assets readable only if asset/profile is public
- private/unpublished assets require signed/authenticated access
- file paths must namespace by creator UUID

Admin/editor storage for hotel/brand assets uses separate namespace/policy.

## 16. Audit expectations

Log at minimum:
- entitlement manual grants/revokes
- hotel merge
- contact invalidation/replacement
- verification state changes
- role changes
- destructive account operations

Never log raw private notes or unnecessary PII.
