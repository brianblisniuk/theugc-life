# Sprint 1C — First Real Import

Status: Approved.

## Goal

Run the first real-data cohort through the existing canonical pipeline without changing the architecture around the source workbook.

Flow:

`canonical XLSX -> inspect -> stage -> dry-run -> full review snapshot -> promotion preview -> external approval -> apply`

The first Sprint 1C execution STOPS after promotion preview. Actual canonical mutation requires a subsequent explicit approval.

## Pilot

Expected local file:

`data/imports/raw/theugc-life_Sprint1C_Dubai_Pilot_30.xlsx`

The file is private and must remain gitignored.

Expected contract counts:

- 30 properties
- 42 contacts: 30 verified, 6 probable, 6 inferred
- 30 property_exists evidence rows
- country AE
- destination Dubai
- destination_slug `dubai`

The file already conforms to HOTEL_DATA_CONTRACT.md. Do not add a source-specific parser.

## Selection policy

The cohort contains 30 curated 4–5 star Dubai properties with official property sources and at least one verified official property-scoped endpoint. Known duplicate-property/data-quality-flag rows and Group HQ entities are excluded. Broader-than-property contacts are excluded from this first cohort. Five source contacts marked verified but missing a primary source URL are held out pending provenance recovery.

## Minimum destination catalog

Ensure these canonical nodes exist before staging:

- `united-arab-emirates`: country, AE
- `dubai`: city, AE, parent `united-arab-emirates`

Do not create neighborhood nodes for this pilot.

## QA gates

Stop if any of these fail:

- 30 reviewable property bundles
- zero rejected property rows
- every property resolves to canonical `dubai`
- zero country/destination conflicts
- zero duplicate property bundle keys
- zero cross-property child references
- inferred contacts remain inferred
- no seed outreach/intelligence mutations
- source and reports remain untracked

Differences from expected contact/evidence counts must be explained, never forced.

## Review policy

The manifest is a full snapshot.

- No credible existing-hotel match candidate: `approve_create` in Dubai.
- Any deterministic/plausible existing-hotel match candidate: `defer` and report it for external review; do not guess create vs match.
- Use Sprint 1B child defaults. Do not force-include inferred contacts.

Apply the review snapshot, then run promotion in PREVIEW mode only.

## Preview report

Report batch status, create/match/defer plan, contact create/reuse/skip counts, inferred contacts deferred, evidence plan, conflicts/match candidates, preview zero-mutation confirmation, and zero outreach/intelligence mutation confirmation.

STOP after the preview.

## After approval

A later explicit instruction may run the reviewed canonical apply. That run must verify committed counts, lineage/provenance, destination consistency, repeat-run idempotency, and zero creator-intelligence seeding.

## Non-goals

Do not import all 655 source properties, enrich coordinates/Instagram, build organization resolution, build UI, or begin Sprint 2 in Sprint 1C.
