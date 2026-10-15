# Production checklist

Owner steps for a go-live of theugc.life. Names only. Do not put values in
this file or in git.

Set every variable in the host (Netlify for the app and the scheduled
functions, Supabase for `DATABASE_URL` when an operator runs a script).
A scheduled job with an unset secret, or a secret shorter than 16
characters, fails closed and does not call the route.

## Application

| Name | Owner step |
| --- | --- |
| `NEXT_PUBLIC_SUPABASE_URL` | Supabase project URL. Present at build time. |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Supabase anon key. Present at build time. It is public. RLS is the boundary. |
| `NEXT_PUBLIC_SITE_URL` | The public origin, used for auth links and as the job fallback when `URL` is absent. |
| `NEXT_PUBLIC_POSTHOG_KEY` | Optional. Unset means analytics does nothing. |
| `NEXT_PUBLIC_POSTHOG_HOST` | Optional PostHog host. |
| `NEXT_PUBLIC_GOOGLE_MAPS_API_KEY` | Optional. Restrict it to the Maps JavaScript API and to this site's referrers. Unset means no map. |
| `SUPABASE_SERVICE_ROLE_KEY` | Server only. Never `NEXT_PUBLIC_`. |
| `DATABASE_URL` | Operator scripts and migrations. Not required by the Next server for ordinary requests. |
| `NODE_ENV` | `production` on the live Node process. This value does not open Gmail sending. |
| `BILLING_WEBHOOK_SECRET` | The server schema reads it. It does not authorize `POST /api/billing/webhook`. |
| `URL` | Set by Netlify to the site origin. The scheduled functions post here. |

## Rebill

| Name | Owner step |
| --- | --- |
| `REBILL_SECRET_KEY` | Server only. Required before a hosted checkout link can be created. |
| `REBILL_PUBLIC_KEY` | Rebill public key. |
| `REBILL_WEBHOOK_SIGNING_SECRET` | Signs `POST /api/billing/webhook`. The header is `x-rebill-signature`. The signature is HMAC-SHA256 of the raw body. There is no timestamp. |
| `REBILL_LIVE` | Exactly `true` for a productive Rebill organization. Any other value keeps live charges off. |

Register the webhook URL on the Rebill organization and store that
organization's signing secret in `REBILL_WEBHOOK_SIGNING_SECRET`.

## Anthropic

| Name | Owner step |
| --- | --- |
| `ANTHROPIC_API_KEY` | Server only. Empty refuses model drafts. Template drafts still work. |
| `ANTHROPIC_MODEL` | Optional. Unset means Claude Sonnet (latest). |
| `ANTHROPIC_PRIORITY_MAX_TOKENS` | Optional ceiling for Max. |
| `ANTHROPIC_PRO_MAX_TOKENS` | Optional ceiling for Pro. |
| `ANTHROPIC_PRIORITY_CONTEXT_CHARS` | Optional context ceiling for Max. |
| `ANTHROPIC_PRO_CONTEXT_CHARS` | Optional context ceiling for Pro. |
| `ANTHROPIC_MONTHLY_BUDGET_USD` | Required before any model call. A missing or non-positive value refuses the call. |
| `ANTHROPIC_INPUT_USD_PER_MTOK` | Optional price override. |
| `ANTHROPIC_OUTPUT_USD_PER_MTOK` | Optional price override. |
| `AI_BUDGET_MAX_USD` | Optional Max budget ceiling. |
| `AI_BUDGET_PRO_USD` | Optional Pro budget ceiling. |
| `AI_REGEN_WEIGHT` | Optional. Clamped by the server. |
| `AI_GLOBAL_POOL_PERCENT` | Optional pool share. |

`ANTHROPIC_BASE_URL` is for the benchmark script only. The application
does not read it.

## Gmail OAuth

Google Cloud OAuth client. The redirect URI must match
`GOOGLE_OAUTH_REDIRECT_URI` character for character.

| Name | Owner step |
| --- | --- |
| `GOOGLE_OAUTH_CLIENT_ID` | OAuth client id. |
| `GOOGLE_OAUTH_CLIENT_SECRET` | Server only. |
| `GOOGLE_OAUTH_REDIRECT_URI` | Registered redirect URI. |
| `GMAIL_TOKEN_ENCRYPTION_KEY_V1` | Base64 key that seals refresh tokens. |

Scopes the product asks for:

- Connect and reconnect: `openid`, `https://www.googleapis.com/auth/userinfo.email`, `https://www.googleapis.com/auth/gmail.readonly`.
- The separate send grant (D156) adds `https://www.googleapis.com/auth/gmail.send`.

Connect and reconnect must not request `gmail.send`. Google's consent
screen for the send grant is the incremental authorization, not a second
connect.

## Gmail send

| Name | Owner step |
| --- | --- |
| `GMAIL_SEND_ENV` | Exactly `production` to allow recipients outside the allowlist. Leave unset on every other deploy. |
| `GMAIL_SEND_DISABLED` | `true`, `1`, or `yes` stops every send. Unset leaves sending enabled. |
| `GMAIL_SEND_ALLOWLIST` | Comma-separated addresses. When `GMAIL_SEND_ENV` is not `production` and this is unset, only `hello@theugc.life` can be a recipient. |
| `GMAIL_SEND_PRO_DAILY_CAP` | Optional. Unset means 120. |
| `GMAIL_SEND_MAX_DAILY_CAP` | Optional. Unset means 300. |
| `GMAIL_DISPATCH_SECRET` | Bearer for `POST /api/internal/gmail-send-dispatch`. At least 16 characters. |

The send schedule is every minute: `* * * * *` on `gmail-send-dispatch`.

## Scheduled jobs

Each function only posts to its route. The route does the work. Give
each secret its own value of at least 16 characters.

| Function | Schedule | Secret | Route |
| --- | --- | --- | --- |
| `gmail-inbox-sync` | `*/15 * * * *` | `GMAIL_SYNC_SECRET` | `POST /api/internal/gmail-inbox-sync` |
| `account-erasure` | `15 6 * * *` (06:15 UTC) | `ACCOUNT_ERASURE_SECRET` | `POST /api/internal/account-erasure` |
| `credit-period-refresh` | `45 6 * * *` (06:45 UTC) | `CREDIT_PERIOD_SECRET` | `POST /api/internal/credit-period-refresh` |
| `gmail-followup-housekeeping` | `7,22,37,52 * * * *` | `GMAIL_FOLLOWUP_SECRET` | `POST /api/internal/gmail-followup-housekeeping` |
| `gmail-send-dispatch` | `* * * * *` | `GMAIL_DISPATCH_SECRET` | `POST /api/internal/gmail-send-dispatch` |

Inbox sync discharges mailboxes the database has already marked due
(about 15 minutes, a login, or a pipeline catch-up). It does not call
Claude.

Account erasure deletes creators whose `delete_after` has arrived. It is
idempotent. Identifier-free hotel counters stay. `npm run account:erase-due`
remains the operator command.

Credit refresh calls `ensure_credit_grants` for an active or past-due
annual subscription. Monthly plans still refresh from the Rebill
webhook. A creator with a pending deletion is skipped.

Follow-up housekeeping settles due follow-ups without calling Gmail.
The send dispatcher also settles before it claims.

These commands stay manual. Each one names a mailbox or a run. Nothing
in the schedule calls them:

- `npm run gmail:import`
- `npm run gmail:normalize`
- `npm run gmail:outreach`
- `npm run gmail:reply`

## Other server switches

| Name | Owner step |
| --- | --- |
| `CONTACT_PROVIDER` | Leave unset. `fake` is the only approved provider. |
| `GMAIL_COLLAB_CLASSIFIER` | Leave unset. `heuristic` is the only approved classifier. |
| `PITCH_PERSONALIZER` | Leave unset unless a wired adapter is deployed. |

## Scripts and CI, not the application

`TEST_DATABASE_URL`, `E2E_DATABASE_URL`, `E2E_BASE_URL`,
`CLIENT_BUNDLE_EXTRA_FORBIDDEN`, `CI`, `HOTELBEDS_API_KEY`,
`HOTELBEDS_SECRET`, `BOOKING_DEMAND_API_TOKEN`, `BOOKING_AFFILIATE_ID`,
`EXPEDIA_RAPID_API_KEY`, `EXPEDIA_RAPID_SHARED_SECRET`, `NUITEE_API_KEY`,
`EVAL_RUN_LABEL`, `ANTHROPIC_BASE_URL`, `OPENAI_API_KEY`,
`OPENAI_BASE_URL`, `GEMINI_API_KEY`, `GEMINI_BASE_URL`, and
`B07_BENCH_MODEL_<CANDIDATE_ID>`.

Property-source and benchmark keys are not required for the site to
serve. Do not put them on the production Netlify site unless that
specific script is being run there.

## Go-live order

1. Apply migrations through `0093_preprod_jobs.sql` on the production database.
2. Set the application, Rebill, Anthropic, and Gmail variables above.
3. Confirm the Google OAuth client lists `gmail.readonly` for connect and `gmail.send` only on the incremental send grant.
4. Set `REBILL_WEBHOOK_SIGNING_SECRET` to the secret Rebill uses for `POST /api/billing/webhook`, and set `REBILL_LIVE` only when the organization should take live charges.
5. Set the five job secrets to distinct values of at least 16 characters, and confirm the five schedules in `netlify.toml` are the ones Netlify registered.
6. Leave `GMAIL_SEND_ENV` unset until a real recipient outside `hello@theugc.life` must be allowed. `GMAIL_SEND_DISABLED=true` is the kill switch.
7. Send one allowed message on a non-production deploy first. Production sending stays closed until `GMAIL_SEND_ENV` is exactly `production`.
