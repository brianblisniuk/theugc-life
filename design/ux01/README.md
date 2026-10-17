# UX01 — High-fidelity static prototypes

Block UX01, phase 1. Mockups only for owner approval. No application code changes.

## Screens

All linked from `index.html` (design system entry).

| File | Screen |
|------|--------|
| `index.html` | Design system: colors, type, spacing, components, dark-mode note |
| `landing.html` | Marketing landing |
| `signup.html` | Signup |
| `onboarding.html` | Onboarding (display name, username) |
| `discover.html` | Discover — list + map placeholder, filters, intelligence badges |
| `hotel-detail.html` | Hotel detail — intelligence, confidence, creator fit, unlock contact, generate pitch |
| `pitch.html` | Pitch composer — tone, key points, language, AI budget meter, send/queue |
| `pipeline.html` | Pipeline / CRM board |
| `inbox.html` | Inbox / replies (read-only links to pipeline) |
| `trips.html` | Trips |
| `portfolio.html` | Portfolio |
| `pricing.html` | Plans & pricing — Free / Pro / Max + credit packs |
| `billing.html` | Billing & credits |
| `settings.html` | Account settings including deletion |

## Design decisions

- Visual Direction V1: **A2 — Sunlit Creator OS**
- Accent: **Sun `#FFE01B`** (action / selection only; never status)
- Typeface: **Archivo** (Google Fonts CDN)
- Light theme primary. Dark-mode note on design system page.
- Mobile-first, responsive. Tailwind via CDN. No build step.
- Realistic sample data (Sofía Reyes, Bali hotels, pipeline states matching product language: Saved / Pitched / Replied / Negotiating / Won).
- UI language: English, matching current app routes and docs.
- Plans follow locked commercial contract from project memory (2026-10-14): Free (5 credits/week), Pro ($20 annual / $30 monthly, 150 credits/mo + AI + Outreach Assisted + Premium Intelligence), Max ($50 annual / $60 monthly, 500 credits/mo + Priority AI). Packs: 50=$10, 150=$20, 500=$40. Payment: Rebill.
- Note: `CANON-v1.1-creator-credits.md` was not found in the repository at the time of this work. Pricing uses the locked plans recorded in project memory. Destination Pass / $199 Pro from earlier docs are superseded for these prototypes.
- No photography invented. No-photo state is first-class on hotel cards and detail.
- Self-contained. Clickable via ordinary links. Static HTML/CSS/JS.

## How to review

Open `design/ux01/index.html` in a browser. Navigate between screens. Approve or request changes before any production implementation.
