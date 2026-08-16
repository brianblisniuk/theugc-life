# Property-source evaluation harness

Evaluation-only tooling for the Bali/Dubai inventory-source bake-off specified in
[`docs/PROPERTY_SOURCE_EVALUATION.md`](../../docs/PROPERTY_SOURCE_EVALUATION.md),
governed by [`docs/PROPERTY_CONTENT_COVERAGE_CONTRACT.md`](../../docs/PROPERTY_CONTENT_COVERAGE_CONTRACT.md)
(D060–D064).

**This harness never writes to Supabase, never touches `hotels`, never promotes
anything, and is not imported by the application.**

## Current status

**HBX Group / Hotelbeds is the active evaluation target** and its credentials are
held in the gitignored `.env.local`. Booking and Expedia are preserved as
documented future strategic sources with no direct access.

The API is reachable and the credentials are **valid**. Master data has been
observed — 65 categories, 178 Indonesian and 10 UAE destinations, all enumerated
to exhaustion for **4 of the 50 daily requests**. **No hotel inventory has been
extracted** and no destination code has been promoted into the descriptor. See
[`docs/evaluations/PROPERTY_SOURCE_BAKEOFF_BALI_DUBAI_2026-08.md`](../../docs/evaluations/PROPERTY_SOURCE_BAKEOFF_BALI_DUBAI_2026-08.md).

## Commands

```bash
# Readiness: credential presence + per-capability runnability. Always safe,
# never issues a request.
npm run eval:sources:status

# Credential probe. Costs ONE provider request and bypasses the cache on
# purpose: a cached 200 from yesterday cannot prove today's credential works.
# Re-reports every capability under the runtime it just OBSERVED.
npm run eval:sources:probe

# Category master. Fetches the code→meaning table the hotels operation's
# category codes depend on, paginated to exhaustion, with duplicate detection.
npm run eval:sources:categories

# Geography discovery — destination master data for one country, paginated to
# exhaustion, written as CANDIDATES for review. NOT gated on classification.
npm run eval:sources:geography -- --country ID

# Prepare the Dubai pilot probe input from the local (gitignored) workbook.
npm run eval:sources:pilot-probe

# Live extraction. Fetches the category master first, then enumerates every
# provider entity for the destination.
npx tsx scripts/provider-evaluation/run.ts --provider hotelbeds --destination bali
```

Shared flags: `--max-requests N` (local run ceiling, default 40) and `--no-cache`.

## Static descriptor facts vs runtime observations

These are different kinds of claim and the harness keeps them apart.

A **descriptor** carries what is true about the provider: its endpoints, field
semantics, pagination contract, whether a classification issuer is established.
Those facts do not change between runs.

A **`RuntimeObservation`** carries what was true of _this execution_: whether
egress reached the host, whether the credential was accepted. It starts at
`egress: "unknown"` / `credentials: "untested"`.

Capability gates read both. **`unknown` never blocks** — only a _currently
observed_ block does, because the probe is what decides and it has to be allowed
to run. Blocked runs therefore recover the moment the network does, with no
descriptor edit. Getting this wrong is not cosmetic: a hardcoded "EGRESS
BLOCKED" blocker on the descriptor would keep every capability blocked forever,
so allowlisting the host would change nothing at all.

## Why a provider run can still refuse

**Not** because extraction is unimplemented — the full pipeline (auth →
exhaustive pagination → field-map verification → normalize → metrics →
gitignored artifacts) lives in `execute.ts` and is tested end to end.

`capabilities.ts` assesses each dimension independently — `enumerate_inventory`,
`measure_location`, `measure_media`, `assess_classification`,
`resolve_d060_classification` — and a run proceeds when **any** of them is
measurable.

That matters for the layered-source principle: a provider can be an excellent
inventory, location and media source while its classification needs secondary
verification, and refusing to measure the first three teaches us nothing.
`resolve_d060_classification` remains strict, so nothing about D060 publication
is weakened.

## Field-map verification

Before any aggregate is computed from a live extraction, the descriptor's mapped
paths are checked against the actual payload (`field-verification.ts`). A mapped
path that resolves on **zero** sampled records raises `FIELD_MAP_MISMATCH` and
the run stops.

This is the point. A wrong path does not crash — it reads `undefined` and
reports "coordinate coverage 0%, star coverage 0%" for a provider that supplies
both. That output is indistinguishable from a measurement, and it would be used
to choose a provider. A path mismatch is our bug and must never be published as
the provider's zero.

`classification.codePath` is verified the same way. It is currently recorded as
DOCUMENTED/EXPECTED, not confirmed, and the first real payload settles it.

## Exhaustive enumeration

Master data is enumerated to exhaustion, not sampled. `fetchDestinations` and
`fetchHotelbedsCategoryMaster` both walk the shared paginator until the provider
stops filling pages _and_ its own reported total is satisfied. A single
`from=1&to=1000` request cannot mean "all destinations" — a country with 1001
would silently lose one, and under D061 that is a coverage claim we would be
unable to support. When a budget or quota stop interrupts the walk, the result is
marked **INCOMPLETE** rather than returned as a partial list.

Geography is discovery output, never a hardcoded code. Bali in particular may
require a **union** of several destination codes; one famous town is not Bali,
and an incorrect mapping makes a perfectly exhaustive extraction systematically
incomplete.

## Quota safety

The evaluation account allows **50 requests/day**. Four mechanisms protect it:

- a **persistent ledger** (`.data/provider-evaluation/hotelbeds/`) counting
  provider-reaching requests **across processes**, scoped by account fingerprint;
- a **cross-process lock** in the same directory — two processes both reading
  49/50 would both issue request 50. A second process refuses rather than racing;
  a lock older than the staleness threshold is reclaimed and the reclamation is
  reported, never silent;
- an in-process run budget (default 40, `--max-requests`) leaving ≥10 in reserve;
- an **account-aware response cache**, so reruns cost nothing.

What counts against the allowance:

| Outcome                                                       | Counts?                            |
| ------------------------------------------------------------- | ---------------------------------- |
| Cache hit                                                     | **No** — no request was made       |
| Explicit local egress denial (`x-deny-reason`)                | **No** — it never left the sandbox |
| Any response from the provider, including 4xx/5xx and retries | **Yes**                            |
| Network failure _after_ the request was attempted             | **Counted as possibly consumed**   |

The last row is the honest one. When a connection dies with no response, we
cannot prove Hotelbeds did not receive and count it, so it is recorded as
`provider_reach_unknown` and reported as "possibly consumed" — separately from
the confirmed count, so nothing is overstated in either direction.

The account exposes no authoritative reset timestamp, so a **conservative 24-hour
rolling window** is used: it can under-spend, never over-spend. A corrupt ledger
**fails closed** — treating it as empty would silently restore the allowance.

## Completing a descriptor

Fill in an adapter from **official documentation only**. Each file carries a
numbered checklist. Record a URL and access date in `sources` for every claim,
then set `documentationStatus: "verified"`.

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
environment variables take precedence over the file.

Names only ever appear in output; values are redacted everywhere (`redact.ts`)
and are never printed, logged or written to an artifact. Auth headers and
signatures are redacted in diagnostics too.

| Provider  | Variables                                              |
| --------- | ------------------------------------------------------ |
| Hotelbeds | `HOTELBEDS_API_KEY`, `HOTELBEDS_SECRET`                |
| Booking   | `BOOKING_DEMAND_API_TOKEN`, `BOOKING_AFFILIATE_ID`     |
| Expedia   | `EXPEDIA_RAPID_API_KEY`, `EXPEDIA_RAPID_SHARED_SECRET` |

## Output

Everything is written under `.data/provider-evaluation/`, which is **gitignored**.
Raw provider responses and property-level extracts must never be committed; only
aggregate metrics belong in the evaluation report, copied across deliberately.

## Network requirement

The live bake-off needs egress to the provider API hosts.
`api.test.hotelbeds.com` is allowlisted. The documentation domains
`developers.booking.com`, `developers.expediagroup.com` and
`developers.google.com` are not.

A proxy denial is a **technical error, not a domain fact**. The client detects it
before any status-based classification, so a 403 from the sandbox is never
reported as an authentication failure against a credential that was never tested.

**Node's built-in `fetch` ignores `HTTPS_PROXY`.** Without
`NODE_USE_ENV_PROXY=1` (Node ≥ 22.21) requests bypass the proxy, get
intercepted, and return a denial — so a perfectly reachable host reports as
`EGRESS_BLOCKED`. The `eval:sources:*` commands set the flag; if you invoke
`run.ts` directly, set it yourself. `EgressBlockedError` detects the
configured-but-unused proxy and says so, because "fix your env var" and "change
the org allowlist" are very different next actions.
