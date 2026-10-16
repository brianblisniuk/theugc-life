# theugc.life — UX/UI V12.2 · Midnight Studio

**Design-only consolidation of V12.1.** No backend or repository changes. Cursor owns functionality.

## Final selected identity

- **Theme:** dark mode across all 17 HTML pages.
- **Brand action color:** `#D1FF02`
- **Canvas:** `#0C1110`
- **Sidebar:** `#0A0E0D`
- **Cards:** `#121918` / `#151D1B`
- **Borders:** `#23302D`
- **Heading:** `#F5F8F6`
- **Body:** `#C7D0CC`
- **Muted:** `#93A19B`
- **Text on lime:** `#111507` — never white.
- **Font:** Archivo, with system fallback.

## UX rules

1. The brand color denotes the **primary action**, not a success state.
2. Sidebar active selection uses dark text on lime. Secondary and tertiary buttons use dark neutral surfaces.
3. Status colors are semantic: Verified `#8EE7B0`, Warning `#FFCE79`, Info `#91D5F5`, Danger `#FFA7A7`. Avoid invented performance thresholds.
4. Normal body 14–15px, working data at least 13px. Metadata only may be 11.5–12px.
5. An inaccessible premium contact is a server-authorized locked state, not a real email merely blurred on the client.
6. One Hotel identity, multiple Opportunity records. Trip and Outreach are separate contexts.
7. Demo data is illustrative; all commercial actions remain nonfunctional design references.

## Files

Open `index.html` with `styles.css` and `ui.js` in the same directory. All 17 HTMLs share the exact same visual system. `design-system.html` documents the definitive tokens.

## Scope

Only styling and reference-copy adaptations were made. No new routes, backend, billing or provider integration. Original V12.1 is preserved separately.
