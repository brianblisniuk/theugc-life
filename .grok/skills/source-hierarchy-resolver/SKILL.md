# Skill: source-hierarchy-resolver

Resolve any product/architecture question before acting on it.

**Facts about the repository** (what is merged, what CI says, which PRs are open): **live GitHub always wins**. Check with `git fetch origin`, `gh pr list`, `gh api repos/brianblisniuk/theugc-life/commits/<sha>/check-runs`.

**Product/architecture intent**, highest first:

1. `docs/DECISIONS.md` (latest D-entry on the topic; reconciliation entries such as D073/D074 qualify earlier ones without rewriting them)
2. the accepted block contract (`docs/<BLOCK>_*_CONTRACT.md`)
3. `docs/PRD.md`
4. `docs/MASTER_PLAN.md`
5. `docs/MASTER_PLAN_TRACKER.md`
6. `docs/AUTONOMOUS_ENGINEERING_SYSTEM.md`
7. `docs/AUTOPILOT_STATE.md` / `.grok/autopilot-state.json`
8. historical handoffs, then bot memory (never authoritative)

Steps:

1. `rg -n "<topic>" docs/DECISIONS.md docs/*CONTRACT*.md` to find the governing entry.
2. If two sources conflict, the higher one wins. Record the conflict as a finding, and fix the lower one through a reconciliation PR. Never rewrite a historical D-entry.
3. If the decision is **not closed** anywhere and the choice changes product, pricing, privacy or semantics, stop: `PRODUCT DECISION REQUIRED`. Give options and a recommendation.

Output: the governing source (file:line), the answer, and any conflict found.
