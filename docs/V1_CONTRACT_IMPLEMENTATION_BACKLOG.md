# V1 Contract — Implementation Backlog

Scope of the **next technical PR**. Nothing here is implemented yet; this file
exists so that PR starts from an unambiguous list rather than a re-reading of
the decision log.

Produced during the pre-Sprint-3 product contract sync, after the owner approved
D049–D053. Every item below is production code or test code that contradicts one
of those decisions, or a gap the decisions created.

**Nothing in this backlog was changed in the PR that created this file.**

Governing decisions: **D049** (one canonical inventory, no "premium hotels"),
**D050** (Public + Premium Intelligence, identical privacy), **D051**
(Destination Pass $39 / 30 days), **D052** (Pro $199/year), **D053** (Archivo).

---

## 1. Stale commercial copy and configuration

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

## 2. The Public / Premium Intelligence split — the substantial work

D050 requires two projections. **One exists.** Today's single projection is
graduated by *confidence*, not by *plan*, so **reply rate currently reaches
anonymous visitors and Free creators** at `strong` confidence. That is the
central gap.

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

## 6. Explicitly NOT in this backlog

- Media/photography schema, sourcing or ingestion — still an open product
  contract (VISUAL_DIRECTION.md §21A).
- Geocoding provider and canonical coordinate enrichment — still open
  (VISUAL_DIRECTION.md §21B).
- Payment-provider integration (Hotmart or otherwise) — a later concern (D051,
  Owner Decision 7). Fixing price/duration copy is not the same as building
  checkout.
- Sprint 3A Discover/map implementation — governed by VISUAL_DIRECTION.md
  §20–§23.
