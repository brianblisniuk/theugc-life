# F03 — Hotel ranking rules

**Status:** Binding work order for this PR. Awaiting audit. Do not merge.
**Base:** `main` `b541343c7f7e87e3402d377d88bc5b23d67cbe5a` (merge of PR #77).
**Branch:** `cursor/f03-hotel-rankings-70fa`.
**Migrations:** none. `0075` and `0076` are unused. `0071` and `0072` are H01 and are not edited.
**Decision:** D130. D131–D134 are unused.

One PR for canon v1.1 F03. The agency F03 row stays planned and is a different block.

## Principal question

How does Discover or Pipeline order hotels by one transparent metric, without a composite score, without showing a locked caller a reply-rate order or a hotel list, and without treating below-floor as a rank?

## Sources

Canon v1.1 F03. D120 and the H01 reads: `hotel_metric_signal_public`, `hotel_metric_signal_premium`, `read_destination_metric_ranking`. D049, D059, D098. PRD §12.8.4.

## In scope

- An optional `rank` param on Discover and Pipeline. One of `response_rate`, `response_time`, `creator_activity`. Anything else is dropped.
- Order is `rank_key` descending, then hotel id ascending.
- A destination uses `read_destination_metric_ranking`. No destination uses the matching signal view.
- Pipeline orders only the caller's own hotels.
- Locked premium: no hotel list.
- Below the floor: not enough data, and those hotels are absent from the metric order.
- A measured zero that cleared the floor stays.

## Out of scope

A new table or migration. A composite score. Changing the name order or the recent-activity order when no metric is requested. Home files under `src/lib/home`. Rewriting H01 math. A paid-collaboration rank. Production data changes.

## Invariants

- Authentication is not authorization.
- Unknown is not zero. Below a floor the hotel is not in the metric order.
- A failed read is an error, not an empty list and not a lock.
- A locked reply order has no hotels.
- No creator id, evidence id, or rank key on the rendered card. The card shows the published label.
