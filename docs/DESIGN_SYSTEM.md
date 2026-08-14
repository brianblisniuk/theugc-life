# theugc.life — DESIGN_SYSTEM.md
Version: 0.2 — implementation guardrails, not final brand bible.

Visual Direction V1 is **A2 — Sunlit Creator OS** (D047), with **Sun `#FFE01B`**
as the approved primary accent (D048) and **Archivo** as the primary product
typeface (D053). See
[`VISUAL_DIRECTION.md`](VISUAL_DIRECTION.md) for the direction itself, the
approved Discover interaction model, and what remains open. This document covers
how it is built.

## 1. Product feeling

Professional, premium, aspirational travel-creator work software.
Not:
- enterprise CRM
- childish gamification
- generic social network
- casino/points UI

The map provides discovery wow; dashboard/CRM provides habitual utility.

## 2. UX principles

1. Mobile and desktop are first-class.
2. One obvious primary action per surface.
3. Progressive disclosure instead of long forms.
4. Recency/freshness is visually prominent.
5. Locked premium data communicates value without leaking it.
6. Intelligence uses human-readable language and confidence-aware precision.
7. Private creator activity is visually distinct from collective intelligence.
8. Empty states teach the next useful action.
9. No fake urgency/social proof/counts.
10. Milestones look like professional career achievements.

## 3. Information hierarchy

Hotel page order:
1. identity/location
2. creator intelligence
3. premium contact
4. creator's private relationship/actions

Dashboard:
1. action due now
2. next trip
3. recommended discovery
4. intelligence snapshot
5. personal progress

## 4. Core components

Create reusable primitives for:
- AppShell / PublicShell
- Navigation
- HotelCard
- HotelMapMarker
- IntelligenceMetric
- ConfidenceLabel
- LockedField
- ContactCard
- PipelineCard
- PipelineBoard
- TripCard
- FollowupCard
- UpgradeModal
- EmptyState
- VerificationBadge
- MilestoneCard
- ShareCard
- AdminDataTable

Do not build an oversized component framework before these are needed.

## 5. Status language

Pipeline labels should be human-readable:
Saved, Planned, Pitched, Follow-up, Replied, Negotiating, Won, Closed.

Intelligence avoids false precision:
- insufficient → “Creator activity detected” / “Not enough data yet”
- emerging/moderate → qualitative language as configured
- strong → precise metric may be shown

## 6. Responsive behavior

Map/list:
- desktop may use split map/list
- mobile prioritizes list with map toggle or full-screen map
- do not force desktop Kanban interaction onto narrow screens

Pipeline:
- desktop board + list
- mobile defaults to list; board optional if usable

## 7. Accessibility

- semantic HTML
- keyboard-accessible controls
- visible focus
- WCAG-conscious contrast
- do not encode status by color alone
- form errors linked to fields
- map has list/search alternative

## 8. Loading/error/empty states

Every data surface has:
- skeleton/loading
- empty
- recoverable error
- permission/locked state where relevant

No blank white screens.

## 9. Brand tokens

Implement semantic design tokens so visual branding can change centrally:
- background
- surface
- text
- muted
- border
- accent
- success/warning/danger
- radius
- spacing
- typography scale

### 9.1 Accent — Sun `#FFE01B` (D048)

`--accent` is **Sun `#FFE01B`**. The current `#2f6df6` blue in
`src/app/globals.css` is the remaining placeholder and is replaced in Sprint 3A,
not before.

**The accent is a brand / selection / action color and must never carry semantic
status meaning.** `--success`, `--warning` and `--danger` remain an independent
system. A yellow that also means "warning" cannot simultaneously mean "selected"
or "primary action", and A2's selection language depends on the latter. When
choosing a warning color, choose one that cannot be confused with the accent.

Yellow must read bright, sunlit, contemporary and energetic — never mustard,
ochre, beige, terracotta, rustic or bohemian.

### 9.2 Typography — Archivo (D053)

**Archivo** is the approved primary product typeface for V1. The app currently
loads no custom font at all; adding it is implementation work for the next PR,
not a change made in the contract PR.

Approving the typeface does **not** promote any A2 prototype size, weight, width
or line-height to a token. The type scale is derived from a real surface with
real content (VISUAL_DIRECTION.md §22).

### 9.3 Containers are earned

Avoid the generic SaaS composition in which every piece of information sits
inside its own rounded card. A container is justified when it groups things that
genuinely belong together, or when it is interactive as a unit — not by default.

Prefer:

- thin rules;
- typographic hierarchy;
- restrained geometry;
- high information density;
- real content — photography, names, places, numbers — as the visual structure.

A screen where every element is boxed has no hierarchy left to express, and it is
the fastest route to looking like every other creator-economy dashboard.

### 9.4 The master brand must outlive travel

The master-brand system is: **Sun yellow · ink · paper/near-white · typography ·
thin structural rules · restrained geometry · photography and content where
relevant.**

Travel aspiration comes from **product content and photography**, not from the
brand furniture. The identity must therefore not depend intrinsically on maps,
hotels, airplanes, passport stamps, palms, beaches or any travel iconography, so
that it extends to beauty, fashion, food, fitness, lifestyle, tech and other
creator verticals without a rebrand.

Travel motifs belong to the current vertical's content layer. If removing every
travel image would leave the brand unrecognisable, the brand is too narrow.

## 10. Share outputs

Milestone/year-recap outputs:
- story-friendly portrait format as primary
- creator achievement is hero
- theugc.life branding is present but secondary
- no hotel targets/active negotiations
- generated data must come from real creator records
