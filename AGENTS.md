# AGENTS.md

This repository is operated by the **THEUGC autonomous engineering system**.

**Before any work, read in order:**

1. [`docs/AUTONOMOUS_ENGINEERING_SYSTEM.md`](docs/AUTONOMOUS_ENGINEERING_SYSTEM.md) — persistent bots, PLAY contract, human frontiers, autopilot loop.
2. [`docs/WORKING_METHOD.md`](docs/WORKING_METHOD.md) — binding process (contract → implement → hostile audit → same-PR correction → exact-head CI → human merge).
3. [`docs/DECISIONS.md`](docs/DECISIONS.md) — closed product and architecture decisions.
4. The current block contract / spec.
5. [`docs/PRD.md`](docs/PRD.md), [`docs/MASTER_PLAN.md`](docs/MASTER_PLAN.md), [`docs/MASTER_PLAN_TRACKER.md`](docs/MASTER_PLAN_TRACKER.md).
6. [`docs/AUTOPILOT_STATE.md`](docs/AUTOPILOT_STATE.md) — current frontier and last verified main.

**PLAY contract (owner sends exactly `PLAY`):**
THEUGC ORCHESTRATOR invokes AUTOPILOT. Do not ask what to do. Derive the next dependency-valid block from live GitHub + decisions + tracker. Execute until a genuine human frontier.

**Human frontiers only (notify owner with these labels):**

- PRODUCT DECISION REQUIRED
- CREDENTIAL REQUIRED
- EXTERNAL ACTION APPROVAL REQUIRED
- MERGE DECISION REQUIRED
- TECHNICALLY BLOCKED
- AUTOPILOT FRONTIER COMPLETE

**Permanent invariant:** authentication ≠ authorization. Every private multi-user resource must prove User A cannot read, enumerate, modify, delete or infer User B’s resources by ID, API, Server Action, RPC or relation. Prefer PostgreSQL RLS/ACL as the authoritative boundary.

**No direct commits to `main`:** every change, including docs, tracker and `docs/AUTOPILOT_STATE.md`, goes through a feature branch + PR. `.grok/config.toml` flags are advisory only; real enforcement requires a GitHub ruleset on `main` (pending owner approval). `.grok/workflows/` and `.grok/hooks/` do not exist yet.

**Merge:** never silent. After PASS + exact-head CI green, notify:
`MERGE DECISION REQUIRED — PR #X — HEAD <exact-sha>`
Wait for explicit approval of that PR + SHA. Re-fetch before merge; if head moved, re-audit.

Canonical workspace for agents: `/workspace/theugc-life` (rebuild from GitHub if missing).  
GitHub is the source of truth. Conversation memory never overrides the repository.
