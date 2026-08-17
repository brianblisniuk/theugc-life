# theugc.life — PROPERTY_SOURCE_HOSPITALITY_SCOPE_POLICY.md

Version: 1.0
Status: **Approved product contract.** Governs how a provider accommodation type
becomes a resolved PHYSICAL-HOSPITALITY fact.

Governing decisions: **D060** (V1 scope is a physical hospitality property with
an exact 4/5 classification — and **property type alone does not decide
eligibility**), **D062** (promotion is publication), D063 (source-agnostic
canonical identity), D065 (source data is isolated and never canonical by
default), **D066** (the method: canonical truth resolved from a reviewed
provider policy, reviewed once per provider/field/code).

---

## 1. What this dimension answers, and what it does not

```
provider observation           source evidence, never canonical (D065)
        ↓
REVIEWED PROVIDER POLICY       this document — one review per provider,
        ↓                       not one per property
scope resolver                 physical_hospitality | not_physical_hospitality
        ↓                                          | unresolved
one INPUT to the future D062 gate
```

It answers exactly one question: **is this candidate a physical hospitality
property?**

It is **not** V1 eligibility, and nothing in migration 0029 says `eligible`,
`publishable`, `promoted` or `resolved_eligible`. The V1 gate is a conjunction
composed later, at the D062 preview:

> physical hospitality property **AND** resolved exact 4/5 hospitality
> classification **AND** supported destination

So, concretely:

| Scope | Star | Result of THIS block |
|---|---|---|
| `physical_hospitality` | 3-star | resolved on both dimensions; **not eligible** |
| `physical_hospitality` | exact 5 | resolved on both dimensions; **still not published here** |
| `unresolved` | exact 5 | a **HOLD** for D062 — not an exclusion |
| `not_physical_hospitality` | exact 5 | a finding; D062 composes it |

This is also **not a hotel-type whitelist standing in for D060**. `S` Hostel is
mapped `physical_hospitality` even though a hostel will rarely carry an approved
4/5 classification, because D060 says type alone is not the gate and the two
dimensions are resolved independently. Excluding it here would smuggle a
classification judgement into a type resolver.

## 2. Outcomes

| Outcome | Meaning |
|---|---|
| `physical_hospitality` | the provider's reviewed master denotes a physical hospitality establishment |
| `not_physical_hospitality` | the provider's reviewed master denotes something that is not one |
| `unresolved` | semantics not established, or ambiguous |

`unresolved` is the default and the safe state. It means REVIEW, and it is
explicitly **not** the same fact as `not_physical_hospitality`.

## 3. Approval rules

1. **The code is the unit, not the property.** Reviewed once, applied to every
   property carrying that type.
2. **Versioned and frozen.** Changing any mapping is a NEW version; migration
   0029 enforces that in the database, not by convention.
3. **Evidence-bound, and the evidence is the PROVIDER's.** A code may only be
   mapped when the provider's own reviewed master semantics establish it. D060's
   enumeration of qualifying forms says which KINDS of property may qualify; it
   is not evidence about what a given provider code means, and it must never be
   used to complete a master description that does not say. Absent provider
   semantics: `unresolved`.
4. **The line is BUSINESS vs DWELLING.** Map to `physical_hospitality` only when
   the master's wording names an accommodation BUSINESS — a place operated to
   host guests. A label proving that a unit is accommodation does **not** prove
   there is a hospitality OPERATION behind it.
5. **No inference from anything else.** Not from the property name, guest rating,
   star category, price, chain, website, contacts or photos. This resolver reads
   `accommodationTypeCode` and nothing else.

## 4. Evidence

The Hotelbeds accommodations master, retrieved to exhaustion in PR #21
(`exhaustionProven: true`, 24 codes), plus the live Bali/Dubai type
distributions from the same evaluation. `accommodationTypeCode` is present on
**100% of the 4,110 properties** in that dataset and is persisted by 0027's
ingestion as `source_property_type_code`.

No provider call was made for this block, and no country legislation was
researched: the unit of review is provider + field + code, as D066 established.

---

## 5. Hotelbeds — hospitality-scope policy v1

Provider: `hotelbeds` · Field: `accommodationTypeCode` ·
Version: `hotelbeds-hospitality-scope/1`

### 5.1 The full 24-code master, and the decision for each

Counts are from the cached Bali/Dubai evaluation (4,110 properties).

| Code | Master description | Bali | Dubai | e4 | e5 | Decision |
|---|---|---:|---:|---:|---:|---|
| `H` | Hotel | 2614 | 717 | 753 | 475 | `physical_hospitality` |
| `W` | Resort | 163 | 4 | 70 | 57 | `physical_hospitality` |
| `G` | Guest house | 164 | 0 | 3 | 0 | `physical_hospitality` |
| `K` | Bed and breakfast | 126 | 0 | 4 | 0 | `physical_hospitality` |
| `P` | Aparthotel | 5 | 55 | 3 | 5 | `physical_hospitality` |
| `S` | Hostel | 25 | 1 | 2 | 0 | `physical_hospitality` |
| `D` | Lodge | 8 | 1 | 1 | 1 | `physical_hospitality` |
| `M` | Motel | 2 | 0 | 0 | 0 | `physical_hospitality` |
| `Z` | Rural hotel | 0 | 0 | 0 | 0 | `physical_hospitality` |
| `X` | Historical hotel Luxurious | 0 | 0 | 0 | 0 | `physical_hospitality` |
| `U` | Cruise | 0 | 0 | 0 | 0 | `not_physical_hospitality` |
| `L` | Boat | 0 | 0 | 0 | 0 | `not_physical_hospitality` |
| `V` | Vacation home or villa | 137 | 4 | 8 | 3 | **`unresolved`** |
| `A` | Apartment | 7 | 46 | 5 | 1 | **`unresolved`** |
| `C` | Vacation condo or apartment | 0 | 4 | 0 | 0 | **`unresolved`** |
| `N` | Residence | 1 | 1 | 0 | 1 | **`unresolved`** |
| `B` | Botel | 0 | 1 | 0 | 1 | **`unresolved`** |
| `R` | Vacation resort | 1 | 0 | 1 | 0 | **`unresolved`** |
| `Q` | Boutique | 22 | 1 | 3 | 2 | **`unresolved`** |
| `T` | Vacation Townhouse | 0 | 0 | 0 | 0 | **`unresolved`** |
| `Y` | Rural house | 0 | 0 | 0 | 0 | **`unresolved`** |
| `E` | Camping | 0 | 0 | 0 | 0 | **`unresolved`** |
| `I` | Riad | 0 | 0 | 0 | 0 | **`unresolved`** |
| `O` | Pousada | 0 | 0 | 0 | 0 | **`unresolved`** |
| | **total** | **3275** | **835** | **853** | **546** | |

10 mapped in scope, 2 mapped out, 12 deliberately unresolved. All 24 accounted
for.

### 5.2 Why the ten are approved

Each names an operated accommodation establishment in the provider's own
register, or contains one:

- `H`, `Z`, `X`, `P`, `M` — the word itself is *hotel* / *aparthotel* / *motel*.
  `P` Aparthotel is additionally named by D060 ("aparthotel / hotel apartment").
- `W` Resort, `G` Guest house, `K` Bed and breakfast, `S` Hostel, `D` Lodge —
  plain-English establishment nouns. `D` Lodge is named by D060.

### 5.3 Why the two are excluded

`U` Cruise and `L` Boat name a vessel or an itinerary rather than a property. No
reading of D060's "physical hospitality property" admits them, so unlike the
unresolved set these are a positive finding.

### 5.4 Why the twelve stay unresolved

Grouped by *why*, because the reasons differ:

**A dwelling, not evidently an operation** — the label proves the unit is
accommodation; it does not establish that a hospitality business runs it, and
this master does not settle the difference:
`A` Apartment · `V` Vacation home or villa · `C` Vacation condo or apartment ·
`T` Vacation Townhouse · `Y` Rural house

> `V` and `A` are the largest unresolved groups (141 and 53), and between them
> hold 17 of the exact-4/5 candidates whose scope is unresolved. That is the
> honest position: a five-star villa in Bali may well be a hospitality operation,
> and this policy does not yet know.

**The provider's own "Vacation *" register** — `R` Vacation resort sits inside a
prefix family that otherwise denotes self-catering rentals, so "resort" inside it
does not clearly mean an operated resort. 1 property, exact_four.

**An operation, but not evidently a fixed physical property** — `B` Botel (a
floating hotel) and `E` Camping (an operated site). 1 botel in Dubai, carrying
`5EST`.

**Not established for this provider by the master alone** — `I` Riad and
`O` Pousada are regional words that usually denote an operated guesthouse or inn,
but nothing in this repository establishes that reading for this provider. 0
properties in the evaluation.

**`Q` Boutique — a bare adjective, and the rule tested honestly.** D060 says a
*boutique hotel* may qualify. That is a product rule about a FORM OF PROPERTY; it
is not evidence about what **this provider** means by a code whose entire master
label is "Boutique". Rule 3 says a code may only be mapped when the provider's own
reviewed semantics establish it, and completing the master's missing noun from our
own contract is exactly the inference that rule forbids — the same way `SUP`
("SUPERIOR 4\*") stays unresolved in the classification policy despite naming a
star count. 23 properties, 5 of them exact-4/5, all now holds. D060's generic
statement is unchanged and unaffected; it simply does not decide this code.

**`N` Residence — the closest call, and the first candidate for v2.** D060
explicitly allows a "residence" form, and 1 Dubai property carries `N` with
`5EST`. It stays unresolved because the bare label does not distinguish a
*serviced residence* — a hospitality operation — from a residential building let
by its owner. Approving it is a one-line new version with a reviewer's name on
it, exactly as `SUP` is for the classification policy.

### 5.5 What this does NOT change

The classification policy is untouched. A property's accommodation type neither
admits nor excludes it on stars, and the reverse holds too — the Dubai evaluation
already contains Apartment × "4 STARS" and Aparthotel × "5 STARS", and both
dimensions resolve independently on the same candidate.

## 6. Other providers

No other provider has an approved hospitality-scope policy. Each must be reviewed
the same way: field, codes, semantics, evidence, version. A new provider is rows
in `provider_hospitality_scope_policies` and
`provider_hospitality_scope_policy_mappings` — **no canonical schema change, and
no global accommodation-type enum**.

## 7. Where this policy is enforced

Migration `0029_prepublication_hospitality_scope.sql` carries §5.1 as DATA, keyed
by provider, version and field, and a trigger checks every scope revision against
it: the outcome must be the one the approved mapping reaches, an unmapped code
can resolve only to `unresolved`, the policy must belong to the observation's own
provider, and it must be **approved** rather than a draft. Once approved, the
field and the complete mapping set are immutable — a semantic change requires a
new version. A parity test fails if this table and
`scripts/provider-scope/hotelbeds.ts` ever drift.

## 8. Not implemented here

Lifecycle resolution (D062 condition 4 — see
[`PROPERTY_CONTENT_IMPLEMENTATION_SPEC.md`](PROPERTY_CONTENT_IMPLEMENTATION_SPEC.md)
§21.4), entity matching, review manifest, the D062 preview or apply, promotion,
Coverage Engine. This document is the product contract those will implement
against.
