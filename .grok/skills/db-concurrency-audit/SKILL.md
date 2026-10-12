# Skill: db-concurrency-audit

Review migrations and RPCs for:
- Idempotency
- Transaction boundaries
- Stale writes / lost updates
- Replay safety
- Unique constraints matching the documented source_reference pattern
- Safe migration (no destructive change without explicit contract)
- Grant / revoke correctness on SECURITY DEFINER functions

Output: PASS or blocking findings.
