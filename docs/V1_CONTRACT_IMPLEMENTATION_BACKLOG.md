# V1 Contract — Implementation Backlog

Scope of the **next technical PR**. Nothing here is implemented yet; this file
exists so that PR starts from an unambiguous list rather than a re-reading of
the decision log.

Produced during the pre-Sprint-3 product contract sync, after the owner approved
D049–D056. Every item below is production code or test code that contradicts one
of those decisions, or a gap the decisions created.

> **Status: §1, §2 and §6 are DONE** — delivered by the V1 Premium Intelligence
> PR (migration `0026`, D057–D059). They are kept below, struck through, as the
> record of what was corrected. §4, §5, §7 and §8 remain open for later blocks.
>
> **§7 and §8 now have a governing contract.** The Property Content & Destination
> Coverage block (D060–D064,
> [`PROPERTY_CONTENT_COVERAGE_CONTRACT.md`](PROPERTY_CONTENT_COVERAGE_CONTRACT.md))
> decided *what* those items must satisfy. It changed no code, so every row below
> is still open work.

Governing decisions: **D049** (one canonical inventory, no "premium hotels"),
**D050** (Public + Premium Intelligence, identical privacy), **D051**
(Destination Pass $39 / 30 days), **D052** (Pro $199/year), **D053** (Archivo),
**D054** (100% map coverage of publishable inventory), **D055** (destination
inventory complete, not capped), **D056** (Destination Pass workflow scope).

---

## 1. Stale commercial copy and configuration — ✅ DONE

| # | File | Current | Required |
|---|---|---|---|
| 1.1 | `src/lib/config.ts:33` | `durationDays: 90` under `PRICING.destinationPass` | `30` (D051) |
| 1.2 | `src/lib/config.ts:31` | comment `// PRD §5.2: USD 29–39, 90-day access. Price must be configurable.` | Cite the fixed V1 contract: USD 39 / 30 days / one destination (D051), still configurable |
| 1.3 | `src/lib/config.ts:36` | comment `// PRD §5.3 / D005: reference 299, launch 199, later 249.` | Note that 199 is the **fixed V1 launch price** (D052); 299/249 remain future hypotheses |
| 1.4 | `src/app/(public)/pricing/page.tsx:36` | "Premium hotels, contacts, and intelligence for one destination." | Must not say *premium hotels* (D049). Say: Premium Intelligence and actionable contacts for one destination; discovery stays worldwide |
| 1.5 | `src/app/(public)/pricing/page.tsx:44` | "Worldwide premium access and the full creator CRM." | Name what is unlocked: worldwide Premium Intelligence + premium contacts + full CRM (D052). "Premium access" is too vague to be checked against the contract |
| 1.6 | `src/app/(public)/pricing/page.tsx:22` | Free card lists only the three workspace limits | Should also state what Free *gets*: worldwide discovery + Public Intelligence (D049 — the free tier's story is the asset, not the limit) |
| 1.7 | `src/app/(public)/pricing/page.tsx:17` | "Launch pricing hypotheses. Subject to change." | $39/30d and $199/yr are now fixed V1 terms, not hypotheses. Reword without over-promising permanence |
| 1.8 | `src/app/(public)/pricing/page.tsx:10` | doc comment cites D004/D005 as governing | Cite D051/D052 |
| 1.9 | `src/lib/billing/view.ts:19` | `freeBody: "Premium access — a Destination Pass or Pro — unlocks contacts and richer hotel data."` | "Richer hotel data" implies a gated inventory (D049). Should be Premium Intelligence + actionable contacts |
| 1.10 | `src/components/hotels/locked-contact.tsx:2` | doc comment cites "PRD §5.2/§5.3" | Still correct in substance (contacts *are* entitlement-gated); re-verify wording against the rewritten §5.2/§5.3 |

Note on 1.1: `durationDays` is currently read **only** by the pricing page. No
entitlement is created from it, because checkout is not implemented — so the
change is safe, but the next PR must confirm nothing else has begun consuming it.

---

## 2. The Public / Premium Intelligence split — ✅ DONE

**Delivered.** Migration `0026` removed `reply_rate` from
`hotel_public_intelligence` and added `hotel_premium_intelligence`, gated inside
the view by `has_premium_hotel_access()`. `anon` holds no privilege on it. The
exact metric contract is D058; the four-state UI contract is D059.

Two items in §2.1 were implemented differently from the sketch below, both
deliberately:

- **2.1.4** — thresholds are two-dimensional. Every premium metric requires a
  contributor floor as well as a sample floor, because volume and diversity fail
  differently and only the second protects an individual creator.
- The **public** recency band gained a contributor floor too (3 distinct
  creators in 90 days for the recent bands). D050 requires the same privacy rule
  for a metric on every plan, and 15 pitched cycles can belong to one creator.

### 2.1 Database

| # | Object | Required |
|---|---|---|
| 2.1.1 | `hotel_public_intelligence` (migration `0022`) | Remove `reply_rate` from the public projection — it is a Premium field under D050 |
| 2.1.2 | *(new)* premium projection | A second view/RPC exposing the Premium fields, entitlement-gated in the database via the existing `has_premium_hotel_access` pattern — **never** a grant on `hotel_intelligence` / `destination_intelligence` / `outreach_events` / `collaborations` |
| 2.1.3 | ACL contract | Add the new relation to `0024`'s declared matrix through a **new** migration; `0024` and `0025` are immutable |
| 2.1.4 | Suppression rules | The premium projection needs its own thresholds. Privacy is identical across plans (D050) — premium may not lower a threshold to have something to show |

Migrations `0001`–`0025` are immutable. All of this lands in `0026+`.

### 2.2 Application

| # | File | Required |
|---|---|---|
| 2.2.1 | `src/lib/hotels/queries.ts:327` | Reads `hotel_public_intelligence`. Needs a sibling loader for the premium projection, with the same tri-state (`ok` / `none` / `error`) discipline |
| 2.2.2 | `src/lib/hotels/intelligence.ts:59` | `canShowReplyRate()` gates reply rate on confidence alone. Must additionally require premium entitlement — and the entitlement answer is itself tri-state, so an entitlement *error* must not render as "not entitled" |
| 2.2.3 | `src/lib/hotels/intelligence.ts` | `IntelligenceSignal` / `IntelligenceResult` currently model one layer. Needs a shape that distinguishes public signal, premium signal, and *locked* premium |
| 2.2.4 | `src/components/hotels/intelligence-panel.tsx` | No locked state exists. Needs a premium-locked treatment that communicates value without leaking it — the `LockedContactSection` pattern is the model |
| 2.2.5 | `src/app/(app)/app/hotels/[id]/page.tsx:76,147-149` | `getHotelIntelligence()` loads the public projection only; must also load premium when entitled, and render locked when not |
| 2.2.6 | `src/components/hotels/hotel-card.tsx` | Discover cards must show Public Intelligence only — a premium signal must never leak into a list card |
| 2.2.7 | `src/lib/analytics/events.ts:33` | `premium_intelligence_viewed` already exists in the vocabulary and is currently never emitted. Wire it when the surface exists |

### 2.3 Tests

| # | File | Required |
|---|---|---|
| 2.3.1 | `tests/rls/rls.test.ts:281` | Asserts `reply_rate` is selectable from the public view. Becomes the opposite assertion, plus a new premium-view suite |
| 2.3.2 | `tests/intelligence/aggregation.test.ts:171` | Asserts the public projection's five columns including `reply_rate`; the gating-band assertions change with 2.1.1 |
| 2.3.3 | `tests/intelligence/display-gating.test.ts` | Confidence-only gating; add entitlement dimension |
| 2.3.4 | `tests/hotels/intelligence-display.test.ts` | Add locked-premium panel state |
| 2.3.5 | `tests/rls/acl-matrix.test.ts:69,151` | The declared `CONTRACT` map is exhaustive by design — a new relation **fails the drift assertion** until added deliberately. That is the intended behaviour, not an obstacle |
| 2.3.6 | *(new)* | Entitlement matrix over the premium projection: anon / Free / entitled-destination / expired-pass / Pro / admin, using real DB roles |
| 2.3.7 | *(new)* | Privacy-invariance regression: the same hotel at the same confidence discloses the same *public* fields to Free and to Pro. Premium adds fields; it never lowers a threshold (D050) |

---

## 3. Entitlement duration assumptions

| # | Location | Note |
|---|---|---|
| 3.1 | `access_entitlements.expires_at` | Already generic — nothing encodes 90 days in the schema. No migration needed for D051 |
| 3.2 | `_has_active_pro` / `_has_active_destination_access` (migration `0010`) | Already evaluate `starts_at <= now()` and `expires_at`. Unchanged by D051 |
| 3.3 | Checkout / purchase → entitlement creation | **Not implemented.** When it is, it must read the duration from typed config, never a literal |

---

## 4. Typography (D053)

| # | File | Required |
|---|---|---|
| 4.1 | `src/app/layout.tsx` | **No custom font is loaded today** — the app runs on system defaults, so this is an addition, not a swap. Load Archivo (`next/font`). Deliberately not done in the contract PR |
| 4.2 | `src/app/globals.css` | Type tokens follow the real surface, not the prototype's pixel values (VISUAL_DIRECTION.md §22) |

## 5. Accent (D048)

| # | File | Required |
|---|---|---|
| 5.1 | `src/app/globals.css:15,30` | `--accent: #2f6df6` (and the dark variant) is the last placeholder; becomes Sun `#FFE01B`. Contrast for `--accent-contrast` must be re-derived — yellow needs dark text, not white |
| 5.2 | `src/app/globals.css:60` | Focus ring uses `--accent`; re-check visible-focus contrast against both backgrounds once the accent changes |
| 5.3 | Semantic palette | `--warning` must be chosen so it cannot be confused with the accent (D048) |

---

## 6. Entitlement scope and workflow limits (D056) — ✅ VERIFIED

| # | Location | Required |
|---|---|---|
| 6.1 | `save_hotel_to_pipeline` (migration `0019`) | ✅ Verified — exempts premium-covered hotels via `_has_active_pro` / `_has_active_destination_access`, resolved per hotel through the destination hierarchy. Unchanged; no duplication added in the UI |
| 6.2 | `transition_pipeline_item` (migration `0020`) | ✅ Verified — same mechanism for the engaged limit |
| 6.3 | tests | ✅ Covered in `tests/pipeline/save-to-pipeline.test.ts` and `tests/pipeline/transitions.test.ts` (Pro not blocked; Pass covers the hierarchy; a Pass holder acting outside falls back to Free) |
| 6.4 | Copy | ✅ The pricing page now states "Unlimited pipeline for that destination" |

## 7. Map coverage (D054)

| # | Location | Required |
|---|---|---|
| 7.1 | Promotion path (`scripts/import/promote.ts`, `CANONICAL_PROMOTION_SPEC.md`) | Coordinates become a **promotion precondition**: a candidate without valid canonical lat/long must be held back, not promoted. This is a promotion-gate change, not a schema change. **Widened by D062** — promotion into `hotels` **is** publication, and the gate covers all eleven conditions, including 4/5-star classification and provenance for both stars and coordinates (`CANONICAL_PROMOTION_SPEC.md` §6.1). No `publication_status` column or unpublished-canonical tier may be introduced to route around it |
| 7.6 | Pilot rows | The canonical pilot was promoted before D054/D060/D062 existed. Those rows are **not** retroactively compliant and must be audited, enriched and re-evaluated against the gate |
| 7.2 | `src/app/(app)/app/discover/page.tsx:8` | Doc comment says the map is deferred because "the canonical dataset currently has no coordinates". Restate against D054: the map ships when coverage does, and coverage is a precondition |
| 7.3 | Discover map (Sprint 3A) | The unmapped state is a defensive fallback only. Do not build product affordances around it (filters, counts, an "unmapped" tab) that would normalise it |
| 7.4 | *(new)* coverage check | A publishable hotel without coordinates should be detectable — a validation/report step, so coverage can be audited rather than assumed |
| 7.5 | Pilot data | The 30-property Dubai pilot needs coordinate enrichment before Discover's map ships. Provenance-backed; never fabricated |

## 8. Destination completeness (D055)

| # | Location | Required |
|---|---|---|
| 8.1 | Exclusion recording | Excluded properties need an explicit, auditable reason (duplicate / closed / HQ / non-property org / out of scope). The import pipeline records resolution decisions; confirm an exclusion reason is durable and reviewable |
| 8.2 | Coverage measurement | Coverage is measured against a destination's universe, not a target count. There is no such measure today |
| 8.3 | Copy | Nothing may describe a destination as "curated", "top N", "selected hotels", "initial 50" or "representative inventory" (D061). The 30-property Dubai set is a **technical pilot**, never Dubai inventory |
| 8.4 | `src/components/hotels/discover-filters.tsx:69-81`, `src/lib/hotels/filters.ts:19,34` | **REQUIRED CLEANUP, not an open decision.** V1 inventory scope is settled at 4/5-star only (D060), so the Discover **"3+"** option is definitively inconsistent with the product and **must be removed** during Sprint 3A. The final filter UX may still be designed (e.g. All / 4-star / 5-star, or no star filter at all) — but "3+" must not survive. This contract block changed no `src/` |
| 8.5 | *(new)* Enrichment queues | D061 requires missingness to be **measurable** (`hotels_without_any_contact`, `hotels_without_photo`, …). None exists. They are work queues, never exclusion filters |
| 8.6 | *(new)* Coverage runs | D061 requires an auditable per-destination, per-source coverage run producing the eligible inventory count as an **output**. Nothing exists today |
| 8.7 | *(new)* Coverage closure | D061 forbids declaring a destination complete while any coverage-critical candidate is unresolved. Reporting must carry **both** the resolved eligible count and the unresolved-candidate count / closure status, and completeness must never be computed over a denominator that excludes unresolved records |

Provider selection is **not** in scope — see §9.

---

## 9. Explicitly NOT in this backlog

- Media/photography **implementation** — schema, sourcing and ingestion. The
  *contract* is now closed (D064, VISUAL_DIRECTION.md §21A); no table, no
  pipeline and no supplier choice exists.
- **Property inventory sources** for D055's coverage universe — Booking, Expedia,
  Google and every other provider remain explicitly unchosen. The comparative
  evaluation that will choose them is specified in
  [`PROPERTY_SOURCE_EVALUATION.md`](PROPERTY_SOURCE_EVALUATION.md) and runs
  against Bali and Dubai.
- **Geocoding provider** — still unchosen (VISUAL_DIRECTION.md §21B). D054 fixes
  the coverage target, not the supplier.
- ~~The **initial destination list** — not selected.~~ **Selected** — the initial
  twenty are recorded in `INTELLIGENCE_ROADMAP.md` §11. Not ingested, and no
  destination carries a hotel-count target (D061).
- The exact **star-source authority hierarchy** and **entity-match thresholds** —
  deferred to the source-evaluation block on purpose (D060, D063), because a
  number invented before the evidence would read as a decision.
- ~~The exact **Premium Intelligence field projection and numeric thresholds**.~~
  **Closed by D058**, implemented in `0026`.
- Payment-provider integration (Hotmart or otherwise) — a later concern (D051,
  Owner Decision 7). Fixing price/duration copy is not the same as building
  checkout.
- Sprint 3A Discover/map implementation — governed by VISUAL_DIRECTION.md
  §20–§23.
