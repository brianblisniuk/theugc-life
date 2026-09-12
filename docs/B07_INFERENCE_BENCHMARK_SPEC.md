# B07 Inference Benchmark — Specification

**Status:** Benchmark infrastructure, not production. This document specifies an
EVALUATION whose purpose is to produce evidence for a later B07 implementation
decision.
**Governing decision:** D072 (`docs/B07_GMAIL_COMMERCIAL_MEANING_CONTRACT.md`).
**Implements:** nothing. No schema, no migration, no application code, no
vendor selection.
**Explicitly NOT in this round:** B07 production implementation, migration
`0041`, any product database schema change, any real Gmail data, any merge.

---

## 1. The one question this benchmark answers

> Which inference approach gives TheUGC.life the best practical B07 commercial
> interpretation quality **under D072's exact semantics**, considering semantic
> accuracy, critical false-positive safety, abstention quality, structured-output
> reliability, stability, latency, token use, estimated cost, operational
> complexity and privacy/vendor suitability?

It does **not** assume in advance that rules are best, that an LLM is best, that
any particular vendor is best, or that the largest or the cheapest model is best.
`NO PRODUCTION WINNER YET` is an allowed and sometimes correct outcome.

## 2. What is in scope: MACHINE-owned B07 outputs only

Two tasks, both machine-advisory, both taken verbatim from D072:

**Task M — message-level commercial meaning** (D072 §3, §4, §15), for one
effective human reply:

| field | values |
|---|---|
| `disposition` | `positive` · `negative` · `neutral` · `mixed` · `ambiguous` |
| `signals` (a SET) | `interest` · `request_information` · `redirect` · `terms_discussion` · `offer` · `agreement` · `rejection` · `timing_constraint` · `other_commercial` |
| `evidence_strength` | `strong` · `moderate` · `weak` · `insufficient_evidence` |

**Task T — thread-level machine meaning** (D072 §5, §8, §15):

| field | values |
|---|---|
| `thread_state` | `unresolved` · `engaged` · `negotiating` · `agreement_observed` · `declined_observed` · `ambiguous` |
| `compensation_structure` | `paid` · `in_kind` · `hybrid` · `unpaid` · `other` · `unknown` |
| `evidence_strength` | `strong` · `moderate` · `weak` · `insufficient_evidence` |

## 3. What the benchmark must NEVER ask a model to infer

Human business outcome (`open`/`won`/`lost`/`ghosted`/`uncertain`), lost reason,
creator correction, whether the creator personally considers a deal won or lost,
CRM state, collaboration lifecycle, or B07 Axis A creator truth. These are human
facts under D072 §6/§10, not machine targets.

`agreement_observed` is not `won`. Machine `rejection` is not human `lost`.
Historical absence is never machine `ghosted`.

This is enforced **structurally**: the machine-output schema
(`scripts/b07-benchmark/schema.ts`) contains no such value, so a compliant
response cannot express one, and a non-compliant response fails validation
rather than becoming a prediction. A test asserts it.

## 4. Critical invariants (hard gates)

`scripts/b07-benchmark/scoring/invariants.ts` registers fifteen named
collapses that D072 forbids outright. Each one is a PREDICATE over a prediction,
not a gold comparison: a candidate can be wrong about a case without violating an
invariant, and a candidate that violates one is disqualified as a finalist
regardless of its aggregate scores.

| id | D072 | forbidden collapse |
|---|---|---|
| `politeness_not_positive` | §3, §27 | courtesy read as `positive` |
| `interest_not_agreement` | §5, §27 | interest promoted to agreement/negotiation |
| `rate_request_not_agreement` | §27 | a rate question read as a closed deal |
| `offer_not_agreement` | §5, §17, §27 | an unaccepted offer read as `agreement_observed` |
| `enthusiasm_not_agreement` | §5 | target enthusiasm read as agreement |
| `creator_acceptance_alone_not_agreement` | §16, §27 | the creator's own acceptance read as the target's |
| `unknown_not_unpaid` | §8 | silence about money read as "no compensation" |
| `redirect_not_terminal` | §27 | routing read as winning or losing |
| `temporary_timing_not_permanent_decline` | §17, §27 | a dated constraint read as a permanent decline |
| `reopening_supersedes_decline` | §5, §17 | a reopening that stays `declined_observed` |
| `contradicted_agreement_not_clean_agreement` | §17, §27 | contradicted agreement frozen as clean agreement |
| `quoted_positive_not_current_positive` | §16, §27 | quoted history overriding the authored message |
| `no_fabricated_strong_evidence` | §15, §26 | `strong` evidence asserted over sparse or self-contradicting text |
| `unsupported_compensation_unknown` | §8, §28 | a compensation structure invented from nothing |
| `no_machine_human_outcome` | §6 | any human outcome value in machine output |

**Silence is not safety.** A candidate only clears the gate when it produced a
prediction for every critical case AND violated nothing. A candidate that
crashed its way past the suite fails it.

**If every candidate fails the critical suite, the round reports NO WINNER.**
D072 is never relaxed to let a provider pass.

## 5. Gold corpus

`scripts/b07-benchmark/fixtures/b07_gold_corpus_v1_{message,thread}.jsonl`,
version `b07_gold_corpus_v1`.

- **180 cases**: 110 message-task, 70 thread-task.
- **Split**: 60 `dev` (cheap screening), 120 `holdout` (finalists only). The
  harness preserves the split explicitly and the two are disjoint.
- **Languages**: English and Spanish materially, with a smaller Portuguese and
  French challenge slice. Taxonomy values stay English regardless of source
  language.
- **Critical suite**: 126 cases carry at least one invariant tag.
- **Few-shot exemplars**: five `dev` case ids, resolved from the corpus at prompt
  build time with a runtime assertion that they are `dev`, and **excluded from
  every scored set** so a candidate is never graded on an answer it was shown.

### Gold-label discipline

Gold truth derives from D072, never from a model's labels — no candidate output
was used to author any label. Every case carries a stable id, split, language,
task, synthetic evidence, expected labels, adversarial tags, critical-invariant
tags where applicable, and a short **human-audit rationale that is never shown to
a candidate model**.

D072's own worked examples (§27) are locked seed cases. Where D072 genuinely
admits more than one honest answer, the case encodes an explicit
**acceptable-answer set** rather than forcing fake precision. Two mechanical
guards back this up:

1. the loader refuses a case whose primary `expected` value is not inside its own
   acceptable set;
2. a test enumerates the full cross-product of every acceptable answer for every
   case and asserts that **none of them violates that case's own tagged
   invariants** — a self-contradicting gold label fails CI.

### Privacy of the corpus

Synthetic only. No real B03/B04/B05/B06 Gmail content was read, exported or
copied; no mailbox was queried; no Gmail API call was made; no OAuth changed. A
test asserts the fixture bytes contain no Gmail or provider identifier and that
nothing under `scripts/b07-benchmark/**` imports a Gmail, Supabase or `src/`
module.

## 6. Prompt

One canonical provider-neutral semantic prompt, `b07_benchmark_prompt_v1`
(`scripts/b07-benchmark/prompt/render.ts`).

- Every candidate receives byte-identical system and user text for a case. The
  prompt API takes no provider argument, so per-provider semantic tuning is
  structurally impossible in this first comparison.
- 3–5 few-shot examples, all from `dev`.
- No chain of thought is requested; only the structured object.
- The candidate-visible projection is built from an explicit allow-list, so
  `gold_rationale`, `expected`, `acceptable`, `adversarial_tags`,
  `critical_invariants` and `split` cannot reach a provider. A test builds the
  FULL payload for all 180 cases and asserts this.

## 7. Structured output

One logical schema (`b07_benchmark_schema_v1`) in two kept-in-lockstep forms: a
Zod schema for local validation and a plain JSON Schema for provider transports.
Provider-specific transports are permitted (OpenAI `json_schema`, Anthropic
`output_config.format`, Google `responseSchema` — the Gemini dialect translation
is asserted to preserve the same enums and required fields).

Every response is validated locally. Recorded separately per case: first-pass
schema success, whether a retry was required, final schema success, and the
semantic result.

**At most ONE bounded format retry.** The CLI rejects `--max-schema-retries > 1`
so unlimited retries cannot make a weak candidate look reliable. A provider
ERROR is not retried as a format problem, because doing so would distort the
retry statistic.

## 8. Scoring

Deterministic and inspectable. No single opaque weighted number.

**Task M**: disposition accuracy; per-class precision/recall/F1; macro F1 (both
over all classes and over supported classes, so a dominant class cannot hide a
rare one); commercial-signal exact-set accuracy; signal micro F1; signal macro
F1; over-prediction rate; under-prediction rate; evidence-strength confusion
matrix.

**Task T**: thread-state accuracy; per-class precision/recall/F1; compensation
accuracy; an explicit `unknown` ↔ `unpaid` confusion COUNT (computed against the
primary gold, since that confusion is never an acceptable alternative);
evidence-strength confusion matrix.

**Reliability**: first-attempt validity, retry rate, final parse rate, provider
failure rate, timeout rate — all computed over calls actually ATTEMPTED, so a
model that was never called has an absence rather than a flattering rate.

**Performance**: median and p95 latency over SUCCESSFUL calls only, with `n` and
the excluded-failed-call count printed beside them; input, output and
reasoning/thinking tokens where the provider exposes them.

**Economics**: estimated cost per case, per 1,000 interpreted messages and per
1,000 interpreted threads. Every attempt counts, **including failed ones and
retries**. Price metadata is timestamped, source-attributed and carries a
`verification` field; estimated pricing is labelled
`estimated_from_published_prices` and is never presented as measured billing.

Scoring honours acceptable-answer sets identically for every candidate,
including the baseline: a prediction inside the acceptable set is scored as if it
were the gold answer, so the confusion matrix is not polluted.

## 9. Quality targets

Decision targets, not a grading curve:

- first-pass structured-output success ≥ 99%
- final structured-output success after bounded retry = 100%
- message disposition macro F1 ≥ 0.90
- signal micro F1 ≥ 0.90
- thread-state accuracy ≥ 0.90
- compensation accuracy ≥ 0.95
- ZERO critical invariant violations

If nobody meets all of them, the round returns a ranked diagnosis and
`NO PRODUCTION WINNER YET`. A candidate is never nominated merely for being the
least bad, and the Stage-0 baseline can never be nominated at all.

## 10. Decision method

Hard gates first (critical suite, then quality targets), then a **Pareto**
comparison of the survivors on: semantic quality, critical-error safety, schema
reliability, cost, latency, operational complexity, privacy/vendor suitability.
No scalar weighted score decides anything.

Valid recommendations include: one model for all B07 inference; a cheap model
plus an escalation model; rules for narrow obvious cases plus a model for
ambiguity; or no winner. A hybrid is only recommended if benchmark evidence
actually supports it.

## 11. Staged tournament

- **Stage 0 — benchmark baseline.** A deliberately simple lexical rules engine,
  banner-marked `BENCHMARK BASELINE — NOT PRODUCTION B07 IMPLEMENTATION`, run
  across the whole corpus to give the model candidates a floor to beat. It must
  not be promoted into production architecture; a test asserts the banner.
- **Stage 1 — screening.** Reasonably priced current candidates on the `dev`
  split. The candidate matrix is configuration-driven
  (`scripts/b07-benchmark/config/candidates.ts`); model availability is verified
  at execution time against the provider's own model listing, and a model whose
  id has moved is recorded `unavailable` or overridden via
  `B07_BENCH_MODEL_<CANDIDATE_ID>` — a renamed model never fails the round.
- **Stage 2 — finalists.** The top approaches surviving the hard gates against
  the full `holdout`, optionally with one higher-cost frontier model as a quality
  ceiling where that materially informs the decision.

## 12. Honesty rules the harness enforces

- A missing API key yields `not_run_missing_key`. A model whose id is gone yields
  `unavailable`. Neither is a failure of the model, and neither may be presented
  as benchmark evidence: the report lists them in a separate "Not run — recorded
  as absence of evidence" table.
- A provider exception can never become a semantic prediction. Only a
  schema-valid parse populates `prediction`.
- Resume reuses a stored result only when candidate, case, corpus version, prompt
  version and schema version ALL match, and only for settled work; a transient
  provider error is retried rather than frozen. `report --run` refuses to render
  a run produced under a different prompt/schema/corpus version.
- Secrets are redacted from every log line and every artifact write.
- Run artifacts (`artifacts/b07-benchmark/`) are gitignored. Only the corpus,
  schemas, scoring logic, harness, tests, this specification and a derived,
  content-free summary are committed.

## 13. Privacy / vendor screen

`scripts/b07-benchmark/privacy/vendor-screen.ts` records, per provider: whether
API/commercial data is used for training by default, standard retention, ZDR
availability, paid-vs-free differences, deletion/control constraints, relevant
security notes, official source URLs, the accessed date, and **how the fact was
verified in this environment**.

Each provider is classified separately for `synthetic_benchmark_suitable` and for
private-Gmail candidacy. A provider whose official documentation could not be
read from the benchmark host is recorded
`undetermined_official_source_unreachable`, never optimistically cleared.

> **Passing the synthetic benchmark privacy screen DOES NOT authorize real Gmail
> processing.** No provider receives real G1/G2 data until a later explicit
> privacy/vendor approval for that exact production configuration (D072 §19/§20).

## 14. Known limitations of this corpus

Stated rather than hidden, because a benchmark that conceals its own weaknesses
is worse than none:

- `other_commercial` is deliberately rare in D072 and correspondingly rare in the
  gold set (primary gold on a single case, plus several acceptable-answer sets).
  Its per-label F1 is therefore high-variance; read it next to its printed
  `support`, and read signal micro F1 as the headline instead of signal macro F1.
- `evidence_strength` is the most subjective of the five fields. It is reported as
  a confusion matrix and is deliberately NOT a hard gate; many cases encode two
  adjacent acceptable values.
- The corpus is synthetic by mandate. It is designed to be representative of
  hotel/creator outreach, but it is not a sample of real traffic, and a
  production decision should be revisited against real (privacy-approved) data
  before B07 ships.
- All model candidates in this round were recorded `not_run_missing_key`: no
  external provider comparison exists yet.

## 15. What this round explicitly does not do

No B07 production implementation. No migration `0041`. No product database schema
change. No real Gmail data, no Gmail API call, no OAuth change. No D072 semantics
modified. B07 remains implementation-next / benchmark-before-implementation in
`docs/MASTER_PLAN_TRACKER.md`. Nothing here locks the product to one provider or
model.
