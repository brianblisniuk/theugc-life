# Workflow: security-review

> **What this is:** a markdown runbook that Grok Bot agents follow by hand: the Orchestrator plus subagents running on the shared box, using `gh` authenticated as the owner. There is **no native workflow engine**. Nothing here executes automatically, and the `.grok/config.toml` flags are advisory. Hard enforcement is GitHub ruleset **24915605** on `main`: PR required, `verify` must pass, no force push, no deletion.

Run on every PR that touches `supabase/migrations/`, `src/lib/**/actions.ts`, `src/app/api/**`, RLS, grants, SECURITY DEFINER functions, auth, billing, or Gmail/private data.

## Roles

- **Security+DB Auditor** (independent subagent, fresh context). Input: PR number and head SHA only. It reads the diff itself (`gh pr diff <n>`).
- **Privacy+Provider Auditor** (temporary): added when Gmail, OAuth, AI vendors or billing providers are touched (`privacy-provider-audit`).
- **Orchestrator**: consolidates findings and decides whether the correction loop is needed.

## Checklist (cite file:line for each)

1. **Grants:** every new function has `revoke all ... from public, anon, authenticated` and an explicit grant, and is added to `tests/rls/acl-matrix.test.ts`. Every new table gets a row in the ACL contract.
2. **SECURITY DEFINER:** `set search_path = public, pg_temp`; ownership derived inside the function, never trusted from client input; caller identity passed only from `resolveSession()`.
3. **RLS / IDOR:** User A↔B tests for direct id, list, count inference, update, delete, FK link, and RPC. Foreign and missing ids give identical responses.
4. **Concurrency/replay:** unique keys + `ON CONFLICT`, row locks, stale-write fences. A two-session race test using `tests/db/tx.ts`.
5. **Idempotency:** a replay with mismatched identity must not grant or leak (pattern: 0043 `source_reference_conflict`).
6. **Secrets/webhooks:** server-only env, constant-time compare (`src/lib/billing/rebill-signature.ts`), allowlisted events, stubs labelled.
7. **Negative controls:** each guard proven by `negative-control-generator`.

Output: an AUDIT VERDICT comment (format in `pr-cycle.md`) tied to the exact head.

## Stop conditions

Any BLOCKING finding → correction loop. An invariant reduction requested by the Builder → `PRODUCT DECISION REQUIRED`.
