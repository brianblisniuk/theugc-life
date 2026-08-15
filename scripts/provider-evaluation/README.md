# Property-source evaluation harness

Evaluation-only tooling for the Bali/Dubai inventory-source bake-off specified in
[`docs/PROPERTY_SOURCE_EVALUATION.md`](../../docs/PROPERTY_SOURCE_EVALUATION.md),
governed by [`docs/PROPERTY_CONTENT_COVERAGE_CONTRACT.md`](../../docs/PROPERTY_CONTENT_COVERAGE_CONTRACT.md)
(D060–D064).

**This harness never writes to Supabase, never touches `hotels`, never promotes
anything, and is not imported by the application.**

## Current status

Both provider adapters are **PARTIALLY VERIFIED** — their endpoints, auth,
pagination and field paths are recorded from official documentation, but each
still has named gaps (Booking's `stars_type` enum; both providers' Bali/Dubai
geography ids) and neither has credentials. They therefore refuse to run. See
[`docs/evaluations/PROPERTY_SOURCE_BAKEOFF_BALI_DUBAI_2026-08.md`](../../docs/evaluations/PROPERTY_SOURCE_BAKEOFF_BALI_DUBAI_2026-08.md).

## Commands

```bash
# Readiness: credential presence + per-capability runnability. Always safe.
npm run eval:sources:status

# Credential probe. Costs ONE provider request and bypasses the cache on
# purpose: a cached 200 from yesterday cannot prove today's credential works.
npm run eval:sources:probe

# Geography discovery — fetches destination master data for a country and
# writes candidate codes for review. NOT gated on classification.
npm run eval:sources:geography -- --country ID

# Prepare the Dubai pilot probe input from the local (gitignored) workbook.
npm run eval:sources:pilot-probe

# Live extraction — refuses until the descriptor is verified and credentialed.
npx tsx scripts/provider-evaluation/run.ts --provider booking --destination bali
```

## Why a provider run refuses

**Not** because extraction is unimplemented — the full pipeline (auth →
exhaustive pagination → raw-count evidence → normalize → metrics → gitignored
artifacts) lives in `execute.ts` and is tested end to end.

`capabilities.ts` assesses each dimension independently — `enumerate_inventory`,
`measure_location`, `measure_media`, `assess_classification`,
`resolve_d060_classification` — and a run proceeds when **any** of them is
measurable.

That matters for the layered-source principle: a provider can be an excellent
inventory, location and media source while its classification needs secondary
verification, and refusing to measure the first three teaches us nothing.
`resolve_d060_classification` remains strict, so nothing about D060 publication
is weakened.

## Quota safety

The evaluation account allows **50 requests/day**. Three mechanisms protect it:

- a **persistent ledger** (`.data/provider-evaluation/hotelbeds/`) counting
  provider-reaching requests **across processes**, scoped by account fingerprint;
- an in-process run budget (default 40, `--max-requests`) leaving ≥10 in reserve;
- an **account-aware response cache**, so reruns cost nothing.

Cache hits and egress denials never consume quota. Provider 4xx/5xx and
provider-reaching retries do.

This is the point of the design. Guessed field paths do not crash — they read
`undefined` and report "coordinate coverage 0%, star coverage 0%" for a provider
that supplies both. That output is indistinguishable from a measurement, and it
would be used to choose a provider.

## Completing a descriptor

Fill in `adapters/booking.ts` or `adapters/expedia.ts` from **official
documentation only** (`developers.booking.com`, `developers.expediagroup.com`).
Each file carries a numbered checklist. Record a URL and access date in `sources`
for every claim, then set `documentationStatus: "verified"`.

Two rules that are easy to break:

- **Use the static-content path, not availability/search.** "Which properties
  have a room for these dates" is a different question from "which properties
  exist", and only the second can define a coverage universe.
- **A field named `stars` is not automatically a hospitality classification.**
  Only qualifier values whose provenance can be stored and cited belong in
  `starKindsAcceptedAsD060Evidence`. Guest-review scores never do — map them to
  `fieldMap.reviewScore` so the harness can prove they stay separate.

## Credentials

Put these in **`.env.local`** (gitignored) — the CLI loads it automatically via
Node's built-in `process.loadEnvFile`, so no dependency is involved. Exported
environment variables take precedence over the file, so an explicit
`EXPEDIA_RAPID_API_KEY=… npx tsx …` still wins.

Names only ever appear in output; values are redacted everywhere (`redact.ts`)
and are never printed, logged or written to an artifact.

| Provider | Variables                                              |
| -------- | ------------------------------------------------------ |
| Booking  | `BOOKING_DEMAND_API_TOKEN`, `BOOKING_AFFILIATE_ID`     |
| Expedia  | `EXPEDIA_RAPID_API_KEY`, `EXPEDIA_RAPID_SHARED_SECRET` |

## Output

Everything is written under `.data/provider-evaluation/`, which is **gitignored**.
Raw provider responses and property-level extracts must never be committed; only
aggregate metrics belong in the evaluation report, copied across deliberately.

## Network requirement

The live bake-off needs egress to the provider documentation and API hosts. In
the environment this block ran in, all of them were blocked by the egress proxy
(HTTP 403 on CONNECT): `developers.booking.com`, `developers.expediagroup.com`,
`developers.google.com`, `demandapi.booking.com`, `api.ean.com`.
