# UX01 — fase 1, mockups

Static, clickable HTML for owner approval. No app code, no build.

Open `index.html`. It is the design system and the index of every screen. The **v1 / v2 / v3** switch on that page loads the same 15 screens from `./` , `v2/`, or `v3/`.

v2 is a second visual pass on paper: desktop-first grids, the hotel as the hero, decision signals on every card, and Sun only on Generar pitch, Desbloquear, Upgrade, badges and highlights. Prices, states and Spanish copy stay with v1.

v3 is a separate dark pass in English. It does not change D047, D048, or D053. The accent on these mockups is tennis-ball `#E3F04A`, used on primary actions and a few highlights. A preview bar switches Free / Pro / Max and hides the live / to-build notes. List is on the left, map on the right. Generate pitch is the hotel hero. D05 follow-ups (merged on main as D171–D177) are shown as live: two follow-ups, defaults 3 and 5 days, any whole number from 1 to 30. This branch was not rebased onto that merge.

## Screens

| File | Screen |
|---|---|
| `landing.html` | Marketing |
| `signup.html` | Sign up |
| `onboarding.html` | Destination, then first catalog hotel |
| `inicio.html` | Signed-in home |
| `discover.html` | Map, list, filters, intelligence badges |
| `hotel.html` | Public activity, premium time band, collaboration type, unlock |
| `pitch.html` | Hotel, tone and points, Gmail send, follow-up sketch |
| `pipeline.html` | Photo board of the eight statuses, plus the list |
| `inbox.html` | Gmail readings beside open cycles |
| `trips.html` | Trip list and one open trip |
| `perfil.html` | Profile, public card, private past work |
| `portfolio.html` | Layouts and per-collaboration approval |
| `pricing.html` | Free, Pro, Max, packs, Destination Pass |
| `billing.html` | Balance, ledger, Rebill checkout |
| `account.html` | Gmail, password, deletion |

`inicio.html` and `perfil.html` are the shell routes the primary nav already uses.

## Design decisions

- Direction stays A2 (D047, D048, D053): paper `#FFFFFF`, ink `#111111`, Sun `#FFE01B`, Archivo. Sun is the action and selection color. Success, warning, follow-up, and danger stay on their own hues.
- Light theme is the product. Dark tokens are documented on the index and are not applied to the screens.
- UI copy is Spanish, voseo, matching the live shell (Inicio, Descubrir, Pipeline, Viajes, Perfil) and the home checklist. Pipeline, Pro, Max, Gmail, and Inbox stay as product names. The deletion phrase stays `DELETE`.
- Mobile is list-first. Discover opens the map from a toggle. The pipeline opens as a list; the board scrolls sideways. Five primary items sit on the bottom bar.
- From 1024px the same screens become desktop: a left sidebar replaces the bottom bar, content goes to columns, Discover keeps the map beside the list, and the hotel page puts status, pitch, and contact in a side panel. The index has an Escritorio / Celular toggle that previews either width. Copy and links stay the same.
- Rows, rules, and photography carry the layout. A box is used when the thing is clicked as a unit.
- The map is a static stand-in. The product map remains Google Maps.
- Sample contacts use `.example` addresses. A missing public signal is “todavía no hay datos”, not a low score.
- Prices and credits follow D131–D136 and `CREDITS_CONFIG`: Free 5 per rolling week, capped at 5; Pro USD 20/mo billed annually or USD 30 monthly, 150 credits / 30 days; Max USD 50/mo billed annually or USD 60 monthly, 500 credits / 30 days; packs 50/USD 10, 150/USD 20, 500/USD 40; unlock cost 1; a provider miss is not charged. Destination Pass stays USD 39 / 30 days and does not include full AI email.
- The AI meter is the monthly dollar budget (Pro USD 5, Max USD 15, warning at 80%), separate from credits. D166: the first generation for a hotel in the month uses 1 credit, the next three do not, and later ones use 1 credit. The generate and send buttons do not show a price. A successful send costs no credits (D159). v1/v2 drew two follow-ups as a sketch. v3 shows the follow-ups merged on main (D171–D177): opt-in, at most two, defaults 3 then 5 days, any whole number from 1 to 30, then the existing send queue.
- Send and queue do not mark the hotel as pitched. The queue line matches the live Gmail send: business hours, a few minutes apart.
- Checkout copy says a payment is not access until the verified webhook.

`CANON-v1.1-creator-credits.md` is not in the repo. Amounts were taken from the accepted decisions that restate that canon (D100, D131–D136) and from `src/lib/credits/config.ts`.

## v3

`design/ux01/v3/` is an English, dark-only pass for owner review. It does not edit app code and it does not replace D047 or D048. Accent `#E3F04A` is a tennis-ball yellow, slightly warm, and it fills primary buttons plus a few highlights (the mark dot, a selected pin, an active chip’s dot). Success, warning, and danger stay on their own hues.

The preview bar is not product chrome. It switches Free / Pro / Max and turns the live / to-build notes off. Free sees public activity, blurred premium numbers, a template pitch that is never generated, and Gmail actions that go to plans. Contacts unlock with 1 credit on every tier. There is no reverse trial and no WhatsApp. Pitches do not claim a stay. Closed-deal names are fictional.

Screens, same files as v1: landing, signup, onboarding, home (`inicio.html`), discover, hotel, pitch, pipeline, inbox, trips, profile (`perfil.html`), portfolio, plans (`pricing.html`), credits (`billing.html`), settings (`account.html`).

| Shown | Mark |
|---|---|
| Activity, recency, observed collaboration, confidence | live |
| Reply-time bands, reply rate, collaboration types, fit, Max rank/freshness | live, Pro or Max |
| Credits, prices, packs, Pass, unlock cost 1, AI dollar budget, D166 draft credits | live |
| Gmail sync pause, send queue, two follow-ups, deliverables, compensation, pipeline stages | live |
| Personal counts (outreach, replies, agreements, completed, approved deliverables) | live |
| Hotel share link and per-field opt-in | live |
| “Pitch this one today”, response likelihood, similar deals, personal response rate, countries, revenue rollup | to build |
| News, UGC School, 9:16 video files, activity chart | to build |
