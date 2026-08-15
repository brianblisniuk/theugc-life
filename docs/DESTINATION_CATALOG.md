# theugc.life — DESTINATION_CATALOG.md
Version: 1.0
Status: Approved Sprint 1B specification

## 1. Principle

`destinations` is a controlled product taxonomy, not a dump of arbitrary geography strings from research.

A source file may describe a city, island, region or neighborhood. That text does not automatically create a canonical destination.

Canonical destination nodes are deliberately created and versioned as the product expands.

## 2. Existing hierarchy

The existing `destinations` table remains canonical:

- `country`
- `region`
- `island`
- `city`
- `area`

A hotel belongs to the most specific approved destination available.

Examples:

`Indonesia -> Bali -> Ubud`

`United Arab Emirates -> Dubai -> Dubai Marina`

`Spain -> Balearic Islands -> Ibiza`

Commercial sellability is independent from geographic specificity. `is_sellable` determines whether a Destination Pass may be sold for a node; parent entitlement continues to cover descendants through the existing entitlement resolver.

## 3. Stable destination key

Future standardized research should include an optional `destination_slug` field in the property contract.

When a research project targets an already-approved destination, `destination_slug` SHOULD be supplied and is the preferred deterministic identity.

Example:

- `destination_name = Bali`
- `destination_slug = bali`

Legacy adapters may leave it null.

The importer never invents a destination slug from ambiguous source geography and then creates a canonical node automatically.

## 4. Destination aliases

Add `destination_aliases` as an internal editorial mapping table.

Fields:

- `id uuid PK`
- `destination_id uuid FK destinations`
- `alias text NOT NULL`
- `normalized_alias text NOT NULL`
- `country_code text NULL`
- `source text NOT NULL DEFAULT 'editorial'`
- `is_active boolean NOT NULL DEFAULT true`
- timestamps

Uniqueness must prevent duplicate active alias identities for the same destination while allowing the same human-readable alias in different countries where legitimate.

Aliases exist only to resolve research/import terminology. They are not public destination entities.

Examples:

- `Floripa` -> `florianopolis`
- `JBR` -> `dubai-marina` or another explicitly approved node
- historical/alternate spelling -> canonical destination

Ambiguous aliases must not auto-resolve.

## 5. Resolution order

For standardized imports, resolve destination in this order:

1. exact active `destination_slug`;
2. exact active alias + compatible country code;
3. exact normalized canonical destination name + compatible country code when unique;
4. otherwise unresolved/review-required.

Never use fuzzy geography matching for automatic canonical promotion.

Never auto-create a destination from free text during hotel promotion.

## 6. Destination management tooling

Sprint 1B should provide admin/server CLI tooling, not a public UI, equivalent to:

- `destination:list`
- `destination:upsert`
- `destination:alias`

The commands must validate:

- slug uniqueness;
- parent exists;
- no parent cycle;
- country compatibility;
- type is in approved taxonomy;
- latitude/longitude range when supplied.

No third-party geocoder or global city package is required in Sprint 1B.

## 7. Research workflow going forward

Before commissioning a clean destination-specific research batch:

1. create/confirm the canonical destination node;
2. provide the researcher the canonical destination slug;
3. require the output to use that slug;
4. let free-text city/region/address fields remain descriptive metadata.

This reverses the old workflow: the product taxonomy controls research, rather than research accidents controlling the product taxonomy.

## 8. Promotion requirement

A new canonical hotel MUST have an approved canonical `destination_id` before promotion.

If destination resolution is unresolved, the property remains in staging regardless of contact quality.

A reviewer may explicitly choose a destination during review. That decision is audited.

## 9. Non-goals

Sprint 1B does not attempt to build a universal geographic database, geocode every address, infer neighborhoods, or pre-seed every travel destination in the world.

The catalog grows deliberately as inventory/research expands.

## Initial V1 destination set — recorded, not ingested

The owner has approved the first twenty product destinations. They are listed in
[`INTELLIGENCE_ROADMAP.md`](INTELLIGENCE_ROADMAP.md) §11.

**No coverage ingestion has started**, and the property inventory sources remain
unchosen — the comparative evaluation that will choose them is specified in
[`PROPERTY_SOURCE_EVALUATION.md`](PROPERTY_SOURCE_EVALUATION.md), and it runs
against **Bali and Dubai** first. Two constraints apply when the nodes are
created:

- They are product **destinations**, not necessarily schema type `city`. Bali is
  the obvious case — an island containing areas a creator thinks of separately.
- The hierarchy matters commercially, not only editorially: a Destination Pass
  covers descendants (`_has_active_destination_access`, D051), so flattening a
  destination that should have children silently narrows what the Pass buys.

Each destination is subject to D055 and D061: **all** eligible properties in its
coverage universe, with exclusions recorded and auditable. Eligibility is defined
by D060 — a physical hospitality property with a resolved 4- or 5-star
hospitality classification.

**No destination has a hotel-count target.** The count is an output of its
coverage run (`PROPERTY_CONTENT_COVERAGE_CONTRACT.md` §15), so a number must
never be assigned to a destination in advance, in this file or anywhere else.
