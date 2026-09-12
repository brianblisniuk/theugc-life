# B07 inference benchmark — run summary, 2026-09-12

**Status:** ANTHROPIC STAGE 1 COMPLETE (real run, both candidates) — OpenAI and
Google remain `not_run_missing_key`. See §7 for the real Anthropic evidence;
§1–§6 below are the prior (baseline-only, no-key) round and are kept as
historical record.
**Corpus:** `b07_gold_corpus_v1` · **Prompt:** `b07_benchmark_prompt_v1` · **Schema:** `b07_benchmark_schema_v1`
**Specification:** [`docs/B07_INFERENCE_BENCHMARK_SPEC.md`](../B07_INFERENCE_BENCHMARK_SPEC.md)
**Governing decision:** D072 — [`docs/B07_GMAIL_COMMERCIAL_MEANING_CONTRACT.md`](../B07_GMAIL_COMMERCIAL_MEANING_CONTRACT.md)

This summary is derived from real local runs. It contains no provider response
content, no raw provider payloads and no secrets — only derived metrics,
tokens counts and estimated costs. Raw run artifacts live in the gitignored
`artifacts/b07-benchmark/` directory and are never committed.

---

## 1. What was actually run

| candidate | provider | requested model | outcome |
|---|---|---|---|
| `benchmark-rules-baseline` | local | `benchmark-lexical-rules-v1` | **RUN** — 175/175 cases |
| `openai-gpt-5-6-luna` | OpenAI | `gpt-5.6-luna` | `not_run_missing_key` |
| `openai-gpt-5-6-terra` | OpenAI | `gpt-5.6-terra` | `not_run_missing_key` |
| `anthropic-sonnet-5` | Anthropic | `claude-sonnet-5` | `not_run_missing_key` at authoring time — **superseded, see §7: RUN, 55/55 cases** |
| `anthropic-haiku-4-5` | Anthropic | `claude-haiku-4-5-20251001` | `not_run_missing_key` at authoring time — **superseded, see §7: RUN, 55/55 cases** |
| `google-gemini-flash` | Google | `gemini-3.8-flash` | `not_run_missing_key` |
| `google-gemini-pro` | Google | `gemini-3.1-pro-preview` (PREVIEW) | `not_run_missing_key` |
| `anthropic-opus-5` | Anthropic | `claude-opus-5` | `not_run_missing_key` (ceiling, finals only) |

`OPENAI_API_KEY`, `ANTHROPIC_API_KEY` and `GEMINI_API_KEY` were all absent from
the execution environment. **No external API call of any kind was made in this
round**, so no model above may be cited as benchmark evidence.

**Integrity correction (this round):** the Google model ids above were
previously `gemini-flash-latest` / `gemini-pro-latest` — floating aliases
Google's own documentation describes as hot-swapped, which is not a
reproducible benchmark identity — and the Anthropic Haiku id was the floating
`claude-haiku-4-5` alias. All three are now pinned to explicit, dated or GA
identities (`gemini-3.8-flash` GA stable, `gemini-3.1-pro-preview` labelled
PREVIEW, `claude-haiku-4-5-20251001` exact dated id); every id remains
overridable via `B07_BENCH_MODEL_<CANDIDATE_ID>` if it moves. This is a
correction to the recorded configuration, not a new external run — the
outcome for every model candidate is still `not_run_missing_key`, and no
model above may be cited as benchmark evidence until a real key is used.

Scored set = 175 cases: the 180-case corpus minus the 5 few-shot exemplars, which
are excluded from scoring because the candidate is shown their answers.

## 2. Corpus

- 180 cases: 110 message-task, 70 thread-task.
- Split: 60 `dev` / 120 `holdout`, disjoint.
- Languages: 111 `en`, 48 `es`, 13 `pt`, 8 `fr`.
- Critical-invariant suite: 126 cases (41 `dev`, 85 `holdout`).

Gold taxonomy coverage (primary gold only):

| axis | distribution |
|---|---|
| disposition | positive 38 · neutral 39 · negative 13 · mixed 12 · ambiguous 8 |
| signals | terms_discussion 35 · interest 28 · (empty set) 22 · request_information 18 · rejection 16 · timing_constraint 16 · redirect 12 · offer 11 · agreement 7 · other_commercial 1 |
| thread_state | negotiating 18 · engaged 17 · unresolved 13 · declined_observed 9 · agreement_observed 7 · ambiguous 6 |
| compensation | unknown 37 · in_kind 13 · paid 7 · hybrid 6 · unpaid 5 · other 2 |

## 3. Stage 0 — BENCHMARK BASELINE (deterministic lexical rules)

> **BENCHMARK BASELINE — NOT PRODUCTION B07 IMPLEMENTATION.** This exists only
> to give the model candidates a floor to beat. It must not be promoted into
> B07 production architecture, and the decision logic structurally refuses to
> nominate it.

**Hard gate: FAIL.** 123 critical cases evaluated, **2 violations**, all of
`temporary_timing_not_permanent_decline` — the baseline reads a dated
availability constraint as an outright decline, exactly the collapse D072 §17/§27
forbids.

| Task M (n=107) | value |
|---|---|
| disposition accuracy | 79.4% |
| disposition macro F1 (all classes) | 0.6902 |
| signal exact-set accuracy | 43.9% (47/107) |
| signal micro F1 | 0.5654 |
| signal macro F1 | 0.4831 |
| signal over-prediction rate | 0.0458 |
| signal under-prediction rate | 0.5878 |
| empty gold signal sets | 25, correctly empty 25 |
| evidence-strength accuracy | 16.8% |

Per-class disposition F1: `ambiguous` 1.000 · `positive` 0.862 · `neutral` 0.836
· `mixed` 0.400 · `negative` 0.353.

| Task T (n=68) | value |
|---|---|
| thread-state accuracy | 76.5% |
| thread-state macro F1 (all classes) | 0.6310 |
| compensation accuracy | 88.2% |
| **unknown predicted as unpaid** | **0** |
| unpaid predicted as unknown | 1 |
| evidence-strength accuracy | 10.3% |

Per-class thread-state F1: `engaged` 1.000 · `agreement_observed` 1.000 ·
`negotiating` 0.788 · `unresolved` 0.776 · `declined_observed` 0.222 ·
`ambiguous` 0.000.

Reliability: first-pass 100%, retries 0%, final 100%, provider errors 0,
timeouts 0 — trivially, since it is local and deterministic.
Economics: no pricing metadata (no tokens are consumed).

### What the baseline result actually tells us

The lexical baseline is respectable on the easy half and collapses exactly where
D072's semantics live:

- it recovers straightforward positives, redirects and clean confirmations;
- it scores **0.000 F1 on `ambiguous` threads and 0.222 on `declined_observed`**,
  because "what the thread currently supports" is not a keyword problem;
- it scores 0.353 on `negative` and 0.400 on `mixed` dispositions — it cannot tell
  a decline from a constrained yes;
- its evidence-strength assessment is near-useless (16.8% / 10.3%) because
  counting matched keywords is not an epistemic judgement;
- and it **fails the critical safety gate outright**.

Notably it did NOT commit the `unknown` → `unpaid` collapse — silence produces no
keyword match, so the rules land on `unknown` by construction. That is luck of
architecture, not safety reasoning, and it should not be read as evidence that a
rules approach is safe on this axis.

**Conclusion for the round:** a deterministic rules approach is not a viable
standalone B07 implementation under D072. It remains useful as the floor every
model candidate must clear by a wide margin, and the evidence does not yet
support or refute a "rules for obvious cases + model for ambiguity" hybrid —
that question needs the model runs.

## 4. Privacy / vendor screen

Verified 2026-09-12. **Passing this screen authorizes nothing about real Gmail.**

| provider | trains on API data by default | standard retention | ZDR | synthetic benchmark | private-Gmail candidacy | verification |
|---|---|---|---|---|---|---|
| Anthropic — Claude API | no | conversation content **not retained by default**; 30 days for Covered Models | yes, on request (per organization) | `synthetic_benchmark_suitable` | `potential_private_gmail_candidate_pending_final_approval` | `official_page_fetched` |
| OpenAI — Platform API | unknown | unknown | unknown | `synthetic_benchmark_suitable` | `undetermined_official_source_unreachable` | `official_page_unreachable_from_this_host` |
| Google — Gemini Developer API (paid) | no (paid tier) | abuse logs, reported 55-day default expiry | unknown | `synthetic_benchmark_suitable` | `undetermined_official_source_unreachable` | `secondary_summary_only` |

### Correction to the round brief's stated baseline facts

The brief stated Anthropic's commercial API has "standard API retention
approximately 30 days". The official
[API and data retention](https://platform.claude.com/docs/en/manage-claude/api-and-data-retention)
page, read on 2026-09-12, says something materially narrower:

> "Only what is technically necessary for the feature to work is retained.
> Conversation content (your prompts and Claude's outputs) is not retained by
> default; the exception is Covered Models, which require 30-day retention."

and

> "Retained data is never used for model training without your express
> permission."

So the 30-day figure applies to Covered Models (Fable/Mythos class), which are
also **not ZDR-eligible unless expressly authorized**. Any B07 vendor approval
must therefore fix the exact model tier before it can state a retention posture.

The same page carries a constraint that is directly relevant to B07's design:
structured-output JSON schemas are compiled to grammars and **cached separately
from message content, without the same protections**. The benchmark schema
contains only D072 enum names and no case content, and a production B07
configuration must preserve that property — no Gmail-derived text, names,
property names or regex patterns in a schema.

OpenAI's and Google's official documentation domains are blocked by this
environment's egress proxy. Their entries record what could and could not be
verified; neither is cleared as a private-Gmail candidate on the strength of a
secondary summary.

## 5. Decision

`DECISION: external_runs_pending` — "No non-baseline candidate was successfully
called, so no provider comparison exists."

The benchmark's own decision logic reached this outcome mechanically, from the
recorded evidence, rather than by editorial judgement.

## 6. Known limitations

See §14 of the specification. In short: `other_commercial` has a single primary
gold instance and a correspondingly high-variance per-label F1;
`evidence_strength` is the most subjective axis and is deliberately not a hard
gate; and the corpus is synthetic by mandate, so any production decision should
be revisited against real, privacy-approved data before B07 ships.

---

## 7. ANTHROPIC STAGE 1 — REAL RUN, 2026-09-12 (this round)

This section supersedes the `not_run_missing_key` rows for
`anthropic-sonnet-5` and `anthropic-haiku-4-5` in §1. A real `ANTHROPIC_API_KEY`
was used for the first time this round. Only OpenAI and Google remain
`not_run_missing_key` — no key was available for either this round, no code
change to those adapters was made, and neither was run.

### 7.0 Transport correction that made this round possible

The Anthropic adapter previously constructed
`thinking: { type: "enabled", effort: <provider-wide-value> }` for every
Anthropic candidate, derived from `provider_id` alone. That is not a valid
current request for either model in the candidate matrix — confirmed
independently against the account's own `GET /v1/models/{id}` response during
this round's availability check (§7.1): `claude-sonnet-5` reports
`thinking.types.enabled.supported: false` / `thinking.types.adaptive.supported:
true` / `effort.supported: true`, and `claude-haiku-4-5-20251001` reports
`effort.supported: false`. The adapter and its inference-config derivation
(`scripts/b07-benchmark/config/inference-config.ts`) now compute
`thinking_mode`/`effort`/`budget_tokens` per EXACT model id via a
`model_capability_profile`, never from `provider_id` alone:

- `claude-sonnet-5`: `thinking: { type: "adaptive" }`, `output_config.effort:
  "medium"` (screening effort — a narrow classification task, cost-conscious;
  a later higher-effort experiment is separate evidence under a different
  digest).
- `claude-haiku-4-5-20251001`: no `thinking` parameter at all, no
  `output_config.effort` — ordinary, non-thinking configuration. Never
  labelled with a borrowed effort value.

The inference-policy version was bumped to
`b07_bench_inference_policy_v2_anthropic_model_capability_aware`, so no result
computed under the old, invalid shape could ever be silently resumed under
this one (none existed — every prior Anthropic row was `not_run_missing_key`).
Mocked transport-contract tests were corrected accordingly
(`tests/b07-benchmark/provider-transport.test.ts`,
`tests/b07-benchmark/inference-config-and-coverage.test.ts`) before any paid
call was made.

**Operational finding, not a code defect:** this execution environment sets a
stray `ANTHROPIC_BASE_URL=https://api.anthropic.com` (no `/v1` path) for
unrelated host purposes. Left in place, every Anthropic request this adapter
sends 404s silently — `GET .../models/{id}` becomes `GET
https://api.anthropic.com/models/{id}`, still a well-formed URL, so it fails
quietly as "unavailable" rather than loudly. This was caught during the Step 1
availability check (both models initially reported `available: false`) and
resolved by unsetting the variable for every live invocation, restoring the
adapter's own correct default (`https://api.anthropic.com/v1`); an independent
raw-`fetch` check against `GET /v1/models/{id}` confirmed both models exist,
are enabled and respond `200` before any billed call was made. No adapter code
change was needed or made for this — it is an environment variable local to
this execution host, not a benchmark defect.

### 7.1 API availability (Step 1)

Checked directly against the account's own model listing before any billed
call, with the stray `ANTHROPIC_BASE_URL` unset:

| model | `GET /v1/models/{id}` | available |
|---|---|---|
| `claude-sonnet-5` | `200` | **yes** |
| `claude-haiku-4-5-20251001` | `200` | **yes** |

Both models are enabled for this account. Neither is `unavailable`.

### 7.2 Live smoke (Step 2) — one DEV case per model, before Stage 1

Case `m-en-dev-002` (a `dev`-split message case, not a few-shot exemplar, not
holdout) was sent once per candidate through the corrected transport, under a
smoke-only run id never reused for Stage 1.

| | Sonnet 5 | Haiku 4.5 |
|---|---|---|
| HTTP status | 200 | 200 |
| requested model | `claude-sonnet-5` | `claude-haiku-4-5-20251001` |
| returned model | `claude-sonnet-5` | `claude-haiku-4-5-20251001` |
| structured output | valid, first pass | valid, first pass |
| `thinking_mode` sent | `adaptive` | (none sent) |
| `output_config.effort` sent | `medium` | (none sent) |
| input tokens | 2,329 | 1,533 |
| output tokens | 32 | 18 |
| thinking tokens (diagnostic) | 0 | not exposed (`null`) |
| latency | 2,395 ms | 1,015 ms |
| estimated cost | ≈$0.0050 | ≈$0.0016 |

Both smoke calls succeeded cleanly on the first attempt — no transport
failure, no retry, no fallback needed. Per the round rules, these two smoke
results are **not** counted as Stage-1 evidence and are excluded from every
metric in §7.3–§7.6 (separate run id, never resumed into the Stage-1 run).

**Cost-affordability check (per the product owner's explicit authorization to
run a complete Stage 1 rather than stop at a prior ~$1.70 approximate
budget):** at measured smoke cost, a full 55-case Stage-1 DEV run projects to
roughly $0.27 for Sonnet and $0.09 for Haiku — about $0.36 total, comfortably
inside the account's small balance. The complete Stage 1 was therefore run in
full for both candidates rather than truncated (§7.3 confirms the actual
measured total was in this range).

### 7.3 Stage 1 — complete run, both candidates, identical case set

Run: full `screen` stage, `dev` split, `--candidate anthropic-sonnet-5
--candidate anthropic-haiku-4-5`, default concurrency 4, default bounded
retry budget 1. Both candidates scored the identical 55-case set (60 `dev`
cases minus the 5 few-shot exemplars — nothing partial, nothing cherry-picked,
no candidate compared against a different case count than the other).

| | `anthropic-haiku-4-5` | `anthropic-sonnet-5` |
|---|---|---|
| requested model | `claude-haiku-4-5-20251001` | `claude-sonnet-5` |
| returned model(s) | `claude-haiku-4-5-20251001` (only) | `claude-sonnet-5` (only) |
| cases attempted | 55/55 | 55/55 |
| identity conflicts | none | none |
| invalidated | no | no |

#### Reliability

| | Haiku 4.5 | Sonnet 5 |
|---|---|---|
| first-pass structured-output rate | 100.0% | 100.0% |
| bounded-retry rate | 0.0% | 0.0% |
| final structured-output rate | 100.0% | 100.0% |
| provider errors | 0 | 0 |
| timeouts | 0 | 0 |

#### Critical invariant hard gate — BOTH CANDIDATES FAIL

| | critical cases | evaluated | violations | gate |
|---|---|---|---|---|
| Haiku 4.5 | 38 | 38 | **3** | **FAIL** |
| Sonnet 5 | 38 | 38 | **5** | **FAIL** |

Per the round's hard gate, aggregate quality cannot override this: a model
with even one critical collapse is not a Stage-1 survivor.

**Every violation, with gold, prediction and a semantic/mechanical call:**

| candidate | case | invariant | gold | prediction | evidence | call |
|---|---|---|---|---|---|---|
| Haiku 4.5 | `m-en-dev-007` | `temporary_timing_not_permanent_decline` | disposition `mixed`, signals `[interest, timing_constraint]` | disposition `mixed`, signals `[rejection, timing_constraint, interest]` | Target: *"We have no availability in November — it's our busiest month. Please do reach out again for January, we'd be glad to look at it then."* | **semantic** — added an unsupported `rejection` signal onto a dated-availability decline that explicitly invites a retry; the invariant exists precisely to catch this. |
| Haiku 4.5 | `m-es-dev-007` | `temporary_timing_not_permanent_decline` | disposition `mixed`, signals `[interest, timing_constraint]` | disposition `mixed`, signals `[rejection, timing_constraint, interest]` | Spanish counterpart of `m-en-dev-007` — same "we're full now, come back in October" retry-invitation pattern. | **semantic**, and notably the SAME collapse reproduced across languages — suggests a systematic Haiku tendency to add `rejection` on "no availability now" phrasing even with an explicit invitation to return. |
| Haiku 4.5 | `t-en-dev-006` | `offer_not_agreement` | thread_state `negotiating` (target verbally agreed to a $600 fee but the creator has not yet confirmed) | thread_state `agreement_observed` | Target: *"Yes — 600 USD is approved on our side. Whenever you're ready, just say the word."* | **semantic** — a one-sided yes still awaiting the creator's own confirmation read as a closed agreement. Also made by Sonnet 5 on the identical case (see below) — a genuinely hard corpus case, not a benchmark-mechanical artifact. |
| Sonnet 5 | `m-en-dev-012` | `temporary_timing_not_permanent_decline` | disposition `mixed`, signals `[interest, terms_discussion, timing_constraint]` | disposition `negative`, signals `[timing_constraint, rejection]` | Target: *"...our marketing budget for this year is fully committed... Try us again in Q2 when the new budget opens."* | **semantic** — a budget-timing constraint with an explicit "try again" invitation collapsed to an outright negative/rejection. |
| Sonnet 5 | `m-es-dev-008` | `temporary_timing_not_permanent_decline` | disposition `mixed`, signals `[interest, terms_discussion, timing_constraint]` | disposition `negative`, signals `[timing_constraint, rejection]` | Spanish counterpart of `m-en-dev-012` — same budget/"vuelva a escribirnos" pattern. | **semantic**, same collapse reproduced cross-lingually. |
| Sonnet 5 | `t-en-dev-006` | `offer_not_agreement` | thread_state `negotiating` | thread_state `agreement_observed` | Same case as the Haiku row above. | **semantic** — identical collapse to Haiku on the same case. |
| Sonnet 5 | `t-en-dev-008` | `temporary_timing_not_permanent_decline` | thread_state `unresolved` | thread_state `declined_observed` | Target: *"November is impossible... Please come back to us for January, we'd be glad to look at it then."* | **semantic** — the thread-level form of the same permanent-decline collapse. |
| Sonnet 5 | `t-en-dev-009` | `interest_not_agreement` | thread_state `engaged` (a reopening case: initial decline, then target reopens interest and asks about October dates) | thread_state `negotiating` | Target reopens: *"...the policy changed last week. If you're still interested we'd very much like to pick this up. Are your October dates still free?"* | **semantic** — a defensible-looking but D072-disallowed escalation: a concrete scheduling question read as an active negotiation rather than reopened interest. |

None of the seven violations are benchmark-mechanical (no schema-parse
failure, no case-selection or scoring-code defect, no identity conflict) — all
seven are the model's own predicted labels tripping an invariant the corpus
deliberately tests for. `t-en-dev-006` is the one case both candidates got
wrong identically, which is worth flagging to the product owner as a
genuinely hard corpus instance (a one-sided verbal "yes" pending the other
side's confirmation) rather than a fluke of either model.

#### Semantic metrics

**Task M (message, n=35 per candidate)**

| | Haiku 4.5 | Sonnet 5 |
|---|---|---|
| disposition accuracy | 88.6% | 80.0% |
| disposition macro F1 | 0.8981 | 0.7551 |
| signal exact-set accuracy | 77.1% (27/35) | 77.1% (27/35) |
| signal micro F1 | 0.8972 | 0.8713 |
| signal macro F1 | 0.8702 | 0.8732 |
| signal over-prediction rate | 0.2041 | 0.1400 |
| signal under-prediction rate | 0.0204 | 0.1200 |
| evidence-strength accuracy | 71.4% | 82.9% |

**Task T (thread, n=20 per candidate)**

| | Haiku 4.5 | Sonnet 5 |
|---|---|---|
| thread-state accuracy | 85.0% | 85.0% |
| thread-state macro F1 | 0.7187 | 0.8577 |
| compensation accuracy | 100.0% | 100.0% |
| `unknown`→`unpaid` count | **0** | **0** |
| evidence-strength accuracy | 80.0% | 90.0% |

Full per-class precision/recall/F1 and evidence-strength confusion matrices
for both tasks and both candidates are in the raw
`artifacts/b07-benchmark/stage1-anthropic-20260912/report.md` (gitignored,
not committed — regenerate with `npm run eval:b07:report -- --run
stage1-anthropic-20260912`).

#### Performance and economics

| | Haiku 4.5 | Sonnet 5 |
|---|---|---|
| latency n (successful) | 55 | 55 |
| median latency | 1,256 ms | 1,773 ms |
| p95 latency | 1,567 ms | 2,070 ms |
| excluded (failed) calls | 0 | 0 |
| input tokens (all attempts) | 84,459 | 126,675 |
| cached input tokens | 0 | 0 |
| output tokens (all attempts) | 1,280 | 2,143 |
| thinking tokens (diagnostic) | not exposed | 0 |
| estimated Stage-1 total cost | **$0.0909** | **$0.2748** |
| estimated cost per case | $0.00165 | $0.00500 |
| projected $ / 1,000 message interpretations | $1.65 | $5.05 |
| projected $ / 1,000 thread interpretations | $1.65 | $4.91 |

Every attempt (including any retry) is counted in these totals; both
candidates had a 0% retry rate this round, so attempts = cases here. Reasoning
tokens are Anthropic-billed as part of `output_tokens`, not added again (see
`config/pricing.ts`). Pricing basis for both: `estimated_from_published_prices`
(Sonnet 5 $2.00/$10.00 per MTok, Haiku 4.5 $1.00/$5.00 per MTok, accessed
2026-09-12) — never measured invoice billing.

### 7.4 Direct comparison — Haiku 4.5 vs Sonnet 5

- **Safety (the gate that actually decides Stage 1):** both FAIL. Haiku: 3
  critical violations / 38 evaluated. Sonnet: 5 critical violations / 38
  evaluated. Neither is a survivor regardless of any other number below.
- **Quality (informational only, given the gate failure):** Haiku has the
  higher message-disposition macro F1 (0.898 vs 0.755) and matches Sonnet on
  signal exact-set accuracy; Sonnet has the higher thread-state macro F1
  (0.858 vs 0.719) and higher evidence-strength accuracy on both tasks. Signal
  micro/macro F1 are close (Haiku 0.897/0.870, Sonnet 0.871/0.873). Neither
  dominates the other on quality alone.
- **Schema reliability:** identical — both 100% first-pass, 0% retry, 0
  provider errors, 0 timeouts.
- **Latency:** Haiku is consistently faster (median 1,256 ms vs 1,773 ms;
  p95 1,567 ms vs 2,070 ms) — expected for a non-thinking efficient-tier model
  against an adaptive-thinking mid-tier model.
- **Cost:** Haiku is roughly 3x cheaper per case ($0.00165 vs $0.00500) and
  per 1,000 interpretations (~$1.65 vs ~$5).
- No scalar combination of the above changes the outcome: the hard gate is
  evaluated first, and both candidates fail it.

### 7.5 Stage-1 survivors

**None.** A survivor requires the complete screening run (satisfied by both)
AND zero critical invariant violations (satisfied by neither). Both
`anthropic-sonnet-5` and `anthropic-haiku-4-5` are disqualified on the hard
gate; their quality/latency/cost numbers above are recorded as evidence for
the external audit and any future re-attempt (e.g. a prompt revision that
specifically targets the `temporary_timing_not_permanent_decline` and
`offer_not_agreement` collapses), not as a basis to nominate either as a
Stage-1 winner. D072 is not relaxed to let either pass.

### 7.6 Hostile-review findings (this round, after the live run)

1. **Same scored DEV case set for both candidates** — confirmed: both
   attempted the identical 55 case ids (set difference is empty either way).
2. **No holdout case accessed** — confirmed: the run manifest and every
   result row record `split: "dev"`; `resolveSelection` was called with
   `split: "dev"` only.
3. **Few-shot examples excluded from scoring** — confirmed: 55 = 60 dev cases
   minus the 5 exemplar ids (`m-en-dev-001`, `m-en-dev-014`, `m-es-dev-005`,
   `t-en-dev-003`, `t-en-dev-011`).
4. **Smoke calls did not contaminate scored results** — confirmed: smoke runs
   used their own run ids (`smoke-anthropic-sonnet-5-<ts>`,
   `smoke-anthropic-haiku-4-5-<ts>`); Stage 1 used a fresh run id
   (`stage1-anthropic-20260912`) with `--resume` not set, so nothing could be
   reused even if the ids had collided.
5. **No pre-fix result reused** — confirmed: no Anthropic result existed
   before this round (every prior row was `not_run_missing_key`), and the
   inference-policy version bump would refuse a mismatched-config resume
   regardless.
6. **Exact requested models correct** — confirmed: `claude-sonnet-5` /
   `claude-haiku-4-5-20251001`, read from `config/candidates.ts` and echoed in
   every result row's `requested_model`.
7. **Returned-model identities internally consistent** — confirmed: each
   candidate's `returned_models` list in `scores.json` has exactly one value,
   identical to its requested model, across all 55 cases; `identity_conflicts`
   is empty for both.
8. **Sonnet actually ran adaptive thinking + medium effort** — confirmed on
   every result row's `inference_config`: `thinking_mode: "adaptive"`,
   `effort: "medium"`.
9. **Haiku actually ran without unsupported effort/adaptive thinking** —
   confirmed: `thinking_mode: "disabled"`, `effort: null`, no `thinking` key
   sent, `output_config.effort` never sent. Independently corroborated by the
   account's own `GET /v1/models/claude-haiku-4-5-20251001` response
   (`effort.supported: false`).
10. **All critical cases evaluated** — confirmed: 38/38 for both candidates
    (§7.3).
11. **Retry calls included in reliability and economics** — confirmed: 0%
    retry rate this round, so no adjustment was needed, but the accounting
    path (`scoreCandidate` sums every attempt) is unconditional and was not
    bypassed.
12. **Thinking tokens not double-billed** — confirmed: Anthropic's
    `reasoning_billed_separately_from_output` is `false` in
    `config/pricing.ts`; the diagnostic `reasoning_tokens` field (0 for
    Sonnet on the smoke case, and folded into `output_tokens` totals for
    Stage 1) is never added a second time.
13. **No API key anywhere in git diff, committed files, generated docs,
    persisted artifacts or logs** — confirmed via a `grep -rn "sk-ant-"`
    sweep of everything staged/tracked before push; the only matches are the
    pre-existing fake test literal `sk-ant-test-0123456789` in
    `tests/b07-benchmark/provider-transport.test.ts`. The real key was read
    only via `readFileSync` from its external path and passed as a
    `process.env` value to a child process — never echoed, logged, or written
    to any file under this repository.
14. **No B07 production code, Gmail data, DB schema or migration 0041** —
    confirmed: only `scripts/b07-benchmark/`, `tests/b07-benchmark/` and
    `docs/` were touched this round; `src/` is untouched; no migration files
    were added.

**Benchmark-mechanical defect found and fixed before any paid call:** this
execution environment's stray `ANTHROPIC_BASE_URL` (§7.0) would have silently
misdirected every Anthropic request had Step 1's independent availability
check not caught it (both models initially reported `available: false`,
prompting the investigation that found the missing `/v1` path segment). No
code change was required — every live invocation this round explicitly
unset the variable — but this is recorded here because a future runner
invocation in the same or a similar environment must do the same, or every
result will silently degrade to `unavailable` rather than fail loudly.
