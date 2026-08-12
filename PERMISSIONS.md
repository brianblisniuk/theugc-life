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

## 6. Private notes

`pipeline_items.private_notes` are especially sensitive.
- owner read/write
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

### Public
Only safe coarse projection.

### Premium
Detailed intelligence can be returned if:
- active Pro; or
- active Destination entitlement covers hotel/destination.

Premium intelligence still obeys confidence/privacy suppression.

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
