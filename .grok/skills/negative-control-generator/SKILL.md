# Skill: negative-control-generator

Every critical invariant needs a test that FAILS if the guard is removed.

Steps:

1. List each guard in the diff: RLS policy predicate, `revoke ... from anon, authenticated`, owner filter in a SECURITY DEFINER function, unique/ON CONFLICT, lock, secret check, allowlist.
2. For each, write a test that exercises the attack:
   - User A → User B by direct id, list, count, update, delete, FK link, RPC;
   - anon/authenticated EXECUTE → expect `42501`;
   - concurrent duplicate → two `openSession()` clients from `tests/db/tx.ts`, commit one while the other blocks.
3. **Prove it:** remove the guard locally (edit the migration or code), run `npx vitest run <file>`, confirm failure, then `git checkout -- <file>`. Never commit the mutation.
4. Record a table in the PR body: guard → test → "fails when removed: N tests".

Harness notes:

- DB suites need `TEST_DATABASE_URL`. Each file calls `setupDatabase()`, which resets the schemas.
- The compat shim gives `service_role` **no USAGE on `public`** (pinned by `tests/db/human-review-revocation.test.ts`). To exercise a service_role-only RPC, run `await adminQuery("grant usage on schema public to service_role")` in that file's `beforeAll`. Do not change `tests/db/bootstrap.sql` (PR #47).
- `queryAs` always rolls back. To observe a committed effect, use `openSession`/`closeSession(…, "commit")`.
