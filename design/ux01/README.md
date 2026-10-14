# UX01 — fase 1, mockups

Static, clickable HTML for owner approval. No app code, no build.

Open `index.html`. It is the design system and the index of every screen.

## Screens

| File | Screen |
|---|---|
| `landing.html` | Marketing |
| `signup.html` | Sign up |
| `onboarding.html` | Destination, then first catalog hotel |
| `inicio.html` | Signed-in home |
| `discover.html` | Map, list, filters, intelligence badges |
| `hotel.html` | Intelligence, confidence, creator fit, unlock, pitch |
| `pitch.html` | Tone, key points, language, AI budget, send and queue |
| `pipeline.html` | CRM list and board |
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
- The AI meter is the monthly dollar budget (Pro USD 5, warning at 80%), separate from credits. The first draft for a hotel costs 1 credit; the next three that month do not.
- Send and queue do not mark the hotel as pitched. The queue line matches the live Gmail send: business hours, a few minutes apart.
- Checkout copy says a payment is not access until the verified webhook.

`CANON-v1.1-creator-credits.md` is not in the repo. Amounts were taken from the accepted decisions that restate that canon (D100, D131–D136) and from `src/lib/credits/config.ts`.
