# Skill: repo-state-audit

Fetch and record live GitHub state before any work.

Steps:

1. Confirm canonical workspace `/workspace/theugc-life` exists; if not, clone `brianblisniuk/theugc-life`.
2. `git fetch origin`.
3. Record current `main` SHA, open PRs, and their heads.
4. Compare against `docs/AUTOPILOT_STATE.md`.
5. If drift exists, record it as a finding and fix it in the current block's PR (`docs-state-sync`). Never commit to `main` directly. Report only if it creates a human frontier.
6. Repository facts: live GitHub wins over every state file. Product intent: see `source-hierarchy-resolver`.
7. Validate `.grok/autopilot-state.json` (`npm run autopilot:validate`) and compare its `expected_head`/`pr` with live.

Output: short state summary (main SHA, open PRs, frontier).
