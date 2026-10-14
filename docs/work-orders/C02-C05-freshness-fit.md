# C02–C05 — Freshness, aggregates, and creator fit

**Status:** Binding work order for this PR. Awaiting CI. Do not merge.
**Base:** `main` `bf756686bf359c22723b5628fa4446bee2af0302` (merge of PR #81).
**Branch:** `cursor/c02-c05-freshness-fit-dc8e`.
**Migrations:** `0084`, `0085`, `0086`, `0087`. `0081`–`0083` are not these files.
**Decisions:** D146–D150.

One PR for the extension of C02, C03, C04, and C05. D099, H01, and F03 stay in place.

## Principal question

How does a creator see freshness and confidence, a personal total, a k-anonymous network read, and a fit list, without a second ranking math and without a single creator becoming the network?

## Sources

Canon v1.1. D012, D050, D058, D099, D120, D130, D133. PRD §12.8. The H01 reads and the F03 order.

## In scope

- Confidence and freshness beside an available H01 metric.
- The caller's own manual and Gmail counts.
- A network read that is insufficient, with no other keys, below three creators.
- Creator fit ordered by public activity, then hotel id. Prior not applied.
- Max detail fields on that list. Pursue and skip for a hotel already on it.
- RLS, revoked grants, and security-definer functions with an empty search path.

## Out of scope

Rewriting `recompute_hotel_intelligence`, `network_hotel_public`, or the H01 basis. A composite score. A change to Discover or Pipeline order. A paid-collaboration rank. Editing migrations `0056`, `0071`, or `0072`. Merging this PR.

## Invariants

- Authentication is not authorization.
- Unknown is not zero. A missing network row is not zero.
- A freshness band is null unless three distinct creators fall inside that window and confidence is moderate or strong.
- Network payloads have no creator id, evidence id, or count.
- A locked fit has no hotels. Max detail does not reorder the list.
- A decision does not change the aggregate.
