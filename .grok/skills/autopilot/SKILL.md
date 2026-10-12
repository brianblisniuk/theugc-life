# Skill: autopilot

Entry point when owner sends `PLAY`.

1. Run repo-state-audit.
2. Read DECISIONS, current tracker, AUTOPILOT_STATE.
3. Determine the next dependency-valid block (do not ask the owner).
4. Write work order.
5. Dispatch Builder (worktree).
6. After PR exists, dispatch Security/DB Auditor and Release Auditor.
7. Loop corrections until PASS.
8. Confirm exact-head CI.
9. Raise MERGE DECISION REQUIRED with the exact SHA.
10. After approval, run merge-closeout and continue to the next frontier.

Only stop for the six human-frontier labels.
