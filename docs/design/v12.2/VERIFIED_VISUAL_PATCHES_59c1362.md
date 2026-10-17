# UX / UI visual fidelity corrections — V12.2 vs production SHA 59c1362

**Scope:** Visual changes only. Branch created from exactly `59c13626eb6ec3746d319e6b5644e06bce1d79ae`. Does **not** touch `main`, Netlify, data, billing, Gmail, authentication, or commercial state.

## Source-verified corrections included

1. **Sidebar SVG geometry:** reinstates the exact path, circle and rect data from `docs/design/v12.2/home.html` for My Trips, Pipeline, Pitch Studio, Inbox, Collaborations, My Profile, Plans & Credits, Billing & Activity and Getting Started. ViewBox, stroke, linecap and rendered size are unchanged. Home/Discover/Outreach were already very close and remain unchanged.
2. **Home action SVGs:** restores a 15x15 columns glyph next to View all opportunities, plus the 15x15 arrow for Open your Pipeline, Open My Trips, Continue outreach and Continue exploring. All existing href and render conditionals remain in place.
3. **Topbar surface:** aligns `#101715` to the reference `#151D1B`.

## Deliberately not changed

- No new `Contract Review` route or navigation item (the original reference had one but the current product's scope omitted it). Product decision required.
- No redesign of Outreach, Inbox, Pipeline, or Pitch Studio; component placement and data-driven states need visual QA.
- No blind restoration of reference text on `#D1FF02` because the original contains accessibility failures. Keep production `#111507` dark text (15.88:1 contrast ratio).
- No restoration of fake sample values from the V12.2 static HTML.
- No broad CSS overrides for spacings, widths, and typography without authenticated visual comparison.

## Verification required before merge

- Run build/typecheck/lint and normal tests.
- Capture identical-data screenshots at 1440×900 and 390×844 for each screen after logging in.
- Compare original HTML from `docs/design/v12.2` versus actual production/staging. Dynamic data must be controlled; no attempt to produce parity by inventing user data.
- Verify tab/keyboard focus, icon consistency, CTA click targets, role-gated views, and contrast.
- Review all findings in **the separately delivered comprehensive 70-item UX audit**, sorted by P0/P1/P2.

This branch represents **three confirmed visual-only patches**, not completion of the comprehensive pixel-by-pixel audit.
