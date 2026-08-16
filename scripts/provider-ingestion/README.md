# Provider source ingestion

Writes provider-sourced property data into the migration `0027` source
infrastructure — `source_runs`, `source_property_identities`,
`source_property_observations`.

In its current form it does exactly one thing: **replay a cached Hotelbeds
evaluation extraction, offline, into a disposable local database.** It makes no
provider requests, needs no provider credentials, and runs with the Hotelbeds
host completely unavailable.

```bash
# PREVIEW (default — no writes of any kind)
npm run source:ingest -- --provider hotelbeds --destination bali

# APPLY (local/disposable database only)
TEST_DATABASE_URL=postgres://… npm run source:ingest -- --provider hotelbeds --destination bali --apply
```

---

## Architecture: one writer, one adapter per provider

```
cached artifacts ──▶ HOTELBEDS ADAPTER ──▶ generic input ──▶ GENERIC WRITER ──▶ 0027 tables
 (.data, gitignored)  adapters/            types.ts          writer.ts
                      hotelbeds-cached.ts
```

**`writer.ts` is provider-agnostic.** It knows the three 0027 tables and knows
nothing about any provider's JSON. Adding Nuitee means writing another adapter,
not another writer — which is the whole point of a source-agnostic canonical
model (D063).

**`adapters/hotelbeds-cached.ts` knows Hotelbeds.** It imports the PURE modules
from the PR #21 evaluation harness — `hotelbedsContentDescriptor` (the field map
verified against live payloads), `buildClassificationMaster`,
`deriveImageEvidence`, `readPath` — so a correction to the verified semantics
there is automatically a correction here. It imports nothing that can reach the
network.

| File                           | Responsibility                                               |
| ------------------------------ | ------------------------------------------------------------ |
| `types.ts`                     | the provider-agnostic contract between adapter and writer    |
| `digest.ts`                    | canonical JSON, SHA-256, deterministic run UUIDs             |
| `manifest.ts`                  | explicit artifact selection, digests, evidence, verification |
| `db-target.ts`                 | local-only target resolution; refuses remote                 |
| `writer.ts`                    | the transactional, idempotent, evaluation-locked writer      |
| `adapters/hotelbeds-cached.ts` | cached-payload → generic observation input                   |
| `ingest.ts`                    | CLI: preview, apply, reporting                               |

---

## The manifest

Every run is anchored to a frozen manifest under `.data/provider-ingestion/`
(gitignored). It records **which** cached evidence is being replayed:

```jsonc
{
  "formatVersion": "provider-ingestion-manifest/1",
  "runEvidenceVersion": "hotelbeds-cached-evaluation/1",
  "provider": "hotelbeds",
  "sourceEnvironment": "evaluation",
  "destinationSlug": "bali",
  "providerGeography": { "destinationCode": "BAI" },
  "artifacts": [
    {
      "role": "raw_properties",
      "relativePath": "…",
      "sha256": "…",
      "bytes": 79521136,
      "artifactCaptureTimestamp": "…",
    },
  ],
  "evidence": { "rawRecordCount": 3275, "providerReportedTotal": 3275, "…": "…" },
  "observedAt": "…",
  "observedAtBasis": "artifact_capture_timestamp_local_evidence",
  "manifestDigest": "…",
}
```

**Artifacts are named explicitly, never discovered by globbing `.data/`.** The
evaluation tree also holds credential probes, one-record field probes, geography
masters, category masters, superseded partial runs and pilot comparison rows —
none of which are properties, and several of which a pattern match would happily
pick up. The whitelist lives in `HOTELBEDS_CACHED_SELECTIONS`, so adding a
destination is a reviewable diff.

Before every preview and every apply, **all artifacts are re-hashed** and
compared with the manifest. A mismatch is a hard stop: changed source data must
never be ingested under the identity of an older run.

---

## Idempotency

`0027` deliberately adds no provider-run fingerprint column, and this block does
not add one. Instead the **run's primary key is derived from the content**:

```
runFingerprint = sha256(runEvidenceVersion, provider, environment,
                        destinationSlug, providerGeography,
                        artifact content digests)
run.id         = deterministicUuid(runFingerprint)
```

so `insert … on conflict (id) do nothing` gives idempotency through the existing
PK. Consequences, all intended:

- replaying the same artifacts resolves to the **same** run — no second run, no
  duplicate observations, no `observation_count` inflation;
- a **copied** artifact with identical bytes is still the same logical run: the
  fingerprint uses content digests only, not paths or mtimes;
- a **changed** artifact produces a different run.

Deliberately NOT used as run identity: `created_at`, a random UUID, a `notes`
text lookup, or a filename.

Below the run, the existing 0027 keys do the rest — identities on
`(source, source_environment, source_property_id)`, observations on
`(source_run_id, source_property_identity_id)`.

`observation_count` increments **only** for an observation that was genuinely
inserted, and `last_seen_run_id` advances **only** for a run newer than the one
already recorded — so ingesting an older cached run records its observation
without dragging the identity's last sighting backwards.

---

## Timestamps: what `observed_at` actually means

The Hotelbeds Content API supplies **no run timestamp**, and these are cached
files. So `observed_at` is the raw artifact's **file capture timestamp**, frozen
into the manifest, and labelled `artifact_capture_timestamp_local_evidence`.

That is local evidence about when we wrote the file — **not** a
provider-authoritative observation time, and the run notes say so in the
database itself. `created_at` remains what it looks like: when the row was
inserted. Freezing the value in the manifest is what keeps a later replay
deterministic.

---

## Safety

**No network.** No client, transport, signature, cache, budget or credential
module is in the import closure — a test walks the real import graph and asserts
it, and also asserts that the PURE evaluation modules _are_ still reachable so
the two cannot drift apart.

**Evaluation-locked.** The writer substitutes the `evaluation` constant; there is
no parameter to change it. `--environment production` is an explicit error
rather than a silently ignored flag, because a caller who asked for production
needs to be told there is no production path.

**Local-only.** `db-target.ts` reuses the import pipeline's host classifier and
refuses any remote target, any unclassifiable target, and offers **no override
flag** — no `--yes-really-write-production`, and a test proves no environment
variable unlocks one.

**Dry-run by default.** `--apply` is required for any write.

**All-or-nothing.** Each destination is applied inside one `begin … commit`. A
failure at record 3,000 leaves no run, no identities and no observations.

---

## Boundaries this writer respects

| Boundary                          | How                                                                                                                                                                                                                 |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Raw payloads stay out of Postgres | `source_payload_digest` only — SHA-256 over a canonical form of the whole original record, so a change to _any_ field (including unmodelled ones) changes it                                                        |
| `source_payload_uri`              | left NULL. A local filesystem path is not a durable URI; the manifest records which file was used                                                                                                                   |
| `source_attributes`               | `{}`. Every field the adapter reads has a typed column; an adapter-side bound rejects anything large before the 8 KB database trigger has to                                                                        |
| Media                             | count + provider-designated-principal flag. No rows, no URLs, no binaries (D064)                                                                                                                                    |
| Classification                    | provider code, label, group, and `simpleCode` **as text**. The writer never writes `source_classification_evidence_kind`, so 0027's single permitted value stands and no provider can appoint itself star authority |
| Lifecycle                         | NULL. The hotels payload carries no structured lifecycle field, and one is not invented from a destination-master name                                                                                              |
| Phones                            | first **voice** number. A fax is never reported as a contact phone                                                                                                                                                  |
| Coordinates                       | stored raw. Out-of-range values are retained and flagged; missing ones stay NULL, never 0/0                                                                                                                         |
| Canonical data                    | untouched. There is no SQL for `hotels`, `hotel_source_identities`, `source_match_candidates` or `source_property_reviews` in this directory                                                                        |

---

## Deliberately NOT implemented

- any live provider call, any production ingestion mode;
- entity resolution, `source_match_candidates`, `source_property_reviews`;
- star or location resolution, the D062 promotion gate, promotion apply;
- Coverage Engine — and note that terminal resolution states are not yet
  operationally authoritative, so counting them is premature
  (`PROPERTY_CONTENT_IMPLEMENTATION_SPEC.md` §22.2);
- `hotel_media`;
- any canonical hotel write of any kind.

Every identity this writer creates leaves `resolution_state = 'unresolved'`, in
`source_environment = 'evaluation'`. That is the entire intended outcome.
