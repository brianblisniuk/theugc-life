# theugc.life — LEGACY_DATA_MIGRATION.md
Version: 1.0
Status: One-time migration guidance

## 1. Scope

The currently available hotel research files are legacy inputs only.

They are NOT product requirements and are NOT the canonical format for future research.

The valuable asset is the underlying hotel/contact/evidence information. We may discard malformed/noisy rows when they cannot be mapped reliably.

## 2. Strategy

Each legacy source gets a narrow adapter that translates source-specific fields into the canonical normalized staging contract defined by `HOTEL_DATA_CONTRACT.md` and `IMPORT_SPEC.md`.

Legacy adapters may parse:
- mixed tables
- repeated headers
- narrative columns
- multiple emails in one cell
- malformed copy/paste artifacts
- citations/notes
- hotel/group/agency ambiguity

But no source-specific field is allowed to become a canonical database column merely because it exists in a legacy file.

## 3. Current legacy sources

The migration currently needs to handle:
- broad Dubai accommodation research workbook
- curated Dubai outreach/contact workbook
- multi-destination mixed research workbook
- structured Florianópolis research Markdown

Exact filenames are local implementation details.

## 4. What to preserve

Preserve when confidently extractable:
- property identity
- destination/geography
- website/social URL
- brand
- property type/star rating
- valid contact endpoint
- named contact and role
- source/provenance
- explicit verification level
- operator/group/agency relationship
- useful editorial evidence

## 5. What may be discarded or review-gated

Do not force-import:
- webpage navigation fragments
- masked emails
- guessed values with no explicit inference flag
- rows combining several distinct hotels when splitting is unclear
- stale narrative without identifiable subject
- duplicate copied headers
- malformed content whose meaning cannot be reconstructed safely

Lossy cleanup is acceptable when the alternative is contaminating canonical data.

## 6. Quality hierarchy

When sources conflict, do not simply prefer the newest spreadsheet row.

Prefer evidence quality in this order unless a stronger specific fact exists:
1. official property/brand/operator source
2. authorized representative/media kit
3. named corporate source with traceable provenance
4. reputable third-party/public registry
5. research compilation
6. inferred/guessed value

Conflicts become review items when they affect identity or a premium contact.

## 7. No live intelligence seeding

Legacy statements about creator friendliness, influencer activity or collaboration history are editorial evidence only.

They never create creator workflow events or collective outcome metrics.

## 8. Migration completion

Once useful legacy information is promoted into canonical tables and lineage/evidence is preserved, the product must not depend on the original file structure.

Future hotel research uses `HOTEL_DATA_CONTRACT.md` directly.
