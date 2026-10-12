# Skill: tenant-isolation-audit

Verify authentication ≠ authorization for every private multi-user resource touched.

Required attack matrix (User A vs User B):
- Direct ID read
- Enumeration / list
- Update
- Delete
- Server Action
- API route
- RPC
- Foreign-key / join reference

Authoritative enforcement must be RLS/ACL or equivalent non-bypassable server check. UI hiding does not count.

Output: PASS or blocking findings with evidence.
