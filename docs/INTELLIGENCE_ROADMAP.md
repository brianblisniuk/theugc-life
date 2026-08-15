# theugc.life — INTELLIGENCE_ROADMAP.md

Owner-approved future direction for the intelligence and hotel-side products.

**Nothing in this document is implemented.** It exists so that approved thinking
is not lost between blocks, and so the next implementer does not have to
re-derive it from conversation. Every section is labelled:

- **ACCEPTED DIRECTION** — the owner has decided this is where the product goes.
  The design is still open; the direction is not.
- **OPEN / UNDECIDED** — genuinely not decided. Do not implement, do not assume.

What is **implemented now** is the V1 Public/Premium split (D050, D058, D059,
migration 0026) and the provenance model (D057). See `PRD.md` §12.8 and
`PERMISSIONS.md` §9.

---

## 1. Gmail-assisted workflow capture — ACCEPTED DIRECTION

A future Gmail OAuth integration should be able to assist in detecting:

- when a pitch was sent;
- when an actual human reply arrived;
- a possible reply classification.

while excluding autoresponders, out-of-office messages, and bounce or system
notifications — the same exclusions D058 already applies to a qualifying
`reply_received`.

**Manual creator workflow remains the fallback and the source of truth.** Gmail
assists the creator in recording what happened; it does not become an
independent writer of domain events.

Not now: no Gmail scopes are requested, no OAuth exists, no email content is
read. `outreach_events.source` already reserves `'gmail'` for the day it does.

## 2. Premium funnel visualization — ACCEPTED DIRECTION

A future premium surface may visualize the creator-outreach funnel:

> Contacted → Replied → Advanced → Collaboration agreed → Collaboration completed

Expressed as **percentages and safe aggregates**. It must not expose raw pitch or
reply counts (D058), and it must obey the same sample and contributor floors as
every other premium metric.

The graph is premium: locked for anonymous and Free viewers.

Not now: no implementation.

## 3. Trends — ACCEPTED DIRECTION

Direction-of-change signals such as "Reply rate ↑ improving".

A trend must derive from statistically valid time windows and must **not** be
fabricated from small samples. Two data points a month apart is not a trend, and
a trend arrow is a stronger claim than the number it decorates, because a reader
takes it as prediction.

Not now: no implementation.

## 4. Value Intelligence — V2 — ACCEPTED DIRECTION

Strategically important and deliberately deferred.

A future V2 should capture **economic outcome** data when a collaboration is
agreed or closed. Sources, in order of authority:

1. **creator confirmation — primary truth**;
2. optional, consented AI-assisted detection from connected Gmail or
   conversation content;
3. **AI-detected monetary values must be presented to the creator for
   confirmation or correction before becoming trusted collaboration value
   data.** Unconfirmed extraction never becomes network intelligence.

Potential fields: was cash paid, amount, currency, stay included, stay length
where appropriate, and the existing type vocabulary (paid / stay / stay + paid /
other material value).

The existing `collaborations.private_value_amount` and `private_value_currency`
**remain private in V1** and feed no aggregate (DATABASE.md §8).

Future aggregate products may include paid-collaboration rate, typical or median
reported compensation, compensation bands, highest-paying hotels in a
destination, highest-paying destinations, and hotel value patterns.

**Never expose an individual creator's compensation.** Money is the most
re-identifiable fact a creator can give the product, and the one they are least
willing to have leaked.

Not now: no implementation.

## 5. Metric-specific positive rankings — ACCEPTED DIRECTION

**No composite Creator Friendly Score** (D058). Rankings use transparent
individual metrics:

- Most responsive hotels in Bali
- Fastest replying hotels in Bali
- Most active hotels with creators
- Highest paid-collaboration rate
- Highest-paying hotels

Avoid "worst hotels" and naming-and-shaming rankings as a product or content
strategy. **A hotel can disagree with the data; it cannot buy a better metric.**

Not now: no implementation.

## 6. Sponsored hotel distribution — future B2B — ACCEPTED DIRECTION

Hotels **may** pay for distribution and visibility:

- a sponsored result at the **top** of Discover or search, analogous to a
  search-engine sponsored result;
- sponsored or featured opportunity modules;
- paid email distribution to relevant creators;
- future sponsored creator opportunities and briefs.

Sponsored placements must be **clearly identified as sponsored/paid
distribution**, and a sponsored hotel may appear before organic results.

However — and this is the line:

> **A hotel may pay for DISTRIBUTION. A hotel may not pay for REPUTATION.**

Sponsorship **never** changes Creator Network Intelligence: not reply rate, not
reply time, not activity, not compensation, not data strength, not collaboration
outcomes, not any organic metric value.

For a metric-specific ranking such as "Most responsive hotels", sponsorship must
not falsify the organic ordering. Commercial inventory shown above such a
ranking must be a separately identified sponsored placement, never a position
that pretends to have been earned.

Not now: no implementation.

## 7. Claim this hotel / hotel-side product — ACCEPTED DIRECTION

Future hotel-side product: claim a hotel, verify the hotel representative,
manage confirmed hotel information, update contacts, update official imagery,
declare a creator partnership policy, define preferred creator outreach, and
later see creator-performance benchmarks, a creator inbox and collaboration
tools, and publish opportunities and briefs.

**A hotel improves its Creator Network metrics only by improving its real
behaviour with creators. It cannot edit or purchase the metric.**

Not now: no hotel accounts and no claim workflow. `hotel_claims` exists today as
lead capture only.

## 8. Hotel outreach / hotel-confirmed data — ACCEPTED DIRECTION

theugc.life will proactively contact hotels one by one to introduce the
platform, verify the correct creator/marketing/PR contact, verify
deliverability, ask whether they currently work with creators, ask which
partnership types they consider, ask their preferred outreach channel, request
official photography, and establish an ongoing relationship.

This creates **hotel-confirmed intelligence** (D057 domain B) and editorial
verification data.

> **A reply from a hotel to theugc.life is NOT a creator reply.**

It must never enter reply-rate or any other Creator Network metric. The two
datasets stay separate at the schema level, not merely in presentation.

Not now: no outreach system, no hotel-confirmed schema.

## 9. Hotel data review and correction — ACCEPTED DIRECTION, with one part OPEN

A hotel may report that information appears wrong. theugc.life audits the
underlying data internally.

- If the data **is** wrong: correct it, and retain an auditable correction
  trail.
- If the underlying Creator Network metric is **valid**: the hotel does not get
  to remove or alter it because it dislikes the result.

**OPEN / UNDECIDED:** whether hotels get a public "hotel response" feature. This
is not approved, not rejected, and not to be implemented or designed around.

## 10. Monthly transparency / data review — ACCEPTED DIRECTION

A recurring **theugc.life Monthly Review**, potentially covering: meaningful
creator-network trends, destination intelligence changes, coverage and data
milestones, notable positive rankings, methodology changes, a
transparency/data-review section, material corrections or audit learnings that
can be disclosed safely, and how intelligence quality and coverage are evolving.

Its purpose is transparency and trust in the data asset.

**Never expose creator identities or private information in such a report.**

Not now: no publishing system.

---

## 11. Initial V1 destinations — RECORDED, NOT INGESTED

The owner has approved the initial destination set. **This PR does not ingest
any of it** — coverage ingestion belongs to the Property Content block, and the
inventory sources are still unchosen (D055).

1. Bali
2. Dubai
3. New York
4. Miami
5. London
6. Barcelona
7. Lisbon
8. Bangkok
9. Tokyo
10. Mexico City
11. Cancún
12. Rio de Janeiro
13. Rome
14. Paris
15. Chiang Mai
16. Medellín
17. Buenos Aires
18. Cape Town
19. Seoul
20. Ho Chi Minh City

**These are product DESTINATIONS, not necessarily schema type `city`.** Bali is
the obvious case: it is an island containing several areas a creator would think
of separately (Canggu, Ubud, Uluwatu). Flattening all twenty into `city` would
break the destination hierarchy that Destination Pass entitlement depends on
(D051, `_has_active_destination_access`) — a Pass bought for "Bali" must cover
its descendants, which requires Bali to *have* descendants.

See `DESTINATION_CATALOG.md` for the type vocabulary and the hierarchy rules,
and D055 for the completeness contract that applies to each of them.
