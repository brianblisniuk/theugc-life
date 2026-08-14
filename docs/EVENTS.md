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
**Reserved — no V1 producer yet.** The event type exists in the enum so the
ledger vocabulary is stable, but nothing in V1 emits it: there is no email
integration and no bounce feed. When one ships, it will be a domain signal that
an attempted contact bounced, feeding the contact-signal workflow. It will not
automatically invalidate a master contact. Until then, treat any occurrence as
impossible rather than as a gap in a surface.

## 4. Pipeline transition map

This map is what the database enforces (migrations 0020, 0021, 0023). Every
combination not listed is rejected as `invalid_transition`. Retrying a
transition that already happened is idempotent: it writes nothing and reports
`already_applied`.

| From | Action | To | Event(s) |
|---|---|---|---|
| `saved` | plan | `planned` | *(none — planning is not a hotel interaction)* |
| `saved`, `planned` | mark pitched | `pitched` | `pitch_sent` |
| `pitched` | mark follow-up sent | `follow_up` | `followup_sent` |
| `pitched`, `follow_up` | mark replied | `replied` | `reply_received` **+** one of `positive_reply` / `negative_reply` / `offer_received` |
| `replied` | start negotiation | `negotiating` | `negotiation_started` |
| `negotiating` | mark won | `won` | `deal_won` **+** a collaboration row |
| `saved`, `planned` | close | `closed` | `creator_closed_pipeline` |
| `pitched`, `follow_up`, `replied`, `negotiating` | close | `closed` | `deal_lost` |
| `won` | *(outreach cannot close a won cycle)* | — | — |
| `won` | complete collaboration | `closed` | `collaboration_completed` |
| `won` | cancel collaboration | `closed` | `creator_closed_pipeline` (reason `collaboration_cancelled`) |
| `closed` | *(terminal — a new cycle starts through Save)* | — | — |

**Close classification (D043).** Closing from `saved` or `planned` is
abandonment and emits `creator_closed_pipeline`; closing from any state where
the hotel was actually contacted (`pitched`, `follow_up`, `replied`,
`negotiating`) is a lost deal and emits `deal_lost`. The two are different
facts and must not be merged.

**A won cycle closes through the collaboration, not through outreach (D045).**

```
won + agreed → scheduled (optional) → active → completed | cancelled → cycle closed
```

The pipeline cycle stays `won` while the collaboration is `agreed`, `scheduled`
or `active`. Only a terminal collaboration closes the cycle and frees the Free
engaged slot. Scheduling emits no domain event (it is the creator's own
planning, not a creator↔hotel interaction). Starting emits
`collaboration_started`. Completing emits `collaboration_completed`.
**Cancelling is not a lost deal**: it never emits `deal_lost` and never rewrites
`deal_won`, because the deal really was won and the collaboration later failed
to happen.

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

Collaboration dates are deliberately NOT asked here. On the day a deal is
agreed the creator usually does not know them yet, and asking would either
invent data or add an optional field nobody fills. Dates belong to Schedule and
Start, where they are actually known.

### Schedule collaboration (optional)
Ask:
- planned start date
- optional end date

### Start collaboration
Ask:
- start date

### Complete collaboration
Ask:
- end date
- terms matched?
- work with them again? (yes / no / not sure — "not sure" is recorded as
  unknown, never as "no")

### Cancel collaboration
Ask:
- who cancelled: creator / hotel / mutual / other

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
