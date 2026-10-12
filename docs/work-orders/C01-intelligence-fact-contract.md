# C01 — Normalized intelligence event/fact contract (docs only)

**Status:** Binding work order for this PR. Awaiting audit. Do not merge.
**Base:** `main` `4062170212beb8b978a248ef219eb91ddbfb080b` (merge of PR #52).
**Branch:** `docs/c01-intelligence-fact-contract`.
**Migration:** none. No runtime code. 0047 is claimed by open PR #53 (B08). This block reserves no number.

One PR for the whole block. Do not merge.

## Principal question

Which claims already produced by pipeline and outreach events, collaborations, the B05–B07 Gmail layers, and trips are intelligence facts, what must every such fact point at, and what may C02 and C03 later read?

## Decision number

D076 is not free. Checked on 2026-10-12:

- `main` at `4062170` ends at D075.
- The only open pull request is #53, `feat/b08-gmail-incremental-sync`, which already uses D076.

This block uses **D077**, status **Proposed (requires owner acceptance)**. It is not Accepted.

## Sources

D009, D010, D012, D014, D015, D043, D045, D050, D057, D058, D067, D070, D071, D072, `docs/EVENTS.md`, `docs/DATABASE.md` §§8–9 and §11, the B05–B07 contracts, the D01 trip behavior merged in PR #52, and `docs/INTELLIGENCE_ROADMAP.md` §4. This work order adds no product semantic beyond the proposal in `docs/C01_INTELLIGENCE_FACT_CONTRACT.md`.

## In scope

- `docs/C01_INTELLIGENCE_FACT_CONTRACT.md`
- D077 in `docs/DECISIONS.md`
- Tracker, autopilot state, and this work order, in this same PR

## Out of scope

Aggregates, ranking, schema, migration, UI, runtime code, CRM materialization of Gmail, B08 sync, prices, Rebill, and any model or vendor call.

## Invariants the proposal must keep

- Every admitted fact traces to one canonical target and one private evidence or event id.
- Machine provenance and creator-confirmed provenance stay separate (D072).
- Anything network-level requires creator-confirmed provenance.
- D072 is untouched: machine interpretation is never human truth; redirect is not rejection; a one-sided yes is negotiation, not agreement; unknown is not unpaid and is not zero.
- Authentication is not authorization. Stated for the later implementation. This PR has no new private table to test.

## Open owner questions (do not answer)

1. Aggregation thresholds for any new aggregate over these facts.
2. Network eligibility of creator-confirmed Gmail-derived facts, including whether an organization target can be network-level.
3. B08 pilot KPIs: which quality and data-density measures the pilot must observe, and what result would pause or justify a larger intelligence product. D076 does not define them. The Milestone B list is not an accepted KPI contract.

## Gate

Every derived fact traces to a canonical target and a private evidence or event id. The proposal states that gate. It does not implement it.
