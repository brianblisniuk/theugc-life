# theugc.life — PROPERTY_SOURCE_CLASSIFICATION_POLICY.md

Version: 1.0
Status: **Approved product contract.** Governs how a provider observation becomes
a canonical D060 classification.

Governing decisions: **D060** (V1 scope is exactly 4 or exactly 5),
**D066** (canonical is product truth, resolved from an approved provider policy),
D062 (promotion is publication), D063 (source-agnostic canonical identity),
D065 (source data is isolated and never canonical by default).

---

## 1. The pipeline

```
provider observation          source evidence, never canonical (D065)
        ↓
REVIEWED PROVIDER POLICY      this document — one review per provider,
        ↓                      not one per property
star resolver (future)        owns canonical truth; cites the observation
        ↓
canonical product classification + provenance
```

A provider never declares itself canonical. The policy is **ours**; the provider
only supplies a code.

## 2. What a policy must produce

For a given provider, field and code, exactly one outcome:

| Outcome | Meaning |
|---|---|
| `exact_four` | unambiguous hospitality classification of **exactly 4** |
| `exact_five` | unambiguous hospitality classification of **exactly 5** |
| `classified_not_v1_scope` | a real classification that is **not** exactly 4 or 5 (3, 3.5, 4.5 …) |
| `unresolved` | semantics not established, ambiguous, or a different classification system |

`unresolved` is the default and the safe state. It means REVIEW, and it is
explicitly **not** the same fact as "below scope" (D061 §9).

## 3. Approval rules

1. **The code is the unit, not the property.** A policy entry is reviewed once
   and applies to every property carrying that code.
2. **Versioned.** A policy has a version; changing a mapping is a new version, so
   a resolution can always name the policy that produced it.
3. **Evidence-bound.** A code may only be mapped when its semantics are
   established by reviewed evidence already in the repository. Absent that,
   `unresolved` — never a guess.
4. **One classification system at a time.** KEYS are not STARS. Aparthotel
   categories are not hotel stars. A different register is a different system
   even when both count to five.
5. **No aggregate field may drive the outcome.** For Hotelbeds specifically,
   `simpleCode` must never resolve a classification (§5).
6. **Half-star classifications are real and are not 4 or 5.** `4 STARS AND A
   HALF` is `classified_not_v1_scope`, never rounded into scope.

## 4. Evidence standard

A single approved provider is sufficient (D066). What is required is not a second
source but a **reviewed mapping**: the provider's own published semantics for that
code, checked against the master data we retrieved, recorded here.

Optional, never required: government or tourism registries, hotel-owned evidence,
a second provider. These are how a **conflict** gets resolved, not how a normal
property gets classified.

---

## 5. Hotelbeds — provider classification policy v1

**Approved** for D060 resolution **only** through the explicit code mapping below.

Field: `categoryCode` on the hotels payload, resolved through the categories
master. **Not** `simpleCode`, **not** `categoryGroupCode`, **not** the free-text
description.

Evidence: the 65-code categories master retrieved and reviewed in PR #21
(`docs/evaluations/PROPERTY_SOURCE_BAKEOFF_BALI_DUBAI_2026-08.md`), plus the live
Bali/Dubai category distributions from the same evaluation.

### 5.1 Approved mappings

| `categoryCode` | Master description | Outcome |
|---|---|---|
| `4EST` | 4 STARS | `exact_four` |
| `4LUX` | 4 STARS LUXURY | `exact_four` |
| `5EST` | 5 STARS | `exact_five` |
| `5LUX` | 5 STARS LUXURY | `exact_five` |

Four codes. Each states a plain hotel star count in the provider's own master,
in the star groups (`GRUPO4` / `GRUPO5`), with no competing register.

`4LUX` and `5LUX` add a luxury qualifier **within** a star level rather than
moving between levels — the master encodes half-steps separately (`H4_5`,
`H5_5`), which is what makes "luxury" a sub-grade rather than an increment.

### 5.2 Classified, but not V1 scope

Real classifications that are not exactly 4 or 5, so a property carrying them is
**out of V1 scope with a durable reason** rather than unresolved:

`1EST` · `2EST` · `3EST` (1, 2, 3 STARS) · `H1_5` · `H2_5` · `H3_5` · `H4_5` ·
`H5_5` (half-star levels, including 4.5 and 5.5) · `H2S` · `H3S` (superior 2*/3*)

> `H4_5` and `H5_5` are the codes most likely to be coerced into scope by a
> careless mapping. They are **not** 4 or 5. Four-and-a-half stars is a real
> classification that D060 excludes, and rounding it is exactly the failure the
> "never average" rule exists to prevent.

### 5.3 Deliberately UNRESOLVED

Everything else. Grouped by *why*, because the reasons differ:

**A different classification register (not hotel stars):**
`1LL` `2LL` `3LL` `4LL` `5LL` (KEYS) · `APTH` `APTH2` `APTH3` `APTH4` `APTH5`
(aparthotel categories) · `AT1` `AT2` `AT3` (apartment 1st/2nd/3rd category) ·
`BB` `BB3` `BB4` `BB5` (bed & breakfast) · `HS` `HS2` `HS3` `HS4` `HS5` (hostel) ·
`HSR1` `HSR2` (rural hostel) · `ALBER` `PENSI` `CHUES` (hostel / boarding /
guest house) · `CAMP1` `CAMP2` (camping)

**Rural-hotel register** — a separate national scheme whose scale we have not
established as equivalent to the ordinary hotel scale:
`HR` `HR2` `HR3` `HR4` `HR5` `HRS`

**Property-type labels carrying no star count:**
`VILLA` · `RSORT` · `BOU` · `POUSA` · `AG` · `LODGE` · `RESID` · `VTV` · `HIST`

**Explicitly absent or unknown:**
`SPC` (WITHOUT OFFICIAL CATEGORY) · `PENDI` (PENDING CATEGORY) · `0` · `2` · `3`
(no description in the master) · `STD` (STANDARD — no scale stated)

> **`HIST`** deserves naming. "HISTORICAL HOTEL LUXURIOUS" carries
> `simpleCode = 5` while sitting in `GRUPO4`, and its description states no star
> count at all. Three signals, two of them contradictory, none of them a star
> classification. Unresolved.

> **`SUP`** ("SUPERIOR 4\*", `simpleCode 4`, `GRUPO4`) is the closest call left
> unresolved. Its description names 4\*, and the master encodes 4.5 separately as
> `H4_5`, which argues "superior" is a sub-grade like `4LUX`. It is left
> unresolved because no reviewed evidence in this repository establishes that
> reading, and D066 requires a mapping to rest on evidence rather than on a
> plausible argument. **It is the first candidate for policy v2**, and approving
> it is a one-line change with a reviewer's name on it.

### 5.4 What this does NOT change

The PR #21 finding stands, unamended:

> **`simpleCode` alone is NOT usable as stars.**
> `simpleCode 5` covers `5EST` (5 STARS), `5LL` (5 KEYS), `APTH5`, `BB5`, `HS5`
> and `HIST`. `simpleCode 4` covers `VILLA`, `BOU`, `RSORT`, `AT1`, `SUP` and
> `4EST`. `simpleCode 3` covers `SPC` — "WITHOUT OFFICIAL CATEGORY".

The mapping above is on `categoryCode`, which is why the finding is preserved
rather than contradicted. `where simple_code >= 4` remains the query that must
never produce inventory, and `source_classification_simple_code` remains **text**
in the database so it cannot be compared numerically by accident.

A STAR-labelled category also still does not imply a hotel *type* — Dubai returns
Apartment × "4 STARS" and Aparthotel × "5 STARS". Under D060 and D066 property
type neither admits nor excludes; physical hospitality scope is resolved
separately, and the codes in §5.1 are the hotel-star register regardless of the
`accommodationTypeCode` beside them.

### 5.5 Coverage is a separate question

This policy resolves **classification**. It says nothing about whether Hotelbeds
lists every property in a destination. Coverage-universe completeness remains
open and is answered by adding sources and de-duplicating identities, not by
re-checking stars.

---

## 6. Other providers

No other provider has an approved classification policy. Booking, Expedia and
Nuitee remain `unresolved` for every code until each is reviewed the same way:
field, codes, semantics, evidence, version.

## 7. Not implemented here

The star resolver, `source_property_star_resolutions`, the D062 gate, promotion,
Coverage Engine. This document is the product contract those will implement
against.
