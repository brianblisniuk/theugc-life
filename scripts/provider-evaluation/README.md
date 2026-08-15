# Property-source evaluation harness

Evaluation-only tooling for the Bali/Dubai inventory-source bake-off specified in
[`docs/PROPERTY_SOURCE_EVALUATION.md`](../../docs/PROPERTY_SOURCE_EVALUATION.md),
governed by [`docs/PROPERTY_CONTENT_COVERAGE_CONTRACT.md`](../../docs/PROPERTY_CONTENT_COVERAGE_CONTRACT.md)
(D060–D064).

**This harness never writes to Supabase, never touches `hotels`, never promotes
anything, and is not imported by the application.**

## Current status

Both provider adapters are **UNVERIFIED** and therefore refuse to run. See
[`docs/evaluations/PROPERTY_SOURCE_BAKEOFF_BALI_DUBAI_2026-08.md`](../../docs/evaluations/PROPERTY_SOURCE_BAKEOFF_BALI_DUBAI_2026-08.md).

## Commands

```bash
# Readiness: credential presence + descriptor runnability. Always safe to run.
npm run eval:sources:status

# Prepare the Dubai pilot probe input from the local (gitignored) workbook.
npm run eval:sources:pilot-probe

# Live extraction — refuses until the descriptor is verified and credentialed.
npx tsx scripts/provider-evaluation/run.ts --provider booking --destination bali
```

## Why a provider run refuses

`adapters/registry.ts` gates execution on the descriptor being verified against
official documentation: a static-content endpoint, a pagination method, field
paths, star semantics, accepted star kinds and resolved provider geography.

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

Set these in `.env.local` (gitignored). Names only ever appear in output;
values are redacted everywhere (`redact.ts`).

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
