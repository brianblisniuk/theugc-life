# theugc.life · UX V6 — Trips ↔ Outreach ↔ Pipeline

**Scope:** integration of exactly three core surfaces, retaining V5's visual Pipeline, the dark sidebar, Archivo typography and the `#DFFF4F` accent.

**Safety:** standalone HTML/CSS/JS design preview only. No backend, no Gmail, no real hotel contacts, no actual billing, no real email sends. Main/production remains untouched.

## Open the V6 prototype

- [My Trips — standalone HTML](./my-trips-standalone.html)
- [Outreach — standalone HTML](./campaigns-standalone.html)
- [Pipeline — standalone HTML](./pipeline-standalone.html)

Additional linked pages remain available: [Discover](./discover-standalone.html), [Hotel Detail](./hotel-standalone.html), [Pitch Studio](./pitch-standalone.html), [Inbox](./inbox-standalone.html), [Contract Review](./contract-review-standalone.html) and [Home](./home-standalone.html).

To use the demo: download all relevant standalone HTMLs from GitHub (**Download raw file**) and keep them in the same directory. For cross-page state, hosting the entire modular folder on an isolated Netlify static preview is more reliable than `file://` due to browser storage restrictions.

## What changed

### 1. My Trips
- One Trip holds destination, dates and hotel shortlist.
- **Start outreach** creates the first linked initiative with the already-shortlisted hotels in one action.
- **Continue outreach** reopens the linked initiative; newly saved Trip hotels are not silently inserted later. The initiative offers **Import from Trip** when appropriate.
- Starting outreach without a Trip remains possible from the sidebar.
- Each trip surfaces shortlisted hotels, logged outreach and conversations.

### 2. Outreach
- Renamed in sidebar from "Outreach Campaigns" to **Outreach**.
- Initiatives (internal campaign records) can be linked to a Trip or independent.
- Each initiative shows opportunities, their status, associated hotel, drafts, contact-unlock state and next action.
- One hotel catalog record can be referenced by more than one initiative.
- No requirement to create a second initiative named exactly like an existing Trip.

### 3. Pipeline
- Retains V5's visually rich Board / List / Timeline / side drawer.
- Adds **All opportunities / Linked to Trips / Independent outreach** contextual filtering and Trip filter.
- Every opportunity has its own `opportunityId`, `hotelId`, optional `campaignId`, optional `tripId`, stage, notes and timeline.
- Same hotel can appear twice in two outreach initiatives, with distinct commercial states and histories. Shared hotel identity and contact unlock remain keyed by `hotelId`.
- Stage changes are explicitly manually confirmed for consequential events.

## A concrete test

1. Open My Trips and select **Start outreach** on the example Bangkok Trip.
2. Check that the shortlist appears immediately in Outreach, without selecting hotels again.
3. Open Pipeline. Inspect the two distinct example opportunities for **Siam Canopy Hotel** (linked Trip versus independent luxury outreach).
4. Change the stage of one example opportunity. Verify the other attempt stays unchanged.
5. Return to Outreach, create a new initiative without a Trip, select hotels and confirm they appear as distinct Pipeline opportunities.
6. Open Pitch Studio from the opportunity drawer; edit and save. When returning to Pipeline, the saved draft can be reflected without creating a new hotel record.
7. Open Contract Review from the drawer: the example document may be linked to the specific opportunity rather than just the hotel.

## Data model and important limitation

The prototype uses `ugc_v4_campaigns` for compatible outreach initiatives and new `ugc_v6_opportunities`, `ugc_v6_events` and `ugc_v6_notes` for opportunity-scoped state. It reads V4 drafts and manual events, projects unambiguous events into opportunity history, and intentionally does **not** guess which of two simultaneous opportunities an ambiguous legacy hotel-only event belongs to.

This is a **browser-local proof of UX**, not an approved production schema. In production, normalized user-owned tables, foreign keys, row-level security, server-side entitlements, idempotent contact charges, transactional event writes and Gmail-provider event verification must replace localStorage. The canonical relationship/opportunity status model must be specified jointly for Outreach, Pitch Studio, Pipeline, Inbox and Collaborations.

Legacy V4 UI remains a preview; it does not fully distinguish every opportunity in all visual components. The full backend event integration and UX audit are pending.

All sample hotel names, dates, reply outcomes and campaign performance are fictitious and labeled illustrative. No sample or manual event feeds aggregate creator intelligence or ML.

**Commercial rules retained:** 1 credit per hotel upon successful contact unlock, not one credit per contact; a failed lookup should not be charged. Free/Pro/Max plan policies still require server enforcement; this demo does not grant Gmail sends to Free.

## Why this direction

Trip: when/where the creator is traveling.

Outreach: which hotel contacts the creator wants to approach and why.

Pipeline: how every *specific* commercial attempt is progressing.

**One hotel can have multiple opportunities; no page needs to maintain a duplicate copy of hotel identity.**

## Deliberately out of scope

No new Home dashboard, no Offer Builder, no fabricated predictive scores, no hotel claim portal, no true AI contract analysis, no Gmail bulk send implementation. Visual browser QA and integration tests remain required before final MVP adoption.
