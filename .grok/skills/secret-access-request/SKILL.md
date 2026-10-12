# Skill: secret-access-request

When a block needs a credential the agent does not have.

Rules:

- Never read, print, copy or exfiltrate existing secrets (`~/.config/gh/hosts.yml`, `.env*`, provider keys). Never put a secret in a commit, PR, comment, log or test fixture.
- Never mint your own access or route around a permission block.
- CI uses dummy env values only (`.github/workflows/ci.yml`). Tests must never need real secrets.

Steps:

1. Confirm the secret is truly required: can the work be done with mocks or the Postgres harness?
2. If yes, raise `CREDENTIAL REQUIRED` with:
   - name (e.g. `REBILL_WEBHOOK_SIGNING_SECRET`);
   - where it goes (Netlify env / GitHub Actions secret / local only);
   - minimum scope;
   - why it is needed;
   - what proceeds without it.
3. Continue all secret-independent work meanwhile.

Reminder: `BILLING_WEBHOOK_SECRET` must never be set in production (stub; `docs/PAYMENT_PROVIDER.md`).
