# theugc.life — VISUAL_DIRECTION.md
Version: 1.0 — Visual Direction Gate before Sprint 3

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

### Sunlit Editorial Utility

A combination of energetic lifestyle branding, real travel photography, editorial composition, dense creator-work software and selective intelligence/data language.

The product should feel like a creator opened a beautiful travel publication and discovered that it was also the operating system for building her career.

It should not feel like a CRM wearing travel colors, or an influencer template with a database behind it.

## 3. Brand personality

Optimistic, ambitious, alive, international, modern, capable, warm, confident, curious and editorial.

The first creator audience is expected to skew female, but the design must not translate that into literal "feminine UI" tropes. Do not use pink, script typography, decorative florals or softness simply because the audience may skew female.

Create emotional resonance through aspiration, photography, confidence, warmth, clear progress, freedom and professional momentum.

## 4. Color philosophy

### Signature: sunlight yellow

Yellow is the strongest candidate for the brand signature. It represents sun, optimism, movement, possibility, travel, creative energy and recognition.

It must feel bright and contemporary — closer to sunlight / lemon / electric warm yellow than mustard, ochre or beige.

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

Exact typefaces are not locked in this gate.

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

## 16. Visual exploration protocol

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

## 17. Selection criteria

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

## 19. Gate to Sprint 3

Before Sprint 3A implementation:

1. Produce the three Discover explorations.
2. Review them against §17.
3. Select/finalize one direction.
4. Convert that direction into semantic tokens and reusable primitives.
5. Then implement Sprint 3A Discover + Map.

The design system should become stricter only after one real surface has proven the visual language.
