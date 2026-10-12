# Skill: docs-state-sync

Keep state docs truthful without creating self-stale PRs.

Policy (binding):

- State updates (`docs/AUTOPILOT_STATE.md`, `.grok/autopilot-state.json`, tracker round status) **ride in each block's closing PR**. No standalone state-only PRs, and never a direct commit to `main`.
- Write state as of the PR's own merge: "PR #N merges block X; next frontier Y". Do not write "open PRs: this PR" or a "last verified main" that this PR's merge will immediately change.
- Live GitHub outranks every state file.

Steps:

1. In the closing PR, set the tracker round to `DONE — PR #N`. Leave the merge SHA to the next block's PR, which records the previous merge SHA.
2. Update `.grok/autopilot-state.json` and run `npm run autopilot:validate`.
3. Update `docs/AUTOPILOT_STATE.md` prose to match the JSON.
4. Reconcile any drift you find (stale §9 prose, wrong statuses) in the same PR, as a separate commit.
