# Property-source bake-off — Bali & Dubai

Date: **2026-08-15**
Governing contract: [`PROPERTY_CONTENT_COVERAGE_CONTRACT.md`](../PROPERTY_CONTENT_COVERAGE_CONTRACT.md) (D060–D064)
Specification: [`PROPERTY_SOURCE_EVALUATION.md`](../PROPERTY_SOURCE_EVALUATION.md)

> ## STATUS: BLOCKED ON LIVE PROVIDER ACCESS
>
> **No provider was measured. No provider is recommended. No star verdict is
> issued.**
>
> Both provider credentials and — decisively — the official documentation
> required to make any capability claim were unavailable in the environment this
> block ran in. Under §3 of the brief (official sources only) and §18 (no winner
> without live evidence), the honest output is an evaluation-readiness
> deliverable, not a bake-off.
>
> This document therefore contains an **empty section A and an empty section B**.
> That is the finding, stated plainly rather than padded.

---

## How to read this document

Four sections, never mixed:

| | Meaning |
|---|---|
| **A. VERIFIED FROM OFFICIAL DOCUMENTATION** | Read from the provider's own developer site, with URL and access date |
| **B. MEASURED FROM LIVE API** | Produced by running the harness against the provider |
| **C. INFERENCE / RECOMMENDATION** | Our reasoning, clearly marked as reasoning |
| **D. BLOCKED / UNKNOWN** | What could not be established, and exactly why |

---

## A. VERIFIED FROM OFFICIAL DOCUMENTATION

**EMPTY.**

Nothing in this report is sourced from provider documentation, because none was
reachable. Every official documentation domain required by brief §3 was blocked
by this environment's network egress proxy, which answered **HTTP 403 to
CONNECT**:

| Host | Purpose | Result |
|---|---|---|
| `developers.booking.com` | Booking capability claims (brief §3) | 403 CONNECT — blocked |
| `developers.expediagroup.com` | Expedia capability claims (brief §3) | 403 CONNECT — blocked |
| `developers.google.com` | Google Places terms/policies (brief §3, §19) | 403 CONNECT — blocked |
| `demandapi.booking.com` | Booking API host | 403 CONNECT — blocked |
| `api.ean.com` | Expedia Rapid API host | 403 CONNECT — blocked |

Verified by `curl` and by the fetch tool, twice, roughly two hours apart
(12:52 UTC and 15:31 UTC on 2026-08-15). The proxy's own diagnostic endpoint
recorded each denial as `connect_rejected — gateway answered 403 to CONNECT
(policy denial or upstream failure)`. These are policy denials, not transient
failures.

**Why this section was not filled in from knowledge.** Both APIs are widely
documented and a plausible-looking field map could have been written from
recollection. It would have been wrong in the worst available way: guessed field
paths do not crash, they read `undefined`, and the harness would have reported
"coordinate coverage 0%, star coverage 0%" for providers that supply both. That
output is indistinguishable from a measurement and would have been used to choose
a provider. Brief §3 restricts capability claims to official sources precisely to
prevent this, and §17 forbids turning missing access into guessed data.

---

## B. MEASURED FROM LIVE API

**EMPTY. No provider API was called.**

| Metric group | Booking | Expedia |
|---|---|---|
| Inventory counts (Bali) | NOT RUN — ACCESS REQUIRED | NOT RUN — ACCESS REQUIRED |
| Inventory counts (Dubai) | NOT RUN — ACCESS REQUIRED | NOT RUN — ACCESS REQUIRED |
| Star distribution + suitability | NOT RUN — ACCESS REQUIRED | NOT RUN — ACCESS REQUIRED |
| Coordinate coverage | NOT RUN — ACCESS REQUIRED | NOT RUN — ACCESS REQUIRED |
| Address / website / brand coverage | NOT RUN — ACCESS REQUIRED | NOT RUN — ACCESS REQUIRED |
| Photo + hero coverage, photos per property | NOT RUN — ACCESS REQUIRED | NOT RUN — ACCESS REQUIRED |
| Property-type distribution | NOT RUN — ACCESS REQUIRED | NOT RUN — ACCESS REQUIRED |
| Pagination / exhaustion evidence | NOT RUN — ACCESS REQUIRED | NOT RUN — ACCESS REQUIRED |
| Cross-source overlap | NOT RUN — BOTH PROVIDERS REQUIRED | NOT RUN — BOTH PROVIDERS REQUIRED |
| Dubai 30-property probe | NOT RUN — ACCESS REQUIRED | NOT RUN — ACCESS REQUIRED |

### Credential status (presence only)

| Variable | Status |
|---|---|
| `BOOKING_DEMAND_API_TOKEN` | **NOT AVAILABLE** |
| `BOOKING_AFFILIATE_ID` | **NOT AVAILABLE** |
| `EXPEDIA_RAPID_API_KEY` | **NOT AVAILABLE** |
| `EXPEDIA_RAPID_SHARED_SECRET` | **NOT AVAILABLE** |

No credential value was read, printed, logged or stored at any point.

### The one thing that WAS measured

The Dubai pilot probe **input** was built from the local, gitignored Sprint 1C
workbook — no provider and no production database involved:

| Field | Coverage across the 30 pilot entries |
|---|---|
| Name | 30 / 30 |
| Address | 30 / 30 |
| Website | 30 / 30 |
| Star value (research-supplied, provenance not established) | 30 / 30 |
| **Coordinates** | **0 / 30** |

This is a real and load-bearing finding — see §D.5.

---

## C. INFERENCE / RECOMMENDATION

Everything below is reasoning, not evidence.

### C.1 No source-strategy recommendation is defensible

Brief §18 is explicit, and it binds here: with neither provider run, **no
provider winner exists**. Not "Booking pending confirmation", not "Expedia
likely" — nothing. A recommendation formed now would be a preference dressed as a
finding, and it would be quoted later as the outcome of a bake-off that never
happened.

### C.2 What the environment blocker actually means

This is not simply "we lacked API keys". Keys alone would not have been enough:
without official documentation, the harness could not have been pointed at the
right endpoint, paginated correctly, or read a single field with confidence.

The two blockers are therefore ordered, not parallel:

1. **Documentation access** — without it, no adapter can be written at all.
2. **Credentials** — without them, a written adapter cannot be executed.

Fixing (2) without (1) unblocks nothing.

### C.3 Why the harness ships anyway

Everything that does **not** depend on provider schemas is built and tested:
exhaustive pagination with honest exhaustion proof, field-map-driven
normalization, the star/review-score separation, the metric suite, cross-source
overlap analysis, secret redaction, gitignored artifacts, and the Dubai probe
input builder. 35 deterministic tests over hand-written synthetic fixtures.

When access exists, the remaining work is filling in two descriptors from
official documentation and running one command — not building an evaluation.

### C.4 The star question is the one to protect

D060's hard part is not measuring how *often* a star field is populated; it is
establishing what that field *means*. The harness enforces this structurally:
`starKindsAcceptedAsD060Evidence` starts empty, so **every** star value is
treated as unresolved until a qualifier value is explicitly accepted from
documentation. A star field with an unrecognised kind counts as `unknownStar`,
never as a lower band — because under D061 "classification unknown" and
"confirmed 3-star" are different facts, and collapsing them silently deletes
eligible properties.

The verdict is allowed to be per-destination. If a provider carries
authority-issued classifications in the UAE and its own normalisation in
Indonesia, that is two findings, and forcing one global verdict would hide
exactly the thing worth knowing.

---

## D. BLOCKED / UNKNOWN

### D.1 Booking.com Demand API — NOT EVALUATED

Descriptor: `scripts/provider-evaluation/adapters/booking.ts`, status
`unverified`, all fields empty, blockers recorded in the file. It carries a
numbered checklist for completion from official documentation.

Blocked on: `developers.booking.com` (403), `demandapi.booking.com` (403),
`BOOKING_DEMAND_API_TOKEN` (NOT AVAILABLE), `BOOKING_AFFILIATE_ID` (NOT AVAILABLE).

Unanswered, and required: the static property-content enumeration path (brief §4A
is emphatic that an availability/search endpoint must not define a coverage
universe); pagination and any documented hard cap; the star value field, its
qualifier field, that qualifier's allowed values and their meanings; whether
per-value provenance can be stored and cited; photo metadata and storage terms.

### D.2 Expedia Rapid — NOT EVALUATED

Descriptor: `scripts/provider-evaluation/adapters/expedia.ts`, status
`unverified`, same structure and checklist.

Blocked on: `developers.expediagroup.com` (403), `api.ean.com` (403),
`EXPEDIA_RAPID_API_KEY` (NOT AVAILABLE), `EXPEDIA_RAPID_SHARED_SECRET` (NOT
AVAILABLE).

Unanswered, and required: the content/catalog and geography endpoints; chunking
or pagination for large content payloads; the property rating field and — the
decisive question — how the provider distinguishes a rating originating from a
local star authority from one it assigns itself, **measured separately in Bali
and Dubai**; image metadata, hero indication, and content usage constraints.

### D.3 Provider geography for Bali and Dubai — NOT RESOLVED

Brief §9 forbids assuming `Bali = city` and forbids querying a handful of
well-known towns and calling the union "Bali". Resolving this requires each
provider's geography documentation, which was unreachable.

`AdapterDescriptor.geography` records the resolution explicitly — entity kind,
entity ids, method, whether a union is required, and caveats — and the
runnability gate refuses to run while it is empty. **No geography was assumed.**

### D.4 Google Places — POLICY ASSESSMENT NOT PERFORMED

`developers.google.com` was blocked, so no persistent-storage rule, Place ID
retention rule, photo attribution requirement or display constraint was read, and
none is asserted here.

Two things are nonetheless settled by our own contract and need no external
source:

- **A Google user rating is never D060 star evidence.** It is a guest-satisfaction
  score. The prohibition is D060/§2.1 and does not depend on Google's terms.
- **Google is not a candidate inventory backbone in this bake-off.** Its potential
  role is identity cross-check, Place ID mapping and location QA (brief §5).

Whether any Google-derived field may be *persisted* in our source-identity
architecture is **UNKNOWN and unresolved**, and must be read from the official
terms before any such field is stored. If those terms turn out to be incompatible
with persistent canonical storage, that is recorded as a product constraint, not
engineered around.

### D.5 Dubai 30-property probe — INPUT AVAILABLE, EXECUTION BLOCKED

**Input: AVAILABLE.** The pilot workbook is present locally and gitignored, and
`npm run eval:sources:pilot-probe` builds a 30-entry probe input under `.data/`.
Production Supabase was **not** contacted and the 30 canonical rows were **not**
read or modified.

**Execution: BLOCKED** — a probe needs a provider to probe against.

**Finding that does not depend on any provider: 0 of 30 pilot entries carry
coordinates.** Two consequences:

1. **Coordinate agreement cannot be measured** in this probe even once providers
   are reachable. Matching will lean on name plus website domain and address,
   which is weaker; and coordinate *comparison* — the strongest available
   identity signal — will only become possible after the pilot is enriched.
2. **It corroborates the D054/D062 compliance gap** already flagged in the
   contract block. These rows are in `hotels` — i.e. published — and canonical
   coordinates are a publishability condition. The pilot predates D054/D060/D062
   and is explicitly not grandfathered (backlog 7.6). This is now measured rather
   than asserted.

Star values are present on all 30 entries, but they are research-supplied and
carry **no established provenance**, so they do not satisfy D060 condition 7 as
they stand.

### D.6 Cross-source overlap — NOT RUN

Requires both providers. The analysis is implemented and tested
(`overlap.ts`): two agreeing independent signals for high confidence, one signal
is ambiguous, and a coordinate contradiction beyond 2 km vetoes a match outright.
Deliberately **no numeric match threshold is proposed** — D063 defers that until
real source behaviour is observed, and a number invented here would later read as
a decision.

### D.7 Access and licensing questions still open

- Booking Demand API access level required for static property content, and its
  commercial terms.
- Expedia Rapid access level required for property content and geography.
- Content and media usage rights for both: caching, storage, redistribution and
  attribution — **unresolved, and a precondition for storing any provider image**
  (D064).
- Whether either provider's star field can be stored *with citable provenance*,
  which is publishability condition 7 (D062) and not merely a data-quality
  preference.
- Google Places persistent-storage compatibility (D.4).

---

## What this block delivered

- A complete, tested, provider-agnostic evaluation harness
  (`scripts/provider-evaluation/`, 35 tests).
- A **runnability gate** that refuses to execute an unverified descriptor, so
  this evaluation cannot later be completed carelessly and produce numbers that
  look measured.
- Two provider descriptors, honestly empty, each with a completion checklist.
- The Dubai probe input builder, plus one measured finding (0/30 coordinates).
- Gitignored artifact handling and secret redaction, both tested.
- This report.

## Exact next action

**Unblock network egress to the official documentation hosts** —
`developers.booking.com`, `developers.expediagroup.com`, `developers.google.com`
— then complete the two descriptors from those docs. Credentials are required
only for the run that follows.

Nothing else in this block can proceed first, and the Coverage Engine must not
start until it has: a source strategy chosen on evidence, a star-suitability
verdict per provider per destination, and resolved provider geography for Bali
and Dubai.
