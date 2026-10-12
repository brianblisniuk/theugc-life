# Skill: official-doc-research

Use when behaviour depends on a third-party API or platform (Gmail API, Google OAuth, Supabase, Postgres, Next.js, Rebill, Netlify, GitHub).

Steps:

1. Prefer official docs and changelogs over blogs. Record URL + retrieval date (Asia/Bangkok) in the PR or contract.
2. Quote the exact rule relied on (rate limit, scope, retention, signature scheme), not a paraphrase.
3. If the docs are ambiguous or absent, design for the conservative reading and record it as an assumption.
4. Never test against a real external account or send real email to "verify". Use fixtures and mocks (e.g. `vi.mock` in `tests/billing/webhook-route.test.ts`).
5. Rebill: the payment provider is accepted (`docs/PAYMENT_PROVIDER.md`, D073), but the signature scheme is not yet researched. Do this before replacing the webhook stub.

Output: a source list with dates, the rules relied on, and open assumptions.
