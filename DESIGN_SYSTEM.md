# theugc.life — DESIGN_SYSTEM.md
Version: 0.1 — implementation guardrails, not final brand bible.

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

Do not invent final brand colors/typefaces without approved brand direction.
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

## 10. Share outputs

Milestone/year-recap outputs:
- story-friendly portrait format as primary
- creator achievement is hero
- theugc.life branding is present but secondary
- no hotel targets/active negotiations
- generated data must come from real creator records
