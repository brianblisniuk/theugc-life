# UX02 components

Static frames in this folder. Light is the master (`data-theme="light"`). Dark sets the same custom properties on `[data-theme="dark"]`. The accent is `#DFFF4F` with ink `#17191B` on it. It is a fill, never a text or icon color on a light surface.

Type is Archivo. Spacing is 4, 8, 12, 16, 24, 32, 40, 48, 64. Radii: controls 8, panels 12, thumbnails 8, chips 6. Nothing is set below 12px. Buttons and inputs are 44px tall. Chips are 32px. One primary button per context.

## Header

Wordmark, primary links (Home, Discover, Pipeline, Trips, Profile), plan chip, credit readout, theme toggle.

- Desktop: 64px, 32px padding.
- Mobile and `force-mobile` frames: 56px, 16px padding. Primary links and the credit readout move to the bottom nav. The theme toggle stays.

## Nav

Text links. The current item is ink plus a 2px ink underline. The underline is not the accent, because `#DFFF4F` on paper is 1.08:1.

## Mobile nav

Fixed or pinned under the page: Home, Discover, Pipeline, Trips, Profile. Each item is an icon plus a 12px label. The icon is never alone. The hotel action bar sits above this nav and does not cover it.

## Search

Label “Search”. Placeholder “Search hotels or destinations”. 44px, radius 8, control border `#8A9094` (3.09:1 on paper).

## Filter select

Destination and Hotel type sit in the bar. More filters opens a 360px popover (inside the 340–380 range) or, at 390, a bottom sheet with a sticky Apply.

Popover and sheet fields, and only these:

- Country
- 4-star or 5-star classification
- Editorial verification: Editorially verified, Needs review, Verification stale, Unverified
- Creator activity: High, Medium, Emerging, Creator activity detected
- Observed collaboration: one checkbox, “Creator collaboration observed”

No Beach, Fast response, Paid, Stay + paid, AI match, or budget control.

## Chip

Active filters are accent-filled chips with the `#5E6C00` edge, a text label, and a remove button. “Clear all” is a 44px quiet button. Removing one chip is not the only way out.

## Hotel row

Editorial row, about 132px, hairline dividers, no card. 120×96 placeholder, name at 17/24 weight 650 (two lines allowed), destination · country · type, official classification (“5-star classification”, not a guest rating), at most two public signals, then Save or Saved. The row link opens the hotel. Save is outside the link.

Signals used here: “Creator activity detected”, “High creator activity”, “Medium creator activity”, “Emerging creator activity”, “Creator collaboration observed”. Absence is blank. The row never says “No creator activity”.

A rank line appears only for the one selected metric.

## Photo placeholder

Neutral block, initials, “No photograph” for assistive tech. Discover 120×96, radius 8. Mobile 88×88. Hotel hero is 140px tall when no verified photograph exists. These frames do not invent a photograph.

## Save

Secondary 44px button. Label “Save”, or “Saved” with `aria-pressed="true"` when the viewer already has a pipeline row. It is not the page primary. Apply is the primary on Discover. The next-step button is the primary on Hotel Detail.

## Map pin

44px hit target, 16px ink dot, paper ring. Neutral. No price and no probability color. Hover and focus sync the pin with its row. Activating a pin opens the preview.

## Map preview

Name, destination · type · classification, and “View hotel”. No price, email, or score.

## Metric

Three cells in one row with a hairline between them, not three cards.

- Creator activity — public. High, Medium, or Emerging when the floor is met.
- Reply rate — Pro, or a Destination Pass for this destination. A whole percent only when the H01 floor is met (15 pitches, 5 creators, 365 days).
- Typical reply time — same entitlement. Bands only: Under 24h, 1–3 days, 3–7 days, 1–2 weeks, 2+ weeks. Floor: 10 replies, 5 creators, 365 days.

Each available cell carries Confidence and Freshness as metadata: Emerging, Moderate, or Strong, and Past month, Past quarter, or Older. Sample basis, when shown, is “Based on activity from N creators” with N at least 5.

Four states, never collapsed into each other:

- Available — the value.
- Locked — capability name, what it is for, the plan, “View plans”. No blurred number.
- Insufficient — “Not enough data”. Not 0% and not Low.
- Error — “Metric rankings couldn't be loaded.” Retry. Not an empty ranking and not a lock.

## Methodology popover

“How this works” is a button. Click and keyboard open it. Escape closes it. The copy is the H01 threshold text.

## Confidence

Metadata beside a metric that already has a value. It is not a second score. Withheld when the metric is locked or below the floor.

## Locked

Panel with the capability, its use, and “View plans”. Hotel response insights: “See confirmed reply-rate and response-time signals when enough creator data is available.” “Available on Pro and Max, or with a Destination Pass for this destination.” Creator fit uses the premium-intelligence rule: a Pass covers the destination, Pro and Max cover every destination, and a locked fit shows no hotels.

## Contact card

Shown only after unlock. Fields that exist: name, title, department, organization, email, phone, LinkedIn, verification, last verified. Missing fields are omitted. A mailbox with no person is titled by role and reads “Role-based mailbox — no named individual on file.” “Report incorrect contact” is a secondary button. No masked fake email.

Contact states:

- Locked — “Unlock contact · 1 credit” and “1 credit is charged only after a successful unlock.”
- Unlocked — the cards, plus “Already unlocked” when that is the state.
- Empty — “No contact on file yet.”
- Error — “Contact details couldn’t be loaded.” Retry. Not an empty file and not an upgrade.

## Next action

Sticky side panel, “Your next step”. One primary.

- Not saved, contact locked: “Unlock contact · 1 credit”, then Save hotel and Add to trip.
- Unlocked: “Create pitch”.
- Contacted: “Open conversation”, “View pipeline”, the stage, and the next follow-up.
- Won: “Manage collaboration”.
- Credit balance known: “N credits available”.
- Balance unknown: “Credits unavailable” and Retry. Not 0.
- Known zero: “0 credits available” plus “You're out of credits. Pack purchases are not open yet. An admin can grant credits.”

Mobile replaces the panel with one fixed action bar above the global nav.

## Relationship status

Always with the word: Saved, Planned, Pitched, Replied, Follow-up, Negotiating, Won, Closed.

- Saved and Planned: neutral.
- Pitched, Replied, Negotiating: process.
- Follow-up: warning.
- Won: success.
- Closed: neutral grey.

Discover shows the same stage as “Your pipeline · {stage}”, plus “On trip” when the viewer’s own trip shortlist contains the hotel. Those private chips are a different treatment from the green public signals.

## Activity event

Vertical timeline. Each event has a type, a date, and a source of Manual or Gmail.

Follow-ups are separate: Draft (not sent), Scheduled (cancelable), Sent. At most two on a thread. Delay is 1–30 days. They spend no credits.

## Skeleton

A row-sized block: 120×96 (88×88 on mobile) and two text bars. Flat `--skeleton`. No shimmer.

## Empty

- No results: “No hotels match your filters.” / “Try another destination or remove some filters.” / Clear filters.
- Empty catalog: “No published hotels yet.” / “Hotels appear here once they are in the published catalog.”
- Metric floor: “Not enough data.” Hotels under the floor are left out of the order. Show the catalog order.
- Ranking floor: “No hotel in this destination has enough confirmed data for this metric yet.”
- Hotel not found: “Hotel not found.” / “This hotel is not in the published catalog.”
- No contact: “No contact on file yet.”
- No relationship: “You have no open relationship with this hotel.”
- Collaboration before a win: “A collaboration opens here once this hotel is won.”

## Error

- Discover: “Hotels couldn't be loaded.” / “Your search is still available. Try again.” / Retry. The search bar stays.
- Map: “Map unavailable.” / “The hotel list is still available.” / Retry. The list stays. This is not the search error.
- Metric: temporary load failure, Retry, not an empty ranking.
- Contact: load failure, Retry, not “no contact” and not a plan lock.
- Credits: “Credits unavailable”, Retry, not zero.
