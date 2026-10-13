# C02–C05 — Network intelligence

**Status:** Binding work order for this PR. Awaiting CI. Do not merge.
**Base:** `main` `502ae69ecb192dc3678a27619a557bb1012ff0e5` (merge of PR #66).
**Branch:** `cursor/c02-c05-network-intelligence-a035`.
**PR:** #67. Do not merge.
**Migration:** `0056_network_intelligence_facts.sql`. `0055` is not edited.

One PR for C02, C03, C04, and C05. The owner asked for that scope.

## Principal question

Which confirmed creator facts become an anonymous hotel signal, what must stay private, and which admin-only measures the pilot observes?

## Decision number

D099. D077 is Accepted (Brian, 13 Oct 2026). The three C01 questions are closed there, not reopened here.

## Sources

D012, D058, D077, D099, `docs/C01_INTELLIGENCE_FACT_CONTRACT.md`, and the owner's accepted answers.

## In scope

- Private fact, confirmation, view, and priority tables.
- Anonymous `network_hotel_public` at three distinct creators, with D012 bands.
- Pipeline Sí/No for a linked Gmail reading. Dismissed never enters.
- Personal history split into manual and Gmail.
- Baseline destination order. Hierarchical prior not applied.
- Admin-only provenance and pilot measures.
- RLS tests: User A cannot read User B's facts. Anon and creators cannot see provenance.

## Out of scope

Rewriting `recompute_hotel_intelligence` or the D058 projections. A composite score. A numeric public reply time. A pause threshold. Treating a canonical organization as a network target. Merging this PR.

## Invariants

- Authentication is not authorization. RLS and the revoked grants are the boundary.
- The service-role key is not in client code.
- A missing network row is not zero. Insufficient is not a precise metric.
- A recency or freshness band is null unless three distinct creators have a sample event inside that band's window. A Gmail confirmation stores the email time, not the tap time. Destination order sorts only those anonymous fields.
- `unknown` is not unpaid. Redirect is not rejection. A shortlist is not network-eligible.
