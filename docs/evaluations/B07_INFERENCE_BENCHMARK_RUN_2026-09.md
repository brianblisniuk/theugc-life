# B07 inference benchmark — run summary, 2026-09-12

**Status:** SCORING-V2 INTEGRITY CORRECTION COMPLETE. §11 (this round)
corrects a candidate-dependent-gold-support defect in the scorer used to
produce §10's macro-F1 hard-gate reading, implements a versioned
`b07_benchmark_scoring_v2` policy, and — because raw §10 inference artifacts
no longer exist (see §11.1) — performs an exact-same-configuration Stage-1
**replication** run (`stage1-anthropic-v2-replication-20260912`) rather than
reusing or fabricating §10's numbers. §10's own PROMPT-V2 / CORPUS-V2 Stage 1
below is kept, byte-for-byte, as the historical scoring-v1 record; **no
scoring-v1 report is reinterpreted as scoring-v2 evidence, and no replication
run is presented as though it were the original §10 run** — see §11 for the
full correction, the replication evidence, and the current Stage-1
disposition for both Anthropic candidates. OpenAI and Google remain
`not_run_missing_key`; no OpenAI/Google/holdout/Stage-2 call was made this
round.
**Corpus:** `b07_gold_corpus_v1` (§1–§7, historical) → `b07_gold_corpus_v2`
(§8–§10, current) · **Prompt:** `b07_benchmark_prompt_v1` (§1–§7, historical) →
`b07_benchmark_prompt_v2` (§8–§10, current) · **Schema:** `b07_benchmark_schema_v1`
(unchanged)
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

---

## 8. DEV corpus audit correction — v1 → v2 (this round)

External audit of the §7 v1 Anthropic run found ONE benchmark inconsistency:
`t-en-dev-009` was internally over-constrained relative to what D072 §27
actually permits. This section documents the correction, the sweep performed
to check for analogous defects elsewhere in the corpus, and the resulting
version bump.

### 8.1 Finding 1 — `t-en-dev-009`

The case: target previously declined ("Sorry, no — we're not doing creator
collaborations this year."); later, target reopens ("Update: the policy
changed last week. If you're still interested we'd very much like to pick
this up. Are your October dates still free?").

v1 tagging: primary gold `thread_state: engaged`; acceptable
`["engaged", "unresolved"]`; `critical_invariants` included
`interest_not_agreement`, whose predicate (`scoring/invariants.ts`) fires on
`thread_state === "negotiating"` OR `"agreement_observed"` — meaning
`negotiating` was flatly forbidden for this case regardless of what the
reopened conversation actually contained.

Why that is wrong under D072 §27 (quoted in full above, §27 bullet "A target
says yes, but the creator never explicitly accepts" and the reopening
bullet): D072 does not say every reopening must resolve to `engaged`. A
reopened conversation that has moved into concrete scheduling/term
exploration can legitimately be `negotiating`. "Are your October dates still
free?" is a concrete scheduling question — prompt v1 itself already defines
dates as a potential commercial term (`terms_discussion`: "engages with the
commercial terms (rates, compensation, deliverables, dates as terms)"). Sonnet
5 predicted `negotiating` on this case in v1 and was counted as a CRITICAL
violation; the external audit found that reading defensible, not a semantic
collapse, and found the invariant's blanket prohibition on this case
specifically over-constrained.

**Correction applied, in `b07_gold_corpus_v2_thread.jsonl` only:**

| field | v1 | v2 |
| --- | --- | --- |
| `expected.thread_state` | `engaged` | `engaged` (**unchanged** — primary gold is not being changed to flatter any model) |
| `acceptable.thread_state` | `["engaged", "unresolved"]` | `["engaged", "unresolved", "negotiating"]` |
| `critical_invariants` | `["reopening_supersedes_decline", "unknown_not_unpaid", "interest_not_agreement", "unsupported_compensation_unknown"]` | `["reopening_supersedes_decline", "unknown_not_unpaid", "unsupported_compensation_unknown"]` (`interest_not_agreement` **removed**) |
| `gold_rationale` | original text | original text **preserved**, with an appended `CORPUS v2 CORRECTION` paragraph explaining the change and its D072 §27 basis |

`reopening_supersedes_decline`, `unknown_not_unpaid` and
`unsupported_compensation_unknown` are unchanged and still apply — this
correction touches exactly one invariant tag and one acceptable-answer array,
nothing else about the case.

### 8.2 Audit of every other case tagged `interest_not_agreement`

Before bumping the corpus version, every case (dev AND holdout) carrying the
`interest_not_agreement` tag was inspected for the same defect. The predicate
only has two branches: message-level (fires on a predicted `agreement`
signal) and thread-level (fires on `negotiating` or `agreement_observed`).
The message-level branch was never at risk — it fires strictly on the
`agreement` signal, so a message case correctly tagged `interest_not_agreement`
remains correctly tagged even when it also contains real `terms_discussion`
(D072 §27: "asking about rates opens a negotiation; it does not close one" —
an `agreement` signal would be wrong there regardless). Message-level cases
inspected and confirmed correctly tagged (no change): `m-en-dev-020`,
`m-en-dev-023`, `m-en-hold-013`, `m-en-hold-018`, `m-en-hold-035`,
`m-es-hold-011`, `m-es-hold-015`, `m-es-hold-018`.

The thread-level branch is where the `t-en-dev-009` defect lived, so every
OTHER thread case tagged `interest_not_agreement` was read in full and
checked for actual terms/offer/rate/deliverable/concrete-scheduling
discussion (the test for whether `negotiating` would be a defensible reading
D072 forbids the tag from ruling out):

| case | split | content | verdict |
| --- | --- | --- | --- |
| `t-en-dev-001` | dev | target asks for media kit + past work examples | interest/information-request only — **correctly tagged, unchanged** |
| `t-es-dev-001` | dev | Spanish counterpart of the above | same — **unchanged** |
| `t-pt-dev-001` | dev | Portuguese counterpart | same — **unchanged** |
| `t-en-hold-001` | holdout | target says "great fit", asks for media kit, takes it to the GM | interest + internal progress only — **unchanged** |
| `t-en-hold-016` | holdout | creator is shortlisted; board decides later | shortlisting is engagement, not term discussion — **unchanged** |
| `t-en-hold-027` | holdout | three creator-sent follow-ups; target's one reply is "interested, can we speak next week" | target-side interest only, no terms — **unchanged** |
| `t-es-hold-001` | holdout | Spanish counterpart of `t-en-hold-001` | same — **unchanged** |
| `t-es-hold-013` | holdout | Spanish counterpart of `t-en-hold-027` | same — **unchanged** |

None of these contain rates, price, deliverables, a concrete offer, or
scheduling raised as an actual commercial term (as opposed to `t-en-dev-009`'s
"are your October dates still free?" arriving inside a reopened, previously
negotiated-adjacent thread). `negotiating` is correctly forbidden for all
eight — they were left exactly as they were. A permanent regression test
(`tests/b07-benchmark/corpus.test.ts`, describe block "v2 corpus correction
(Finding 1...)") pins this exact list going forward.

A companion sweep checked the inverse direction across the WHOLE corpus:
does any case combine `interest_not_agreement` with an `acceptable.thread_state`
that already includes `negotiating` or `agreement_observed` (a self-
contradiction independent of any model result)? Zero hits, before or after
the correction — `t-en-dev-009` was a "the tag is too strict for what D072
actually allows" defect, not a "the acceptable set already contradicts the
tag" defect.

### 8.3 HOLDOUT check (no model result inspected)

Per the round's constraint, no holdout model result exists to inspect, and
none was created. The mechanical sweep above (§8.2) covers holdout cases
tagged `interest_not_agreement` equally with dev cases, using only the
case's own authored text and D072 — never a model prediction — as the basis
for judgement. Two holdout cases, `t-en-hold-009` and `t-es-hold-009`, are
independently notable: they are reopening cases structurally identical in
shape to `t-en-dev-009` (prior decline → policy-change reopening → a
scheduling question), and their **v1 tagging already gets this right** —
`critical_invariants` on both is `["reopening_supersedes_decline",
"unknown_not_unpaid", "unsupported_compensation_unknown"]` (no
`interest_not_agreement`), and `acceptable.thread_state` already includes
`negotiating`. This confirms `t-en-dev-009` was an isolated authoring
oversight in the original v1 corpus, not evidence of a systematic mistagging
pattern — the correct pattern was already present elsewhere in the same
corpus. **No holdout case required a correction; none was touched.**

### 8.4 Version bump and v1/v2 identity separation

- New fixtures: `scripts/b07-benchmark/fixtures/b07_gold_corpus_v2_message.jsonl`
  and `b07_gold_corpus_v2_thread.jsonl`. The v2 message fixture is
  byte-for-byte identical to v1 (no message case changed); the v2 thread
  fixture differs from v1 in exactly the one case described in §8.1.
- `scripts/b07-benchmark/fixtures/b07_gold_corpus_v1_message.jsonl` and
  `b07_gold_corpus_v1_thread.jsonl` remain on disk, **untouched** (confirmed
  via `git diff` before this round's commit — zero diff against the base
  head), as the permanent historical record backing §1–§7's v1 evidence.
- `CORPUS_VERSION` (`scripts/b07-benchmark/corpus/schema.ts`) bumped
  `b07_gold_corpus_v1` → `b07_gold_corpus_v2`; `FIXTURE_FILES`
  (`scripts/b07-benchmark/corpus/load.ts`) now loads the v2 files.
  `corpus_version` is baked into every run manifest and every result row
  (`cli.ts`, `run/runner.ts`), and `cli.ts`'s own resume/report logic refuses
  to mix a stored run computed under one corpus version into a report
  rendered under a different one (`refusing to resume run ...: version
  mismatch`) — so no v1 scored result can be silently presented as v2
  evidence, structurally, not just by convention.
- Every other corpus property is unchanged: 180 cases, 60 dev / 120 holdout,
  the same 5 few-shot exemplar ids, the same taxonomy coverage, the same
  critical-invariant suite membership (126 cases) except for the single
  removed tag on `t-en-dev-009`.

---

## 9. Prompt v2 — provider-neutral conservative clarifications

### 9.1 What changed and why

v1's shared preamble already stated several D072 boundaries in prose (an
offer is not agreement; interest is not agreement; rates-request opens
rather than closes a negotiation), but the §7.3 v1 run showed two systematic
collapses that v1's prompt text did not address as an explicit, actionable
rule:

1. a dated "no availability now" reply that also invites a retry later was
   read as an outright `rejection`/permanent decline (both candidates, on
   both an English and a Spanish case each — `temporary_timing_not_permanent_decline`);
2. a one-sided target "yes" still awaiting the creator's own confirmation was
   read as `agreement_observed` (both candidates, identically, on
   `t-en-dev-006` — `offer_not_agreement`).

`b07_benchmark_prompt_v2` (`scripts/b07-benchmark/prompt/render.ts`) adds
four explicit rules (RULE A–D) to the shared preamble, restating D072 §27's
own prose examples in generic, fictional wording:

- **RULE A** (temporary unavailability is not rejection) — do not add a
  `rejection` signal or classify `negative`/`declined_observed` merely
  because a reply contains "no"/"can't"/"impossible"/"no availability" when
  the SAME reply also explicitly invites a future retry; prefer
  `timing_constraint` plus any genuinely supported `interest`/
  `terms_discussion`, disposition usually `mixed` (sometimes `neutral`), not
  `negative`.
- **RULE B** (one-sided acceptance is not yet thread agreement) — a target's
  `agreement`-shaped "yes" to a specific proposed term is real evidence for
  THAT message, but `agreement_observed` at the thread level requires the
  chronology to show BOTH sides confirming the SAME arrangement; absent a
  later creator-side confirmation, the thread state is `negotiating`. Runs
  symmetrically for an unconfirmed creator-sent acceptance.
- **RULE C** (reopening is not read back into the decline it reopens) — a
  reopening supersedes a current `declined_observed` summary, then the
  reopened conversation is classified on its own merits: renewed interest
  alone → `engaged`; concrete scheduling/term/offer discussion → `negotiating`;
  explicit two-sided confirmation → `agreement_observed`; insufficient/
  conflicting evidence → `unresolved`/`ambiguous`.
- **RULE D** (a scheduling question is not agreement) — "are your dates
  still free?" tests availability; depending on context it can support
  `engaged` or `negotiating`, never `agreement_observed` alone.

### 9.2 Provider neutrality — proof, not assertion

- `PROMPT_VERSION` bumped `b07_benchmark_prompt_v1` → `b07_benchmark_prompt_v2`
  (`scripts/b07-benchmark/prompt/render.ts`), participating in run/result
  identity exactly like `CORPUS_VERSION`.
- The four rules live in `SHARED_PREAMBLE`, the same single template string
  every task/provider draws from — there is no provider argument anywhere in
  the prompt-building API (`buildSystemPrompt(task)` takes only `"message" |
  "thread"`), so per-provider tuning is structurally impossible, not merely
  avoided by convention. `tests/b07-benchmark/schema-and-prompt.test.ts`
  asserts the rules text is byte-identical between the message and thread
  system prompts.
- No OpenAI- or Anthropic-specific wording was added; the rules use the same
  generic vocabulary (`timing_constraint`, `negotiating`, `agreement_observed`,
  etc.) already defined in the taxonomy section of the prompt. When OpenAI
  and Google are run in a future round, they receive this exact same prompt
  text — no new adapter-side prompt branch was added for Anthropic.

### 9.3 No leakage

- No scored case id or `gold_rationale` text appears in the rule prose
  (verified both by hand and by
  `tests/b07-benchmark/schema-and-prompt.test.ts` iterating the full corpus
  against the rendered system prompt).
- The RULE A/B fictional examples ("We're full in November, but please
  contact us for January." / "Could you cover a $500 fee?") are original
  wording, not copied verbatim from any scored case's message text — the
  same test suite asserts no non-few-shot case's message text appears
  anywhere in the shared system prompt.
- No new few-shot exemplar was added; the five existing exemplar ids
  (`m-en-dev-001`, `m-en-dev-014`, `m-es-dev-005`, `t-en-dev-003`,
  `t-en-dev-011`) are unchanged, still all `dev`, still excluded from every
  scored set.

### 9.4 One revision only

This is the round's single prompt-v2 design. No prompt v3 was created after
seeing the §10 results below, even though neither candidate is a full
Stage-1 survivor — see §10.5/§13.

---

## 10. ANTHROPIC STAGE 1 v2 — REAL RUN, 2026-09-12 (this round)

Run id: `stage1-anthropic-v2-20260912`. Full `screen` stage, `dev` split,
`--candidate anthropic-sonnet-5 --candidate anthropic-haiku-4-5`, default
concurrency 4, default bounded retry budget 1 — identical operational
parameters to the §7.3 v1 run. Corpus: `b07_gold_corpus_v2`. Prompt:
`b07_benchmark_prompt_v2`. Inference policy: unchanged from §7 —
`b07_bench_inference_policy_v2_anthropic_model_capability_aware` (Sonnet 5:
adaptive thinking, `output_config.effort: "medium"`; Haiku 4.5: no thinking
parameter, no effort — neither transport was touched this round, per the
round's explicit instruction not to change them). `ANTHROPIC_BASE_URL` was
unset before every live invocation, same operational note as §7.0.

### 10.0 Live smoke (before Stage 1)

Case `m-en-dev-002` (same dev case used for the §7.2 v1 smoke), one call per
candidate, under a smoke-only run id never reused for Stage 1:

| | Sonnet 5 | Haiku 4.5 |
| --- | --- | --- |
| HTTP status | 200 | 200 |
| structured output | valid, first pass | valid, first pass |
| input tokens | 3,224 | 2,132 |
| output tokens | 31 | 18 |
| latency | 1,852 ms | 1,473 ms |
| estimated cost | ≈$0.00676 | ≈$0.00222 |

Input tokens rose ~38% over the §7.2 v1 smoke on the identical case (Sonnet
2,329→3,224; Haiku 1,533→2,132), consistent with the added RULE A–D text —
output tokens did not materially change. Projected full 55-case Stage-1 cost
from this smoke: ≈$0.37 for Sonnet, ≈$0.12 for Haiku, ≈$0.49 total —
comfortably inside the remaining account balance (already-spent total from
the prior round plus this smoke stayed under $0.4). The complete Stage 1 was
run in full for both candidates; §10.1 confirms the actual measured total
matched this projection closely.

### 10.1 Stage 1 — complete run, both candidates, identical case set

Both candidates scored the identical 55-case set (60 `dev` cases minus the 5
few-shot exemplars) — same set as §7.3, now under corpus v2/prompt v2.

| | `anthropic-haiku-4-5` | `anthropic-sonnet-5` |
| --- | --- | --- |
| requested model | `claude-haiku-4-5-20251001` | `claude-sonnet-5` |
| returned model(s) | `claude-haiku-4-5-20251001` (only) | `claude-sonnet-5` (only) |
| cases attempted | 55/55 | 55/55 |
| identity conflicts | none | none |

**Reliability** (identical structure to §7.3, both candidates 100%/0%/100%,
0 provider errors, 0 timeouts — see the table below):

| | Haiku 4.5 | Sonnet 5 |
| --- | --- | --- |
| first-pass structured-output rate | 100.0% | 100.0% |
| bounded-retry rate | 0.0% | 0.0% |
| final structured-output rate | 100.0% | 100.0% |
| provider errors | 0 | 0 |
| timeouts | 0 | 0 |

#### Critical invariant hard gate

| | critical cases | evaluated | violations | gate |
| --- | --- | --- | --- | --- |
| Haiku 4.5 | 38 | 38 | **2** | **FAIL** |
| Sonnet 5 | 38 | 38 | **0** | **PASS** |

Sonnet 5 clears the critical-invariant hard gate under v2 — the first time
either Anthropic candidate has done so in this benchmark. Haiku 4.5 still
fails it (2 violations, both the same invariant as before).

#### Semantic metrics

**Task M (message, n=35 per candidate)**

| | Haiku 4.5 | Sonnet 5 |
| --- | --- | --- |
| disposition accuracy | 91.4% | 94.3% |
| disposition macro F1 | 0.9153 | **0.7596** |
| signal exact-set accuracy | 80.0% (28/35) | 91.4% (32/35) |
| signal micro F1 | 0.9109 | 0.9462 |
| signal macro F1 | 0.8866 | 0.9442 |
| signal over-prediction rate | 0.1458 | 0.0426 |
| signal under-prediction rate | 0.0417 | 0.0638 |
| evidence-strength accuracy | 71.4% | 71.4% |

**Task T (thread, n=20 per candidate)**

| | Haiku 4.5 | Sonnet 5 |
| --- | --- | --- |
| thread-state accuracy | 95.0% | 100.0% |
| thread-state macro F1 | 0.8000 | 1.0000 |
| compensation accuracy | 100.0% | 100.0% |
| `unknown`→`unpaid` count | **0** | **0** |
| evidence-strength accuracy | 80.0% | 95.0% |

#### Performance and economics

| | Haiku 4.5 | Sonnet 5 |
| --- | --- | --- |
| median latency | 1,235 ms | 1,717 ms |
| p95 latency | 1,503 ms | 2,197 ms |
| input tokens (all attempts) | 117,404 | 175,900 |
| output tokens (all attempts) | 1,261 | 2,277 |
| thinking tokens (diagnostic) | 0 | 164 |
| estimated Stage-1 total cost | **$0.123709** | **$0.374570** |
| estimated cost per case | $0.002249 | $0.006810 |
| projected $ / 1,000 message interpretations | $2.2502 | $6.8441 |
| projected $ / 1,000 thread interpretations | $2.2476 | $6.7513 |

Pricing basis unchanged from §7.3: `estimated_from_published_prices`, same
per-token rates, never measured invoice billing. Total measured spend this
round (Stage 1 + smoke, both candidates): ≈$0.507.

### 10.2 V1 → V2 comparison

| metric | Haiku v1 | Haiku v2 | Δ | Sonnet v1 | Sonnet v2 | Δ |
| --- | --- | --- | --- | --- | --- | --- |
| critical violations | 3 | 2 | −1 | 5 (4 valid + 1 corrected) | 0 | −5 (−4 valid, −1 corrected) |
| hard gate | FAIL | FAIL | unchanged | FAIL | **PASS** | flipped |
| disposition macro F1 | 0.8981 | 0.9153 | +0.0172 | 0.7551 | 0.7596 | +0.0045 |
| signal exact-set accuracy | 77.1% | 80.0% | +2.9pp | 77.1% | 91.4% | +14.3pp |
| signal micro F1 | 0.8972 | 0.9109 | +0.0137 | 0.8713 | 0.9462 | +0.0749 |
| thread-state accuracy | 85.0% | 95.0% | +10pp | 85.0% | 100.0% | +15pp |
| thread-state macro F1 | 0.7187 | 0.8000 | +0.0813 | 0.8577 | 1.0000 | +0.1423 |
| compensation accuracy | 100.0% | 100.0% | unchanged | 100.0% | 100.0% | unchanged |
| first-pass schema valid | 100.0% | 100.0% | unchanged | 100.0% | 100.0% | unchanged |
| median latency | 1,256 ms | 1,235 ms | −21 ms | 1,773 ms | 1,717 ms | −56 ms |
| est. cost/case | $0.00165 | $0.002249 | +$0.0006 | $0.00500 | $0.006810 | +$0.0018 |

Cost/latency moved slightly against both candidates (longer system prompt =
more input tokens for the same output); this is the expected, disclosed
price of the added rule text, not a reliability regression.

**Separating (A) benchmark-correction improvement from (B) actual model
improvement**, per-case, using the raw v1 predictions (§7.3) against the raw
v2 predictions (this round's `results.jsonl`):

| case | v1 prediction (violating) | v2 prediction | still a violation under v2? | why |
| --- | --- | --- | --- | --- |
| `t-en-dev-009` (Sonnet) | `negotiating` | `engaged` (exact primary gold) | no | **(B) actual model improvement.** Sonnet's v2 answer is the unmodified v1 primary gold value — it does not rely on the newly-added `negotiating` acceptable value at all. The corpus correction (§8.1) was NOT the reason this case stopped being a violation; RULE C's explicit "renewed interest alone → engaged" guidance was. |
| `m-en-dev-012` / `m-es-dev-008` (Sonnet) | `negative`/`[rejection, timing_constraint]` | `mixed`/`[interest, timing_constraint]` (matches gold) | no | **(B) actual model improvement** — RULE A's explicit "do not add rejection when the reply also invites a retry" directly targets this exact pattern. |
| `t-en-dev-006` (Sonnet + Haiku) | `agreement_observed` | `negotiating` (matches gold) — **both candidates** | no | **(B) actual model improvement** — RULE B's explicit "a one-sided yes... is negotiating, not agreement_observed" directly targets this. The hardest v1 case (both models missed it identically) is fixed for both under v2. |
| `t-en-dev-008` (Sonnet) | `declined_observed` | `unresolved` (matches gold) | no | **(B) actual model improvement** — RULE A/C's timing-constraint guidance at the thread level. |
| `m-en-dev-007` / `m-es-dev-007` (Haiku) | `mixed`/`[rejection, timing_constraint, interest]` | **unchanged**: `mixed`/`[rejection, timing_constraint, interest]` | **yes — still violating** | Neither (A) nor (B) — RULE A did not change Haiku's behavior on this exact pattern. See §10.3. |

**Conclusion: 100% of the reduction in Sonnet's critical violations (5→0) is
attributable to (B) genuine behavioral change under prompt v2, 0% to (A) the
corpus correction.** Every one of Sonnet's v1-violating cases now resolves to
its unmodified primary gold value under v2 — the loosened `t-en-dev-009`
acceptable set was never actually exercised by either candidate's v2
prediction. The corpus correction in §8 remains independently justified as a
benchmark-integrity fix (an equally D072-defensible `negotiating` reading of
that reopening must not be structurally forbidden for a *future* candidate),
but it is not what changed Sonnet's score this round — this round's own
outcome would have been identical (0 violations) even without it. Haiku's
improvement (3→2) is 100% attributable to (B) as well (`t-en-dev-006` fixed),
with its remaining 2 violations unmoved by (A) or (B) — a persistent, real
weakness (§10.3).

### 10.3 Remaining critical violations — full per-case audit

**Only Haiku 4.5 has remaining violations. Sonnet 5 has zero.**

| candidate | case | invariant | primary gold | acceptable | prediction | evidence | why predicate fired | semantic vs. mechanical |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Haiku 4.5 | `m-en-dev-007` | `temporary_timing_not_permanent_decline` | disposition `mixed`, signals `[interest, timing_constraint]` | (none declared beyond primary) | disposition `mixed`, signals `[rejection, timing_constraint, interest]` | Target: *"We have no availability in November — it's our busiest month. Please do reach out again for January, we'd be glad to look at it then."* | The invariant fires on message-level `disposition === "negative"` OR a predicted `rejection` signal; Haiku added `rejection` despite the same reply explicitly inviting a retry. | **Semantic, not mechanical.** RULE A in the v2 prompt states this exact pattern by name ("do not add a rejection signal... when that SAME reply also explicitly invites a future retry"). Haiku received this instruction and did not apply it — this is a real, reproduced model weakness, not a prompt-clarity gap (Sonnet, given the byte-identical instruction, correctly avoided the equivalent pattern on `m-en-dev-012`/`m-es-dev-008`, §10.2). The hostile-review question ("is the gold/tag wrong?") was checked and rejected: `disposition: mixed` + `signals: [interest, timing_constraint]` is exactly what D072 §27's own worked example calls for, and the invariant is not over-broad — it does not forbid `timing_constraint`, only `rejection`/`negative` on a reply that itself invites a retry. |
| Haiku 4.5 | `m-es-dev-007` | `temporary_timing_not_permanent_decline` | disposition `mixed`, signals `[interest, timing_constraint]` | (none declared beyond primary) | disposition `mixed`, signals `[rejection, timing_constraint, interest]` | Spanish counterpart of `m-en-dev-007`, same "no disponibilidad en noviembre... vuelva a escribirnos en enero" pattern. | Same predicate, same collapse. | **Semantic**, and the SAME collapse reproduced in a second language — this is not an English-specific quirk, and it is the identical case pair Haiku failed in v1 (§7.3), meaning RULE A's added text had zero measurable effect on this specific failure mode for this model. |

Both violations were checked against D072 §27 and against the round's
"benchmark-mechanical vs. semantic" test (hostile-review requirement): the
gold values, the acceptable-answer sets, and the invariant predicate are all
unchanged from v1 (where the same two cases were also independently audited,
§7.3) and were not touched by this round's corpus correction (§8), which
only ever touched `t-en-dev-009`. There is no benchmark defect here — Haiku
4.5 has a real, reproducible tendency to add a `rejection` signal onto a
timing-bounded decline even when the same authored reply invites a retry,
and an explicit provider-neutral prompt rule targeting exactly this pattern
did not resolve it.

### 10.4 Quality-target evaluation

| target | threshold | Haiku 4.5 | Sonnet 5 |
| --- | --- | --- | --- |
| first-pass structured output | ≥ 99.0% | 100.0% — **PASS** | 100.0% — **PASS** |
| final structured output | = 100.0% | 100.0% — **PASS** | 100.0% — **PASS** |
| disposition macro F1 | ≥ 0.90 | 0.9153 — **PASS** | 0.7596 — **FAIL** |
| signal micro F1 | ≥ 0.90 | 0.9109 — **PASS** | 0.9462 — **PASS** |
| thread-state accuracy | ≥ 0.90 | 95.0% — **PASS** | 100.0% — **PASS** |
| compensation accuracy | ≥ 0.95 | 100.0% — **PASS** | 100.0% — **PASS** |
| critical invariant violations | = 0 | 2 — **FAIL** | 0 — **PASS** |

**Haiku 4.5: FAILS the round.** Disqualified on the critical-invariant hard
gate alone (2 violations, §10.3); every other quality target actually passes.

**Sonnet 5: FAILS the round.** Clears the critical-invariant hard gate (the
first Anthropic candidate to do so in this benchmark) and every other
quality target, but misses `disposition macro F1 ≥ 0.90` (0.7596). Root
cause, audited: Sonnet 5 predicted `disposition: neutral` for `m-en-dev-026`
(target's entire authored reply is "See attached.", with the actual content
of the attachment unobservable — primary gold `ambiguous`, no `acceptable`
override declared, per D072 §15: "the attachment's content is not
observable. No commercial meaning is supported by the authored text.").
Sonnet's `evidence_strength` prediction for that same case was correctly
`insufficient_evidence`, so the model recognised the evidence was thin but
still emitted a concrete disposition rather than `ambiguous` — a genuine
miss, not a corpus defect (checked: the gold value is exactly what D072 §15
requires and no acceptable alternative was ever declared for this specific
case). Because `ambiguous` had only one scorable gold instance in this
55-case set (the corpus's other dev `ambiguous`-gold message case,
`m-en-dev-011`, declares `acceptable.disposition: ["ambiguous", "neutral"]`,
so Sonnet's `neutral` answer there is scored as correct and folds out of the
`ambiguous` class's support count), this single miss produces `precision:
0, recall: 0, f1: 0` for the whole `ambiguous` class and pulls macro F1 down
from what would otherwise be ~0.95 to 0.7596. This is exactly the kind of
low-support class-variance sensitivity the original spec flagged (§14) — it
does not make the miss less real, but it does mean one message case decided
this entire quality target for Sonnet 5 in this round.

### 10.5 Stage-1 survivors

**None.** A Stage-1 survivor must clear the critical-invariant hard gate AND
every quality target (§10.4's own framing, unchanged from the round's
"quality targets remain" instruction). Sonnet 5 is the closer candidate —
first Anthropic model in this benchmark to clear the safety gate outright —
but it does not meet the disposition-macro-F1 target, so it is not
nominated as a production candidate. Haiku 4.5 fails outright on safety. The
benchmark's own decision engine (`scoring/targets.ts` `decide()`) reaches
`no_production_winner_yet` mechanically from the recorded evidence:
`gate_passed = [anthropic-sonnet-5]`, `qualified = []`.

### 10.6 Hostile-review findings (this round)

1. **IDENTITY** — `stage1-anthropic-v2-20260912`'s manifest records
   `corpus_version: b07_gold_corpus_v2`, `prompt_version:
   b07_benchmark_prompt_v2`; no v1 row appears anywhere in this run's
   `results.jsonl`/`scores.json`. Config digest for both candidates'
   `inference_config` is unchanged from §7 (confirmed: `thinking_mode:
   "adaptive"`/`effort: "medium"` for Sonnet, `thinking_mode: "disabled"`/
   `effort: null` for Haiku) — this round changed the prompt and corpus,
   never the transport.
2. **LEAKAGE** — confirmed: `split: "dev"` on every result row; no holdout
   case id appears anywhere in `results.jsonl`; the case-set digest
   (`15d3f6da1370a29c`) matches the expected 55-case dev-minus-few-shot
   selection; no scored case's message text or gold rationale appears in
   the rendered system prompt (§9.3); no newly-scored case was added as a
   few-shot exemplar.
3. **BENCHMARK TRUTH** — every one of Haiku's 2 remaining critical
   violations audited against D072 §27 in §10.3; the gold/tag/predicate for
   both was independently re-examined and found NOT over-constrained (in
   contrast with the corrected `t-en-dev-009`). The hostile-reviewer
   question "is the model wrong, or is the benchmark wrong?" was answered
   case-by-case, not assumed.
4. **FAIRNESS** — confirmed: `buildSystemPrompt(task)` takes no provider
   argument; both candidates received the byte-identical rendered prompt
   for every case (verified: the prompt-building call site in
   `run/runner.ts` is shared, not candidate-branched); identical case set,
   identical retry budget (1), identical concurrency (4), identical scorer.
5. **OVERFITTING** — confirmed: exactly one prompt-v2 revision was authored
   before either candidate was called under it; no prompt edit was made
   after seeing the v2 results above (§9.4). The four rules were derived
   from the §7.3 failure PATTERNS (timing-constraint collapse,
   one-sided-yes collapse), stated as D072-general rules, not fitted to any
   individual case's exact wording — confirmed by the no-verbatim-leakage
   tests in §9.3.
6. **COST** — every attempt (both candidates had 0% retry rate, so
   attempts = cases) is counted in §10.1's totals; the smoke calls (§10.0)
   used separate run ids and are excluded from Stage-1 totals, same
   discipline as §7.2.
7. **SCOPE** — confirmed: only `scripts/b07-benchmark/`,
   `tests/b07-benchmark/`, and `docs/` were touched this round; `src/` is
   untouched; no migration file was added; no real Gmail data, no CRM
   write, no Stage 2, no holdout case, no OpenAI/Google call, no
   Opus/Fable call.
8. **NO SILENT V1 REUSE** — confirmed: `cli.ts`'s resume/report paths
   compare `corpus_version`/`prompt_version`/`schema_version` and refuse a
   mismatch; this round used a fresh run id (`stage1-anthropic-v2-20260912`)
   with `--resume` never passed, so no v1 result could be reused even if an
   id had collided (none did).
9. **NO API KEY LEAKED** — confirmed via a repository-wide
   `grep -rn "sk-ant-"` sweep of everything staged for this round's commit
   before push; the only match is the pre-existing fake test literal
   `sk-ant-test-0123456789` in `tests/b07-benchmark/provider-transport.test.ts`.
   The real key was read only via shell substitution from its external
   scratchpad path directly into a child process's environment — never
   echoed, logged, or written to any file inside this repository.

---

## 11. SCORING-V2 INTEGRITY CORRECTION AND STAGE-1 v2 REPLICATION, 2026-09-12 (this round)

External audit of §10's macro-F1 hard-gate reading found a scoring defect,
not a corpus or prompt defect. This section documents the defect, the
scoring-v2 fix, why a fresh replication run (not a rescore) was required,
that replication's evidence, and the corrected Stage-1 disposition for both
Anthropic candidates. No corpus, prompt, inference-configuration or D072
change was made this round. No holdout case was sent to any provider. No
OpenAI/Google call was made.

### 11.1 Why this is a replication, not a rescore

Scoring is a downstream interpretation of raw inference evidence — the
inference identity is corpus + prompt + schema + model + inference
configuration + case evidence, and none of that changed this round. The
round's preference order is: rescore existing raw evidence under the new
scorer; only if that raw evidence no longer exists, replicate. Checked before
writing any code: `artifacts/b07-benchmark/` does not exist in this fresh git
worktree (`ls artifacts` → "No such file or directory"), and the working
directory is a clean checkout of `feat/b07-inference-benchmark` at
`origin`'s head — the prior round's `results.jsonl`/`scores.json` for
`stage1-anthropic-v2-20260912` lived only in a since-deleted agent worktree
(`.claude/worktrees/agent-ab36300b8a8711e2e/`) and were never committed, per
the repository's own artifact policy (§10's own text: "Raw run artifacts live
in the gitignored `artifacts/b07-benchmark/` directory and are never
committed"). Only §10's committed, derived SUMMARY (aggregate metrics and a
small number of individually-quoted per-case predictions, for the violation
cases and two named non-violation cases) survives. This round therefore
performed an **exact-same-configuration Stage-1 replication**
(`stage1-anthropic-v2-replication-20260912`) rather than a rescore, and
reports it as independent evidence alongside — never averaged into — §10's
original run. See §11.5 for what could and could not be compared between the
two.

### 11.2 The scoring defect (external audit finding), reproduced

`scoring/score.ts`'s `effectiveGold(goldPrimary, acceptable, predicted)`
rewrites the gold value fed into the confusion matrix to the candidate's own
prediction whenever that prediction is inside the case's declared acceptable
set (the identical rewrite exists for signal sets, `effectiveGoldSignals`).
That makes per-class gold SUPPORT a function of the candidate's own
prediction. Minimal reproduction (now a permanent regression test,
`tests/b07-benchmark/scoring-v2.test.ts`, describe block "PASS A"): one
corpus case, primary gold `ambiguous`, declared acceptable
`["ambiguous", "neutral"]`. Candidate A predicts `ambiguous`; candidate B
predicts `neutral`. Both predictions are equally D072-acceptable. Scored
under the PRESERVED, UNCHANGED v1 scorer:

| | candidate A (`ambiguous`) | candidate B (`neutral`) |
| --- | --- | --- |
| `ambiguous` class support | 1 | 0 |
| `neutral` class support | 0 | 1 |

The identical corpus case contributes to a *different* gold class depending
on which acceptable alternative the candidate happened to predict. Per-class
support therefore differs by candidate, the confusion matrices are not drawn
from one fixed target distribution, and a class can disappear from support
purely because a candidate selected an acceptable alternative — exactly what
happened to Sonnet 5's `ambiguous` disposition class in §10.4/§10.5, which
"becomes effectively one scorable case" and collapses macro F1 to 0.7596
despite 94.3% overall disposition accuracy. **The single miss itself
(`m-en-dev-026`, gold `ambiguous`, Sonnet predicted `neutral` with no
declared acceptable alternative for that case) is real and is NOT
disturbed by this correction** — the tri-state sufficiency rule (§11.4) is
about whether the *aggregate metric* is a valid PASS/FAIL basis, not about
excusing an actual miss.

### 11.3 Scoring-v2 design

New files, `scoring/score.ts` (v1) left **completely unmodified**:

- `scoring/scoring-version.ts` — `SCORING_VERSION_V1 =
  "b07_benchmark_scoring_v1"`, `SCORING_VERSION_V2 =
  "b07_benchmark_scoring_v2"`. `scoring/score.ts`'s `CandidateScore` now also
  carries `scoring_version: SCORING_VERSION_V1` (additive; v1's actual
  scoring behaviour is byte-for-byte unchanged) so a v1 artifact is
  self-identifying, never merely identified by convention or filename.
- `scoring/acceptable.ts` — the only functions allowed to reason about
  acceptable alternatives. Corpus-only: they take a case's primary/acceptable
  values and a prediction, and decide (a) is this ONE case's prediction
  correct, and (b) is this case SINGLE-VALUED (strict) for this field. Never
  decide which class a case's gold "is" from what was predicted.
- `scoring/score-v2.ts` — `scoreCandidateV2()`, producing two metric families
  per field, over the SAME `ScoreInput` v1 uses (same raw evidence, same
  `normaliseResults`/reliability/critical-suite/economics builders — those
  are unaffected by the defect and are reused, not forked, from
  `scoring/score.ts`):
  - **Family A, `acceptable_answer`** — correct iff prediction == primary
    gold OR prediction ∈ the case's declared acceptable set. Uses ALL cases.
    Support is simply `n` (case count) — never rewritten.
  - **Family B, `strict`** — ordinary precision/recall/F1, computed ONLY over
    cases whose gold is single-valued for that field (the acceptable-value
    set collapses to exactly one distinct value — a redundant declaration of
    the same value does not exclude a case), always against the untouched
    PRIMARY gold. `excluded_multi_answer_cases` is reported alongside every
    strict report.
  - Signals: `acceptable_set` (Family A, exact-set correctness against the
    acceptable set) and `strict` (Family B multilabel P/R/F1, restricted to
    cases whose acceptable signal-SET collapses to one canonical set) —
    same principle, generalised to sets via canonical signal-set keys
    (`acceptableSignalSetKeys`/`isStrictSignalSet` in `acceptable.ts`).
  - `*_full_support` fields (`disposition_full_support`,
    `signals_full_support`, `thread_state_full_support`,
    `compensation_structure_full_support`) — corpus-derived support over the
    FULL case set (every case, strict or not), used only to decide which
    classes are "expected to participate" in a hard gate.
- `scoring/targets-v2.ts` — tri-state quality-target evaluation
  (`evaluateCandidateV2`) and the Stage-2 holdout preflight
  (`holdoutSupportPreflight`, `checkHoldoutCanResolve`).
- `report/render-v2.ts` — a SEPARATE markdown renderer
  (`report-v2.md`, never a section spliced into `report.md`), printing
  exactly what the round asked for: strict n, per-class strict support,
  excluded multi-answer case count, strict macro F1, acceptable-answer
  accuracy over all cases, and the tri-state target verdicts.
- `cli.ts` now computes BOTH `scoreCandidate` (v1) and `scoreCandidateV2`
  (v2) from the identical per-candidate `ScoreInput` on every `screen`/
  `final`/`baseline` run and `report` replay, and persists both: `scores.json`
  (wrapped with `scoring_version: "b07_benchmark_scoring_v1"`) and
  `report.md` unchanged; `scores-v2.json` (wrapped with
  `scoring_version: "b07_benchmark_scoring_v2"`) and `report-v2.md` newly
  added. Neither artifact can be mistaken for the other by filename or by its
  own `scoring_version` field.

### 11.4 Quality-target sufficiency model (tri-state)

`0.90`/`0.90`/`0.90`/`0.95` are **UNCHANGED** — `QUALITY_TARGETS` in
`scoring/targets.ts` is imported verbatim by `targets-v2.ts`, never
redefined. What changed is (a) the metric fed into each comparison and (b)
whether the comparison may be hard-evaluated at all:

- **disposition macro F1** and **signal micro F1** are evaluated on the
  STRICT subset. A target is HARD-EVALUABLE only when every taxonomy
  class/label with nonzero FULL (corpus-wide) support also has
  `>= MIN_RELIABLE_CLASS_SUPPORT` (3) STRICT support. Below that:
  `insufficient_support` — never a fabricated PASS, never a punitive FAIL.
  At or above it: `pass` if the strict metric clears the (unchanged)
  threshold, `fail` otherwise.
- **thread-state accuracy** and **compensation accuracy** are evaluated as
  Family-A acceptable-answer accuracy over ALL cases — always hard-evaluable
  (the denominator is case count, not per-class support), so no tri-state
  question arises for them.
- **critical invariant violations** and **schema validity** are unaffected by
  this correction and keep their v1 boolean semantics.

### 11.5 Replication evidence — `stage1-anthropic-v2-replication-20260912`

**Live smoke** (before Stage 1, single dev case `m-en-dev-002`, separate run
id, excluded from every Stage-1 metric below): both candidates 200/first-pass
schema-valid; Sonnet 5 3,224 input / 31 output tokens, 1,759 ms; Haiku 4.5
2,132 input / 18 output tokens, 1,414 ms — both within ~0 tokens of the
§10.0 v2 smoke on the identical case, confirming the transport is unchanged.
Cost ≈$0.0090. The stray `ANTHROPIC_BASE_URL=https://api.anthropic.com` (no
`/v1` — the same environment quirk documented in §7.0) was present in this
environment too; every live invocation this round set
`ANTHROPIC_BASE_URL=""` (falls back to the adapter's own
`https://api.anthropic.com/v1` default) before calling — confirmed via an
independent `isModelAvailable` check against `GET /v1/models/{id}` for both
`claude-sonnet-5` and `claude-haiku-4-5-20251001` (`available: true` for
both) before any billed call.

**Stage 1** — `screen` stage, `dev` split, `--candidate anthropic-sonnet-5
--candidate anthropic-haiku-4-5`, default concurrency 4, default bounded
retry budget 1 — **identical operational parameters and identical case-set
digest** to §10.1 (`case_set_digest: 15d3f6da1370a29c`, `corpus_version:
b07_gold_corpus_v2`, `prompt_version: b07_benchmark_prompt_v2`,
`inference_policy_version:
b07_bench_inference_policy_v2_anthropic_model_capability_aware`). Both
candidates scored the identical 55-case set, 55/55 attempted, 0 identity
conflicts, 0 provider errors, 0 timeouts, 100% first-pass / 100% final schema
validity for both — no reliability regression from §10.1.

#### Critical invariant hard gate

| | critical cases | evaluated | violations | gate |
| --- | --- | --- | --- | --- |
| Haiku 4.5 | 38 | 38 | **1** | **FAIL** |
| Sonnet 5 | 38 | 38 | **0** | **PASS** |

Sonnet 5: zero violations, an EXACT match to §10.1's original v2 run — the
decisive safety-gate outcome replicates exactly. Haiku 4.5: **1** violation
this run vs **2** in §10.1's original run — see §11.6 for the exact per-case
diff; the candidate still fails the hard gate in both runs, on the same
invariant (`temporary_timing_not_permanent_decline`), so the elimination
conclusion is unaffected by the count difference.

#### Semantic metrics (scoring v1, for direct comparability with §10.1's table)

**Task M (message, n=35)**

| | Haiku orig. (§10.1) | Haiku repl. | Sonnet orig. (§10.1) | Sonnet repl. |
| --- | --- | --- | --- | --- |
| disposition accuracy | 91.4% | 91.4% | 94.3% | 94.3% |
| disposition macro F1 | 0.9153 | **0.9153** | 0.7596 | **0.7596** |
| signal exact-set accuracy | 80.0% (28/35) | 80.0% (28/35) | 91.4% (32/35) | 91.4% (32/35) |
| signal micro F1 | 0.9109 | 0.9109 | 0.9462 | 0.9583 |
| signal macro F1 | 0.8866 | 0.8921 | 0.9442 | 0.9554 |
| evidence-strength accuracy | 71.4% | 65.7% | 71.4% | 65.7% |

**Task T (thread, n=20)**

| | Haiku orig. | Haiku repl. | Sonnet orig. | Sonnet repl. |
| --- | --- | --- | --- | --- |
| thread-state accuracy | 95.0% | 95.0% | 100.0% | 100.0% |
| thread-state macro F1 | 0.8000 | 0.8000 | 1.0000 | 1.0000 |
| compensation accuracy | 100.0% | 100.0% | 100.0% | 100.0% |
| `unknown`→`unpaid` count | 0 | 0 | 0 | 0 |
| evidence-strength accuracy | 80.0% | 80.0% | 95.0% | 100.0% |

Sonnet 5's decisive number — the exact `disposition macro F1 = 0.7596` that
drove §10.4's FAIL reading — reproduced **exactly**, to four decimal places,
across two independent live runs. Every hard-gate-relevant figure for both
candidates (critical PASS/FAIL direction, thread-state/compensation
accuracy, schema validity) is identical or effectively identical between the
two runs; the small drifts (signal macro F1, evidence-strength accuracy,
Haiku's violation count) are genuine run-to-run model stochasticity — this
benchmark does not pin a fixed sampling seed, and Sonnet 5 runs with adaptive
thinking (non-deterministic token allocation; `reasoning_tokens` diagnostic:
0 for Haiku both runs, 0→39 for Sonnet across the two runs) — not a
benchmark defect.

#### Performance and economics

| | Haiku orig. | Haiku repl. | Sonnet orig. | Sonnet repl. |
| --- | --- | --- | --- | --- |
| input tokens (all attempts) | 117,404 | **117,404** | 175,900 | **175,900** |
| output tokens (all attempts) | 1,261 | **1,261** | 2,277 | 2,155 |
| estimated Stage-1 cost | $0.123709 | **$0.123709** | $0.374570 | $0.373350 |
| median latency | 1,235 ms | 1,226 ms | 1,717 ms | 1,702 ms |

Haiku's token/cost totals are an **exact** match across both live runs (zero
attempts, zero retries, identical billed tokens on every one of 55 cases).
Sonnet's input-token total is an exact match; its output/cost differ by
~5% — attributable to adaptive-thinking token variance (see above), not a
transport or accounting defect. Total measured spend this round (Stage 1 +
smoke, both candidates): ≈$0.506 — within the ≈$0.50 projection given to the
product owner before running, and combined with the ≈$0.88 cumulative spend
already recorded on this PR, cumulative live spend is now ≈$1.39.

### 11.6 Stability diagnostic (descriptive only — no threshold invented)

**What this diagnostic can and cannot cover.** §10 committed only aggregate
metrics and a small number of individually-quoted per-case predictions
(every critical-violation case, plus `m-en-dev-011` and `m-en-dev-026`) —
never the full 55-case raw prediction set, per the repository's own artifact
policy (§11.1). A full per-case exact-agreement-rate table across all 55
cases against the ORIGINAL §10.1 run is therefore **not reconstructible** —
that data no longer exists anywhere. What follows is (a) the aggregate-level
comparison in §11.5, and (b) an exact per-case comparison for every one of
the ~10 cases §10 individually quoted. This is a real, if partial, same-
input/model stability signal — not a substitute for having kept the raw
evidence, which is itself a process finding worth recording: **future
rounds should commit a minimal redacted per-case prediction digest (case_id
+ predicted fields, no case content) specifically to make stability
diagnostics reconstructible without holding raw provider payloads.**

| case | candidate | §10.1 original v2 prediction | this round's replication prediction | changed? |
| --- | --- | --- | --- | --- |
| `m-en-dev-007` | Haiku | `mixed` / `[rejection, timing_constraint, interest]` (violating) | `mixed` / `[timing_constraint, interest]` (matches gold, NOT violating) | **YES** — `rejection` signal dropped |
| `m-es-dev-007` | Haiku | `mixed` / `[rejection, timing_constraint, interest]` (violating) | `mixed` / `[rejection, timing_constraint, interest]` (violating) | no |
| `t-en-dev-006` | Haiku | `negotiating` / `paid` / `strong` (matches gold) | `negotiating` / `paid` / `strong` (matches gold) | no |
| `m-en-dev-012` | Sonnet | `mixed` / `[interest, timing_constraint]` (matches gold) | `mixed` / `[interest, timing_constraint]` (matches gold) | no |
| `m-es-dev-008` | Sonnet | matches gold (`mixed` / `[interest, terms_discussion, timing_constraint]`) | `mixed` / `[timing_constraint]` (disposition still correct; `interest`/`terms_discussion` signals dropped) | **YES** — signal set narrower |
| `t-en-dev-006` | Sonnet | `negotiating` / `paid` / `moderate` (matches gold) | `negotiating` / `paid` / `moderate` (matches gold) | no |
| `t-en-dev-008` | Sonnet | `unresolved` (matches gold) | `unresolved` (matches gold) | no |
| `t-en-dev-009` | Sonnet | `engaged` (matches gold) | `engaged` (matches gold) | no |
| `m-en-dev-011` | Sonnet | `neutral` (acceptable-set match) | `neutral` (acceptable-set match) | no |
| `m-en-dev-026` | Sonnet | `neutral` / `insufficient_evidence` (the real semantic miss vs gold `ambiguous`) | `neutral` / `insufficient_evidence` (identical miss, reproduced exactly) | no |

- **Exact agreement on these 10 named cases: 8/10 (80%).** Both changes are
  Haiku/Sonnet dropping a signal that was present in the original run
  (`rejection` on `m-en-dev-007`; `interest`+`terms_discussion` on
  `m-es-dev-008`) — no case flipped from correct to incorrect on disposition
  or thread-state, and no NEW critical-invariant violation appeared anywhere
  that wasn't already a violation in the original run.
- **Critical-violation agreement:** Sonnet 5 — exact agreement, 0 violations
  both runs. Haiku 4.5 — the SET of violating cases changed
  (`{m-en-dev-007, m-es-dev-007}` → `{m-es-dev-007}`), but the outcome
  (FAILS the hard gate) and the invariant tripped
  (`temporary_timing_not_permanent_decline`) are identical both times.
- **Disposition/thread-state exact agreement (named cases only):** 10/10 —
  every named case's disposition or thread-state classification is identical
  across both runs; only signal-set membership drifted, and only on 2 of the
  10 named cases.
- This is DESCRIPTIVE ONLY, per the round's explicit instruction — no
  stability threshold is proposed or invented from these two data points.

### 11.7 Quality-target evaluation (scoring v2, this round's replication)

| target | threshold | Haiku 4.5 | Sonnet 5 |
| --- | --- | --- | --- |
| first-pass structured output | ≥ 99.0% | — (not evaluated: eliminated on safety before target evaluation) | 100.0% — **PASS** |
| final structured output | = 100.0% | — | 100.0% — **PASS** |
| disposition macro F1 (strict) | ≥ 0.90 | — | 0.7778 (strict n=23, excluded 12 multi-answer) — **INSUFFICIENT_SUPPORT** (`mixed` strict support 2, `ambiguous` strict support 1 — both < 3) |
| signal micro F1 (strict) | ≥ 0.90 | — | 0.9867 (strict n=27, excluded 8 multi-answer) — **INSUFFICIENT_SUPPORT** (`agreement`, `timing_constraint`, `other_commercial` strict support < 3) |
| thread-state accuracy (acceptable-answer) | ≥ 0.90 | — | 100.0% (n=20, all cases) — **PASS** |
| compensation accuracy (acceptable-answer) | ≥ 0.95 | — | 100.0% (n=20, all cases) — **PASS** |
| critical invariant violations | = 0 | 1 — **FAIL** | 0 — **PASS** |

**Haiku 4.5 quality targets are not evaluated beyond the safety gate** — per
`evaluateCandidateV2`'s design (§11.3/§11.4), a candidate that fails the
critical-safety hard gate is eliminated immediately; computing quality
targets for an already-eliminated candidate would invite exactly the
"quality can override safety" misreading the round forbids.

Note the reversal from §10.4's v1 reading: under v1, Sonnet 5's disposition
macro F1 (0.7596) was reported as a hard **FAIL** against the 0.90 target.
Under v2, the SAME underlying evidence (same raw predictions, same run) is
correctly read as **INSUFFICIENT_SUPPORT** — the strict `ambiguous` class has
exactly 1 gold case in this 55-case dev selection (below
`MIN_RELIABLE_CLASS_SUPPORT = 3`) and the strict `mixed` class has 2 (also
below 3), so this dev-split evidence genuinely cannot resolve whether Sonnet
5's disposition performance clears 0.90 — it is not the same claim as "it
does not clear 0.90". The `m-en-dev-026` miss itself is unchanged and fully
real (§11.2) — it is simply insufficient, on its own, to fail a macro-F1
target whose class support this dev split cannot supply. The signal
micro-F1 target is likewise INSUFFICIENT_SUPPORT (three signal labels below
support-3 in the strict subset), a v2 finding not previously surfaced under
v1 at all (v1 read the same evidence as PASS, 0.9462 ≥ 0.90 — also not a
statistically sound PASS under the corrected methodology, though it happens
to be numerically above threshold either way).

### 11.8 Stage-1 disposition (scoring v2)

- **`anthropic-haiku-4-5`: ELIMINATED (critical safety).** 1 critical
  invariant violation (`temporary_timing_not_permanent_decline`,
  `m-es-dev-007`) — a real, reproduced-across-both-runs model weakness
  (§11.6), not a benchmark defect (checked against D072 §27 exactly as
  §10.3 did; the gold/tag/predicate for this case are unchanged from §10.3's
  independent audit). Haiku cannot become a Stage-1 finalist through this or
  any scoring correction — the safety gate is not scoring-methodology-
  dependent.
- **`anthropic-sonnet-5`: STAGE1_FINALIST_WITH_UNRESOLVED_QUALITY_TARGET.**
  Zero critical invariant violations (exact match across both runs). Every
  statistically evaluable quality target passes (schema validity,
  thread-state accuracy, compensation accuracy). Two targets — disposition
  macro F1 and signal micro F1 — are `insufficient_support` on this dev
  split, not `fail`. Per the round's explicit rule (§ "STAGE-1 DECISION
  SEMANTICS"), this makes Sonnet 5 a Stage-1 finalist **only** in this
  explicit provisional sense: **it is NOT a production/vendor winner**, and
  the two unresolved targets MUST be resolved against the frozen holdout
  corpus in Stage 2 before any final implementation/provider recommendation.
- This scoring policy was applied identically to both candidates — no
  candidate-id branch exists anywhere in `scoring/score-v2.ts` or
  `scoring/targets-v2.ts` (confirmed by a hostile-review test asserting two
  different `candidate_id`s scored against identical evidence produce
  identical output apart from the id field itself, §11.9) — and will apply
  identically to a future OpenAI, Google, or local-baseline candidate.

### 11.9 Hostile-review findings and fixes (this round)

1. **No candidate-specific code** — checked by construction (neither
   `score-v2.ts` nor `targets-v2.ts` branches on `candidate_id` or
   `provider_id` anywhere in the metric/target logic) and by test
   (`tests/b07-benchmark/scoring-v2.test.ts`, "no candidate-specific code"):
   two candidate ids scored against byte-identical evidence produce
   byte-identical output apart from the id itself.
2. **No threshold changed** — `QUALITY_TARGETS` (`scoring/targets.ts`) is
   imported verbatim by `targets-v2.ts`; a test asserts
   `QUALITY_TARGETS.dispositionMacroF1 === 0.9` and that every v2 target
   result's `threshold` field equals the corresponding v1 constant.
3. **Haiku still fails safety** — confirmed both in this round's live
   replication (§11.5, §11.8) and by a generic test asserting that ANY
   candidate with critical violations is eliminated regardless of how
   excellent its quality-target fixture is (`buildScoreV2Fixture` with
   `criticalViolations: 2` and otherwise-perfect metrics still resolves to
   `eliminated_critical_safety`).
4. **Valid acceptable alternatives remain accepted** — Family A
   (`acceptable_answer`) scores both the primary and every declared
   acceptable prediction as correct (test: "1. an acceptable-alternative
   prediction counts as correct, exactly like the primary").
5. **Invalid answers remain wrong** — a prediction outside the acceptable set
   scores 0 under both families (test: "real failure: a NON-acceptable
   prediction is still wrong"); a below-threshold strict macro F1 with
   SUFFICIENT support still resolves to an actual `fail`, never laundered
   into `insufficient_support` (test: "sufficient support + F1 below 0.90 =
   an actual FAIL").
6. **Support cannot vary by candidate** — the multi-answer-case exclusion is
   decided from the case's OWN `acceptable` declaration only, never from a
   prediction; tests assert two candidates predicting different acceptable
   alternatives (both single-label and signal-set) produce byte-identical
   `strict.per_class`/`strict.per_label` objects, and that
   `*_full_support` is corpus-derived and identical across candidates.
7. **Statistical insufficiency cannot become a fake PASS** — a class with
   strict support 1 (or any value below `MIN_RELIABLE_CLASS_SUPPORT`) never
   produces `pass` or `fail`; it produces `insufficient_support`, tested
   directly and confirmed against the real replication evidence in §11.7.
8. **An unresolved target never launders a real fail** — tested explicitly:
   a fixture with one `insufficient_support` target AND one genuinely
   failing target resolves to `eliminated_quality_target_fail`, never
   `stage1_finalist_with_unresolved_quality_target` — an unresolved target
   provides no cover for an actual failure elsewhere.
9. **Holdout-support preflight performs zero provider calls, by
   construction** — `holdoutSupportPreflight(cases: CorpusCase[])` has
   exactly one parameter and it is the corpus; there is no
   candidate/provider/API-key parameter for a call to travel through, and it
   is synchronous. Wired into `cli.ts`'s `final` stage (gated on at least one
   selected candidate actually having a usable API key — a key-less `final`
   invocation makes no provider call regardless, exactly like every other
   stage, so the preflight has nothing to protect there) to run BEFORE the
   provider loop and throw `HOLDOUT_INSUFFICIENT_TO_RESOLVE_TARGET` when the
   frozen holdout cannot resolve a required target — reads only
   `--from-run`'s prior `scores-v2.json` (metadata) to find which targets
   Stage 1 left unresolved, defaulting conservatively to checking both
   support-sensitive targets when no prior run is named. NOT exercised this
   round (no `final` invocation was made).
10. **v1/v2 report identity is structural, not conventional** — separate
    files (`report.md` vs `report-v2.md`, `scores.json` vs `scores-v2.json`),
    separate `scoring_version` stamps in both file contents, and a dedicated
    test asserting `scoreCandidate(...).scoring_version !==
    scoreCandidateV2(...).scoring_version` for the same input.

No defect required a second fix — everything above was verified passing on
first implementation, then hardened with a permanent test.

### 11.10 Holdout-support preflight — metadata only, computed against the real frozen holdout (NO provider call)

Run against the actual 120-case `holdout` split (`resolveSelection({split:
"holdout"})`), reading only `expected`/`acceptable` fields — no model output
exists or was inspected:

| field | full support (by class) | strict support (by class) | classes below `MIN_RELIABLE_CLASS_SUPPORT=3` |
| --- | --- | --- | --- |
| disposition | positive 24, negative 9, neutral 26, mixed 7, ambiguous 6 | positive 15, negative 8, neutral 8, mixed 3 | **ambiguous** (0 strict — every `ambiguous`-gold holdout case declares a genuine acceptable alternative) |
| signals | interest 17, request_information 10, rejection 11, redirect 8, terms_discussion 20, offer 5, timing_constraint 12, agreement 5 | interest 6, request_information 8, rejection 7, redirect 4, terms_discussion 9, offer 4 | **agreement** (0 strict), **timing_constraint** (0 strict) |

`resolvable: { disposition_macro_f1: false, signal_micro_f1: false }`.

**The frozen 120-case holdout, as currently authored, CANNOT resolve either
of Sonnet 5's two unresolved Stage-1 quality targets on its own** — the
`ambiguous` disposition class and the `agreement`/`timing_constraint` signal
labels have ZERO strict (single-answer) gold cases in the holdout, because
every holdout case touching those classes currently declares a genuine
acceptable alternative. This is the same structural pattern as the dev
split (§11.7), not a coincidence of one split — `ambiguous` disposition and
`timing_constraint` signal cases in this corpus are disproportionately
authored as genuinely ambiguous, multi-answer-acceptable cases, which is
correct D072 modelling but means they contribute zero strict evidence by
construction. **Per the locked Stage-2 rule (§ "STAGE-2 RULE — LOCK NOW, DO
NOT RUN IT" in this round's task), if Stage 2 were run today with Sonnet 5 as
the sole finalist, the preflight would report
`HOLDOUT_INSUFFICIENT_TO_RESOLVE_TARGET` for both `disposition_macro_f1` and
`signal_micro_f1` and refuse before any provider call.** Resolving this would
require either additional strict (single-answer) `ambiguous`/`agreement`/
`timing_constraint` gold cases added to a frozen evaluation set — which is a
corpus-authoring decision this round explicitly forbids inventing
(`docs/B07_GMAIL_COMMERCIAL_MEANING_CONTRACT.md` governs what counts as a
genuine single-answer case) — or accepting that these two targets remain
permanently statistically unresolvable under the current corpus design and
must be evaluated some other way (e.g., a larger supplemental set, or
retiring the macro-F1 hard-gate framing for these specific classes in favor
of the acceptable-answer accuracy already computed). **This is a blocker for
the product/architecture owner to resolve before Stage 2 is ever run — not
something this round decides.**

### 11.11 Validation

- `npx vitest run tests/b07-benchmark` — 158/158 passing (137 pre-existing +
  21 new in `tests/b07-benchmark/scoring-v2.test.ts`), including the
  PASS-A defect reproduction and all 18 of the round's numbered acceptance
  tests.
- `npm run typecheck` — clean.
- `npm run format:check` — clean (see §12 head/SHA below for the exact
  commit this was run against).
- `npm run build` — clean.
- `grep -rn "sk-ant-"` sweep of the full working tree before push: only the
  pre-existing fake test literal in `tests/b07-benchmark/provider-
  transport.test.ts` matches; the real key never appears in any tracked
  file, any artifact, or this document.

---
