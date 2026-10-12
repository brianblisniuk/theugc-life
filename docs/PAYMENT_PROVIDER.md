# Payment Provider

Status: Accepted

**theugc.life will use Rebill (`rebill.com`) as its payment provider.**

This records the provider decision only. Payment integration details remain to be implemented separately.

## Webhook stub (PR #43) — production rule

`src/app/api/billing/webhook/route.ts` is a shared-secret **stub**, not the Rebill
integration. It verifies no payment and trusts the request body.
**`BILLING_WEBHOOK_SECRET` must never be set in production** until Rebill
signature verification (and a payment record) replaces it. With the secret
unset, every request is rejected with 401.
