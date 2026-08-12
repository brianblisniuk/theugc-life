# theugc.life — ROUTES.md
Version: 1.0
Framework: Next.js App Router.

## 1. Routing principles

- Public URLs are human-readable and SEO-oriented.
- Internal relationships use UUIDs.
- Slugs are never foreign keys.
- After authentication/payment, return users to the intent that triggered the flow where possible.
- Route protection occurs server-side.
- Do not create reserved future routes until their feature PRD exists.

## 2. Public routes

### `/`
Marketing landing page.
Primary CTA: explore creator-friendly hotels / start free.

### `/pricing`
Free, Creator Destination Pass explanation, Creator Pro.
Destination-specific checkout is initiated from destination context.

### `/hotels`
Public browse/search surface with safe information only.

### `/hotels/[slug]`
Public hotel page.
Shows basic hotel data + safe aggregate intelligence.
Never premium contacts.
CTAs:
- View verified contact
- Create/save account
- Claim this profile (lead capture)

### `/destinations/[slug]`
Destination SEO/acquisition page.
Shows map/list/public intelligence and relevant pass/Pro CTA.

### `/creators/[username]`
Only if public profile enabled.
Public portfolio.

### `/reports/[slug]`
Architecture reserved for published proprietary reports. It may be absent/404 until report publishing exists.

### `/share/[token]`
Public share-card/recap landing. Token must be non-guessable.

## 3. Auth routes

### `/login`
### `/signup`
### `/forgot-password`
### `/onboarding`

Onboarding is lightweight:
1. next destination
2. creator type

After completion redirect to relevant destination/discovery context.

## 4. Authenticated app routes

### `/app`
Dashboard/home.

### `/app/discover`
Authenticated map/search/filter experience.

### `/app/hotels/[id]`
Authenticated hotel workspace using UUID.
Includes entitlement-aware contact section and private creator relationship.

### `/app/pipeline`
List/Kanban CRM.

Recommended query params:
- `view=list|board`
- filters may use URL search params.

### `/app/trips`
Trip list.

### `/app/trips/[id]`
Trip workspace. Ownership required.

### `/app/profile`
Creator profile editor.

### `/app/profile/portfolio`
Portfolio asset management.

### `/app/account`
Account/security/preferences.

### `/app/billing`
Current access, passes, Pro state, referral link if enabled.

## 5. Checkout routes

### `/checkout/destination/[slug]`
Explains selected destination pass and sends to Hotmart checkout.

### `/checkout/pro`
Pro checkout bridge.

### `/payment/success`
Must verify entitlement/payment server-side; never trust query-string “success” alone.
Return to stored post-checkout intent when available.

### `/payment/cancelled`
No entitlement mutation based solely on this route.

## 6. Admin routes

All server-protected.

- `/admin`
- `/admin/hotels`
- `/admin/hotels/[id]`
- `/admin/contacts`
- `/admin/flags`
- `/admin/verifications`
- `/admin/users`
- `/admin/access`
- `/admin/database-health`

Editor access may be narrower than admin on account/access routes.

## 7. Upgrade routing behavior

### Anonymous clicks locked contact
Store intended hotel URL → signup/login → return to hotel.

### Free clicks locked contact
Open upgrade UI:
- destination pass for current destination
- Pro

### Destination user clicks hotel outside entitlement
Offer:
- destination pass for target destination if sellable
- Pro

### Paid checkout success
Return directly to triggering hotel/destination whenever possible.

## 8. Expired entitlement behavior

Do not redirect creator away from owned CRM records.
Hotel contact/intelligence sections become locked; private historical pipeline remains available.

## 9. Canonical/SEO rules

- Public hotel/destination pages define canonical URL.
- Changed slugs should preserve redirect mapping if page has been indexed/shared.
- Closed hotels remain addressable with clear status where useful.
- Admin/app pages are noindex.
- Public creator profile is noindex if user disables public profile.

## 10. Map/search API behavior

Do not fetch entire worldwide dataset to browser.
Server/API queries accept:
- map bounds
- search query
- destination
- filters
- pagination/limit

Contacts are never included in public map payloads.

## 11. Route error states

Explicitly design:
- 404 unknown hotel/destination
- closed hotel
- deleted/private creator profile
- expired share token
- unauthorized app resource
- payment pending
- entitlement sync delay
- no results in map bounds

No silent redirects that obscure authorization failures.
