# theugc.life — ANALYTICS.md
Version: 1.0
Product analytics provider: PostHog or equivalent.
Domain intelligence source: PostgreSQL `outreach_events`, never PostHog.

## 1. Measurement layers

### A. Product analytics
Measures how people use theugc.life and convert.

### B. Domain/outcome data
Measures what happens between creators and hotels.

Keep them separate.

## 2. North Star

**Tracked Outreach Outcomes / month**

Qualifying known outcomes:
- reply_received
- deal_won
- deal_lost
- collaboration_completed

Track unique relationship cycles as well as raw event count to prevent misleading duplication.

## 3. Outcome Coverage

`relationship cycles with a known meaningful outcome / relationship cycles with pitch_sent`

Primary data-flywheel health metric.

## 4. Product funnel

1. visitor
2. signup_started
3. signup_completed
4. onboarding_completed
5. hotel_viewed
6. hotel_saved
7. contact_unlock_clicked
8. checkout_started
9. purchase_completed
10. contact_unlocked
11. pipeline_item_created
12. pitch_recorded
13. outcome_recorded
14. collaboration_recorded
15. retained/renewed

## 5. Canonical product events

### Acquisition/auth
- `landing_viewed`
- `pricing_viewed`
- `signup_started`
- `signup_completed`
- `login_completed`
- `onboarding_started`
- `onboarding_completed`

Properties may include UTM/referrer and chosen destination; never private notes.

### Discovery
- `discover_viewed`
- `map_moved`
- `search_performed`
- `filter_applied`
- `hotel_viewed`
- `hotel_saved`

Avoid firing excessive high-volume map events without sampling/debouncing.

### Premium
- `contact_unlock_clicked`
- `upgrade_modal_viewed`
- `checkout_started`
- `purchase_completed`
- `contact_unlocked`
- `premium_intelligence_viewed` — emitted ONLY when premium intelligence content
  is actually rendered (the `available` state). A locked, building or error
  panel does not emit it, so the event means "premium content was seen", not
  "a premium surface existed".

Properties:
- plan context
- destination_id
- hotel_id where appropriate
- entitlement state
Never send contact email/name as analytics property.

### CRM
- `pipeline_viewed`
- `pipeline_item_created`
- `pipeline_status_changed`
- `followup_due_viewed`
- `trip_created`
- `trip_viewed`
- `trip_hotel_added`

Do not duplicate domain outcome truth in analytics reporting. A UI event may exist, but intelligence calculations use database events.

### Portfolio/growth
- `public_profile_viewed`
- `portfolio_asset_added`
- `share_card_created`
- `share_card_shared`
- `hotel_claim_submitted`
- `referral_link_copied`
- `referral_converted`

## 6. User properties

Allowed:
- account_created_at
- current_access_tier
- active_destination_entitlement_count
- creator niche category
- country/home region at coarse level if supplied
- onboarding destination
- lifecycle cohort

Avoid:
- raw private notes
- collaboration monetary value
- contact emails
- private negotiation terms
- sensitive inbox content

## 7. KPI dashboard

### Acquisition
- unique visitors
- visitor→signup
- CAC when paid media exists
- referral share

### Activation
- signup→first hotel viewed
- signup→first save
- time-to-first-save
- time-to-first-pipeline-item
Target: first useful hotel interaction <2 minutes after onboarding.

### Monetization
- Free→Destination
- Free→Pro
- Destination→Pro
- checkout conversion
- refund rate
- ARPU
- annual renewal
- churn

### Product usage
- paid WAU/MAU
- contacts unlocked / active paid user
- hotels saved / active user
- active pipeline items
- trips created
- 30/90/180-day retention

### Data flywheel
- pitches recorded
- outcomes recorded
- outcome coverage
- median delay from pitch to outcome entry
- hotels with >=5 / >=15 / >=50 observations
- destination density
- contact-signal rate
- inconsistent/flagged event rate

### Viral
- share cards created
- share rate
- public hotel page sessions
- destination SEO sessions
- public→signup conversion
- referral conversion
- claimed hotel leads

## 8. Cohorts

At minimum segment by:
- signup month
- acquisition source
- Free vs Destination vs Pro
- destination purchased
- creator niche
- first-trip destination
- users who used CRM vs did not
- users with outcome coverage >= threshold vs low coverage

A critical analysis:
Does CRM adoption predict renewal?

## 9. Experimentation

All pricing/limit hypotheses should be config/feature-flag driven where practical:
- Destination Pass $29 vs $39
- Free save/pipeline limits
- $199 launch Pro messaging
- upgrade CTA variants

Do not run experiments that change privacy guarantees.

## 10. Initial decision benchmarks

These are hypotheses, not industry facts:
- Free→Destination: >3–5%
- Destination→Pro: >10–20%
- paid users with >=1 contact unlock: >60%
- contact unlocks/active paid/month: >5
- unlock→pitch recorded: >40%
- pitched→outcome recorded: >35% initially, target >50%
- 30-day CRM reuse: >25–30%
- inconsistent/fraudulent structured events: <3–5%

## 11. Data quality

Analytics event naming is version-controlled.
Do not rename canonical events casually.
Maintain an analytics dictionary with:
- event
- trigger
- properties
- owner
- first release
- deprecated date if any.

## 12. Privacy

Honor consent requirements for analytics by jurisdiction.
Do not use analytics as a covert copy of creator-private CRM data.
