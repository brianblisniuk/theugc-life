# theugc.life — PROPERTY_ENTITY_RESOLUTION_CONTRACT.md

Version: 1.0
Status: **Approved product contract.** Governs how pre-publication
entity-resolution EVIDENCE is generated, recorded and reviewed.

Governing decisions: **D063** (theugc.life owns canonical identity; a provider
ID is a source identity; §12.2 refuses a universal match threshold), **D062**
(promotion is publication — conditions 1 and 11 read from here), D061, D065.

---

## 1. The one question this layer answers

> **What other known property or entity could this source property be?**

It does **not** answer "should this be published?", it creates no canonical
hotel, and it decides no match. Every row it writes is `status = 'pending'`.

```
source property identity
        ↓
latest observation                    (evidence, never canonical — D065)
        ↓
candidate discovery / blocking        "is this pair worth COMPARING?"
        ↓
pair evidence                         what the evidence SAYS
        ↓
source_match_candidates               pending, always
        ↓
review manifest
        ↓
a human                               the only thing that may decide a match
```

## 2. Why there is no score

D063 §12.2 refuses a universal entity-resolution threshold, and the real
Bali/Dubai data shows why in one line. The **highest-evidence pair** in the whole
4,110-property run — name containment, domain agrees, address agrees, phone
agrees, brand agrees, 773 m apart, `agreeing_dimensions = 5` — is:

| | |
|---|---|
| A | `Al Bandar Arjaan by Rotana - Creek` |
| B | `Al Bandar Rotana - Creek` |

Two different properties in one Rotana complex. *Arjaan* is Rotana's
serviced-apartment brand. Any threshold that accepted this pair would merge them;
any threshold that rejected it would reject genuine duplicates scoring lower.

So there is no score, no confidence, no weight, no cutoff, and a test reads the
source files to prove no such comparison exists.

`agreeing_dimensions` is `GENERATED ALWAYS` in 0027 and is **descriptive**:
nothing in this codebase compares it to a number.

## 3. What blocking decides

Only: *is this pair worth comparing?*

### 3.1 The rules

| Reason | Key | Scope |
|---|---|---|
| `exact_domain` | normalised hostname | destination |
| `exact_phone` | international-form digits, non-fax | destination |
| `exact_name_in_destination` | normalised name | destination |

### 3.2 A key must IDENTIFY, not GROUP

This is the load-bearing rule, and the data forced it. Exact domain looks like a
strong anchor until you look at the distribution: **69** domains are shared by
exactly two properties — and then `oyorooms.com` by 31, `ihg.com` by 25,
`all.accor.com` by 25. Phone is the same shape: **160** numbers shared by two,
and one shared by **47**, which is a call centre.

Large keys are not weak identity evidence. They are evidence about a *different
thing* — a chain, an operator, a reservations desk. Expanding them pairwise would
bury the genuine 1:1 collisions under ~4,100 pairs of "these are both Accor
hotels".

> A key generates a candidate pair only when it selects **exactly two**
> identities in scope. A key selecting three or more is recorded as a
> **SHARED-KEY CLUSTER** for review, and never expanded.

That is a distinction between cardinalities — does this key name a property or a
group? — not a tuned constant. **Its cost is stated plainly**: a genuine
triplicate reaches a reviewer as one cluster rather than three pairs. Nothing is
hidden; it is just not pre-paired.

### 3.3 Destination scope

Keys are scoped to the destination, and a key appearing in more than one is a
**cross-destination anomaly** — surfaced, never paired. The real data holds 19,
including `ritzcarlton.com`, `raffles.com` and `marriott.com`: a Ritz-Carlton in
Bali and one in Dubai are two properties.

This does **not** assert that one physical property can never span a destination
boundary. It asserts that a shared chain asset is not the evidence that would
establish it.

## 4. Normalisation

Comparison-only. Nothing is written back; `source_property_observations` keeps
the provider's text verbatim. Conservative or nothing:

| Field | Rule | Deliberately NOT done |
|---|---|---|
| domain | lower-case, strip scheme/credentials/port/path/query, strip `www.`; must have a dot and an alphabetic TLD | subdomain stripping — `bali.chain.com` ≠ `chain.com` |
| phone | international form only (`+…` / `00…`, both peeled once); 8–15 digits | inventing a country code for a national number |
| name | case, punctuation, whitespace; exact equality, or full token containment of the shorter name (≥2 tokens) | stop-words, dropping "Hotel", similarity scoring |
| address | textual only | geocoding, abbreviation dictionaries (`Jl.` ≠ `Jalan`) |
| brand | brand code, falling back to chain code — ONE dimension | counting brand and chain as two agreements |
| coordinates | raw great-circle metres | any threshold, any bucketing |

A value that cannot be compared is `null`, and `null` equals nothing — including
another `null`. That is what keeps missing data out of the evidence as agreement
**and** out of it as disagreement.

The domain rule earns its strictness: the real Bali payload contains a `web`
value of exactly `"n"`.

## 5. Evidence semantics

0027's vocabulary, unchanged:

- `name_evidence`: `exact` | `token_containment` | `none` — ONE dimension with
  two strengths, so an exact name cannot be counted twice.
- `domain` / `address` / `phone` / `brand`: `agrees` | `differs` | `unavailable`.
- `coordinate_distance_metres`: raw, or NULL. Never converted to
  `agrees`/`differs` — there is no coordinate dimension to convert it into.
- `known_source_mapping`: only a confirmed mapping. This block confirms none, so
  it is always `false` here.

**`unavailable` is not `differs`.** In a review queue, "differs" reads as a
reason to reject; "neither side supplied an address" is not one.

## 6. `new_property` is a FINDING, never an inference

The dangerous inference in entity resolution is:

> the sweep produced no candidate → therefore this is a new property

It is not. Absence of a generated candidate is a statement about the **rules**,
not about the world, and D062 would later read a `new_property` row as
authorisation to create a canonical hotel.

So:

- the machine pipeline **never** writes a `new_property` row, at any volume;
- migration 0030 requires one to carry a `review_note` — a sweep has no
  justification to write, a reviewer does;
- the manifest's queue for these identities is called **NO MACHINE CANDIDATE**,
  and says in the output that it is not a new-property list.

In the real run, 3,600 of 4,110 identities have no machine candidate, and **zero**
`new_property` rows exist.

## 7. Review

Status vocabulary is 0027's: `pending` | `accepted` | `rejected` | `superseded`.
Every generated row is `pending`, and no code path in this repository sets any of
the other three.

`npm run source:match:review` is READ-ONLY and offers three queues:

- **CANDIDATES** — pair, both names, both destinations, why it surfaced, every
  evidence dimension, the raw distance, the descriptive count;
- **NO MACHINE CANDIDATE** — see §6;
- **ANOMALIES** — shared-key clusters and cross-destination collisions.

Re-running candidate generation refreshes evidence only on rows that are still
`pending`. Rewriting evidence under a decision a human already made would make
that decision look as though it rested on facts that were not in front of them.

## 8. Idempotency

Migration 0030 adds partial unique indexes so a candidate pair is **one row**,
keyed on the pair rather than on the reason it surfaced: a pair found by both
domain and phone is one candidate carrying both reasons in `match_method`, not
two candidates for a reviewer to decide twice.

## 9. Not in this layer

Lifecycle · D062 preview or apply · promotion · canonical hotels ·
`hotel_source_identities` · terminal `resolution_state` transitions ·
Coverage Engine · Provider B · production ingestion · media · contacts ·
numeric match confidence · automatic thresholds · LLM or embedding decisions.
