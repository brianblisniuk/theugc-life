# Skill: repo-state-audit

Fetch and record live GitHub state before any work.

Steps:
1. Confirm canonical workspace `/workspace/theugc-life` exists; if not, clone `brianblisniuk/theugc-life`.
2. `git fetch origin`.
3. Record current `main` SHA, open PRs, and their heads.
4. Compare against `docs/AUTOPILOT_STATE.md`.
5. If drift exists, update the state file and report only if it creates a human frontier.
6. Hierarchy of truth: DECISIONS > current contract > PRD > MASTER_PLAN > TRACKER > live GitHub > historical handoffs > bot memory.

Output: short state summary (main SHA, open PRs, frontier).
