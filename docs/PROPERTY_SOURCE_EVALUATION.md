# theugc.life — PROPERTY_SOURCE_EVALUATION.md

Version: 1.0
Status: **Specification for the NEXT block.** Nothing here has been run, and no
provider has been chosen.

Governing contract:
[`PROPERTY_CONTENT_COVERAGE_CONTRACT.md`](PROPERTY_CONTENT_COVERAGE_CONTRACT.md)
(D060–D064). Governing decisions: D054, D055.

---

## 1. Purpose

Decide, with evidence, which structured inventory / property-content source or
sources can supply the **coverage universe** defined in the coverage contract
§4 — and at what cost in entity-resolution burden, provenance quality and usage
constraints.

**No provider winner is chosen in this document.** Booking, Expedia, Google and
every other candidate are explicitly unchosen. The purpose of the evaluation is
to make the choice defensible rather than intuitive.

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
- star-classification coverage;
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

## 5. Permitted conclusions

The bake-off may legitimately conclude any of:

- **one provider is primary** — sufficient alone for V1 destinations;
- **one is primary and another secondary** — a fallback or gap-filler;
- **a union of providers is necessary** — the coverage universe genuinely
  requires more than one source, which the source-identity architecture
  (coverage contract §11) already supports.

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

## 8. Output of this block

1. a per-source, per-destination metric table for Bali and Dubai;
2. an explicit recommendation — primary / secondary / union — with reasoning
   traceable to those metrics;
3. the open items the evaluation resolved, and those it did not;
4. a proposed star-source authority hierarchy, now that real source behaviour is
   known (coverage contract §8);
5. a proposed entity-resolution threshold policy, for the same reason (coverage
   contract §12.2);
6. licensing and usage constraints that require a decision before any production
   ingestion.

Items 4 and 5 are deliberately deferred to this block rather than guessed in the
coverage contract. They are the two places where an invented number would have
looked like a decision.
