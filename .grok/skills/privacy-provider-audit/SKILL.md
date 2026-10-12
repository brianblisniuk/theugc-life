# Skill: privacy-provider-audit

Required when a block touches Gmail data, OAuth, AI vendors, billing providers, or any third party that receives private data.

Check (cite file:line):

1. **Data boundary:** private Gmail tables live in the `private` schema with no client-role access (see `tests/gmail-import/boundary.test.ts` pattern). The new tables must be added to that boundary test.
2. **Minimization:** only the fields the task needs leave the system (B07 contract §20). Raw bodies never go to logs; `src/lib/logger.ts` redaction covers the new keys.
3. **Vendor approval:** no external model or provider receives private data unless DECISIONS records an approved vendor/privacy review (B07 contract §19: no training use, retention limits, region). Benchmarks are evaluation only (PR #40).
4. **Secrets:** server-only (`src/lib/env.server.ts`, never `NEXT_PUBLIC_`), and never in tests or fixtures. Run `run_secret_scanning`, or `rg -n "sk-|AIza|BEGIN PRIVATE"`.
5. **Revocation/deletion:** disconnect and user deletion cascade or purge the new data (`tests/gmail-import/deletion.test.ts` pattern).
6. **Stub honesty:** stubs (e.g. the billing webhook) are labelled, and the production-unsafe config is documented.

Verdict: PASS / BLOCKING / NON-BLOCKING per item. A new provider receiving private data → `EXTERNAL ACTION APPROVAL REQUIRED`.
