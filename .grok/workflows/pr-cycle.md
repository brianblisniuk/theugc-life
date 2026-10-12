# Workflow: pr-cycle

> **What this is:** a markdown runbook that Grok Bot agents follow by hand: the Orchestrator plus subagents running on the shared box, using `gh` authenticated as the owner. There is **no native workflow engine**. Nothing here executes automatically, and the `.grok/config.toml` flags are advisory. Hard enforcement is GitHub ruleset **24915605** on `main`: PR required, `verify` must pass, no force push, no deletion.

Standard cycle for one block, from work order to merge.

## Roles

| Role                | Does                                                                                                                                           | Never                                                      |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| Orchestrator        | runs `repo-state-audit` and `dependency-frontier`, writes the work order, dispatches the others, consolidates verdicts, raises human frontiers | implements; merges without owner approval of the exact SHA |
| Builder             | branches from live `main`, implements, writes tests and negative controls, pushes the branch, opens the PR, applies `same-pr-correction`       | decides product; merges; force-pushes                      |
| Security+DB Auditor | reads the real diff and migrations (not the Builder's report); runs `hostile-pr-audit`, `tenant-isolation-audit`, `db-concurrency-audit`       | trusts claims without a test                               |
| Release Auditor     | `release-readiness` on the exact head                                                                                                          | approves a moved head                                      |

## Steps, inputs → outputs

1. **State** (Orchestrator). Input: live GitHub. Output: `repo-state-audit` summary. Validate `.grok/autopilot-state.json`.
2. **Frontier + work order** (Orchestrator). Output: `write-work-order` text, posted as the PR description or the first comment.
3. **Build** (Builder). Branch `<type>/<block>` from `origin/main`. Output: pushed branch + PR. Local gates must pass with `TEST_DATABASE_URL` set. The state/tracker update rides in this PR (`docs-state-sync`).
4. **CI**: wait with `gh pr checks <n> --watch`, then confirm `verify` at the exact head via `gh api .../commits/<head>/check-runs`.
5. **Security+DB audit**: posts a verdict comment (format below).
6. **Correction loop**: on BLOCKING, the Builder runs `same-pr-correction`, then steps 4–5 repeat on the new head.
7. **Release audit**: verdict comment.
8. **Merge gate** (Orchestrator → owner): `MERGE DECISION REQUIRED — PR #X — HEAD <sha>`, with ≤10 lines of summary.
9. **Merge** after explicit approval of that PR and SHA: `merge-closeout`. Then verify `verify` on the merge commit and continue to the next frontier.

## Audit verdict comment format (handoff artifact)

Every auditor posts exactly one PR comment per audited head:

```text
AUDIT VERDICT — <role: SECURITY+DB | RELEASE | PRIVACY+PROVIDER>
PR: #<n>
HEAD: <exact 40-char sha>
VERDICT: PASS | BLOCKING | PASS WITH NON-BLOCKING
FINDINGS:
- [BLOCKING|NON-BLOCKING] <id> — <one line> — <file:line> — <evidence/test>
NEGATIVE CONTROLS: <guard → test → fails-when-removed: yes/no>
CI AT HEAD: verify=<success|failure|pending>
```

A verdict applies only to the HEAD it names. Any new push invalidates it.
Post it with: `gh pr comment <n> --body-file verdict.md`.

## Stop conditions

- Head moved after an audit → re-audit; do not merge.
- `verify` failure: investigate. A flake may be re-run **once** and must be recorded. A second failure is a real defect.
- A fix would change product semantics or weaken an invariant → `PRODUCT DECISION REQUIRED`.
- A secret is needed → `CREDENTIAL REQUIRED` (`secret-access-request`).
- Real email, charge or refund, production mutation, or a new private-data provider → `EXTERNAL ACTION APPROVAL REQUIRED`.
- An auto-review/approval block on a tool call is answered by the owner's approval card. It is never routed around.
