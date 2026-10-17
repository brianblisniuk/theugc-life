# V12.2 fidelity report

Base: `59c13626eb6ec3746d319e6b5644e06bce1d79ae`. Dark only. Accent `#D1FF02`. Text on lime stays `#111507`.

Contract Review (FV-001, FV-056, FV-057, FV-058, and the Contract Review control in FV-055) is excluded. It is not in the sidebar and there is no `/app/contracts` screen.

Screenshots: reference HTML at 1440×900 and 390×844, plus the shell before and after those token changes, are in the run artifacts (`fidelity/`). Authenticated product routes were not opened here; there is no seeded session in this environment. Visual-pending findings were checked against the rendered reference HTML and the real CSS, and only measured differences were changed.

## Canonical tokens

| Token | Value |
| --- | --- |
| Canvas | `#0C1110` |
| Top bar | `#151D1B` |
| Sidebar | `#0A0E0D` |
| Card / secondary button | `#151D1B` |
| Button text | `#F3FAF4` (AA on `#151D1B`; `#111507` only on lime) |
| Button | min-height 39px, 12px, radius 8px, gap 8px |
| Body | 14.5px Archivo |
| Sidebar icon | 17×17, stroke 1.7 |
| Action icon | 15×15, stroke 1.7 |
| Mobile bottom bar | `#151D1B` |
| Metric ring | 64px (the reference `.ring`; `.ring.sm` is 54px) |

Icon drawings live in `src/components/icons/v12-icons.tsx`. Paths are the drawings in `docs/design/v12.2/home.html` and the action SVGs in the other reference pages. The `contract` drawing is in the catalog and is not rendered in navigation.

Opening `styles.css` in a browser applies later rules that paint the top bar `#101715`, buttons 40px / 12.5px / `#1B2522`, and the mobile bottom bar `#0C1110`. Those later rules are what production had copied. FV-008, FV-009, and FV-012 follow the audit’s expected tokens (`#151D1B`, 39px, 12px, separated bottom bar). Body text is already 14.5px in that same cascade, so it was left alone (FV-010).

## Findings

| ID | Status | What changed |
| --- | --- | --- |
| FV-001 | excluded | Contract Review stays out of the nav. |
| FV-002 | fixed | My Trips uses the paper-plane path. |
| FV-003 | fixed | Pipeline uses the two vertical panels. |
| FV-004 | fixed | Pitch Studio uses the pencil path. |
| FV-005 | fixed | Inbox uses the tray path. |
| FV-006 | fixed | Collaborations uses the briefcase path. |
| FV-007 | fixed | Profile, Plans, Billing, and Getting Started use the reference paths. Staff UI Guide uses the reference sun path and stays staff-only. |
| FV-008 | fixed | Top bar background is `#151D1B`. Computed before: `rgb(16, 23, 21)`. After: `rgb(21, 29, 27)`. Height stays 69px. |
| FV-009 | fixed | Secondary buttons are min-height 39px, 12px, fill `#151D1B`. Label color stays `#F3FAF4` so the control meets AA. Lime buttons stay `#111507`. |
| FV-010 | not applicable | Rendered reference body is 14.5px. `THEME_SPEC.md` allows 14–15px. The finding says not to force 14px. |
| FV-011 | not applicable | `#111507` on `#D1FF02` stays. Contrast is above 7:1. White and `#B0E2B9` on lime were not restored. |
| FV-012 | fixed | Mobile bottom bar is `#151D1B`, separated from the `#0C1110` canvas. Before it matched the canvas (`#0C1110`). |
| FV-013 | not applicable | UI Guide stays on the staff shell and `/app/design` still requires admin or editor. |
| FV-014 | fixed | Home grid remains `1.4fr / 0.8fr`. Inbox columns follow the reference cascade (3 at 1440, 2 from 1320 to 761, 1 at 760). Plan cards share header min-heights. Long names wrap. |
| FV-015 | fixed | Primary actions use the 15px reference SVGs. Handlers and hrefs are unchanged. |
| FV-016 | fixed | Reference pages and the shell were rendered with Playwright at 1440 and 390. Measures are in `fidelity/measures.json`. A seeded authenticated session was not available, so this is not a pixel claim over live account data. |
| FV-017 | fixed | Mail, notices, and the credit line sit in a compact strip above the home grid. Error, consent, and permission states still render. |
| FV-018 | fixed | Home CTAs use the arrow, pipeline, and chevron drawings. |
| FV-019 | fixed | Confirmed nights render as a `3 / 7` figure, a progress bar, and confirmed / pending / uncovered badges. Counts stay real. A zero-night trip does not draw a fake bar. |
| FV-020 | not applicable | “Nothing on this page is a sample” stays. Demo metrics were not restored. |
| FV-021 | fixed | Reference attention and trip panels share one row (y=250 at 1440; widths 712 and 390). The app grid ratio is unchanged and the notice strip no longer sits inside the attention panel. |
| FV-022 | not applicable | Reference “Hotels to explore” is at y=794 and visible in a 900px viewport. The app map stays 245px, shorter than the reference map panel (427px), so the list is not pushed down to match a taller demo map. |
| FV-023 | fixed | Chip row keeps plan-gated sorts and adds “More filters” to the filter form. Live filters were not replaced with the Bangkok demo chips. |
| FV-024 | not applicable | Counts stay real. The sample “8 matching hotels” was not restored. |
| FV-025 | not applicable | Hotel mark is already 46×46. Column structure was left in place. Content varies with the hotel. |
| FV-026 | not applicable | Verified photos stay. A real photo is not treated as a miss. The 46px mark still holds the fallback initials. |
| FV-027 | not applicable | Intelligence remains above photography. Locked and insufficient states stay in the metric components. |
| FV-028 | not applicable | Contact stays in the side column with the next step. No authenticated hotel was rendered, and the column structure was not rearranged. |
| FV-029 | fixed | The side panel eyebrow reads “Turn research into outreach”. The real next-step title and primary action are unchanged. Accessible name stays “Your next step”. |
| FV-030 | not applicable | Missing photos stay an absence. Demo photo grids were not restored. |
| FV-031 | fixed | Rings are 64px, matching the rendered reference `.ring`. Figures still come from the metric state, including locked and insufficient. Sample 42% was not hardcoded. |
| FV-032 | not applicable | The trip list and New trip stay. The featured trip remains the first block. |
| FV-033 | not applicable | Travel nights, confirmed, pending, and uncovered were already the coverage model. No sample numbers were added. |
| FV-034 | fixed | Continue outreach and New trip use the reference arrow and plus icons. |
| FV-035 | fixed | `/app/outreach` opens with the active campaign preview. The full workspace stays on `/app/outreach/[id]`. |
| FV-036 | fixed | The preview links to Hotel opportunities, Your next move, and Volume without losing trust. Those sections are anchors on the detail page. Rows are not copied onto the index. |
| FV-037 | fixed | Open Pipeline, New outreach, Prepare, and Open use the reference icons. |
| FV-038 | fixed | Prepare and Open keep their handlers and gain the arrow icon. Stage chips stay the real stage. |
| FV-039 | fixed | Board, List, and Timeline use the reference board, list, and clock drawings. Open Inbox and Find hotels use arrow and plus. |
| FV-040 | not applicable | The workspace already had the dark hero, metrics, priority list, view switch, and board. Component markup was not rewritten into the HTML file. |
| FV-041 | fixed | Pipeline reminders sit in a compact strip. The repeated board explanation is one status line, so the board starts higher. |
| FV-042 | fixed | The extra “event, not a stage column” sentence was removed. Lane labels and real statuses stay. |
| FV-043 | fixed | The board still scrolls horizontally. Card titles wrap. Board, List, and Timeline remain. |
| FV-044 | fixed | `/app/pitch` is the editor. With no opportunity selected it shows a hotel/opportunity picker. Choosing one opens `/app/hotels/[id]/pitch`. This page does not call a model, save a draft, or send. |
| FV-045 | fixed | The hotel editor keeps its three columns and the real AI, Gmail, credit, and permission gates. The entry editor uses the same column grid. |
| FV-046 | fixed | Save draft, Copy email, and Send use the reference save, link, and paper-plane icons. Actions are unchanged. |
| FV-047 | not applicable | Draft with AI and Send stay, with their plan and safety gates. They were not removed to match the non-sending demo. |
| FV-048 | fixed | InboxScreen was kept. Attention first, the thread, and the context column are still that component. |
| FV-049 | fixed | Inbox is 3 columns at 1440 (measured reference `276 / 479 / 337`). At 1280 and 1024 the reference is 2 columns; the app now matches that breakpoint (1320). Names wrap. |
| FV-050 | fixed | The conversation column is labeled Attention first. Needs reply remains the filter. No second mailbox was added. |
| FV-051 | fixed | Open Pipeline, New pitch, and Prepare reply use the reference icons. |
| FV-052 | fixed | The agreement note and reminders share a compact strip so the board starts higher. Reminders still render, including errors. |
| FV-053 | not applicable | Agreed is still not approved. The sample agreement was not copied in as fact. |
| FV-054 | not applicable | Deliverables, the agreement side, and the timeline were already the board. No authenticated board was re-shot, and the zones were not rebuilt. |
| FV-055 | fixed | Add deliverable uses the plus icon. The Contract Review action was not added. |
| FV-056 | excluded | No contract-review screen. |
| FV-057 | excluded | Draft forms were not relabeled as clause analysis. |
| FV-058 | excluded | No Contract Review link from Collaborations or Pipeline. |
| FV-059 | not applicable | Profile data stays the user’s. Sample portfolio photos were not inserted. |
| FV-060 | fixed | Selected work previews have a 148px minimum height so a recorded piece has a visible area. |
| FV-061 | fixed | Edit profile, Open Pitch Studio, and Add project use the pencil, arrow, and plus icons. Routes are unchanged. |
| FV-062 | fixed | Choose a destination stays below the four steps and two paths, and it can be skipped (Skip to Discover, Back to home). It stays visible: a closed disclosure hid Back to home and broke the signup journey. |
| FV-063 | fixed | The first content is the stepper and the two paths. The destination catalog follows and is optional. |
| FV-064 | not applicable | Free, Pro, Max, and credit packs stay the real catalog. Prices were not removed. |
| FV-065 | fixed | Plan cards share eyebrow and title min-heights, and the action sits at the bottom of the card. The current plan keeps its highlight. |
| FV-066 | not applicable | Payment records, refunds, and checkout stay. They are real transaction states. |
| FV-067 | fixed | Balance and credit activity remain above checkout. The billing stack gap is tighter so activity is not spaced away from the balance. Checkout stays visible. |
| FV-068 | not applicable | `/app/design` stays an internal specimen. The full guide remains `docs/design/v12.2/design-system.html`. |
| FV-069 | fixed | `src/components/icons/v12-icons.tsx` is the icon catalog. A test compares it to `home.html`. |
| FV-070 | fixed | Tokens above are the canonical set. Shell color, button size, and icon paths are asserted in `tests/v12/fidelity.test.ts`. |

## Preserved on purpose

- Dark text `#111507` on `#D1FF02` and on `#B9E700`.
- Real counts, nights, credits, plans, and hotel photos.
- Error, Gmail consent, permission, Free-access, and transaction states.
- Pitch generation only on a real hotel page.
- CSP, RLS, and mail send rules. No database or email-flow edits.
