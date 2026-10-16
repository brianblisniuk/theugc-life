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
`apply_rebill_event` writes an entitlement. `payment.updated` may carry
`data.id` (`pay_…`) and `data.status` when `data.payment` is absent. The
grant still comes from that confirm GET. An apply error, or a result of
`error`, returns 503 so Rebill retries. `applied`, `duplicate`, `ignored`,
and `revoked` stay 200. `BILLING_WEBHOOK_SECRET` does not authorize the
route. The PR #43 stub is replaced.

Live charges stay off unless `REBILL_LIVE` is exactly `true`. A sandbox key
may open a hosted link. A productive organization may not, until that flag
is set. Production keys and the Rebill webhook registration are still an
owner step. No secret is committed.

A monthly refund shortens that payment's 30 days and reverses only the
unused plan credits of that period (D140). An annual refund ends the plan.
A pack refund reverses unused credits of that pack and does not take the
balance below zero. A pack chargeback after that refund still reverses the
full grant and may go below zero. A refund does not flip `past_due` to
`active`. A chargeback still revokes the subscription. The webhook uses
the checkout id from the confirmed payment.
