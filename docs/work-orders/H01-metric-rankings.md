# H01 — Metric rankings and hotel signals

**Status:** Binding work order for this PR. Awaiting audit. Do not merge.
**Base:** `main` `0a69413beb338c7910d8b9473693a3db7136a6aa` (merge of PR #73).
**Branch:** `cursor/h01-metric-rankings-367c`.
**PR:** not opened yet. Do not merge.
**Migrations:** `0071_hotel_metric_signals.sql`, `0072_hotel_metric_ranking_reads.sql`. No new table. `0069` and `0070` are not these files. `0068` is not edited.
**Decision:** D120. D121–D124 are unused.

One PR for canon v1.1 H01. The second-vertical H01 row stays gated and is a different block.

## Principal question

How does a creator see "Most responsive in Bali" as one transparent metric, with the value, the sample, and the threshold, without a composite score and without a hotel paying for the place?

## Sources

Canon v1.1 Sprint 5 H01 and the intelligence principles (real events, individual metrics, hotels cannot pay for reputation). PRD §12.8 and §12.8.4. D012, D013, D050, D058, D059, D062, D077, D098, D099, D100, D106. C02–C05 work order. D077 answers: anonymous network use, admin-only provenance, Gmail only after explicit confirmation, thresholds reuse D058 and D012.

## In scope

- Response rate, reply-time band, and creator activity, each computed only from creator-confirmed network facts.
- A destination ranking is that destination and its descendants. Tie-break is hotel id.
- Hotel signals on the hotel detail intelligence section. Each card shows the metric, the value or "Not enough data" or the locked state, the sample sentence when N is at least 5, and the threshold rule.
- Entitlement inside the database. Activity is all tiers, including anonymous. Reply metrics are Pass inside the requested destination, Pro worldwide, and admin or editor.
- Read API for F03: `hotel_metric_signal_public`, `hotel_metric_signal_premium`, `read_destination_metric_ranking`, `read_hotel_metric_signals`. Order one metric by `rank_key desc, hotel_id`.

## Out of scope

Discover and Pipeline default order (F03). Home files under `src/lib/home`. Profile, portfolio, and share-link files. G02 migrations `0069` and `0070` and deliverable or reminder components. A paid-collaboration rate or a highest-paying rank. A composite score. Rewriting `recompute_hotel_intelligence` or `read_network_destination_rank`. Production data changes.

## Follow-up

Home can later show one entitled metric by calling `read_hotel_metric_signals`. It must not sort Home by a ranking. F03 must not put a second metric in `ORDER BY` and must not read `hotel_intelligence` or `private.hotel_metric_basis` from the client.

## Invariants

- Authentication is not authorization.
- Unknown is not zero. Below a floor the value is null.
- A measured zero that clears the D058 floors stays zero.
- A failed read is a notice, not an empty list.
- A locked reply ranking has no hotels key and no protected value.
- No creator id, evidence id, or provenance class on a non-admin payload.
- A payment, an entitlement, or a sponsored flag is not a ranking input.
