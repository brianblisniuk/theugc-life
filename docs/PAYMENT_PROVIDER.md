# Payment Provider

Status: Accepted

**theugc.life will use Rebill (`rebill.com`) as its payment provider.**

This records the provider decision only. Payment integration details remain to be implemented separately.

## Integration (D137–D139)

Checkout is a hosted payment link at `https://pay.rebill.com/theugc-life`.
The server calls `POST /v3/payment-links` and `POST /v3/plans`. It does not
call `POST /v3/checkout`.

`POST /api/billing/webhook` verifies `x-rebill-signature` (HMAC-SHA256 of the
raw body) and confirms the payment with `GET /v3/payments/:id` before
`apply_rebill_event` writes an entitlement. `BILLING_WEBHOOK_SECRET` does not
authorize the route. The PR #43 stub is replaced.

Live charges stay off unless `REBILL_LIVE` is exactly `true`. A sandbox key
may open a hosted link. A productive organization may not, until that flag
is set. Production keys and the Rebill webhook registration are still an
owner step. No secret is committed.
