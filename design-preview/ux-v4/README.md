# theugc.life — UX V4 Integrated Creator Workspace

**Status:** functional, browser-only UI prototype. It is NOT the Next.js application and does NOT touch production.
**Brand style:** approved dark sidebar + light editorial canvas, Archivo typography, accent #DFFF4F.
**Branch:** design/ux-v4-integrated-workspace-20261015 — main remains unchanged.

## Start

- [Open Discover](./index.html) in a hosted static preview.
- [Open Hotel Detail](./hotel.html).
- [Open Outreach Campaigns](./campaigns.html).
- [Open Pitch Studio](./pitch.html).
- [Open My Trips](./my-trips.html).
- [Open Pipeline](./pipeline.html).
- [Open Inbox](./inbox.html).
- [Open Contract Review](./contract-review.html).
- [Open Home](./home.html).

### Download single-file HTMLs (no build tools)

Each link below opens a **single HTML file that embeds all the product CSS and JavaScript**, preserving the navigation links to the other standalone HTMLs. Download them all into the same directory. No NPM or server is required. Remote Leaflet map tiles and Google Fonts still require internet.

- [Discover — standalone](./discover-standalone.html)
- [Hotel Detail — standalone](./hotel-standalone.html)
- [Outreach Campaigns — standalone](./campaigns-standalone.html)
- [Pitch Studio — standalone](./pitch-standalone.html)
- [My Trips — standalone](./my-trips-standalone.html)
- [Pipeline — standalone](./pipeline-standalone.html)
- [Inbox — standalone](./inbox-standalone.html)
- [Contract Review — standalone](./contract-review-standalone.html)
- [Home — standalone](./home-standalone.html)

If downloading in the ChatGPT interface fails, open the HTML in GitHub and click **Download raw file**, or copy and paste its full code.

### Deploy to Netlify (recommended for review)

Upload the entire directory (index.html, other normal HTML files, styles.css, app.js, v4.js) to a **new static site**. Do not deploy these files over the production Next.js application. Netlify will serve index.html (Discover).

## Page-by-page UX

**Discover.** Sidebar, map first, live visual demo clusters, destination/Trip context, hotel results, Free/Pro/Max switcher, contact/premium teaser, saved search controls, browser search memory, return-to-list scroll position, save to Trip versus Pipeline, create Trip.

**Hotel Detail.** Creator Intelligence moved directly under the hotel name, before photos/map. Separate high-visibility decision-maker preview card in the sticky sidebar. The blurred-like bars are **pure placeholder geometry** with no name, role or email underneath. Each Free-only premium metric gets an Unlock Pro CTA. Contacts require a per-hotel successful unlock of 1 credit. Pitch Studio opens for this hotel.

**My Trips.** The same trip and hotel shortlist state used by Discover. Links to pitches and hotels.

**Outreach Campaigns.** Group hotels by Trip or destination, choose hotel leads, track prepared pitches and manually logged sends. No bulk Gmail sends.

**Pitch Studio.** Reuse hotel and trip data, edit subject/body, save and resume drafts, copy email, and log an external send **only after an explicit confirmation**. Logs in this prototype are manual, unverified and never count as network intelligence.

**Pipeline.** Same hotel IDs and draft/send state as Discover, Trips and Campaigns. One demo source of truth rather than independent arrays.

**Inbox.** Only manual events created in Pitch Studio are shown. Manual report bounce marks the hotel event as bounced and recommends contact review; not a verified bounce, no ML feed or automated retry.

**Contract Review.** Local textarea for a pasted excerpt. A *simple keyword scan* highlights matching source snippets and generic issues to check. No AI, contract file upload or legal certification. Saves local excerpts.

**Home.** A guide into integrated workflows and messaging.

## Non-production and security disclosures

1. **All hotel identities, coordinates, activity scores, reply rates and classifications are invented illustrations.** They are NOT authentic hotels or leads.
2. Hotel contacts are NOT fetched from providers. Unlocked demo cards never display a real name, title or address.
3. UI demos use localStorage; they do not access Supabase, Gmail, Hunter, Snov.io, billing or AI APIs.
4. Free users' mock premium metrics exist in demo JavaScript; NEVER ship a similar client-side gate with real values. Actual private values must be omitted at the server authorization layer.
5. "Unlock" changes a local demo state; it does not charge credits. In production bill **1 credit per HOTEL** only if there is a successful unlock, returning cached eligible contacts if present.
6. Creating Trips, Campaigns, drafts, and log entries in this prototype does not create a real backend record.
7. Contact quality verification, background bounce processing, region heatmap, Gmail sends, real contract AI analysis, and hotel self-claim are not implemented here.
8. Map is a visual demo using Leaflet and CARTO/OpenStreetMap tiles. Integrate the existing Google Maps implementation in production, and use real geolocation clusters with verified published hotels.
9. UX includes Free, Pro, Max but does not silently change production Gmail send rights. Current backend uses Pro/Max only. An eventual limited Free send trial must be independently evaluated for cost, abuse, compliance and deliverability.
10. Browser-based localStorage persistence may vary for separate file:// URLs; the hosted version reliably uses one origin.

## Critical production architecture requirements

- One hotel ID referenced by Trip shortlists, Pipeline records, campaigns, drafts, events, contacts and collaborations.
- Maintain read authorization, row-level access and privacy boundaries; distinguish confirmed network signals from manual logs and Gmail messages.
- Keep dates, trip filters and scroll position when opening hotel and returning; persist last search for signed-in users.
- Support contact provenance: named professional verified, named provisional, department mailbox, not available; never call an inferred title a final decision maker.
- Provider sourcing/caching strategy should minimize billable third-party lookup costs; note time-to-live and reconfirmation.
- Server-side credit transaction and idempotency: one credit per hotel upon successful reveal; no duplicate charges or charge on failure.
- Contact bounce feedback should enter a **review workflow**, not instantly become public network intelligence. Confirm events before aggregation, suppress unusable addresses and monitor opt-outs.
- Pitch drafts and mail events should appear in Pipeline and Inbox based on backend events. Don't make one UI page maintain separate copies of relationships.
- Contract Review must quote source passages and provide scope limitations; no legal guarantees.

## Future hotel-side features — not shipped

**Hotel Claim Portal:**
1. Initial opt-in invitation outreach to suitable official hotel departmental addresses, with rate limits, legal review of electronic marketing rules, attribution and an unsubscribe / opt-out process where applicable.
2. Claim hotel profile via strong verification (e.g. corporate domain proof plus second-step manual review for sensitive changes).
3. Allow authorized hotel representatives to set preferred collaboration email, contact role, creator collaboration preferences and time availability, with an audit trail and re-verification.
4. Receive user-reported bounces, provider failures and profile change requests as moderation tickets; do not automatically publish untrusted edits.
5. Separate public profile facts, premium creator aggregate insights, and personal contacts; protect roles and professional emails from Free HTML/JSON.
6. Provide account/role change and impersonation recovery process before allowing hotel-profile control.

## Preferred marketing copy

**Verified contacts. Real creator signals. Smarter outreach.**

Long-term conditional vision: **Every verified collaboration makes the network smarter.** This phrase represents a goal for trusted learning; it must not imply that unverified user-reported data already trains predictive models.

## Technical delivery checklist before launch

Backend verification, licensed real hotel photography, contact provider billing and permissions, real map/marker clustering, persistence and sync of search state, trip-campaign relationship integrity, valid email provider link, consent, Google account reputation safeguards, real delivery/bounce handling, opted-out suppression, accessible error/loading states, responsive visual QA, E2E tests of entitlements, payment reconciliation and data privacy review.
