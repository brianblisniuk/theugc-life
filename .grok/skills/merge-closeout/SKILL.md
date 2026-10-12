# Skill: merge-closeout

After owner approves a specific PR + HEAD SHA:

1. Re-fetch the PR.
2. If head SHA differs from the approved SHA, abort and re-audit.
3. Merge using the approved SHA.
4. Verify main advanced to the merge commit.
5. Confirm post-merge CI if available.
6. Update `docs/AUTOPILOT_STATE.md` and the tracker.
7. Select the next dependency-valid frontier and continue autopilot.

Never merge without an explicit owner approval of the exact SHA.
