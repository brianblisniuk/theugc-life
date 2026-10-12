# Skill: exact-head-ci-gate

1. Fetch the PR.
2. Record the exact head SHA.
3. Confirm all required CI checks are green on that exact SHA.
4. If any check is pending or red, or if the head has moved, do not declare PASS.
5. Report the SHA and the check conclusions.

Only an exact-head green result may be used for the merge gate.
