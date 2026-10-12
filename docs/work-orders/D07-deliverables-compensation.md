# D07 — Collaboration deliverables and agreed compensation

**Status:** Binding work order for PR #56. Awaiting independent audit. Do not merge.  
**Base:** `main` `ab0507461b4b47b21112dd07589b4b8a88d3efb3` (includes merged E01, PR #55). Prior audit head `984171a`.  
**Branch:** `feat/d07-deliverables-compensation`  
**Decision:** D078, Accepted — Brian, 12 October 2026, option B.  
**Migration:** `0050_collaboration_deliverables_compensation.sql`

`main` ends at `0046`. E01 (PR #55) merged with no migration. Open PR #53 (B08) reserves `0047` and `0048`, and D076. D077 is C01 on `main` and is still Proposed. `0049` is still unused. This block keeps `0050` and D078.

One PR for the whole block. Do not merge.

## Principal question

How does a creator record what a won collaboration is worth, and what content is owed, so each piece can show a value, without charging anyone and without a machine reading overwriting what the creator typed?

## Sources

Accepted product decision, Brian, 12 October 2026, option B: compensation is strategic data intelligence used to value each piece of content. D072 compensation vocabulary (`paid`, `in_kind`, `hybrid`, `unpaid`, `other`, `unknown`). D045 collaboration lifecycle. D072's deferral of amounts, currency, deliverables, and payment status to a later Deal/Collaboration/Deliverables contract — this is that contract. The hotel activity panel is the collaboration detail; there is no separate pipeline-detail route.

## Locked reading used by this implementation

- One agreed-compensation row per collaboration. `paid` is cash only. `in_kind` is product or stay only. `hybrid` is both. `unpaid` is an explicit zero labeled `unpaid_explicit`. `other` and `unknown` have no numeric value. Unknown is JSON null, never zero.
- Cash and in-kind estimates are integer minor units with an uppercase ISO 4217 currency. The in-kind estimate is labeled `creator_estimate`. Amounts are non-negative and at most 9007199254740991.
- Payment status is `pending`, `partially_paid`, `paid`, or `not_applicable`. It is a record. It does not change the derived value. There is no partial-amount field and no payment provider.
- A deliverable has type, quantity, platform, due date, status (`pending`, `submitted`, `approved`, `rejected`), an https proof URL, and notes. Status does not change the piece's value.
- Derived value uses largest remainder across every deliverable's quantity, including rejected rows. Ties break by `created_at`, then `id`. Shares of a known total are labeled derived. A share may be 0 minor units only when the total itself is known. Hybrid with a missing estimate, or with two currencies, stays unknown. No exchange rate is applied.
- Creator-entered values are human truth. Prefill copies a current B07 compensation structure into a suggestion row only. It never writes the agreed row and never writes an amount. A stale or unbound reading writes nothing. The creator names the mailbox and the provider thread. No automatic thread-to-pipeline link is invented.
- These rows do not write `collaborations.private_value_*`, outreach events, public intelligence, or `collaboration_type`. Lifecycle status does not freeze them. They are not promoted into a C01 fact.

## In scope

- Tables, checks, RLS, and service-role write RPCs for compensation, suggestions, and deliverables.
- Security-invoker read `collaboration_deliverable_values`.
- Triggers that reject a cross-creator attach, including a creator or pipeline change that would detach children.
- Zod validation for amounts, currency, and https proof URLs.
- UI on the existing hotel activity panel for a won collaboration.
- Tests: allocation, unknown versus zero, prefill does not overwrite, User A versus User B, ACL matrix for the new definers and the invoker read.

## Out of scope

Charging, payment providers, Rebill, price changes, model or vendor HTTP, public aggregates, usage rights, file upload, automatic Gmail-to-pipeline matching, and any change to D072 machine semantics.
