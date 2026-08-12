# theugc.life — EVENTS.md
Version: 1.0
Purpose: canonical domain-event vocabulary and transition behavior.

## 1. Principle

Pipeline state answers: “Where is this relationship now?”
Outreach events answer: “What actually happened?”

Do not reconstruct history from current status alone.

## 2. Event envelope

Every domain event contains:
- `id`
- `creator_id`
- `hotel_id`
- `pipeline_item_id`
- `event_type`
- `event_at`
- `channel` when relevant
- structured `metadata`
- `source`
- `created_at`

Allowed source values initially:
- `manual_creator`
- `system`
- `admin_correction`
Future: `gmail`, `outlook`, `marketplace`.

## 3. Canonical events

### hotel_saved
Trigger: hotel first added to a relationship cycle.
Intelligence: does NOT count as creator activity.
Metadata: optional trip context.

### pitch_sent
Trigger: creator explicitly marks pitch sent.
Required: `event_at`, `channel`.
Side effects:
- pipeline status `pitched`
- set `first_pitched_at` if null
- update `last_activity_at`
Intelligence: eligible outreach denominator.

### followup_sent
Trigger: creator explicitly marks follow-up sent.
Required: channel/date if known.
Intelligence: future follow-up effectiveness analysis; not a new initial pitch.

### reply_received
Trigger: creator records an actual reply.
Required: reply date.
Metadata: `sentiment` = positive|negative|unclear.
Intelligence: reply numerator and reply-time calculation if a qualifying prior pitch exists.

### positive_reply
Trigger: reply classified positive.
Must normally accompany/reference reply_received.
Intelligence: positive reply metric.

### negative_reply
Same structure; negative metric.

### offer_received
Trigger: concrete collaboration offer or terms are mentioned.
Metadata:
- `offer_type`: stay|product|paid|stay_plus_paid|other
Optional structured fields may be added only by approved schema decision.

### negotiation_started
Trigger: creator begins active negotiation.
Side effect: pipeline status `negotiating`.

### deal_won
Trigger: collaboration agreed.
Metadata: collaboration type.
Side effects:
- pipeline `won`
- create/update collaboration record.
Qualifies for “confirmed creator collaboration” subject to privacy display rules.

### deal_lost
Trigger: relationship closes unsuccessfully.
Metadata reason: no_reply|rejected|not_a_fit|timing|other.
Side effect: pipeline `closed`.

### collaboration_started
Trigger: agreed collaboration begins.
Qualifies as collaboration activity.

### collaboration_completed
Trigger: collaboration completed.
Metadata:
- `terms_matched`: yes|partially|no|unknown
- `would_work_again`: boolean|null
Feeds Experience Intelligence.

### creator_closed_pipeline
Use when creator closes without a definitive deal-loss classification.
Metadata reason if supplied.

### contact_bounced
Domain signal that an attempted contact bounced.
Also create/contact-signal workflow as defined by implementation.
Does not automatically invalidate master contact.

## 4. Pipeline transition map

Allowed ordinary transitions:

- saved → planned
- saved → pitched
- planned → pitched
- pitched → follow_up
- pitched → replied
- follow_up → replied
- replied → negotiating
- replied → closed
- negotiating → won
- negotiating → closed
- won → closed only when closing archived cycle after collaboration lifecycle if product UI requires
- any active state → closed with reason

Backwards corrections require an explicit correction workflow; do not silently delete emitted history.

## 5. Progressive forms

### Mark as pitched
Ask:
- channel
- date default today

### Mark as replied
Ask:
- reply date
- positive / negative / unclear
- offer type if already known (optional)

### Start negotiation
No unnecessary questionnaire.

### Mark won
Ask:
- collaboration type
- agreed date
- optional collaboration dates

### Complete collaboration
Ask:
- terms matched?
- work with them again?

### Close
Ask:
- no reply / rejected / not a fit / timing / other

## 6. Eligibility rules for analytics

### Reply rate
Denominator: eligible `pitch_sent` relationship cycles.
Numerator: cycles with qualifying `reply_received`.
A cycle counts at most once in the basic reply-rate numerator.

### Reply time
Elapsed time from the qualifying initial `pitch_sent` to first qualifying `reply_received` in same relationship cycle.
Use median for display.

### Pitch-to-deal
Eligible cycles with `deal_won` / eligible cycles with `pitch_sent`.

### Follow-up analysis
Do not treat `followup_sent` as independent pitch denominator.

### Repeat partnerships
Multiple relationship cycles between same creator/hotel can support future repeat-collaboration metrics.

## 7. “Confirmed active creator collaboration”

Public/premium copy may only derive from:
- `deal_won`
- `collaboration_started`
- `collaboration_completed`

Never from:
- hotel_saved
- contact_viewed
- pitch_sent
- reply_received alone

Exact timestamp visibility is further constrained by privacy/confidence rules.

## 8. Event idempotency

Manual UI actions must prevent accidental duplicate event creation from retries/double-clicks.
Where server actions accept a mutation request, support an idempotency key or transactional transition guard.

Connected-email future events must use provider message IDs to deduplicate.

## 9. Corrections

V1 must support at least admin-safe correction strategy:
- preserve original event
- mark/supersede through correction metadata or correction record
- recompute derived intelligence

Do not hard-delete events that have already influenced published intelligence unless required for privacy/legal deletion.

## 10. Event-to-product-analytics separation

`hotel_viewed`, `contact_unlock_clicked`, `pipeline_opened` are product analytics, NOT `outreach_events`.

PostHog is not the source of truth for hotel intelligence.
