# theugc.life — PROPERTY_LIFECYCLE_EVIDENCE_CONTRACT.md

Version: 1.0
Status: **Approved product contract.** Governs how pre-publication
lifecycle/closure EVIDENCE is extracted, recorded and evaluated.

Governing decisions: **D062** (promotion is publication — condition 4 reads from
here), D063, D065 (provider source data is isolated and never canonical by
default), D066.

---

## 1. The one question this layer answers

> **Does the latest complete provider evidence contain a CURRENT property-level
> closure window for this source property, AS OF an explicit date?**

It does **not** answer "is the hotel active?", it does not answer "is this hotel
permanently closed?", it publishes nothing, and it changes no canonical state.

```
source property identity
        ↓
latest observation                    (evidence, never canonical — D065)
        ↓
complete issue snapshot               "we extracted this observation's issues"
        ↓
structured issue rows                 the provider's own fields, verbatim
        ↓
approved provider policy              which (code, type) pairs mean anything
        ↓
+ an explicit as_of date              ← the calendar is an input, not a default
        ↓
known_closed | no_known_closure | unresolved
```

## 2. `issueType = CLOSED` does not mean the hotel is closed

This is the load-bearing rule, and the provider's own documentation is what
forces it. Hotelbeds defines
[`issues[]`](https://developer.hotelbeds.com/documentation/hotels/content-api/issues/)
as *incidences or important information reported by the hotel regarding its
facilities*, with `dateFrom` the date the issue starts and `dateTo` the date it
ends. Its published example is facility-scoped: `issueCode = OUTDOORPOOL`,
`issueType = CLOSED`.

The real cached Bali/Dubai evidence — recomputed, not quoted — says the same
thing louder:

| | |
|---|---:|
| properties | 4,110 |
| issue rows | 176 |
| rows with `issueType = CLOSED` | 13 |
| …of which `issueCode = HOTEL` | **2** |
| …of which a FACILITY | **11** |

The eleven are `WATERPARK` ×7, `RESTAURANT` ×2, `PARKING` ×1, `SPA` ×1.

> A generic rule of "`issueType = CLOSED` → hotel closed" would have declared
> **eleven operating hotels closed** on this dataset.

So the policy is keyed on the **PAIR**, and for Hotelbeds V1 exactly one pair is
approved:

| issue_code | issue_type | outcome |
|---|---|---|
| `HOTEL` | `CLOSED` | `property_closed_window` |

**Provider codes are identifiers, not user text**, and are matched EXACTLY.
`"HOTEL "` does not match `HOTEL`, and neither does `" HOTEL"`, `"hotel"` or
`"HO TEL"`. Trimming would repair malformed, unreviewed provider evidence into
the one mapping that closes a property — the same silent-repair class already
closed in star and scope resolution. The padded value survives in the evidence
exactly as sent, and matches nothing.

Everything else gets **no row**. Not a row saying it is harmless — no row —
because an unreviewed pair and a reviewed-and-harmless pair must not look
identical, and because nothing may map to "open": no provider issue is evidence
that a hotel is *operating*.

## 3. The outcome vocabulary

| outcome | means | does NOT mean |
|---|---|---|
| `known_closed` | the provider currently reports the HOTEL ITSELF closed on this date | permanently closed · inactive forever · a closed canonical hotel · final exclusion |
| `no_known_closure` | the latest snapshot is COMPLETE and contains no property-level closure covering this date | **active** · open · confirmed_open · operating |
| `unresolved` | we cannot safely say either | "probably fine" |

**`no_known_closure` is the one that gets misread.** Absence of closure evidence
is not positive proof of operation. A provider that has never said "this hotel is
trading" has not said it, and the name is deliberately negative so no reader can
borrow a claim the evidence does not carry.

`unresolved` arises when: the latest observation has no complete snapshot; a
mapped property-level closure has a missing, impossible or inverted date range;
or lifecycle evidence cannot be tied to the latest observation. **Unknown is not
`no_known_closure`.**

## 4. Completeness is its own fact

A child table of issue rows alone cannot support this layer, because zero rows
would mean two incompatible things:

- **A)** the provider reported no issues — *evidence*;
- **B)** nobody extracted the issues — *ignorance*.

Collapsing them lets an unextracted property read as "no known closure", which is
exactly the false negative D062 must never act on. So completeness is a **row**:
`source_property_issue_snapshots` exists only when a complete provider record for
that observation was processed.

This is not theoretical for Hotelbeds. The provider **omits** `issues` entirely
rather than sending an empty array — **3,936** of the 4,110 cached records have
no such key, and not one has an empty one. "The array was empty" is therefore not
an observable state, and `provider_issue_count = 0` on a snapshot is a real
provider statement while *no snapshot* is nobody having looked.

### 4.1 Complete means EVERY entry was represented

`provider_issue_count` always equals the number of issue rows. A snapshot is
complete only when every entry in the provider's array was structurally
represented — and if any entry cannot be read, **no snapshot is created at all**.

The state this forbids is `provider_issue_count = 1`, zero child rows, snapshot
"complete": an evaluator would then see a complete snapshot with no mapped
closure and answer `no_known_closure` about a property whose only provider issue
nobody understood. If that unread entry was `HOTEL`/`CLOSED`, a closed hotel
reads as clean.

So the conservative rule that already governed a non-array `issues` value governs
malformed entries **inside** the array too: skip nothing, create nothing, report
the failure with the provider's own array index and `order`, and let the property
evaluate `unresolved`.

**Defence in depth.** The evaluator independently refuses any snapshot where
`provider_issue_count` differs from the rows present — `issue_count_mismatch` —
because a hand-written row, a future writer or a partially-failed load could
create what the extractor cannot.

## 5. Dates

`--as-of YYYY-MM-DD` is **required**. There is no default, and no code path in
the decision logic reads a clock — a test reads the source files to prove it.

### 5.1 Provider date bytes are stored VERBATIM

`date_from_raw` and `date_to_raw` are **text**, not `date`, and nothing is
trimmed, sliced, coerced or validated before persistence. A `date` column cannot
keep the contract's promise that malformed evidence survives:

- `2026-02-31` has the shape of a date and is not one. Postgres rejects the cast,
  so the whole extraction rolls back and the evidence that should have produced
  `unresolved` is lost entirely;
- `2026-08-31garbage` would have to be trimmed to fit — inventing a clean
  `2026-08-31` the provider never sent, and turning unreadable evidence into a
  confident closure window.

### A provider date field has exactly three states

| provider sent | extraction |
|---|---|
| nothing / `null` | persist `NULL` — the provider said nothing |
| a **string** | keep it WHOLE, byte for byte — no trim, slice, coercion or validation |
| anything **not a string** | the entry is structurally **unreadable**: no snapshot, explicit failure |

The third row matters as much as the second. `dateFrom: 20260231` is not a date
the provider omitted, and stringifying it to `"20260231"` would fabricate a
statement it never made; nulling it would claim absence where there was a value.
Neither is true, so §4.1 applies and the whole snapshot is withheld with
`unreadable_issue_date_from` / `unreadable_issue_date_to`, carrying the property
id, the provider array index and its `order`.

`" 2026-08-31 "` and `""` are strings the provider chose to send. They survive
verbatim, and the evaluator calls them **invalid** — never missing.

**Validation belongs to the evaluator**, which can tell the two apart:

| provider value | reason |
|---|---|
| absent (NULL) | `mapped_closure_missing_date_from` / `_to` |
| present, not a real date | `mapped_closure_invalid_date_from` / `_to` |
| both real, `from > to` | `mapped_closure_inverted_range` |

An invalid non-null string is never called "missing": the provider *said*
something, and hiding that would misdirect whoever investigates.

The reviewed Hotelbeds interpretation, recorded on the policy row as
`inclusive_day_interval`:

> `dateFrom <= as_of <= dateTo` — **both endpoints inside the window.**

The provider documents `dateFrom` as the date the issue *starts* and `dateTo` as
the date it *ends*; both are days the issue is in force. Treating `dateTo` as
exclusive would declare a hotel open on the last day the provider says it is
shut. No time-of-day semantics are invented: these are day-level facts, compared
as days.

Proven on the real Dubai window `2026-05-31 → 2026-08-31`:

| as-of | outcome |
|---|---|
| 2026-05-30 | not in the window |
| **2026-05-31** | **in** (start inclusive) |
| 2026-08-17 | in |
| **2026-08-31** | **in** (end inclusive) |
| 2026-09-01 | not in the window |

## 6. The answer is not a durable fact

A closure window changes its CURRENT meaning **because the calendar moved**, with
no new provider statement at all. The table above is one snapshot of evidence
producing two different answers.

So this layer persists **no** `hotel_active`, no `hotel_closed`, no
`current_lifecycle_status`. Such a column would be false the morning after it was
written, and keeping it true would mean re-deriving 4,110 rows every calendar day
to record a fact nobody stated. What is persisted is the EVIDENCE; the outcome is
computed by an evaluator holding an explicit date, and D062's receipt will record
which date it used.

## 7. Currentness belongs to the LATEST observation

Current evaluation uses the snapshot tied to the **latest** observation, and only
that one. Historical snapshots stay as historical evidence and are never unioned
in.

| situation | result |
|---|---|
| latest observation has a complete snapshot with no closure; an older one recorded a closure | `no_known_closure` — the closure was lifted |
| latest observation has NO complete snapshot; an older one does | **`unresolved`** — never a fallback to stale evidence |

Both directions matter. Carrying an old closure forward would keep a reopened
hotel closed; falling back to an old clean bill would cover an observation nobody
extracted.

## 8. Malformed closure evidence is not "nothing known"

If a **mapped** (`HOTEL` + `CLOSED`) row has a missing `dateFrom`, a missing
`dateTo`, an impossible date, or `dateFrom > dateTo`, the evaluation is
`unresolved` with the reason surfaced — never `no_known_closure`. Reporting a
broken closure notice as a clean bill of health is the same error as ignoring it.

The malformed row is **preserved**, not discarded: it is the thing that makes the
answer unresolved, and a reviewer needs to see it.

A malformed **facility** issue does not make a property unresolved. It carries no
lifecycle meaning under the approved policy, so it has nothing to be defective
about.

## 9. Multiple windows

Multiple `HOTEL`/`CLOSED` intervals are allowed and are separate provider
statements, never merged or averaged.

- ANY valid interval containing `as_of` → `known_closed`;
- all intervals valid, none containing it → `no_known_closure`;
- any mapped interval malformed → `unresolved`.

## 10. A long range is still a range

The real Bali row is `2020-04-24 → 2039-12-31`. It is **not** permanent closure,
not `inactive_forever`, and not a closed canonical property. Evaluated on
2040-01-01 it returns `no_known_closure` — which permanence would forbid — and on
2026-08-17 it returns exactly the same `known_closed` a three-month window earns.

> Same rule. Different dates.

There is no branch anywhere on how distant `dateTo` is, and a test asserts the
strings `permanently_closed`, `permanent_closure`, `inactive_forever` and
`final_exclusion` appear nowhere in this layer.

## 11. `source_lifecycle_status` is a different field

`source_property_observations.source_lifecycle_status` is NULL on all 4,110
current observations. This layer neither reads nor writes it, and **absence of
issues is never laundered into `lifecycle = active`**. The `issues[]` evidence is
a separate provider evidence source and is kept separate in schema, code and
docs.

## 12. Provenance — the EXACT provider record

An evaluation is reconstructable from: source property identity → latest
observation → complete issue snapshot → the exact structured issue rows →
the approved policy version → the explicit `as_of` date.

It is never derived from a hotel name, a destination label, a free-text search, a
generated summary string, or a historical issue detached from the latest
observation.

**Binding is by whole-record digest, not by recency.** "Which observation does
this artifact record describe?" and "which observation is newest?" are different
questions, and they diverge exactly when it matters: if run A observed a property
with a `HOTEL`/`CLOSED` issue and run B observed it later with different
evidence, extracting artifact A afterwards must not attach A's closure to B's
observation. That would make the provenance false and change the *current*
lifecycle answer using a record that is not current.

So a snapshot carries the digest of the **whole** provider record — the same
value the ingestion adapter wrote on the observation that record produced. A
digest of `issues[]` alone would not do: two runs can agree about the issues and
differ everywhere else.

**But a digest alone still does not name a run.** Observations are unique per
`(source_run_id, source_property_identity_id)`, **not** per digest, so two runs
that both saw an UNCHANGED property produce two valid observations carrying
*identical* digests. A lookup keyed on `(property, digest)` selects both and
keeps whichever row or map entry happened to be written last — provenance decided
by accident of ordering.

(For the avoidance of doubt: object-key order is **not** the issue.
`digestValue` canonicalises through `canonicalJson`, which sorts keys at every
depth before hashing, so re-serialisation cannot change a digest. The ambiguity
is two legitimately different runs carrying the same content.)

So the snapshot also carries `evidence_source_run_id`, and the lookup key is
`(source, environment, source_run_id, source_property_id, whole-record digest)`.
The run id is derived with the ingestion pipeline's own machinery —
`deterministicUuid(runFingerprint(manifest))` — so it is the id already in the
database, not a parallel run-identity scheme. **An extraction from artifact A
binds only to observation A**, regardless of row order, map order, `observed_at`,
or which observation is latest.

`source_payload_digest` is deliberately **not** unique across observations:
identical provider records across different runs are valid and must stay
representable.

If no observation matches, **no snapshot is written**. The failure is
reported as a provenance mismatch, distinguishing "this property was never
ingested here" from "it was ingested from a different record", and the property
evaluates `unresolved`. Nothing is attached best-effort.

Four composite foreign keys make misattribution unrepresentable: a snapshot must
cite an observation **of its own identity**, **of its own payload digest** and
**of its own source run**, and an issue row must cite a snapshot **of its own
identity**. Application logic is the first layer; the database is the second.

## 13. Future composition — D062 condition 4 (DOCUMENTED, NOT IMPLEMENTED)

This PR does not implement D062 Preview or Apply. When it is built:

| lifecycle outcome | condition 4 |
|---|---|
| `known_closed` | **fails** for that explicit `as_of` date |
| `no_known_closure` | **may pass** — and must not be described as "active" |
| `unresolved` | **HOLD** — cannot publish |

The D062 receipt must cite the issue snapshot and evidence, the policy version,
the `as_of` date and the outcome. Without the date the receipt does not explain
its own decision, because the same evidence yields a different answer on a
different day.

## 14. Not in this layer

Permanent hotel closure · `hotels.active_status` writes · canonical lifecycle
status · D062 Preview or Apply · promotion · canonical hotels ·
`hotel_source_identities` · terminal `resolution_state` transitions · human
entity decisions · decision receipts · Coverage Engine · Provider B · production
ingestion · live provider calls · contacts · media · UI · LLM lifecycle
interpretation · free-text, name-based or destination-based closure inference.
