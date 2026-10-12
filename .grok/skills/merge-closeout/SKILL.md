# Skill: merge-closeout

After owner approves a specific PR + HEAD SHA:

1. Re-fetch the PR.
2. If head SHA differs from the approved SHA, abort and re-audit.
3. Merge: `gh pr merge <n> --merge --match-head-commit <approved-sha>` (no admin bypass, no force).
4. Verify main advanced to the merge commit.
5. Confirm post-merge CI if available.
6. Do NOT open a state-only PR. The state/tracker update already rode in this PR, and the next block's PR records this merge SHA (`docs-state-sync`).
7. Select the next dependency-valid frontier and continue autopilot.

Never merge without an explicit owner approval of the exact SHA.
