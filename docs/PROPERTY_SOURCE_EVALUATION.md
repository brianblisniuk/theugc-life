# theugc.life — PROPERTY_SOURCE_EVALUATION.md

Version: 1.1
Status: **Specification. EXECUTED for HBX/Hotelbeds; still open for a second
source.**

Governing contract:
[`PROPERTY_CONTENT_COVERAGE_CONTRACT.md`](PROPERTY_CONTENT_COVERAGE_CONTRACT.md)
(D060–D064). Governing decisions: D054, D055.

> ## CURRENT RUN STATUS (updated 2026-08-17)
>
> **HBX / Hotelbeds source evaluation: COMPLETE BY DIMENSION.**
>
> | | |
> |---|---|
> | Hotelbeds credentials | **VALID** |
> | Live extraction | **Bali `BAI` 3,275 records · Dubai `DXB` 835 records** |
> | Provider totals | **matched exactly on both** |
> | Inventory source | **APPROVED — Source A** |
> | Location source | **APPROVED** |
> | Media source | **APPROVED FOR TECHNICAL INTEGRATION** — production/commercial rights review pending |
> | Contact enrichment | **USEFUL / PARTIALLY SUITABLE** |
> | Canonical D060 classification | **APPROVED — through the reviewed provider-specific `categoryCode` policy (D066)** |
> | Source infrastructure (migration `0027`) | **BUILT** |
> | Cached-evaluation ingestion writer | **BUILT** — survived the real Bali/Dubai replay |
> | Production ingestion | **NOT STARTED** |
> | Multi-source COVERAGE-UNIVERSE comparison | **PENDING SECOND SOURCE** |
> | Canonical promotion into `hotels` | **NONE** |
> | Star resolver / D062 gate | **NOT STARTED** |
> | Coverage Engine | **NOT STARTED** |
> | Bali / Dubai destination coverage | **NOT COMPLETE** |
>
> **On the classification row.** It previously read *NOT APPROVED — REQUIRES
> SECONDARY VERIFICATION*. **D066 supersedes that**: canonical classification is
> theugc.life's resolved product truth backed by accepted source evidence, and one
> approved provider is sufficient when a reviewed policy maps the exact code. The
> approved mapping — `4EST`/`4LUX` → exactly four, `5EST`/`5LUX` → exactly five —
> is [`PROPERTY_SOURCE_CLASSIFICATION_POLICY.md`](PROPERTY_SOURCE_CLASSIFICATION_POLICY.md) §5.
>
> **`simpleCode` alone remains UNUSABLE as stars.** That PR #21 finding is
> unchanged and is precisely why the approved mapping reads `categoryCode`.
>
> **The pending second source is about the COVERAGE UNIVERSE** — unique inventory
> and blind-spot discovery — **not** star validation. No property needs a second
> source to be classified.
>
> Evidence, metrics and method:
> [`evaluations/PROPERTY_SOURCE_BAKEOFF_BALI_DUBAI_2026-08.md`](evaluations/PROPERTY_SOURCE_BAKEOFF_BALI_DUBAI_2026-08.md).
>
> A second source remains wanted — for unique inventory contribution, blind-spot
> discovery, cross-source overlap and stronger coverage-universe evidence. That
> is a **separate question** from whether Hotelbeds itself has demonstrated
> suitability, which it has, per dimension.
>
> ### Superseded run status — historical
>
> **(2026-08-15) ATTEMPTED, BLOCKED.** The first execution of this specification
> produced no provider measurements and no recommendation: the official
> documentation hosts and both Booking and Expedia credentials were unavailable
> in the execution environment. That state no longer holds and is retained only
> as history. The specification was unchanged by that run; nothing in it was
> found ambiguous.

---

## 1. Purpose

Decide, with evidence, which structured inventory / property-content source or
sources can supply the **coverage universe** defined in the coverage contract
§4 — and at what cost in entity-resolution burden, provenance quality and usage
constraints.

**No single global provider winner is chosen in this document**, and none is
needed. Sources are approved BY DIMENSION: a provider can be an approved
inventory, location and media source while its classification is assessed
separately — and, under D066, a provider whose code semantics genuinely do not
support standalone resolution may still receive a *requires corroboration*
verdict on that dimension alone. Booking, Expedia, Google and every other
candidate remain unevaluated live. The purpose is to make each decision defensible rather than
intuitive.

The output is a comparison, not a procurement. Contracts, pricing and licensing
negotiation are a separate concern (coverage contract §16).

---

## 2. Why an evaluation is required at all

D055 makes completeness the product promise, and the coverage contract §4 makes
completeness measurable only against a **defined coverage universe**. That
definition is the thing a provider supplies — so choosing a provider by
familiarity, price or SDK quality would be choosing the definition of "all"
without measuring it.

Two facts make a single-provider assumption unsafe:

- **A provider is not truth.** It is one set of observations about a
  destination's hospitality market.
- **No single provider is assumed complete.** Whether one is sufficient for a
  given destination is an empirical question this evaluation exists to answer.

---

## 3. Evaluation destinations

The first comparative evaluation runs against **Bali** and **Dubai**.

**Dubai** — provides overlap against existing canonical pilot research. The
30-property technical pilot is not Dubai inventory (coverage contract §3.2), but
it is real, human-researched canonical data, which makes it a usable **match-rate
probe**: how many of those 30 does each candidate source contain, identify
correctly, and describe consistently?

**Bali** — exercises a non-city destination with a potentially large and complex
hospitality universe: an island with several distinct areas, a long tail of
boutique and villa-style operations, and exactly the kind of market where two
providers are most likely to disagree about what exists.

Between them they test the two failure modes that matter: *does the source agree
with data we already trust*, and *does the source hold up where the market is
messy*.

No other destination is in scope for the first evaluation. Nothing is ingested.

---

## 4. Metrics to compare

For each candidate source, per evaluation destination:

### 4.1 Coverage

- total source properties found in destination;
- number apparently 4/5-star (per the source's own classification);
- property-type coverage — which types appear, and which are absent;
- brand coverage;
- inactive / permanently-closed property support (does the source say so at all?).

### 4.2 Field completeness

- coordinate coverage;
- star-classification coverage — **coverage of the field is not the same as
  suitability of the field**; see §8;
- address coverage;
- official website coverage;
- photo coverage;
- hero / cover image availability;
- average and median eligible photos per property, where useful.

### 4.3 Identity and resolution burden

- match rate against existing canonical / research data (the Dubai probe);
- duplicate and entity-resolution burden — how much manual review each source
  implies;
- source IDs and mapping stability — do identifiers persist across syncs?
- provenance quality — can a value be traced and justified (coverage contract
  §7.1 conditions 7 and 10)?

### 4.4 Operational

- update / incremental-sync mechanism;
- operational and API constraints (rate limits, quotas, pagination, latency);
- content and media usage constraints requiring review — licence, attribution
  obligations, redistribution limits, caching or storage restrictions.

### 4.5 Recording the metrics

Every number above is recorded **per source, per destination**, alongside the
method used to obtain it. A metric without a method is not comparable, and this
evaluation exists precisely to be argued with later.

---

## 5. Permitted conclusions — and their limits

Bali and Dubai are the **initial source-strategy bake-off**. Two destinations
cannot establish that a provider is complete for twenty.

### 5.1 What this bake-off may establish

- which provider should be **integrated first**;
- which provider is **operationally primary**;
- which providers appear **complementary**;
- adapter architecture;
- initial source-precedence proposals;
- star-field semantics (§8);
- entity-resolution behaviour;
- media and content feasibility.

### 5.2 What it may NOT establish

> **It cannot establish that one provider is complete for all twenty V1
> destinations.**

For initial implementation the permitted conclusions are:

- **PRIMARY SOURCE**
- **PRIMARY + SECONDARY SOURCE**
- **MULTI-SOURCE / UNION STRATEGY**

with one meaning fixed:

> **PRIMARY means operationally preferred — integrated first, queried first. It
> does NOT mean "assumed complete everywhere."**

### 5.3 Completeness is proven per destination

- **Every supported destination executes its own coverage run** against the
  approved source strategy. A destination inherits the strategy, never the
  completeness verdict.
- **If multiple inventory sources are approved, a destination's coverage universe
  must consider their UNION** before any completeness claim is made (coverage
  contract §4, §15.1).
- **A source that contributed no unique eligible properties in Bali or Dubai may
  still contribute unique properties elsewhere.** Two destinations are two data
  points about hospitality markets that differ by country, regulator, brand mix
  and long-tail structure; a provider strong in the Gulf may be thin in
  Southeast Asia, and neither result generalises.
- The system must therefore support **destination-level evidence rather than
  global assumption**, and must not require the same provider mix for every
  destination if later evidence shows otherwise.

> **The invariant is complete coverage, not provider uniformity.**

**Do not pre-decide the answer.** A conclusion reached before the metrics exist
is the thing this document is designed to prevent.

---

## 6. What the evaluation must NOT do

- ingest Bali or Dubai into canonical inventory;
- enrich the 30-property Dubai pilot;
- create `hotel_source_identities`, `hotel_media`, coverage-run or
  location-evidence tables;
- write provider data into `hotels`, `hotel_contacts` or any canonical entity;
- assign a hotel count target to any destination;
- choose a geocoding provider (a separate open decision);
- treat a provider's guest-review score as a star classification (coverage
  contract §2.1);
- commit real provider extracts to the repository — evaluation outputs follow the
  existing rule for real data and stay gitignored.

An evaluation that mutates canonical data is no longer an evaluation.

---

## 7. Relationship to the moat

A source can supply existence, external identity, address, coordinates, star
classification, property type, photography and basic property content.

It cannot supply researched target creator contacts, contact verification,
Hotel-Confirmed Intelligence, creator workflow or Creator Network Intelligence
(coverage contract §17, D057).

Evaluate sources on the first list. Do not credit them for the second, and do not
let a provider's generic hotel contact be scored as if it were the premium target
Marketing / PR / Partnerships contact the product sells.

---

## 8. Star semantics and provenance — required per provider

Measuring how *often* a provider populates something star-shaped says nothing
about whether that value satisfies D060. A field named `rating`,
`property_rating`, `category` or `stars` **must not be assumed** to be a
hospitality star classification.

For **every candidate provider**, for the field that appears to represent stars,
determine and record:

- exact provider field name;
- documented semantics — what the provider says the field is;
- **whether it represents a hotel/hospitality classification or something else**;
- issuer / origin when known;
- whether it is official / local-authority sourced, property-supplied,
  provider-normalized, inferred by the provider, or unclear;
- scale and allowed values (integers? halves? a 0–5 float? a lettered category?);
- refresh and update behaviour;
- what provenance is available **to us**, and whether it can be stored and cited
  (coverage contract §7.1 condition 7);
- conflicts observed against other sources on the same property.

### 8.1 The verdict is explicit

Each provider's classification field must be recorded as one of:

- **APPROVED FOR STANDALONE RESOLUTION** — a reviewed provider policy maps
  specific codes/values to an unambiguous exact classification, so this provider
  alone resolves those properties (D066);
- **UNSUITABLE**;
- **REQUIRES CORROBORATION** — the semantics do not support standalone
  resolution, so a value is usable only alongside another source.

A field that cannot be shown suitable is not usable to publish a hotel, because
a 4/5-star classification without defensible provenance fails condition 7 of the
publishability contract.

> **Amended by D066 (2026-08-17).** The middle verdict used to be *REQUIRES
> SECONDARY VERIFICATION* and was applied as a **universal** rule — every
> property needed a second, ideally official, source. That is withdrawn.
> Provenance is satisfied by a reviewed provider policy, and the verdict is now
> per-provider: a genuinely weak provider can still land in **REQUIRES
> CORROBORATION**, but that is a finding about *that provider's semantics*, not a
> default.
>
> **Current verdicts.** Hotelbeds: **APPROVED FOR STANDALONE RESOLUTION** on the
> four reviewed `categoryCode` values, with every other register unresolved
> ([`PROPERTY_SOURCE_CLASSIFICATION_POLICY.md`](PROPERTY_SOURCE_CLASSIFICATION_POLICY.md)).
> Its `simpleCode` remains **UNSUITABLE** and always will — it conflates keys,
> aparthotels, hostels and "without official category" into one number. Every
> other provider is unevaluated.

**Guest and user review scores remain prohibited** as star evidence in every
case, however the provider labels them (coverage contract §2.1). A 0–5 float that
moves when guests write reviews is a satisfaction measurement, not a
classification, and no amount of field naming changes that.

**There is no authority hierarchy to choose** (D066): a reviewed provider policy
resolves classification, and two approved providers that disagree go to REVIEW
rather than being ranked. What this section still requires is the per-provider
semantic record above. That record is what a provider's classification policy is
built from.

---

## 9. Output of this block

1. a per-source, per-destination metric table for Bali and Dubai;
2. an explicit recommendation — primary / secondary / union — with reasoning
   traceable to those metrics;
3. the open items the evaluation resolved, and those it did not;
4. **per-provider classification semantics and provenance findings (§8)**, each
   with an explicit APPROVED-FOR-STANDALONE-RESOLUTION / UNSUITABLE /
   REQUIRES-CORROBORATION verdict, and — for an approved provider — the reviewed
   code mapping that becomes its classification policy (D066). *No star-source
   authority hierarchy is produced: D066 established there is none to rank.*
5. the entity-resolution EVIDENCE dimensions observed per provider (name, domain,
   address, phone, brand, coordinate distance) and how often each is available.
   **Not a universal match threshold** — D063 §12.2 refuses to invent one, and
   this block does not;
6. licensing and usage constraints that require a decision before any production
   ingestion.

Items 4 and 5 are deliberately deferred to this block rather than guessed in the
coverage contract. They are the two places where an invented number would have
looked like a decision.

Item 2 must state its **scope honestly**: it is a recommendation for the initial
source strategy, not a completeness verdict for the twenty destinations (§5.2).
Each destination still has to prove its own coverage.
