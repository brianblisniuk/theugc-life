# theugc.life — SPRINT_1B_DECISIONS.md
Version: 1.0
Status: Accepted Sprint 1B amendments

## D034 — Canonical destinations are controlled taxonomy

Raw destination text never auto-creates canonical destination nodes.

Future clean research should use the canonical `destination_slug` whenever the target destination already exists.

Reason: geography and commercial destination taxonomy are product data, not researcher-generated truth.

## D035 — Property promotion requires explicit reviewer decision

No deterministic match, confidence score or validation status alone authorizes canonical hotel creation/matching.

Every property bundle requires `approve_create`, `approve_match`, `reject` or `defer`.

Reason: the first canonical dataset must have a deliberate human accountability gate.

## D036 — Inferred contacts are excluded by default

An `inferred` contact stays in staging and is not promoted by default. It may be included only through an explicit review override.

Invalid/rejected contacts cannot be force-included in Sprint 1B.

Reason: protect trust in paid contact data while preserving potentially useful research for later verification.

## D037 — Canonical imports never silently overwrite conflicting data

Matching an existing hotel may fill an approved staged value only when the canonical field is null. Conflicting non-null values remain unchanged unless a later dedicated editorial reconciliation workflow explicitly changes them.

Reason: provenance should accumulate without allowing imports to silently rewrite canonical truth.

## D038 — Contact lifecycle and verification confidence are separate

`hotel_contacts.status` represents operational lifecycle. A separate `verification_status` preserves verified/probable/inferred/unverified/invalid research confidence.

Reason: “currently usable” and “strength of evidence” are different dimensions.

## D039 — Preserve full contact display names

Imported person names are stored in `display_name`. Do not algorithmically split international names into first/last name.

Reason: automatic name splitting is culturally unreliable and can corrupt identity.

## D040 — Organization normalization is deferred, context is preserved

Sprint 1B does not automatically fuzzy-match/create a global organization graph from contact research. Explicit `organization_name` is preserved on canonical contacts/evidence.

Reason: hotel/contact promotion can proceed safely without introducing premature company-identity merges. A dedicated organization resolver may be added later.

## D041 — Sprint 1B is infrastructure, not the first real bulk import

Sprint 1B is complete when destination resolution, review state and promotion work end-to-end using synthetic fixtures.

Real legacy data promotion is a separate reviewed step.

Reason: infrastructure quality should not depend on availability or quirks of historical datasets.