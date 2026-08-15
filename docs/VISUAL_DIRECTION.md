# theugc.life — VISUAL_DIRECTION.md
Version: 2.0 — **Visual Direction Gate PASSED. This is Visual Direction V1.**

The gate is closed. §1–§18 remain the standing brand thinking and still apply.
§19–§23 record what was decided, what is still open, and what Sprint 3A may and
may not build.

The exploration that produced this decision is complete; its brief is preserved
as historical context in
[`CLAUDE_DESIGN_DISCOVER_EXPLORATION.md`](CLAUDE_DESIGN_DISCOVER_EXPLORATION.md).

## 1. Strategic premise

The product starts obsessively focused on travel creators, but the long-term company is creator infrastructure that may expand into beauty, fashion, food, fitness, tech, lifestyle and other UGC verticals.

The visual identity must therefore do two things at once:

1. Feel unmistakably desirable for travel creators now.
2. Avoid encoding "hotel app" or "travel agency" so deeply that the master brand cannot expand later.

Core emotional promise:

**Build the creator career — and life — you want.**

Current travel expression:

**Bright travel ambition. Serious creator infrastructure.**

Product truth:

The lifestyle attracts. The operating system retains.

## 2. Chosen creative direction

### A2 — Sunlit Creator OS — **APPROVED (Visual Direction V1, D047)**

Selected after the A/B/C exploration. A2 is a synthesis, not a raw direction:

- **~70% Direction A — Sunlit Editorial Utility**
- **~20% Direction B — Creator Command Center**
- **~10% Direction C — Visual Opportunity Network**

Product principle:

**Lifestyle aspiration + professional creator infrastructure.**

For travel:

**Bright travel ambition. Serious creator infrastructure.**

Discover must create, in this order:

1. *"I want to be there."*
2. *"This tool can help me get there."*

The B and C contributions are deliberate and must survive implementation. The
20% from B is what keeps A2 from becoming a lifestyle magazine: real density,
strong state/action language, comparison velocity. The 10% from C is what keeps
the map and the intelligence signals from being decorative.

The original Direction A description follows and still holds as the dominant
character:

A combination of energetic lifestyle branding, real travel photography, editorial composition, dense creator-work software and selective intelligence/data language.

The product should feel like a creator opened a beautiful travel publication and discovered that it was also the operating system for building her career.

It should not feel like a CRM wearing travel colors, or an influencer template with a database behind it.

## 3. Brand personality

Optimistic, ambitious, alive, international, modern, capable, warm, confident, curious and editorial.

The first creator audience is expected to skew female, but the design must not translate that into literal "feminine UI" tropes. Do not use pink, script typography, decorative florals or softness simply because the audience may skew female.

Create emotional resonance through aspiration, photography, confidence, warmth, clear progress, freedom and professional momentum.

## 4. Color philosophy

### Signature: Sun `#FFE01B` — **LOCKED (D048)**

The primary brand accent is **Sun `#FFE01B`**. This is no longer an open yellow
exploration; the warmer and brighter alternatives considered during the
exploration are rejected.

Yellow must remain **bright, sunlit, contemporary and energetic**. It must never
read as mustard, ochre, beige, terracotta, rustic or bohemian.

**Yellow is a brand / accent / selection / action color. It must never become a
semantic success, warning or error color.** Status meaning stays in the semantic
palette, which is a separate system — see §4 final paragraph. A yellow that also
means "warning" cannot simultaneously mean "selected" or "primary action", and
the selection language of A2 depends on it meaning the latter.

Yellow is an accent and identity device, not the default background of every screen.

Preferred base system:

- near-white / clean white backgrounds;
- deep ink / near-black text;
- sunlight yellow as signature accent;
- photography as a major source of color;
- one or two restrained secondary chromatic signals when needed.

Brand color and semantic status colors remain separate systems.

## 5. Visual composition

Use editorial principles where they improve hierarchy: strong image crops, purposeful asymmetry, large location/destination moments, restrained oversized typography, clear section rhythm and information layered with visual context.

Do not sacrifice productivity density for magazine aesthetics.

Discover and Pipeline require medium-high information density with excellent hierarchy.

Avoid giant floating cards, excessive whitespace, every item inside a rounded rectangle, and huge dashboard KPI tiles as the default architecture.

## 6. Photography

Photography is part of the product language, not decoration.

It should communicate: "I want to be there", movement, sunlight, place, real hospitality environments and creator lifestyle without staged influencer cliché.

Preferred character: natural light, vivid but credible color, real atmosphere, architectural detail, human presence when useful and cinematic crops without stock-luxury advertising.

Avoid laptop-on-beach stock imagery, champagne/passport/airplane-wing clichés, beige luxury as brand language, synthetic influencer poses and fake creator success imagery.

## 7. Typography direction

**Status: APPROVED — Archivo is the primary product typeface V1 (D053).**

Preferred over Schibsted Grotesk. Typography exploration for V1 is closed.

Why it fits A2:

- high legibility at the dense product-UI sizes A2's result rows require;
- strong numeric rendering, for dates, counts, rates and confidence;
- enough editorial personality to avoid an enterprise-SaaS default, without
  becoming a display-only magazine face;
- variable-width capability, which supports A2's no-photo and editorial
  typographic treatments where no image can carry the row;
- suitable for the master brand beyond travel (§14), so a vertical expansion
  does not force a type change.

**Approving the typeface does not promote any prototype size, weight, width or
line-height to a token** — those remain implementation references until
validated on a real surface (§22). Production font loading is unchanged until
the implementation PR; the app currently uses system defaults.

Use a highly legible modern grotesk / neo-grotesk for product UI, with enough personality to avoid enterprise SaaS defaults, strong numeric rendering and editorial scale contrast in destination/lifestyle moments.

Avoid the default AI-brand pairing of elegant high-contrast serif display + generic neutral sans.

A second display face is optional, not assumed.

## 8. Shape and surface language

Preferred: moderate radii, crisp borders where structure matters, selective elevation, flat surfaces more often than floating surfaces, strong image edges, tabs/chips only when they carry real meaning.

Avoid pill-shaped everything, 24–32px radii everywhere, glassmorphism, gratuitous gradients, heavy shadows and soft beige cards on cream backgrounds.

## 9. Motion

Use motion for map/list synchronization, selection changes, progressive disclosure, saved/pipeline feedback and meaningful state transitions.

Avoid constant ambient motion inside productivity surfaces and gamified confetti for ordinary CRM actions.

## 10. Discover visual thesis

Discover is the first major visual product statement.

It should feel like:

**travel discovery + creator intelligence + professional opportunity search.**

Desktop target:

- map/list split where coordinates exist;
- strong hotel photography in list results;
- useful information visible without opening every hotel;
- selected list item and map marker clearly synchronized;
- filters accessible without visually dominating the surface;
- map is functional, not decorative;
- compact enough cards for rapid opportunity browsing.

A result should communicate, where supported by real data: hotel identity, destination, visual desirability, useful context, creator activity signal, collaboration signal, contact availability/locked state, creator relationship state and primary next action.

Never manufacture intelligence to make a card richer.

Mobile target: list-first, clear Map toggle, full-screen map when selected, no compressed desktop split view.

## 11. Hotel Detail visual thesis

Hotel Detail transitions from aspiration to decision.

Order remains:
1. identity / place;
2. creator intelligence;
3. premium contact;
4. creator private relationship/actions.

Photography creates desire. Intelligence creates confidence. Contact access creates value. Workflow action creates momentum.

The page should answer: **Do I want to work with this hotel, and what should I do next?**

## 12. Pipeline visual thesis

Pipeline is the professional workbench, not the main lifestyle surface.

Use higher information density, strong status hierarchy, visible dates/actions, minimal decorative photography, clear next-action cues and compact rows/cards.

## 13. Home / future dashboard thesis

Home should translate CRM work into life progress.

Not: "12 pipeline records."

Instead: **Your next trip is taking shape.**

Then show real facts underneath: hotels saved, pitches sent, replies, confirmed collaborations, upcoming trip and next useful action.

## 14. Master-brand extensibility

Do not make the master identity dependent on hotel motifs such as keys, doors, suitcases, palm trees, airplanes or hotel bells.

Travel imagery belongs to the current vertical/content layer.

The transferable brand idea is creator ambition and career freedom, not tourism.

## 15. Explicit anti-patterns

Do NOT produce:

- beige / cream lifestyle SaaS;
- terracotta or muted ochre as primary personality;
- boho travel branding;
- clean luxury that removes all energy;
- Airbnb clone;
- generic creator-economy gradients;
- generic purple SaaS;
- wellness aesthetic;
- serif-display + neutral-sans cliché by default;
- giant rounded cards floating in empty space;
- excessive pill UI;
- decorative glassmorphism;
- fake social proof;
- fake hotel/creator intelligence;
- generic AI-generated startup landing-page composition.

## 16. Visual exploration protocol — **COMPLETED**

> This protocol ran and is closed. Three explorations were produced and
> reviewed; the outcome is **A2 — Sunlit Creator OS** (§2). Nothing here remains
> to be executed. It is kept because it records what the alternatives were and
> why the winner is a synthesis rather than Direction A alone.

Before changing production UI, generate THREE intentionally different explorations using the same product content.

### Direction A — Sunlit Editorial Utility — RECOMMENDED
Bright, editorial, photographic, energetic, information-rich.

### Direction B — Creator Command Center
More utilitarian and product-dense. Less photography; stronger grid/data behavior; yellow used as high-energy navigation/action language.

Purpose: test whether A becomes too lifestyle-heavy.

### Direction C — Visual Opportunity Network
Map and network/intelligence signals become more visually dominant.

Purpose: test whether the proprietary data/network angle deserves stronger visual ownership.

These are not three color themes. They must differ in hierarchy, composition, density and interaction language.

## 17. Selection criteria — **APPLIED**

> Applied during the review that selected A2. Retained as the rubric for any
> future direction work; not an open task.

Score each exploration 1–5 on:

1. Distinctiveness
2. Travel desire
3. Professional credibility
4. Daily usability
5. Information density
6. Female-audience resonance without stereotype
7. Master-brand extensibility
8. Ability to support maps/data
9. Mobile adaptability
10. Resistance to generic AI/SaaS aesthetics

Direction A is the default winner unless exploration reveals a concrete usability or extensibility problem.

## 18. Current implementation constraints

The existing repository correctly uses semantic tokens rather than locked brand values. Current blue accent and typography are placeholders, not brand decisions.

Do not redesign domain rules while redesigning surfaces.

Technical errors remain technical states. Suppressed/unknown intelligence remains unknown. Premium locks communicate value without leaking protected data. No visual redesign may fabricate richer data than the product actually has.

## 19. Gate to Sprint 3 — **PASSED**

| Step | Status |
|---|---|
| 1. Produce the three Discover explorations | ✅ done |
| 2. Review them against §17 | ✅ done |
| 3. Select/finalize one direction | ✅ **A2 — Sunlit Creator OS** (D047) |
| 3b. Approve V1 typography | ✅ **Archivo** (D053) |
| 4. Convert that direction into semantic tokens and reusable primitives | ⬜ Sprint 3A |
| 5. Implement Sprint 3A Discover + Map | ⬜ Sprint 3A, subject to §21 prerequisites |

The design system should become stricter only after one real surface has proven the visual language.

---

## 20. Discover V1 interaction direction — APPROVED

This is the approved interaction model for Sprint 3A. It describes hierarchy and
behaviour, not pixels — see §22.

### Desktop

- A **dense hotel result list** is the primary object.
- A **persistent map relationship** sits alongside it.
- **Result ↔ marker synchronization** in both directions.
- A **clear selected state**, unmistakable in both list and map.
- The map remains **secondary to the product**, not the substrate the whole
  application lives inside.

### Mobile

- **List-first.**
- **Map is a mode**, entered deliberately — not a squeezed desktop split.

### Hotel results

- **Photography sits inside the information architecture**, not as giant
  lifestyle hero cards. Browse velocity beats one beautiful screenshot.
- The **no-photo state is first-class**, designed rather than degraded.
- **No permanent grey skeleton placeholder** standing in for a missing image.
- **Never invent photography.** A hotel without a real, rights-cleared image
  shows the designed no-photo state.

### Selection

- The selected row **stays clearly active**.
- The selected marker **becomes active**.
- Contextual actions/details are **compact**.
- Selection **must not dramatically reflow the list** — the creator's scan
  position and comparison context survive a click.

### Map

- A **distinctive marker grammar**, recognisable as this product.
- A **selected marker** state.
- **Clusters** at low zoom.
- An **unmapped fallback state** for a hotel without coordinates. This exists so
  the surface degrades honestly if bad data ever escapes validation — it is a
  **defensive data-integrity state, not a planned condition of production
  inventory** (D054). Publishable hotels all have coordinates.
- **No fake geographic entitlement polygons.** Destination entitlement is a
  hierarchy of catalogue records, not a drawn boundary, and drawing one would
  assert coverage the data does not define.

---

## 21. Prerequisites — NOT solved in the Visual Direction gate

Both are open product/data contracts. Neither is resolved by this document, and
neither may be improvised during Sprint 3A.

### A. Hotel photography / media

A2's treatment of photography **and of the no-photo state** is approved. The
production data model behind it does not exist: `hotels` has no media column, no
media table exists, and no sourcing pipeline exists.

Unresolved, and required before any production photography ships:

- **Media representation** — column, side table, or external store; one image or
  many.
- **Cover vs gallery semantics** — which image represents a hotel in a result
  row, and who decides.
- **Source and provenance** — every image needs the same auditable provenance
  the canonical hotel/contact data already has
  ([`HOTEL_DATA_CONTRACT.md`](HOTEL_DATA_CONTRACT.md)); an unattributed image is
  not promotable.
- **Rights and sourcing** — licence, attribution obligations, and what happens
  when a hotel's own imagery is used.
- **Production ingestion strategy** — how images enter through the existing
  staging → review → promotion workflow rather than around it.

Until these are decided, Discover must render the designed no-photo state. Do
not add an `image_url` column, a media table, or a hotlinked third-party image
as an interim measure.

### B. Geocoding / map coordinates

The map UX is approved. `hotels.latitude` / `hotels.longitude` already exist in
the schema, so **no migration is needed** — the gap is data coverage, not
structure. The canonical pilot does not yet have enough coordinates for a
credible production map.

**Coverage target: 100% of publishable inventory (D054).** Every hotel Discover
lists has canonical coordinates and appears on the map. Coordinates are a
**publishability precondition**, not enrichment that catches up later.

- **Canonical coordinate enrichment is a prerequisite for a real map**, and for
  publishing a hotel at all.
- Internal/staging/research records may lack coordinates while being enriched or
  reviewed. The rule binds at the **promotion boundary**, not before it.
- **Do not add fake production coordinates.** An unlocated hotel is held back
  from publication, never given a plausible point.
- **Do not use prototype marker positions as data.** Positions in the A2
  artifact were illustrative.
- Coordinates must arrive through the canonical staging → review → promotion
  path with the same provenance discipline as every other hotel field, which
  also means choosing a geocoding source is itself an open decision.
- **Partial coverage is not an acceptable V1 target.** An earlier version of
  this section said it was, on the grounds that A2 supports unmapped hotels;
  that is superseded by D054. The unmapped state in §20 survives as a defensive
  fallback only. A2 showed unmapped hotels because its fixtures were incomplete
  demo data — that was a property of the prototype, not a coverage target.

---

## 22. Prototype pixels are not product contracts

The A2 exploration contains concrete dimensions — 111px rows, 168×92 media,
a 116px selected context area, specific column widths. These are **implementation
references, not brand or product decisions**, and must not be frozen into
canonical design tokens merely because they appeared in a prototype.

Production implementation preserves, in priority order:

1. the information hierarchy;
2. the interaction model (§20);
3. density and browse velocity;
4. only then, specific measurements.

A number from the prototype earns token status by proving itself on a real
surface with real content, not by having been rendered once.

---

## 23. Explicitly OUT of the Sprint 3A base contract

The exploration artifact contains visual affordances that are **not approved
functionality**. Production must reflect the queries and features that actually
exist.

- **Saved searches** — not approved.
- **Compare** — not approved.
- **Bulk select** — not approved.
- **"Search this area"** — not approved. It appears in the artifact; it is not a
  supported query.
- **New non-A–Z sorting modes** — not approved. Discover currently sorts by name
  A–Z. The artifact's dropdown-looking control does not imply additional sort
  orders exist.

Rendering a control the backend cannot honour is the same failure as rendering
intelligence the data does not support. If a control appears, the behaviour
behind it must be real.
