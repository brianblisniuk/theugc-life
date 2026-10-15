# UX02 scope

Classification against main `2549b96`. These frames are static HTML. They do not change the app.

- **A** — the running product already supports the behavior. The frame only shows it.
- **B** — the contract exists, and the screen still has to be built or rewritten.
- **C** — the product cannot show it until something new exists behind the UI.

## A — already supported

| Item | Where it already lives |
| --- | --- |
| Discover is the same published catalog for Free, Pass, Pro, and Max | `discover.catalogue`, `all_tiers` |
| Search, destination (with descendants), hotel type, country, 4/5-star, editorial verification, disclosed activity, observed collaboration | `src/lib/hotels/filters.ts` |
| Page size 24 | `DISCOVER_PAGE_SIZE` |
| One metric at a time: name order, Most active with creators, Most responsive, Fastest replying | `METRIC_IDS`, D130 |
| Most active with creators is public. The two reply metrics are premium | `METRIC_LAYERS`, `hotel.metric_response` |
| A locked reply metric has no value and no ranking | `LOCKED_METRIC_COPY` |
| Below the floor is “Not enough data”, never zero | `NOT_ENOUGH_DATA_LABEL`, `ORDER_BELOW_FLOOR_COPY` |
| Public card signals only when disclosed. Null is not “no activity” | `publicCardSignal` |
| Activity words: High, Medium, Emerging, Creator activity detected | `activityLabel` |
| “Creator collaboration observed” only when the flag is true | `card-signal.ts` |
| The viewer’s own pipeline stage and trip shortlist | `assembleCreatorBadges` |
| Temporarily closed can be published | `PUBLISHED_ACTIVE_STATUSES` |
| Map pins are the hotels on this results page, with no premium fields | D079, `discover.map` |
| Hotel basics, classification, editorial verification, address, website, Instagram | `HotelSummary` |
| No invented photograph | Hotel page comment, D064. `HotelSummary` has no photo |
| Reply-rate value is a whole percent. Reply time is one of five bands | `isPublishedValue`, `RESPONSE_TIME_LABELS` |
| Activity ranking labels are High, Medium, Emerging | `ACTIVITY_LABELS` |
| Sample basis “Based on activity from N creators”, N ≥ 5 | `isSampleBasis` |
| Confidence Emerging / Moderate / Strong. Freshness Past month / Past quarter / Older | `intelligence/contract.ts` |
| Creator fit is premium-scoped. Max adds rank, confidence, and freshness. No score | `hotel.premium_intelligence`, `plans.max_flags` |
| Pursue and Skip are private and do not change the network | `record_creator_fit_decision` |
| Contact is 1 credit for every plan. A Pass or Pro row does not reveal the email | `CREDITS_CONFIG.unlockCost`, D100 |
| A miss is not charged | `chargeOnNotFound: false` |
| Unknown balance is not zero and not an upgrade | `unlockChrome` |
| Known zero uses the out-of-credits sentence | `OUT_OF_CREDITS_COPY` |
| Free 5 per rolling week, Pro 150 per 30 days, Max 500 per 30 days. First AI draft is 1 credit | `CREDITS_CONFIG` |
| Free has templates, not Claude. Gmail send is Pro or Max. A Pass does not send | `plans.full_ai_email`, `gmail.send` |
| Follow-up delay 1–30 days, default 3 then 5, max two, cancelable, no credits | `gmail/followup/actions.ts` |
| Collaboration UI only on a won cycle. Draft contracts are not signed agreements | hotel page, `listCollaborationContracts` |
| Free active-trip limit is 1, with the plan sentence | `FREE_LIMITS.activeTrips`, `tripLimitMessage` |
| Pipeline words include Negotiating | `pipelineStatusLabel` |
| Contact card omits empty fields and marks a role mailbox | `contact-card.tsx`, `isGenericContact` |
| Contact empty, locked, and error are different | `contactSectionState` |
| Destination Pass covers premium intelligence inside its destination tree | `premium_scoped` |

## B — frontend needed

The data and the rules exist. The current screens do not match this spec.

| Item | What is on main today |
| --- | --- |
| English shell | Primary nav is Inicio, Descubrir, Pipeline, Viajes, Perfil |
| Discover title and lede in this spec | Title is “Descubrir” with a different description |
| 708 / 644 split and 900 / 452 hotel columns | Discover uses a fluid grid. Hotel detail is one column |
| Editorial rows, 120×96 placeholder, 44px controls, this type scale | Rows are shorter and the type scale is utility classes |
| Accent `#DFFF4F`, light master, dark theme on the same tokens | Accent is Sun `#FFE01B`. There is no dark theme |
| Accent button edge, because the new fill fails 3:1 on paper | Not built |
| More filters popover and 390 bottom sheet | Filters are inline |
| Active chips and Clear all | Clear is a single reset |
| Sort control with Pro labels | Rank is a query param, not this control |
| Free user picks a premium sort and the name-ordered list stays, with View plans | A locked rank replaces the list with an empty state |
| Row and pin hover sync, pin preview, “View hotel” | The map does not sync a preview |
| Visible map error, list still works | A missing Maps key leaves an empty slot and no error |
| Spec empty and error sentences | Live copy differs (“No hotels match these filters.”, “We couldn’t load hotels just now”) |
| Sticky subnav Overview, Intelligence, Contact, My work | Eight anchors, including Map, Activity, Inbox, Collaboration, Trip as peers |
| “Your next step” side panel and the mobile action bar | Actions are inside the sections |
| One “Compare hotels in this destination” selector | Three rankings are stacked |
| Locked pattern with capability name, use, and View plans. No blur | Locked metrics use `LOCKED_METRIC_COPY` in a notice |
| Button label “Unlock contact · 1 credit” | `unlockContactLabel` returns “Unlock contact (1 credit)” |
| Assurance “1 credit is charged only after a successful unlock.” | The miss string is “Contact not available yet. This did not use a credit.” The ledger flag is `chargeOnNotFound: false` |
| “Report incorrect contact” | The button says “Report this email” |
| “On trip” | The card says “On a trip” |
| “Credits unavailable” plus Retry | The live sentence asks for a reload and says it is not an empty balance |
| Click/keyboard methodology popover | Threshold text is inline |
| Skeletons at the final size, no shimmer | Not on these two screens |
| Dark theme as a first-class variant | Not built |

## C — backend needed

| Item | Why it is not a stylesheet change |
| --- | --- |
| Verified hero photograph | `HotelSummary` has no image. The hotel page refuses to invent one. A hero needs a verified asset and a rule for when it may render. Until then the compact initials block is the honest state. |

Nothing else in these two screens needs a new table, a new entitlement, or a new metric. Reply rate stays a published percent when that metric is the selected sort. These frames do not add a match score, a price, a guest rating, or a masked email.

## Copy the frames use on purpose

| Frame | Live string | Frame string |
| --- | --- | --- |
| No results | “No hotels match these filters.” | “No hotels match your filters.” |
| Discover error | “We couldn’t load hotels just now” | “Hotels couldn't be loaded.” |
| Unlock | “Unlock contact (1 credit)” | “Unlock contact · 1 credit” |
| Charge | “This did not use a credit.” | “1 credit is charged only after a successful unlock.” |
| Report | “Report this email” | “Report incorrect contact” |
| Trip badge | “On a trip” | “On trip” |

The charge sentence matches `chargeOnNotFound: false`: a provider miss is stored and is not charged. It does not change the ledger.

## Plans in the frames

Free, Pro, and Max share the architecture.

- Free: no reply rate, no reply time, no Creator Fit, no premium collaboration types in the fit list, templates instead of Claude, no Gmail send, 1 active trip, 5 credits per rolling week. Contact is still 1 credit.
- Pro: those reply metrics, Creator Fit, Claude (first draft 1 credit), Gmail send, 150 credits per 30 days.
- Max: Pro, plus rank, confidence, and recency on fit, and a fuller AI draft. 500 credits per 30 days.
- Destination Pass: premium intelligence for the entitled destination and its descendants. It does not unlock a contact, start Claude, or send Gmail.

## Out of these frames

Home, Pipeline, Trips, Profile, Inbox, and Collaborations are linked so the shell is complete. They are not redesigned here. Empty catalog and hotel-not-found are included because the spec lists them as states; they sit beside the 10 Discover and 12 Hotel frames.
