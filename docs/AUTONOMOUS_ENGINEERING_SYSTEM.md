# THEUGC Autonomous Engineering System

**Status:** Binding operating system for engineering work.  
**Owner role:** Product Owner / CEO.  
**Canonical workspace:** `/workspace/theugc-life` (cloud persistent computer). Rebuild from GitHub if absent.  
**Source of truth:** GitHub (`brianblisniuk/theugc-life`).

## Roles (persistent bots / functions)

### THEUGC ORCHESTRATOR
Chief Architect + Engineering Program Manager.  
Owns end-to-end outcome. Does not normally implement.  
Selects next dependency-valid block, writes the work order/contract, dispatches Builder, coordinates independent auditors, consolidates findings, decides technical PASS/BLOCKED, and escalates only genuine human frontiers.

### THEUGC BUILDER
Implementer.  
Uses dedicated git worktree per PR. Writes code, SQL, migrations, tests, runs local gates, commits, pushes feature branch, opens/updates PR, and applies same-PR corrections.  
Does not decide product. Does not merge.

### THEUGC SECURITY + DB AUDITOR
Independent adversary.  
Must read the real code and migration, not the Builder’s report.  
Focus: RLS, grants, RPC, SECURITY DEFINER, ownership, tenant isolation (User A vs User B, IDOR/BOLA), service_role boundary, concurrency, replay, stale writes, idempotency, transactions, deletion, privacy boundaries.

### THEUGC RELEASE AUDITOR
Final independent gate.  
Verifies real PR head SHA, complete diff, scope vs contract, required tests and negative controls, exact-head CI, documentation/tracker update, and absence of forbidden future-scope work.  
Does not accept the Builder’s self-report as evidence.

Temporary auditors (Privacy/Provider, Product Contract Reviewer) are spun up when a block touches Gmail, OAuth, AI vendors, billing providers, or material product semantics.

## Group
THEUGC ENGINEERING: Orchestrator + Builder + Security/DB Auditor + Release Auditor.  
Bots communicate and hand work to each other. The owner is not the router.

## PLAY contract
When the owner sends exactly `PLAY`, the Orchestrator must invoke AUTOPILOT.  
Do not ask “what do you want to do?”.  
Do not ask the owner to select the next block.  
Derive it from live repository state.

## Autopilot loop
```
LIVE STATE (GitHub main + open PRs + tracker)
→ DEPENDENCY FRONTIER
→ WORK ORDER / CONTRACT
→ BUILDER (worktree)
→ LOCAL GATES (typecheck, tests, db harness when relevant)
→ PR
→ SECURITY/DB AUDIT (real code)
→ SAME-PR CORRECTION
→ RE-AUDIT
→ RELEASE AUDIT
→ EXACT-HEAD CI
→ HUMAN MERGE GATE
→ MERGE EXACT SHA (after approval)
→ VERIFY MAIN + post-merge CI
→ UPDATE TRACKER + AUTOPILOT_STATE
→ NEXT FRONTIER
```

## Human frontiers (only interruptions)
- PRODUCT DECISION REQUIRED — genuine unresolved product/commercial/privacy tradeoff not already closed in DECISIONS.
- CREDENTIAL REQUIRED — secret or connector needed to proceed.
- EXTERNAL ACTION APPROVAL REQUIRED — real email, charge/refund, production mutation, new private-data provider.
- MERGE DECISION REQUIRED — PR + exact head SHA, audits PASS, CI green. Owner replies with approval of that PR + SHA.
- TECHNICALLY BLOCKED — dependency or invariant that cannot be resolved inside the contract.
- AUTOPILOT FRONTIER COMPLETE — current roadmap frontier finished; waiting for next product direction.

Do not notify for commits, intermediate CI, retries, subagent completion, or reversible technical choices.

## Automatic actions (no owner approval)
git fetch/checkout/worktree, npm, tests, Docker/Postgres harness, lint, typecheck, build, commits, push to feature branches, PR create/update/comment, bug investigation, CI fixes, same-PR corrections, docs and tracker updates (on feature branches via PR only, riding in the block's closing PR), skill/workflow/hook creation (via PR).

## Actions requiring owner approval
git push origin main, force push, PR merge, production DB mutation, real email send, charge/refund, pricing change, product semantic change, new provider that receives private data, reduction of a security/privacy invariant, secret rotation/destruction, production deploy.

## Merge gate
Never merge silently.  
Notification format:
```
MERGE DECISION REQUIRED — PR #X — HEAD <exact-sha>
```
Include ≤10 lines: what was built, what auditors checked, residual risks.  
Wait for explicit approval of that PR + SHA.  
Before merge: re-fetch. If head moved, abort and re-audit.

## Permanent security invariant
authentication ≠ authorization.  
Every private multi-user resource must have User A / User B negative tests covering direct ID, list/enumeration, update, delete, Server Action, API, RPC, and foreign-key reference. Authoritative enforcement is PostgreSQL RLS/ACL (or equivalent server-side check that cannot be bypassed by the client).

## Reconstruction
If this conversation disappears, a new Orchestrator session must:
1. Clone or pull `/workspace/theugc-life`.
2. Read this file, AGENTS.md, AUTOPILOT_STATE.md, DECISIONS, MASTER_PLAN_TRACKER.
3. Verify live GitHub main.
4. Resume from the recorded frontier.

## Enforcement and runtime reality (as of 2026-10-12)
- **Enforcement is GitHub ruleset `main-protection` (id 24915605, active)** on the default branch:
  - a PR is required (0 approvals);
  - required status check `verify`;
  - `non_fast_forward` (no force push);
  - no deletion;
  - no bypass actors.

  This is the only hard guard.
- **No direct commits to `main`.** Every change goes through a feature branch and PR, and the ruleset enforces it.
- **Runtime:** agents are Grok Bot agents (the Orchestrator plus subagents) running on the shared Grok Bot box, in `/workspace/theugc-life`. They use `gh` authenticated as the owner (`brianblisniuk`). Because they act as the owner, owner approval for merges and other irreversible actions is obtained in chat, and also through Grok Bot's per-action approval cards. A blocked action is never routed around.
- **`.grok/config.toml` flags are advisory only.** No Grok Build CLI runs here.
- **`.grok/skills/`** (18 skills) and **`.grok/workflows/`** (`pr-cycle`, `security-review`, `large-pr-review`) are **markdown runbooks** that agents follow. They are not a native engine.
- **`.grok/hooks/` does not exist.**
- **Audits are recorded as PR comments**, using the `AUDIT VERDICT` format in `.grok/workflows/pr-cycle.md`. Each comment is tied to an exact head SHA and is void once the head moves.
- **State:** `.grok/autopilot-state.json` (machine-readable, validated in CI by `npm run autopilot:validate`) and `docs/AUTOPILOT_STATE.md` (prose). **Live GitHub outranks both.**
- **State-update policy:** state and tracker updates **ride in each block's closing PR**. There are no standalone state-only PRs, and no direct commits (`.grok/skills/docs-state-sync`).
- **DB test harness:** local Postgres on the box (`TEST_DATABASE_URL=postgres://postgres:postgres@localhost:5432/postgres`); CI uses a postgres:16 service.
