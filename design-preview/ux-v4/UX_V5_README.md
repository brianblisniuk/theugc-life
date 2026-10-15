# theugc.life — UX V5: Outreach Campaigns + Pipeline

**Two redesigned pages only.** The rest of the approved UX V4 product (Discover, Hotel Detail, Home, My Trips, Pitch Studio, Inbox, Contract Review) remains as it was.

**Visual language:** Archivo · dark navigation sidebar · light editorial content · #DFFF4F accent · large accessible type for decisions.

## Open / copy / download the HTMLs

- [Outreach Campaigns V5 — standalone](./campaigns-standalone.html)
- [Pipeline V5 — standalone](./pipeline-standalone.html)

Each standalone page embeds all CSS and JavaScript, without npm or build tools. Save **both files in the same folder**. The other navigation links point to V4 standalone HTMLs, which you can download from this folder if you want the whole journey.

**GitHub download:** open the file → Download raw file (download icon) → open with Chrome or Safari.

For the most reliable cross-page state, deploy the entire `design-preview/ux-v4/` folder to a new static Netlify site (or serve it locally via a static HTTP server). State sharing between distinct local `file://` pages depends on browser security rules.

## Outreach Campaigns — designed around the job

- Persistent sidebar with clear definitions of each product section.
- Campaign switcher cards with destination, hotel count, progress.
- Hero with selected campaign context and actual *local event counts*, not prediction scores.
- Four useful operational measures: selected hotels, saved drafts, manually reported sends, reported conversations.
- Hotel lead table with identity, stage, public activity, draft/contact state and next action.
- Search and stage filter within a campaign; add hotels from the shared V4 hotel catalog; create new campaign and optionally reuse a Trip's shortlist.
- A `Your next move` panel derives a suggestion from existing local stages.
- Activity feed and visible deliverability/reputation guidance.
- Never offers fake mass-send automation.

## Pipeline — a visually rich relationship command center

- Dark executive hero with event progress and key counts.
- Three contextual priority cards before the board.
- Dynamic **Board / List / Timeline** views.
- Five stage lanes: Saved / Pitch ready / Outreach sent / In conversation / Confirmed.
- Drag & drop on desktop; all updates also accessible via the relationship detail drawer.
- Drawer contains contact unlock status, campaign, draft, linked contract count, stage update, notes, event history, links to Hotel Detail, Pitch Studio, Inbox and Contract Review.
- Optional Closed lane, search and status filters.
- Stage changes are manual. Sent, replied, bounced, and won require explicit confirmation.
- Free active-relationship limit is represented in the preview, but production enforcement must remain on the server.

## Shared data model

Both pages refer to the same per-hotel IDs in V4:

- `ugc_v4_campaigns` — campaigns, hotelIds, tripId.
- `ugc_v4_drafts` — pitch drafts.
- `ugc_v4_events` — manually recorded or sample stages.
- `ugc_v4_contracts` — local contract excerpts linked to hotelId.
- `ugc_v3_pipeline` — shared hotel relationships through existing `UXApp.state.pipeline`.
- `ugc_v5_notes` — new notes associated with hotelId, not another hotel record.

When a fresh design-preview origin has **no** existing campaigns, pipeline relationships, drafts or events, it initializes an **explicitly labeled illustrative scenario** (Bangkok and Bali). This is **only localStorage** and will not run on user accounts or production data. If prior V4 work exists, it is preserved and the sample seeding is skipped.

**Limitation:** Other V4 pages were not redesigned in this task. They read the shared IDs, but they do not yet render every new V5-specific stage (e.g. `negotiating`) with identical visual labels. Production should define one canonical stage/status type shared by all modules.

## Security / product truth

- All hotel names, activity labels, campaign stories, drafts and outcomes are fictitious demonstrations.
- No Gmail, Hunter, Snov, AI, billing, maps or database APIs are called.
- No contact data is exposed before a successful server-authorized unlock; **one credit per hotel** remains the intended model.
- Manual/sample activity does not feed network learning or become verified creator intelligence.
- No simulated Gmail reply should be treated as a real reply; manual events are labelled.
- Event logging, contact verification and network metrics require real backend integrations and privacy controls.
- Current production Gmail send access remains Pro/Max; Free is not silently granted email sending.
- The prototype has been syntax-checked and source/ID-checked. A complete browser-based visual and E2E test is still required before production integration.

## Why not Home yet?

Home is an attention-prioritization dashboard, **not** a place to repeat every feature. The six questions to answer at a glance are: what to do today, who replied, what needs follow-up, campaign progress, upcoming trip, and where to resume.

Its implementation should follow the stabilization of Campaigns/Pipeline statuses and queries, so these are backed by one source of truth. Offer Builder is explicitly out of current scope.

## Production handoff

1. Agree on a canonical pipeline status/event model and its transition rules. Ensure the actual server's Free capacity, entitlement and send guards stay authoritative.
2. Design normalized `campaigns`, `campaign_hotel` and note/event tables keyed to real published hotel UUIDs and creator ownership. Do not copy the localStorage arrays into production.
3. Surface creator-verified versus manually claimed vs network-published evidence as separate scopes.
4. Add transactional write APIs for create/add/remove campaign hotels, transition stage, add note and close cycle; link drafts, Gmail events and collaboration status to the existing relationship IDs.
5. Ensure Inbox replies and bounces synchronize into Pipeline only via validated owner-scoped provider events; opt-outs and bad addresses should be suppressed, not retried automatically.
6. Add accessibility, keyboard, mobile drag alternatives, search pagination, error/retry states and E2E tests.
7. Revisit Home from the final shared query/event model. Leave Offer Builder out of scope.
