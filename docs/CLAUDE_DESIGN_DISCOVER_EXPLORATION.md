# Claude Design Brief — Discover Visual Direction Gate

## Objective

Design three deliberately different high-fidelity visual explorations for the authenticated Discover experience of theugc.life before Sprint 3A implementation.

This is a DESIGN EXPLORATION, not production code.

Do not redesign product rules, entitlements, data semantics, pipeline logic or intelligence semantics.

Read and follow:

- `docs/VISUAL_DIRECTION.md`
- `docs/DESIGN_SYSTEM.md`
- current Discover implementation
- current HotelCard implementation

The long-term master brand may expand beyond travel UGC, but the current product must be obsessively good for travel creators.

Core emotional promise:

**Build the creator career — and life — you want.**

Current expression:

**Bright travel ambition. Serious creator infrastructure.**

## Important context

The current implementation is intentionally functional and visually provisional.

Current blue accent values are placeholders.

The current dataset does not yet provide production-ready map coordinates or hotel photography in the application. For visual prototyping only, you MAY use clearly fictional/demo map positions and representative hotel photography to demonstrate layout. Do not present those prototype values as real product data and do not write them into production code or product documentation.

Intelligence must remain semantically honest:

- do not invent reply rates;
- do not invent creator activity;
- do not invent collaborations;
- do not convert missing data into zero/negative data;
- do not expose premium contacts in Discover;
- technical errors are not domain facts.

Prototype cards may show examples of the AVAILABLE component states as a visual state matrix, but label mock/demo states clearly in the prototype rationale.

## Audience

Primary launch audience: professional/aspiring travel UGC creators, likely female-skewed.

Do not translate this into stereotypically feminine UI.

No pink-by-default, floral motifs, script fonts or soft wellness branding.

Target emotional reaction:

"This understands the life I want to build."

Target functional reaction:

"This is serious software I can use every day."

## Signature color hypothesis

Explore a vivid sunlight / lemon / electric warm yellow as the master signature.

The yellow should feel:

- energetic;
- optimistic;
- modern;
- memorable;
- sunlit;
- creative.

It should NOT feel:

- mustard;
- ochre;
- beige;
- boho;
- childish;
- warning-colored.

Do not make the whole interface yellow.

Preferred foundation:

- white / cool near-white;
- ink / near-black;
- sunlight yellow;
- photography as a major source of chromatic richness;
- semantic status colors remain independent.

Exact colors are exploratory, not locked.

## Absolute anti-patterns

Do not produce:

- beige / cream lifestyle SaaS;
- terracotta;
- muted boho palettes;
- Airbnb clone;
- wellness aesthetic;
- generic purple creator SaaS;
- giant rounded cards floating in huge whitespace;
- 24–32px radii everywhere;
- pill-shaped everything;
- glassmorphism;
- gratuitous gradients;
- huge generic KPI cards;
- elegant serif display + Inter-style neutral sans as an automatic AI-brand pairing;
- stock "laptop on beach" imagery;
- passport / champagne / airplane-wing travel clichés;
- fake social proof;
- fake intelligence;
- generic AI-generated startup landing-page composition.

## Product surface to design

Primary surface:

`/app/discover`

Design:

1. Desktop Discover at approximately 1440px wide.
2. Mobile Discover at approximately 390px wide.
3. One selected-hotel interaction state on desktop.
4. One mobile map state.
5. A small component strip showing card/filter/marker states needed to explain the system.

Do not redesign the entire application yet.

## Functional Discover content

The experience should support:

- search;
- destination filter;
- hotel type filter;
- star filter where useful;
- result total;
- pagination or scalable list behavior;
- hotel card;
- Hotel Detail navigation;
- selected list item ↔ selected map marker;
- empty/error states;
- responsive list/map behavior.

The design must anticipate future real signals on a result card, when actually available:

- creator activity level;
- confidence-aware intelligence;
- confirmed collaboration signal;
- contact availability / premium lock;
- creator's own pipeline relationship state.

Do NOT assume every hotel has every signal.

The visual system needs elegant omission/unknown states.

## Information hierarchy

A hotel result should prioritize:

1. photography / hotel identity;
2. hotel name;
3. destination;
4. genuinely useful hotel context;
5. creator opportunity/intelligence signal if available;
6. creator's own relationship state if available;
7. primary next action.

Do not turn every metadata field into a chip.

## Map behavior

The map is a functional discovery surface, not decoration.

Desktop:

- meaningful list/map split;
- card hover/selection visibly coordinates with marker;
- map remains readable alongside information-dense results;
- selected marker has an unmistakable but tasteful state;
- map controls do not dominate.

Mobile:

- list-first;
- prominent but non-obstructive Map toggle;
- map becomes full-screen or near-full-screen;
- selected hotel may use an accessible bottom card/sheet if appropriate;
- do not squeeze a desktop split view onto mobile.

## Photography behavior

Photography should make Discover emotionally desirable.

Use strong, credible hospitality/travel imagery with natural light, vivid but believable color, architecture and a sense of place.

Cards should not become giant photo tiles with too little information.

The product still needs high browse velocity.

## Density

Medium-high density.

A creator should be able to compare multiple hotels quickly.

Avoid sparse Dribbble-style layouts that look beautiful in one screenshot but are inefficient in real use.

## Typography

Use a highly legible modern grotesk / neo-grotesk direction with personality.

A second editorial/display face is optional.

Do not force a serif merely to create "luxury".

Hierarchy and scale should create the editorial quality before font novelty does.

## Shape language

Use moderate radii, clear borders and restrained elevation.

Not every object needs a container.

Let photography, typography, alignment and whitespace establish hierarchy.

## Three directions

You MUST create THREE genuinely different directions.

They must differ in hierarchy, composition, density and interaction model — not merely palette.

### A — SUNLIT EDITORIAL UTILITY — recommended hypothesis

Core idea:

A travel editorial experience that is secretly excellent professional software.

Traits:

- photography-forward but compact;
- strong typographic composition;
- vivid yellow signature;
- editorial asymmetry in controlled moments;
- crisp software controls;
- intelligence integrated elegantly rather than shown as dashboard widgets;
- confident near-black + white foundation;
- high browse velocity.

Desired reaction:

"I want this lifestyle, and this looks like the tool that can help me build it."

### B — CREATOR COMMAND CENTER

Core idea:

The serious operating system for a professional creator.

Traits:

- denser;
- more grid/list-oriented;
- photography secondary;
- strong state/action language;
- yellow as navigation/action energy;
- sharper information architecture;
- opportunity comparison emphasized.

Desired reaction:

"This will save me time and make me better at my job."

This direction exists to prove A has not sacrificed professional utility for lifestyle imagery.

### C — VISUAL OPPORTUNITY NETWORK

Core idea:

Proprietary network/intelligence + geography is the hero.

Traits:

- map more dominant;
- network/data signals visually stronger;
- hotel imagery becomes contextual rather than dominant;
- selected marker/card interaction is the signature experience;
- opportunity/intelligence language has more visual ownership;
- still energetic and travel-desirable.

Desired reaction:

"This shows me opportunities and signals I cannot get anywhere else."

This direction exists to test whether the moat should be visually more prominent than the lifestyle layer.

## Important: force divergence

Before rendering, state in one sentence how each direction differs structurally from the other two.

If two directions share essentially the same card grid, header, typography hierarchy and interaction pattern with only styling differences, start again.

## Deliverables

For each A/B/C provide:

1. Desktop Discover mockup.
2. Selected-hotel desktop state.
3. Mobile list state.
4. Mobile map state.
5. Mini visual system strip:
   - primary button;
   - secondary button;
   - filter control;
   - hotel card;
   - selected map marker;
   - intelligence signal;
   - locked contact signal;
   - pipeline relationship signal.
6. Palette swatches with HEX values — exploratory only.
7. Typography proposal — exploratory only.
8. 5 short bullets explaining the visual logic.
9. 3 risks/tradeoffs.

## Evaluation rubric

Self-score each 1–5:

- Distinctiveness
- Travel desire
- Professional credibility
- Daily usability
- Information density
- Female-audience resonance without stereotype
- Master-brand extensibility beyond travel
- Ability to support maps/data
- Mobile adaptability
- Resistance to generic AI/SaaS aesthetics

Do not declare a winner solely on your own score.

## What not to do after exploration

Do not modify production code.

Do not create a design system implementation.

Do not change Tailwind tokens.

Do not add Mapbox.

Do not commit imagery.

Do not redesign Hotel Detail or Pipeline yet.

STOP after the three exploration packages and rationale.

External review will select/combine the direction before Sprint 3A begins.
