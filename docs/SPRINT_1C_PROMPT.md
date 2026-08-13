# Claude Code — Sprint 1C
Title: First Real Dataset — Dubai Pilot

Sprint 1B is reviewed, CI-validated and merged into `main`.

Work on branch:

`claude/sprint-1c-first-real-import`

## Read first

Read in full:

- `/docs/PRD.md`
- `/docs/DATABASE.md`
- `/docs/PERMISSIONS.md`
- `/docs/DECISIONS.md`
- `/docs/HOTEL_DATA_CONTRACT.md`
- `/docs/IMPORT_SPEC.md`
- `/docs/DESTINATION_CATALOG.md`
- `/docs/CANONICAL_PROMOTION_SPEC.md`
- `/docs/SPRINT_1C_REAL_IMPORT_SPEC.md`
- `/docs/SPRINT_1C_PILOT_SELECTION.md`

Sprint 1C docs are approved amendments.

## Required private input

Expected local file:

`data/imports/raw/theugc-life_Sprint1C_Dubai_Pilot_30.xlsx`

This real-data file must remain untracked. Do not copy contact data into source code, tests, docs, logs, or Git.

If the file is missing, stop and report that exact blocker. Do not recreate the dataset from docs or invent contact data.

## Objective

Execute the first real canonical import through **promotion preview**, with no real-data canonical apply yet.

Do not build new product architecture unless a genuine bug in the reviewed pipeline blocks the run. If a bug appears, stop with evidence instead of silently redesigning the pipeline.

## Step 1 — clean environment

- pull the latest branch;
- verify the raw pilot file is ignored by Git;
- start a clean local DB;
- apply all reviewed migrations from empty;
- run baseline tests before the real-data run.

## Step 2 — minimum destination catalog

Ensure only the minimum required hierarchy exists for this pilot:

- `united-arab-emirates`: country, `AE`
- `dubai`: city, `AE`, parent `united-arab-emirates`

Do not create Dubai neighborhood nodes.

## Step 3 — inspect and dry-run

Use the canonical-standard importer. The pilot already conforms to the canonical contract; do not create a source-specific adapter.

Run the existing inspect/stage/dry-run/report workflow against the file.

Expected source counts:

- properties: 30
- contacts: 42
- evidence: 30
- contact verification: 30 verified, 6 probable, 6 inferred

These are validation expectations, not numbers to force.

## Step 4 — QA gate

Before writing review state, confirm:

- 30 reviewable property bundles;
- zero rejected property rows;
- all properties resolve to `dubai`;
- zero destination/country conflicts;
- zero duplicate property keys;
- zero cross-bundle child references;
- all 42 contacts are property-scoped;
- inferred contacts remain inferred;
- zero creator/outreach/intelligence rows created;
- raw file and generated reports remain gitignored/untracked.

If any gate fails, STOP and report the exact affected rows and root cause. Do not proceed to review.

## Step 5 — full review snapshot

Generate the review template.

Create a complete review manifest using this policy:

- property with no credible existing-hotel match candidate -> `approve_create`, destination `dubai`;
- property with any deterministic or plausible existing-hotel match candidate -> `defer` and report the candidate; do not guess create vs match;
- no child override by default;
- verified/probable contacts follow default child policy;
- inferred contacts remain deferred;
- do not force-include inferred contacts.

Apply the full review snapshot to review tables only.

## Step 6 — promotion preview only

Run:

`npm run import:promote -- --batch <batch-id>`

WITHOUT `--apply`.

Confirm preview mode performs zero canonical mutations.

## Required completion report

Report:

- batch ID/status;
- exact inspect/dry-run counts;
- destination resolution counts;
- reviewable/rejected/deferred property counts;
- all hotel match candidates;
- proposed hotels create/match/defer;
- proposed contact create/reuse/skip counts;
- count and IDs/names of inferred contacts deferred (do not expose private emails unnecessarily);
- proposed evidence count;
- all conflicts/warnings;
- zero canonical mutation confirmation for preview;
- zero outreach/intelligence mutation confirmation;
- git status proving raw data/reports are untracked;
- migrations/lint/typecheck/tests/build results after the run.

## STOP CONDITION

STOP after the real-data promotion preview.

Do NOT run `import:promote --apply` for the real pilot in this execution.
Do NOT import the remaining 625 source properties.
Do NOT start coordinates/Instagram enrichment.
Do NOT build map/discovery/CRM/payment/AI/email/community/marketplace features.
Do NOT open or merge a PR automatically.

Commit only code/docs changes if a reviewed-compatible implementation fix was genuinely necessary. If no code change is required, do not create a meaningless commit.
