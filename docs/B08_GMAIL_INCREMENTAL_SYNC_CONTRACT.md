# B08 — Incremental Gmail sync

Status: implementation contract for D076. D076 wins if this file disagrees with it. D068's inclusion rule and D072's commercial-meaning rules are unchanged.

## What a sync is

One mailbox, one forward window fixed when the run starts: `[horizon_end_at, clock_timestamp())`. The horizon begins as the greatest completed historical-import `window_end_at` for that mailbox. It advances to this run's `window_end_at` only when the run completes.

## How mail is chosen

`history.list` with `startHistoryId` and `historyTypes=messageAdded`. A thread is fetched when an added message is non-draft `SENT`, or when this mailbox already stores a non-draft `SENT` message on that thread. Otherwise the thread is `filtered_out` and nothing is stored.

When `historyId` is null, or Gmail returns HTTP 404 for `history.list`, the run switches to a bounded re-scan:

1. `messages.list` on `SENT` inside the forward window.
2. `threads.get` for already-stored non-draft `SENT` threads, in provider-thread-id order, 100 at a time.
3. `users.getProfile` to store a new `historyId`.

Messages are stored only when `internalDate` is inside the run window. Drafts are dropped before storage. The primary key remains `(mail_account_id, provider_message_id)`.

## What a sync is not

No Pub/Sub watch. No `gmail.send`. No new OAuth scope. No production cron. No pilot KPI table. No propagation of Gmail deletions into stored rows. No mailbox-wide B06 horizon: coverage is per fetched thread, and B06 reads it only after the run is `completed`.

## Scheduling

`private.gmail_sync_cursors.next_sync_at` is set 15 minutes after a successful run. `login_sync_requested` makes the mailbox due sooner. `pipeline_pending` replays normalization and the later local stages without another Gmail read. `npm run gmail:sync:work` lists due mailboxes and discharges them. Creator login calls the same worker for that user only.

## Failure

Five retryable provider failures fail the run, push `next_sync_at` by 15 minutes, and do not move `historyId` or the horizon. A malformed provider body fails the run the same way and is not an empty mailbox. `not_configured` and `configuration_error` release the lease and do not fail login.

## Removal

Disconnect cancels runnable and paused runs. Deletion purge removes cursors, runs, thread work, and coverage before the mailbox may become `deleted`.
