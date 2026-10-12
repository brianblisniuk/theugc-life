# Skill: dependency-frontier

Derive the next dependency-valid block from live state. Never ask the owner to pick.

Steps:

1. Run `repo-state-audit` first. If any PR is open and unmerged, the frontier is that PR's cycle, not a new block.
2. Read the round ledger in `docs/MASTER_PLAN_TRACKER.md` §2 (`NEXT` / `PLANNED` / `GATED` / `DONE`). The §9 prose can be stale, so the ledger and live merges win.
3. For the `NEXT` round, read its D-entry and contract and list each prerequisite. Check every one:
   - merged? (`git log --oneline origin/main | rg "#<pr>"`)
   - required migration numbers free? (`ls supabase/migrations | tail`) — reservations in decisions are advisory (D074)
   - external gates (vendor/privacy approval, credentials, owner decisions) closed in DECISIONS?
4. Classify the result:
   - all satisfied → write a work order (`write-work-order`);
   - blocked by an open owner choice → `PRODUCT DECISION REQUIRED`;
   - blocked by a secret or connector → `CREDENTIAL REQUIRED`;
   - nothing left in the phase → `AUTOPILOT FRONTIER COMPLETE`.
5. If the round can be split so a dependency-free slice proceeds (e.g. schema + RLS + human-correction loop before model inference), propose the slice. Do not invent product semantics.

Output: frontier round, satisfied deps, unmet deps with evidence (file:line / PR / SHA), and the classification.
