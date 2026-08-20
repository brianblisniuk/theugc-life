# theugc.life — PROPERTY_ENTITY_RESOLUTION_CONTRACT.md

Version: 1.0
Status: **Approved product contract.** Governs how pre-publication
entity-resolution EVIDENCE is generated, recorded and reviewed.

Governing decisions: **D063** (theugc.life owns canonical identity; a provider
ID is a source identity; §12.2 refuses a universal match threshold), **D062**
(promotion is publication — conditions 1 and 11 read from here), D061, D065.

---

## 1. The one question this layer answers

> **What other known property or entity could this source property be?**

It does **not** answer "should this be published?", it creates no canonical
hotel, and **it decides no match** — nothing in this system marks a pair
`accepted`. Discovery surfaces relationships worth comparing; persistence
ownership is a separate question. If no row exists, the generator may create its
own `source_identity` + `blocking:%` row as `pending`. It may refresh that row
while it remains pending, stand it down as `superseded` when its own blocking
rule disappears, and reactivate only a row it previously stood down with
`superseded_reason = 'no_current_blocking_rule'`. A manual pending row, a
human-decided row, or any other non-generator-owned row is never acquired or
rewritten by discovery.

```
source property identity
        ↓
pointer-current observation            (identity.last_seen_run_id; evidence, never canonical — D065)
        ↓
candidate discovery / blocking        "is this pair worth COMPARING?"
        ↓
pair evidence                         what the evidence SAYS
        ↓
source_match_candidates               generator-owned: pending while current;
        ↓                             machine-superseded when stale;
review manifest                       manual/decided rows keep their ownership
        ↓
a human                               the only thing that may decide a match
```

## 2. Why there is no score

D063 §12.2 refuses a universal entity-resolution threshold, and the real
Bali/Dubai data shows why in one line. The **highest-evidence pair** in the whole
4,110-property run — name containment, domain agrees, address agrees, phone
agrees, brand agrees, 773 m apart, `agreeing_dimensions = 5` — is:

| | |
|---|---|
| A | `Al Bandar Arjaan by Rotana - Creek` |
| B | `Al Bandar Rotana - Creek` |

Two different properties in one Rotana complex. *Arjaan* is Rotana's
serviced-apartment brand. Any threshold that accepted this pair would merge them;
any threshold that rejected it would reject genuine duplicates scoring lower.

So there is no score, no confidence, no weight, no cutoff, and a test reads the
source files to prove no such comparison exists.

`agreeing_dimensions` is `GENERATED ALWAYS` in 0027 and is **descriptive**:
nothing in this codebase compares it to a number.

## 3. What blocking decides

Only: *is this pair worth comparing?*

### 3.1 The rules

| Reason | Key | Scope |
|---|---|---|
| `exact_domain` | normalised hostname | destination |
| `exact_phone` | international-form digits, non-fax | destination |
| `exact_name_in_destination` | normalised name | destination |

### 3.2 A key must IDENTIFY, not GROUP

This is the load-bearing rule, and the data forced it. Exact domain looks like a
strong anchor until you look at the distribution: **69** domains are shared by
exactly two properties — and then `oyorooms.com` by 31, `ihg.com` by 25,
`all.accor.com` by 25. Phone is the same shape: **160** numbers shared by two,
and one shared by **47**, which is a call centre.

Large keys are not weak identity evidence. They are evidence about a *different
thing* — a chain, an operator, a reservations desk. Expanding them pairwise would
bury the genuine 1:1 collisions under ~4,100 pairs of "these are both Accor
hotels".

> A key generates a candidate pair only when it selects **exactly two**
> identities in scope. A key selecting three or more is recorded as a
> **SHARED-KEY CLUSTER** for review, and never expanded.

That is a distinction between cardinalities — does this key name a property or a
group? — not a tuned constant. **Its cost is stated plainly**: a genuine
triplicate reaches a reviewer as one cluster rather than three pairs. Nothing is
hidden; it is just not pre-paired.

### 3.3 Unknown geography is not the same place

Every rule here is destination-scoped, so an identity whose destination is
unknown satisfies none of them. Mapping NULL to a shared sentinel would make two
unknown-geography identities "the same destination" on the fiction that NULL
equals NULL, and a shared name, domain or phone between them would become a pair
on the strength of a fact nobody has.

They are not discarded: they are reported as an **INCOMPLETE GEOGRAPHY** finding,
which is the honest description — the pair may well be real, and this contract
cannot say so. An absent destination is likewise not a *second* destination, so
it never counts toward a cross-destination anomaly either.

### 3.4 Destination scope

Keys are scoped to the destination, and a key appearing in more than one is a
**cross-destination anomaly** — surfaced, never paired. The real data holds 19,
including `ritzcarlton.com`, `raffles.com` and `marriott.com`: a Ritz-Carlton in
Bali and one in Dubai are two properties.

This does **not** assert that one physical property can never span a destination
boundary. It asserts that a shared chain asset is not the evidence that would
establish it.

**The veto is global, and decided before any pair exists.** Whether a key names
a chain is a fact about the KEY, not about the destination you happen to be
standing in: `marriott.com` does not become property-level identity evidence
inside Bali merely because the Dubai Marriotts sit in a different bucket. So a
key appearing in more than one *known* destination contributes **zero pairs
anywhere**, in every destination, and the same computation produces both the
anomaly and the refusal — what is reported and what is refused cannot disagree.

Scoping first and checking afterwards would have let two Bali properties pair on
a domain that was simultaneously reported as a cross-destination anomaly, which
is the contradiction this rule exists to prevent.

Two things the veto deliberately does not do:

- it removes a **reason**, not a pair. Two Bali properties sharing both
  `marriott.com` and a local phone still surface as one candidate —
  `blocking:exact_phone`, not `blocking:exact_domain+exact_phone`;
- it does not touch **clusters**. A cluster is not a pair, and "these four Bali
  properties share a chain domain that also appears in Dubai" is true and worth
  showing.

In the real data the veto removes **5** of 266 pairs, every one of them domain-only
and every domain a chain: `movenpick.com`, `anantara.com` (twice), `hyatt.com`,
`fourseasons.com`. None survived on an independent reason, because none had one.

### 3.5 Geography comes from the observation being compared

The destination is read from the run named by the identity's
`last_seen_run_id`, and from that run's observation for the same identity,
not from the run that first saw the identity. Taking the name, domain and phone
from a new observation and the geography from an old one describes a property
that never existed: if a provider enumerates a property under destination A and
a later run corrects it into B, that seam can manufacture pairs, miss real ones
and invent a cross-destination anomaly out of nothing. The pointer-current
observation and its run's geography are **one current evidence unit**. Timestamp,
UUID and row order never replace that pointer, and a broken pointer has no
historical fallback.

## 4. Normalisation

Comparison-only. Nothing is written back; `source_property_observations` keeps
the provider's text verbatim. Conservative or nothing:

| Field | Rule | Deliberately NOT done |
|---|---|---|
| domain | lower-case, strip scheme/credentials/port/path/query, strip `www.`; must have a dot and an alphabetic TLD | subdomain stripping — `bali.chain.com` ≠ `chain.com` |
| phone | international form only (`+…` / `00…`, both peeled once); 8–15 digits | inventing a country code for a national number |
| name | case, punctuation, whitespace; exact equality, or full token containment of the shorter name (≥2 tokens) | stop-words, dropping "Hotel", similarity scoring |
| address | textual only | geocoding, abbreviation dictionaries (`Jl.` ≠ `Jalan`) |
| brand | brand code, falling back to chain code — ONE dimension | counting brand and chain as two agreements |
| coordinates | raw great-circle metres | any threshold, any bucketing |

A value that cannot be compared is `null`, and `null` equals nothing — including
another `null`. That is what keeps missing data out of the evidence as agreement
**and** out of it as disagreement.

The domain rule earns its strictness: the real Bali payload contains a `web`
value of exactly `"n"`.

## 5. Evidence semantics

0027's vocabulary, unchanged:

- `name_evidence`: `exact` | `token_containment` | `none` — ONE dimension with
  two strengths, so an exact name cannot be counted twice.
- `domain` / `address` / `phone` / `brand`: `agrees` | `differs` | `unavailable`.
- `coordinate_distance_metres`: raw, or NULL. Never converted to
  `agrees`/`differs` — there is no coordinate dimension to convert it into.
- `known_source_mapping`: only a confirmed mapping. This block confirms none, so
  it is always `false` here.

**`unavailable` is not `differs`.** In a review queue, "differs" reads as a
reason to reject; "neither side supplied an address" is not one.

## 6. `new_property` is a FINDING, never an inference

The dangerous inference in entity resolution is:

> the sweep produced no candidate → therefore this is a new property

It is not. Absence of a generated candidate is a statement about the **rules**,
not about the world, and D062 would later read a `new_property` row as
authorisation to create a canonical hotel.

So:

- the machine pipeline **never** writes a `new_property` row, at any volume;
- migration 0030 requires one to carry a `review_note` — a sweep has no
  justification to write, a reviewer does;
- the manifest's queue for these identities is called **NO MACHINE CANDIDATE**,
  and says in the output that it is not a new-property list.

### 6.1 What that queue may contain

It is the RESIDUAL of the current discovery result, and nothing else: an
identity appears there exactly when the current sweep surfaced **no pair, no
shared-key cluster, no cross-destination anomaly and no incomplete-geography
finding** about it (§7.1).

Deriving it instead from "no row exists in `source_match_candidates`" answers a
different question and swallows findings in both directions — a pair that was
stood down leaves a row behind, so its identities would be excluded forever; the
31 identities sharing `oyorooms.com` produce a cluster and no rows at all, so
they would be listed as "nothing surfaced" when the machine found something
material about every one of them.

In the real run **3,002** of 4,110 identities have no machine finding of any
kind, and **zero** `new_property` rows exist.

## 7. Review

Status vocabulary is 0027's: `pending` | `accepted` | `rejected` | `superseded`.

| Status | Written by | Meaning |
|---|---|---|
| `pending` | the generator, when generator-owned | a current blocking rule supports comparing this machine-owned pair |
| `pending` | a human/manual tool, when non-generator-owned | a reviewer explicitly placed the relationship into review; the generator may not acquire it |
| `superseded` | the generator, with `superseded_reason = 'no_current_blocking_rule'` | no current rule supports its own machine row any more (§8a) |
| `superseded` | a human, with no reason recorded | a reviewer set this pair aside |
| `accepted` / `rejected` | a human, only | a decision |

`pending` alone never establishes ownership. Generator ownership requires both
`candidate_kind = 'source_identity'` and `match_method like 'blocking:%'`.

**No code path in this repository writes `accepted` or `rejected`**, and a test
reads the source files to prove it. **The system decides no MATCH**, at any
volume, on any evidence.

### 7.1 The review surfaces

`npm run source:match:review` is READ-ONLY, and every one of its queues is
computed from ONE current discovery result plus the current rows — never from
the history of what was once found:

- **CANDIDATES** — `status = 'pending'` **only**, because that is the single
  status that is waiting for somebody. A pending row may be generator-owned or
  manual; the queue labels every row `machine` or `MANUAL`. A
  machine-superseded row is history and a decided row is decided; showing all
  four statuses under one heading would put four meanings behind one word, and
  the displayed total uses the identical filter so the count and the list can
  never disagree. Non-actionable rows are summarised separately, grouped by
  status and reason. Each entry shows the pair, both names, both destinations,
  why it surfaced, every evidence dimension, the raw distance and the descriptive
  count;
- **ANOMALIES** — shared-key clusters, cross-destination collisions **and**
  incomplete-geography findings (reason, key, affected identities), plus the
  size of each partition. These sets **overlap by design**: one identity can be
  in a pair on its phone and in a cluster on its chain domain, and both facts
  are true;
- **NO MACHINE CANDIDATE** — the residual of the same discovery result (§6.1).

Geography on every one of these surfaces is read from each identity's LATEST
observation and that observation's own run (§3.5) — never from the run that
first saw it.

### 7.2 The sync gate — CANDIDATES fails closed

ANOMALIES and NO MACHINE CANDIDATE are computed live, so they are current by
construction. CANDIDATES is not: it reads persisted pending rows from an earlier
moment. Between then and now a provider correction can remove the blocking
relation behind a generator-owned pending row, or create a relationship that
nothing has yet accounted for. Either way the queue can silently stop describing
the present, and the row itself shows nothing — a stale machine candidate looks
exactly like a current one.

So before the queue may be shown, the generator's own pair set is compared with
a live sweep:

| | |
|---|---|
| discovered side | the pairs `discoverCandidates` returns right now |
| generator-owned | `status = 'pending'` AND `candidate_kind = 'source_identity'` AND `match_method like 'blocking:%'` — **both** ownership halves, always |
| accounted for | a pair a human DECIDED (`accepted`, `rejected`, or `superseded` with no reason), **or** a MANUAL pending `source_identity` pair |
| out of scope | `canonical_hotel`, `new_property`, and every other kind |

The discovered side asks *"does a reviewer have this relationship in front of
them?"*, not *"does the generator own a row for it?"*. Three things answer yes: a
current actionable machine pair, a decided pair, and a manual pending pair. Only
the first is generator-owned; the other two are accounted for and never machine
state — which is exactly why they must count. The generator is forbidden from
touching either, so calling them missing would raise an alarm no run could ever
clear, and the gate would refuse review forever over a pair a reviewer can
already see. The reverse direction stays narrow: only an actionable machine row
may be called stale, because only the generator can stand one down.

Disagreement in **either** direction stops the review with the command to run.
It is deliberately **not** a filter: intersecting the two would hide a newly
discovered pair that was never persisted, and hide a stale pending row without
recording the supersession it is owed — and a reviewer would believe they had
seen everything current. The review command still writes nothing; it reports the
disagreement and does not fix it.

The comparison is **not symmetric**, and must not be. A pair a human decided
keeps its evidence, so discovery keeps producing it while its row is no longer
`pending`. Counting that as missing would raise an alarm the generator can never
clear — it is required to leave decided rows alone — so a decided pair is
*accounted for* rather than absent.

### 7.3 A manual pair belongs to the human who made it

One pair is one row (§8), so when a reviewer creates A↔B by hand and the
provider evidence later makes the *same* pair machine-discoverable, the
generator's INSERT conflicts with **their** row. What happens next is the whole
question, and the answer is: nothing.

- the evidence refresh matches only rows in the generator's own namespace, so a
  manual row is left **byte-identical** — `manual_search` is never rewritten to a
  blocking method, and the reviewer's evidence and note are never overwritten;
- no second row is created; the unique-pair invariant forbids one, and the
  relationship is already in front of a reviewer;
- the row never becomes machine-supersedable, because it never becomes machine
  state;
- the sync gate treats it as **accounted for** while it stays actionable.

Without the ownership guard the sequence is a silent conversion: the refresh
takes the row, stamps it `blocking:…`, overwrites the evidence, and the next run
is then entitled to stand down what was a human's pair.

**One ownership definition governs every path:**
`candidate_kind = 'source_identity'` plus `match_method like 'blocking:%'`.
The TypeScript `isGeneratorOwned(...)` helper and the writer/sync SQL boundaries
mirror that exact two-part definition. Neither half alone establishes ownership:
`match_method` by itself is too weak because a `canonical_hotel` row is not
something the generator produces at all, and nothing stops a future tool writing
one with a blocking-shaped method. The queue labels every row `machine` or
`MANUAL`.

Re-running candidate generation refreshes evidence only on its own rows that are
still `pending`. Rewriting evidence under a decision a human already made would
make that decision look as though it rested on facts that were not in front of
them.

## 8. One pair, one row — literally

Migration 0030 makes this true **in the database**, not by convention:

- a CHECK requires the canonical orientation for a source↔source candidate
  (`source_property_identity_id < candidate_source_property_identity_id`), so
  `B → A` is refused outright rather than merely deduplicated. UUID ordering
  carries no meaning of its own, which is what makes it a safe canonical form;
- partial unique indexes then make the pair unique, and — because only one
  orientation is legal — genuinely unordered;
- the key is the PAIR, not the pair plus the reason: a pair found by both domain
  and phone is one candidate carrying both reasons in `match_method`, not two
  candidates for a reviewer to decide twice, possibly differently.

### 8.1 Unordered means READERS must not read one column

The canonical orientation is a storage rule, and it is the **only** thing UUID
ordering decides. It carries no claim that the left identity is the subject of the
pair and the right one its candidate — they are two endpoints of one symmetric
relationship, and which lands in `source_property_identity_id` is an accident of
identity generation.

> **A consumer of `source_match_candidates` MUST match BOTH endpoints.**
> Reading only `source_property_identity_id` silently sees a different population
> than the pair set actually contains.

This is not theoretical. Ingesting the same 4,110 cached Hotelbeds properties into
three separate databases produced the identical set of 261 pairs every time, but
**different orientations** in each, because each database generated its own
identity UUIDs. A reader filtering on the left column alone would report a
different candidate population per database from byte-identical provider evidence
— and no error would be raised anywhere, because every individual row is valid.

A04's preview reads the relationship correctly today: it selects a candidate when
the identity matches `source_property_identity_id` **or**
`candidate_source_property_identity_id`. Any future consumer — review surfaces,
counts, exports, A05's apply path — is held to the same rule.

## 8a. A pending candidate is a claim about CURRENT evidence

When the provider corrects a property so a pair shares no domain, no phone and no
destination-scoped name, discovery stops returning it — and a generator that only
visits current pairs would never look at that row again. It would sit in the
review queue forever describing a relationship nothing supports, and D062 cannot
read a queue like that.

So the generator **stands its own stale rows down**: `status = 'superseded'` with
`superseded_reason = 'no_current_blocking_rule'`.

| | |
|---|---|
| eligible | `candidate_kind = 'source_identity'` AND `status = 'pending'` AND `match_method like 'blocking:%'` — all ownership/current-state conditions |
| never touched | anything a human decided; anything the generator did not create |
| deleted | nothing |
| rewritten | nothing — the evidence that WAS current is preserved, so a reader can still see why the pair once stood |

**appears → disappears → reappears.** `source_match_candidates` is a MUTABLE
CURRENT record — 0027 gave it `status`, `resolved_at` and `review_note` and never
declared it append-only — so a pair that returns reactivates **the same row**:
`pending` again, reason cleared, evidence refreshed. A second row would be a
second thing to review for one relationship.

The reason column is what makes that safe. Only the machine writes
`no_current_blocking_rule`, and only a row carrying it may be revived — so a
human's `superseded` decision, which has no reason recorded, can never be
overturned by re-running a script.

Replay after any of these transitions changes nothing further.

## 8b. Future requirement — decision receipts (NOT in this layer)

`source_match_candidates` does not structurally freeze the exact left/right
observation ids behind a human decision, and this layer does not need it to:
nothing here decides anything.

**Before a D062 apply may rely on an entity-resolution decision**, the durable
decision receipt must be able to reconstruct the exact evidence snapshot, the
reviewer and the time the decision was made — the same guarantee 0028/0029 give
star, location and scope through immutable revisions. That is a named
prerequisite for the promotion block, not a gap in candidate discovery.

## 9. Not in this layer

Lifecycle · D062 preview or apply · promotion · canonical hotels ·
`hotel_source_identities` · terminal `resolution_state` transitions ·
Coverage Engine · Provider B · production ingestion · media · contacts ·
numeric match confidence · automatic thresholds · LLM or embedding decisions.
