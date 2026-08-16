# theugc.life — PROPERTY_CONTENT_COVERAGE_CONTRACT.md

Version: 1.0
Status: **Approved V1 contract.** Governs property inventory scope, destination
coverage, publishability, star classification, source identity, media and
coverage measurement.

Governing decisions: **D049** (one canonical inventory), **D054** (100% map
coverage of publishable inventory), **D055** (destination inventory complete,
not capped), **D057** (three provenance domains), and this block's **D060–D064**.

**Nothing in this document is implemented.** No table, column, provider
integration, ingestion job, geocoder or media pipeline exists as a result of it.
This is the contract that the implementation block must satisfy — and the gate
it must pass through first.

---

## 1. What this document decides, and what it deliberately does not

**Decided here:**

- what a property must be to enter V1 inventory at all;
- what "all hotels in a destination" means operationally;
- the difference between *coverage* completeness and *enrichment* completeness;
- what a canonical hotel must have before it may be published;
- what it explicitly need **not** have;
- where the publication boundary sits (promotion into `hotels`);
- when a destination may be called **coverage complete**;
- how star classification is resolved and justified;
- how external provider identities relate to canonical property identity;
- how media is modelled and attributed;
- what a destination coverage run must be able to explain.

**Not decided here** — see §16. No inventory provider is chosen. No geocoder is
chosen. No star-source hierarchy, match threshold, media supplier priority,
storage strategy or sync cadence is chosen. Inventing any of them in
implementation is a contract violation, not a detail.

---

## 2. V1 inventory scope (D060)

> V1 inventory is **every unique, in-scope, physical hospitality property with a
> resolved canonical hotel star classification of 4 or 5 stars** in each
> supported destination.

### 2.1 "Stars" means hospitality classification

`4-star` / `5-star` refers to **hotel/hospitality star classification** — the
classification the property holds as a hospitality establishment.

It is **never** any of:

- a Google review score;
- a Booking guest review score;
- an Expedia review score;
- a TripAdvisor rating;
- any other user-review or guest-satisfaction score.

A property with a 4.7 guest-review average and no hospitality classification has
**no resolved star classification**. It is not thereby a 4-star hotel, and it is
not thereby excluded — it is unresolved, which is a review state (§9).

Deriving stars from review scores is prohibited. It is the single most likely
way this contract gets quietly broken, because both are "out of five".

### 2.2 Property type does not decide eligibility

Type alone neither admits nor excludes. A property qualifies when it is a
physical hospitality property **and** carries a valid 4/5-star classification.

Types that may qualify include, and are not limited to: `hotel`, `resort`,
`boutique_hotel`, `aparthotel` / hotel apartment, `lodge`, `residence`,
villa-style hospitality operations, and other physical hospitality property
types.

The existing `hotel_type` taxonomy in
[`HOTEL_DATA_CONTRACT.md`](HOTEL_DATA_CONTRACT.md) §3 remains descriptive
metadata. It is not the eligibility gate.

### 2.3 What is still excluded

Not hospitality properties, and therefore never hotel inventory:

- corporate or group headquarters;
- management companies and operators as organizations;
- PR, marketing and representation agencies;
- any other non-property organization (D029, `HOTEL_DATA_CONTRACT.md` §8).

These may still be modelled as organizations and may still carry contacts. They
are not hotels.

### 2.4 The gate, stated once

```
physical hospitality property
+ resolved canonical hotel star classification ∈ {4, 5}
+ inside a supported canonical destination
= in V1 inventory scope
```

---

## 3. The no-cap rule, in operational terms (D061, operationalising D055)

There is **no**:

- target hotel count per destination;
- top-N inventory;
- curated subset;
- representative sample;
- package cap;
- "enough hotels" threshold;
- commercial maximum.

If a destination's resolved coverage universe contains 724 eligible properties,
the canonical destination inventory is **724**. If it contains 438, it is 438.
If it contains 79, it is 79.

> **The inventory count is an OUTPUT of destination reality and the coverage
> process. It is never an INPUT chosen by product packaging.**

### 3.1 Prohibited language

Do not describe destination inventory as "top 100", "selected hotels", "curated
hotels", "initial 50", "representative inventory" or any equivalent. This applies
to product copy, documentation, commit messages, dashboards and internal reports
alike.

The one permitted use of such language is an explicitly named **technical test
fixture** that is not destination coverage.

### 3.2 The Dubai pilot is a technical pilot

The existing 30-property Dubai set is a **technical pilot only**. It proved the
staging → review → promotion pipeline end to end on real data.

**It must never be described as complete Dubai inventory**, as Dubai coverage, or
as a coverage baseline. Dubai's coverage number does not exist yet, because Dubai
has not been through a coverage run.

---

## 4. What "all" means (D061)

"All" must be measurable rather than metaphysical. For a supported destination:

```
coverage universe
  = union of all approved inventory-source records
  + existing canonical / research inventory
  + other approved authoritative inventory inputs when adopted

then:
  identity resolution
  + deduplication
  + scope filtering
  + active-status filtering
  + 4/5-star eligibility resolution

produces:
  CANONICAL V1 DESTINATION INVENTORY
```

Therefore:

> **V1 destination completeness = all unique eligible 4/5-star physical
> hospitality properties resolved from that destination's defined coverage
> universe.**

Two consequences that must survive implementation:

- **A provider is not truth.** A provider supplies observations about the world.
  It does not define the world.
- **No single provider is assumed complete.** The coverage universe is a union,
  and the union may need more than one source (§15). A destination whose universe
  came from one provider is a destination whose completeness claim rests on that
  provider's completeness, which is unverified until measured.

---

## 5. Coverage completeness vs enrichment completeness (D061)

These are two different problems and must stay first-class and separate.

### A. Inventory / coverage completeness

> *"Do we have every eligible property in the destination coverage universe?"*

This is the D055 completeness problem. It is measured against the **universe**,
never against a target count and never against the subset already known to
qualify. It cannot be answered "yes" while any candidate in that universe is
still unresolved on a coverage-critical dimension — see **§15.1**, which is the
operative rule.

### B. Enrichment / field completeness

> *"How much do we know about each canonical property?"*

Examples: coordinates · photography · website · Instagram · any contact · target
Marketing/PR/Partnerships contact · contact verification · Hotel-Confirmed
Intelligence · Creator Network Intelligence.

**A missing optional field must never silently remove an otherwise eligible hotel
from the canonical destination inventory.**

Reporting the two as one number is prohibited. "100% coordinate coverage" is not
"100% data completeness", and saying so misrepresents the product to its own
operators.

---

## 6. Missing data is an enrichment queue (D061)

> **MISSING DATA IS WORK TO DO, NOT A REASON TO PRETEND THE HOTEL DOES NOT
> EXIST.**

For an otherwise eligible property, all of these may be missing without removing
it from the coverage universe or from published inventory:

- photo;
- any contact;
- target contact;
- premium contact;
- Instagram;
- Creator Network Intelligence;
- Hotel-Confirmed Intelligence;
- creator-collaboration evidence.

### 6.1 Missingness must be measurable

The system should be able to answer "what do we not know yet, and for which
properties?" as an operational queue rather than an intuition. Expected future
capabilities — **not implemented here**:

- `hotels_without_any_contact`
- `hotels_without_target_contact`
- `hotels_without_photo`
- `hotels_without_verified_contact`
- `hotels_without_instagram`
- `hotels_without_hotel_confirmation`
- `hotels_without_creator_intelligence`

Each is a work queue with an owner, not a defect report and not an exclusion
filter. A hotel appearing in six of them is still published inventory.

---

## 7. Publishability contract (D062)

Two states that this contract makes explicit and that must not be conflated:

| | RESEARCH / STAGING PROPERTY | CANONICAL PUBLISHABLE HOTEL |
|---|---|---|
| May be incomplete | **Yes — legitimately** | Only in the enrichment fields of §7.2 |
| Visible to creators | No | Yes |
| Lives in | staging / review tables | `hotels` |
| Governed by | [`HOTEL_DATA_CONTRACT.md`](HOTEL_DATA_CONTRACT.md) | This section |

Research and staging records may lack almost everything. That is the normal state
of the pipeline before promotion, and `HOTEL_DATA_CONTRACT.md` continues to allow
it.

### 7.0 Promotion IS publication in V1

> **Promotion into the canonical `hotels` inventory is the publication
> boundary.** For V1 there is no canonical-but-unpublished state:
>
> **PROMOTED PROPERTY = CANONICAL PUBLISHABLE PROPERTY**, and **D062 is a
> promotion precondition**.

```
source → staging → audit/review → promotion preview → human review
       → promotion/apply → canonical publishable hotel
```

A candidate that fails any condition in §7.1 **is not promoted**. It stays in
staging/review, where it is enriched, resolved or finally excluded. It is not
deleted, and it is never given a fabricated coordinate or an invented star
classification in order to pass.

**No `publication_status` column, no unpublished-canonical tier and no
draft-hotel state is introduced by this contract.** One boundary is easier to
verify than two, and a second state would immediately raise questions this block
has no need to answer — who sees it, what RLS applies, whether creators can save
it, whether it counts toward coverage. A future product decision may create such
a layer if a concrete need appears; until then, a row in `hotels` is a row a
creator can see.

**Historical rows are not retroactively compliant.** The canonical pilot was
promoted before D054, D060 and D062 existed. Those rows are not claimed to
satisfy §7.1, and the implementation block must audit, enrich and re-evaluate
them against it.

### 7.1 Publication requires, at minimum

1. canonical property identity is resolved;
2. it belongs to a supported canonical destination;
3. it is a physical hospitality property;
4. it is not known permanently closed / inactive;
5. its V1 scope status is resolved;
6. canonical hotel star classification is **exactly 4 or 5**;
7. **star-classification provenance exists**;
8. canonical latitude exists;
9. canonical longitude exists;
10. **coordinate / location provenance exists**;
11. no unresolved entity-resolution conflict prevents us from knowing what
    property it is.

Coordinates remain a hard publishability condition under **D054**. Star
eligibility becomes a hard V1 publishability condition under **D060**.

Conditions 7 and 10 are deliberate: a value without provenance is not a canonical
value, it is a number we cannot defend (D025, D027).

### 7.2 Publication must NOT require

- photography;
- any contact;
- a target contact;
- a premium contact;
- Creator Network Intelligence;
- Hotel-Confirmed Intelligence;
- creator-collaboration evidence.

Stated plainly, because each has been assumed at least once:

> **CONTACT COMPLETENESS IS NOT PUBLISHABILITY.**
> **PHOTO COMPLETENESS IS NOT PUBLISHABILITY.**
> **INTELLIGENCE COMPLETENESS IS NOT PUBLISHABILITY.**

A published hotel with no contact and no photo is an honest statement about the
destination plus a known piece of work. A destination that hides such hotels is a
destination the product is lying about (D055).

---

## 8. Star classification is provenance-backed (D060)

The current `hotels.star_rating numeric` is not sufficient as an unexplained
number. After this contract the system must be able to answer:

> *"Why does theugc.life consider this property a 4-star or 5-star property?"*

The conceptual model is therefore:

```
CANONICAL STAR CLASSIFICATION  +  SOURCE EVIDENCE / PROVENANCE
```

Sources that may later be approved include inventory providers, official
property/brand information, tourism/hospitality authorities, and other approved
authoritative sources. **The authority hierarchy among them is not chosen here**
(§16) — it belongs to the source-evaluation block, which will have evidence for
the choice.

### 8.1 Rules

- **Never infer hotel stars from review scores** (§2.1).
- **Never average conflicting classifications.** A source saying 4 and a source
  saying 5 do not make 4.5. Averaging invents a classification no authority ever
  issued.
- **Never fabricate a missing classification.**
- **Unknown classification → REVIEW / NOT YET PUBLISHABLE.** Not excluded, not
  guessed, not defaulted.
- **A conflict that could mean the property is out of scope → REVIEW.**
- **Retain source-specific observations even after canonical resolution.** The
  canonical value is a resolution of the observations, never a replacement for
  them.

### 8.2 The 4-vs-5 case

If one source says 4 and another says 5, the property is clearly inside the broad
4/5 eligibility set — the *scope* question is answered. The *displayed canonical
classification* is a separate question and still requires an explicit resolution
policy.

**That resolution policy is deliberately not written here.** It belongs to the
implementation / source-evaluation block, where the relative authority of real
sources will be known rather than assumed.

---

## 9. Exclusion reasons: final vs hold (D061)

D055 requires that exclusions be explicit and auditable. The contract now
requires that they distinguish **final exclusions** from **hold / review states**,
because collapsing the two destroys the ability to expand scope later.

| Reason | Kind |
|---|---|
| duplicate / merged into canonical property | final |
| permanently closed / inactive | final |
| corporate / group HQ | final |
| agency / non-property organization | final |
| not a physical hospitality property | final |
| star classification below V1 scope | **out of V1 scope, retained** (§10) |
| star classification unresolved | **hold / review** |
| identity unresolved / review | **hold / review** |
| outside destination | final for *this* destination |
| other explicitly reviewed out-of-scope reason | as reviewed |

The distinction that matters most:

> **"star classification unknown" is not the same fact as "confirmed 3-star
> hotel".** The first may later enter inventory once resolved. The second is
> currently outside V1 scope.

Treating unknown as below-scope silently deletes eligible properties. Treating
below-scope as unknown silently pollutes inventory.

---

## 10. Out-of-scope research is preserved, not deleted (D060)

Existing research on 1/2/3-star properties must **not** be blindly deleted. It
remains valuable for future scope expansion, organization and contact research,
and historical provenance.

Future implementation should be able to classify such a record as:

```
OUT_OF_V1_PRODUCT_SCOPE   reason: star_rating_below_v1_scope
```

— a durable, reviewable state, rather than destroying the data.

**Not implemented in this PR.** No column, no enum value, no migration.

---

## 11. Source-agnostic property identity (D063)

> **theugc.life owns the canonical property identity. External providers supply
> SOURCE identities.**

```
canonical hotel
  ├─ Booking source identity
  ├─ Expedia source identity
  ├─ official website identity
  ├─ other approved provider identity
  └─ future hotel-confirmed identity
```

**An external provider ID must never become the canonical hotel primary key.** A
canonical hotel outlives any provider relationship; a hotel keyed on a provider
is a hotel the product does not own. It also makes multi-source coverage (§4)
structurally impossible, since a property would need one PK per source.

### 11.1 `hotel_source_identities` — IMPLEMENTED (migration 0027)

> **Status update.** This entity was contract-only when written. Migration
> `0027` implements it, together with the source runs, identities, observations
> and resolution candidates it depends on. The semantics below are unchanged;
> see [`PROPERTY_CONTENT_IMPLEMENTATION_SPEC.md`](PROPERTY_CONTENT_IMPLEMENTATION_SPEC.md).
>
> Two invariants are now enforced by the database rather than by convention: one
> **active** source identity maps to at most one canonical hotel, and a canonical
> hotel may hold many source identities. A third was added by implementation:
> only `production`-environment identities may be linked at all, so
> evaluation/test provider data cannot become canonical evidence — enforced by a
> composite foreign key on `(identity id, source, source_environment,
> source_property_id)` plus the production CHECK, so the link's labels are the
> identity's own values and an evaluation identity is *unlinkable* rather than
> merely auditable after the fact.

Fields / semantics:

- `hotel_id` — canonical property
- `source` / provider
- `source_property_id`
- `source_url`
- source property name
- source address
- source coordinates when supplied
- source star classification when supplied
- source property type when supplied
- `first_seen_at`
- `last_seen_at`
- `last_synced_at`
- `match_method`
- `match_confidence`
- `match_status`
- provenance metadata where appropriate

This is also what makes a source replaceable: dropping a provider means dropping
its source identities, not rebuilding the inventory.

---

## 12. Entity resolution (D063)

Multiple source records may describe one hotel. Resolution should use several
signals where available: normalized property name · brand · official
website/domain · address · coordinates · phone · destination · known provider
mappings.

Three conceptual outcomes:

- **MATCHED** — high-confidence same physical property.
- **REVIEW** — a possible match with ambiguity or conflict.
- **NEW PROPERTY** — no canonical property corresponds.

### 12.1 Be conservative

A false merge can corrupt contacts, photos, coordinates, intelligence and live
creator workflows — and it is **strategically worse than temporarily retaining a
duplicate candidate**. A duplicate is visible and fixable. A bad merge silently
attributes one hotel's outreach history to another, and the creator whose
pipeline it corrupts has no way to see that it happened.

**Never merge because the names look similar.**

### 12.2 No invented thresholds

This documentation PR does **not** specify universal numeric match-confidence
thresholds. Real thresholds require real source data (§15). A number written here
would be a guess that later reads as a decision.

---

## 13. Location and coordinate provenance (D063, under D054)

D054 is unchanged: **100% of publishable canonical hotels have coordinates.**

But external source coordinates are **observations, not automatically canonical
truth**. A future location-evidence concept should be able to retain:

- `hotel_id`
- source identity / provider
- source latitude
- source longitude
- source address
- observed / verified time
- resolution status / provenance

> **Status update (migration 0027).** The *source* half exists:
> `source_property_observations` retains source latitude, longitude, address and
> observed time, with run provenance one join away. Source coordinates carry **no
> range constraint** — an invalid provider value is evidence to audit, not a row
> to erase — and `source_coordinates_plausible` records the verdict.
>
> The *canonical resolution* half is deliberately still future: a
> `source_property_location_resolutions` table would FK
> `source_property_observations(id)`, which is why observations are
> `ON DELETE RESTRICT` and append-only (enforced by privileges and a trigger).
> It attaches to the **source identity / candidate**, not to a `hotel_id` —
> under D062 a row in `hotels` *is* publication, so a candidate has no hotel id
> to resolve against until after the gate
> (`PROPERTY_CONTENT_IMPLEMENTATION_SPEC.md` §21.1). Nothing about
> `hotels.latitude` / `hotels.longitude` changes.

`hotels.latitude` / `hotels.longitude` remain the **resolved canonical
coordinates**.

Rules:

- never fabricate plausible coordinates;
- no map point taken from prototype or demo data;
- an unresolved location conflict → review;
- staging may lack coordinates;
- a publishable canonical hotel may not.

The map coverage formula is unchanged:

```
publishable_hotels_with_valid_canonical_coords
/ publishable_hotels
= 100%
```

---

## 14. Media and photography (D064)

Media is a **first-class, provenance-backed child resource of a canonical
hotel** — not a column on the hotel identity contract, and never a single
provider-specific photo URL wired into the hotel record.

### 14.1 Conceptual future resource: `hotel_media`

Contract only — **still not created**. Migration `0027` deliberately stops
short: it retains a media *availability summary* per source observation
(`source_image_count`, `source_provider_designated_principal_image`) and no image
rows, no URLs and no binaries. One evaluation property returned 118 images and
one destination totalled 137,328; ingesting that before the production/
commercial rights review and the storage strategy are settled would be a
permanent cost for data no query needs yet.

When `hotel_media` is built it attaches to `hotels`, to
`hotel_source_identities.id` and to `source_property_observations.id` — all
three exist, so it is an addition rather than a rebuild.

It should support at least:

- `hotel_id`
- source / provider
- source identity / reference
- source media ID when available
- source URL
- asset / remote URL
- media type
- category
- cover vs gallery role
- width / height when known
- sort order
- provenance
- usage / rights basis metadata
- attribution where required
- source updated time
- last verified time
- status
- whether the asset is property/provider/official media vs user-generated

### 14.2 Product rule

**The intended hotel gallery uses PROPERTY / HOTEL imagery.** Do not deliberately
select guest-generated or user-generated photos as canonical editorial property
imagery. The product promise of a hotel image is "this is the place", not "this
is what a guest's phone captured".

**Never ship:**

- Envato preview or watermarked A2 exploration images;
- fake demo photography represented as production data;
- an asset of unknown provenance represented as "official".

Exact provider licensing and usage rules are **source-specific and unevaluated**.
They must be resolved before production ingestion, not during it.

### 14.3 Source priority is a direction, not a provider choice

A strong cover candidate may conceptually later prefer, in order:

1. hotel-supplied / hotel-confirmed official media;
2. approved structured provider property media;
3. approved official hotel/brand media;
4. other approved eligible source;
5. **first-class NO-PHOTO state**.

**Do not hard-code Booking vs Expedia precedence.** The frontend must eventually
ask *"what is this hotel's best eligible cover?"*, never *"what is this hotel's
Expedia image?"*. Provider implementation stays behind the data layer, which is
what makes a provider swap a data-layer change rather than a UI rewrite.

### 14.4 No-photo is a valid field state

D055 means a missing photo must not remove an eligible hotel. Therefore **photo
coverage may legitimately be below 100%**, and the product needs a real no-photo
visual state (VISUAL_DIRECTION.md §21A already approves its design).

That state must not be confused with:

- unmapped;
- unpublished;
- unknown identity.

**Map coverage remains mandatory at 100% of published inventory. Photography does
not.**

---

## 15. Coverage runs (D061)

A **destination coverage run** is the auditable unit that produces and justifies a
destination's inventory. Per destination and per source, a run should be able to
explain:

- raw source records seen;
- source identities;
- candidate properties;
- cross-source matches;
- duplicates;
- manual-review candidates;
- new canonical candidates;
- inactive / closed exclusions;
- non-property exclusions;
- below-V1-star-scope exclusions;
- unresolved-star candidates;
- **coverage-critical unresolved candidate count** (§15.1);
- **closure status** — complete or incomplete;
- **canonical eligible V1 inventory count**.

**The final number is not preselected.** It is what the run resolved. And it is
only an inventory *claim* once the run has closed (§15.1) — before that it is a
progress reading.

> Example, to explain semantics only: *if* resolution produces 724 eligible Bali
> properties, the coverage target is 724 — not 100, not 200, not "as many as
> possible". **724.**

That number is an illustration. It is **not** a destination target and must never
be stored, quoted or planned against as one.

### 15.1 Coverage closure — a destination is not complete while candidates are unresolved

This is the rule that makes §3's promise checkable, and it is the one most easily
lost to a convenient denominator.

> **A destination MUST NOT be declared "coverage complete", "100% inventory
> complete", "complete inventory" or any equivalent while ANY candidate from its
> defined coverage universe remains unresolved on a coverage-critical eligibility
> dimension.**

**Coverage-critical unresolved states** — at minimum:

- canonical identity unresolved;
- duplicate / entity resolution unresolved;
- physical-hospitality-property status unresolved;
- destination membership unresolved;
- active / permanently-closed status unresolved;
- star classification unresolved;
- any other state required to determine whether the candidate belongs in V1
  inventory.

Every candidate in the defined coverage universe must eventually resolve to
exactly one of:

- **A. CANONICAL ELIGIBLE V1 PROPERTY**
- **B. DUPLICATE / MATCHED** to an existing canonical property
- **C. FINAL EXCLUSION / OUT OF V1 SCOPE**, with an explicit durable reason

Hold and review states are legitimate **during** processing (§9). They are not
legitimate at closure.

```
COVERAGE COMPLETE  requires  coverage_critical_unresolved_count = 0
```

A destination with unresolved candidates is **COVERAGE INCOMPLETE**, regardless
of:

- how many hotels are already published;
- coordinate coverage of published hotels;
- photo coverage;
- contact coverage;
- any count that looks large enough.

Why this needs stating: with 700 resolved-eligible properties and 24 candidates
still unresolved, a metric whose denominator holds only *known eligible*
properties reads **700/700 = 100%** — while some of those 24 may themselves be
eligible 4/5-star properties. The destination would be declared complete by
arithmetic that defined the missing hotels out of existence. That is precisely
the failure D055 and §3 exist to prevent, and it is invisible to the buyer.

### 15.2 Inventory-completeness semantics

> **A destination's inventory is complete only after the full defined source
> universe has been processed and every candidate's V1 eligibility has been
> resolved.** The final eligible inventory count is then the number of unique
> canonical properties resolved as eligible.

Two numbers, never one:

1. **resolved eligible inventory count** — the answer to "how many hotels";
2. **coverage-critical unresolved candidate count / closure status** — the answer
   to "are we finished".

A progress metric may be retained:

```
resolved_coverage_candidates / total_coverage_candidates
```

but **process resolution is not the eligible inventory count**, and neither one
substitutes for the other. A run at 96% processed has no inventory claim to make
yet.

**Do not construct a mathematically convenient denominator that excludes
unresolved records.** Any completeness fraction must be taken over the *defined
coverage universe*, not over the subset already known to qualify.

The product promise is not *"we resolved some known eligible hotels."* It is:

> **"We resolved the complete coverage universe and retained every property that
> qualifies."**

### 15.3 Field / enrichment metrics

**Field / enrichment coverage** — measured separately, per field:

coordinate coverage · photo coverage · website coverage · any-contact coverage ·
target-contact coverage · verified-contact coverage · hotel-confirmed coverage ·
Creator Network Intelligence coverage.

Coordinate coverage must reach **100%** for all publishable hotels (D054). The
others may legitimately sit below 100% and become the work queues of §6.

**Never describe 100% coordinate coverage as 100% total data completeness.**

---

## 16. Explicitly NOT decided

None of the following is decided by this contract. Do not invent them:

- which inventory provider wins;
- Booking vs Expedia precedence;
- the geocoding provider;
- exact provider API integration;
- the exact star-source authority hierarchy;
- exact automated entity-match thresholds;
- exact media supplier priority between third-party providers;
- whether third-party media is stored locally or referenced remotely;
- production sync cadence;
- specific destination property counts;
- paid provider contracts and licensing choices.

The comparative evaluation that will inform several of these is specified in
[`PROPERTY_SOURCE_EVALUATION.md`](PROPERTY_SOURCE_EVALUATION.md).

---

## 17. Property sources vs the theugc.life moat

Inventory and content providers may solve:

existence · external identity · address · coordinates · star classification ·
property type · photography · basic property content.

They do **not** replace the proprietary layers:

researched target creator contacts · contact verification · Hotel-Confirmed
Intelligence (D057 domain B) · creator workflow · Creator Network Intelligence
(D057 domain C) · future Value Intelligence.

> **Do not conflate a supplier's generic hotel contact with our premium target
> Marketing / PR / Partnerships contact.** A reservations mailbox from a provider
> feed is not the contact a creator is paying to reach, and treating it as one
> would hollow out the thing the product actually sells.

Buying inventory content buys the *floor* of the product. It cannot buy the moat
(D020).

---

## 18. Relationship to hotel outreach

The Hotel Outreach direction (`INTELLIGENCE_ROADMAP.md` §8) is an **enrichment and
relationship mechanism**. It is **not** a prerequisite for destination inventory
completeness.

A hotel may be published before it has ever answered theugc.life, provided it
satisfies §7.1. Outreach can later improve verified contacts, target contacts,
Hotel-Confirmed Intelligence, official media, preferred creator outreach and
partnership policy.

**A missing hotel response never removes a legitimate eligible property.**

---

## 19. Supported destinations

The initial twenty product destinations are recorded in
[`INTELLIGENCE_ROADMAP.md`](INTELLIGENCE_ROADMAP.md) §11 and referenced by
[`DESTINATION_CATALOG.md`](DESTINATION_CATALOG.md).

They are **selected but not ingested**. No coverage run has been executed for any
of them, no hotel counts are assigned to any of them, and they must not be
flattened into schema type `city` (D051's entitlement hierarchy depends on real
parent/child structure).

Each is subject to §3 and §4: all eligible properties in its coverage universe,
with exclusions recorded and auditable.

---

## 20. What implementation may not do

The implementation block that follows this contract may not:

- choose a provider by writing one into code without the evaluation of §15;
- cap, sample or "phase" a destination's inventory;
- publish (i.e. promote into `hotels`) a hotel that fails §7.1;
- withhold a hotel that only fails §7.2;
- introduce a canonical-but-unpublished state without an explicit product
  decision (§7.0);
- declare a destination coverage complete while coverage-critical candidates
  remain unresolved (§15.1);
- compute inventory completeness over a denominator that excludes unresolved
  candidates (§15.2);
- treat a single-destination or two-destination source result as evidence of
  completeness elsewhere (§4, `PROPERTY_SOURCE_EVALUATION.md` §5);
- store a star classification without provenance;
- average conflicting star classifications;
- infer stars from review scores;
- fabricate coordinates;
- use a provider ID as the canonical hotel PK;
- attach media without provenance and a rights basis;
- report enrichment coverage as inventory coverage.

Each of these is a contract violation, and each is cheaper to prevent than to
unwind once creator workflow is attached to the affected hotels.
