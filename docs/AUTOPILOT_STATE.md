# AUTOPILOT STATE

**Last recorded main:** `b0e0a732ec1b2069bbdde91c6ded51b1466da80e` (merge of PR #108, V2-S2 Trips and Outreach, no new migration, 2026-10-16). It includes PR #104 (`a70c143f9bdc80ba39ce8e3974c84bbd237ac32a`, V2-S6, no migration), PR #102 (`ebf4681a214be89b0246f45f709b98c4b7b00432`, V12.2 Midnight shell, no migration), and PR #109 (`cc1b6cbfaed4457bf501113687c58e9f32921ebb`, scheduled job failures are caught instead of a bare 502, no migration). PR #103 stays merged (`b3cd11a9afe70d14351a1f0abdc4a4ce4d387c50`). PR #100 stays merged (`4001a628a347c0588fcc402d03fadb40302b8b6a`, V2-D1, migration `0097`, D182–D187). The merge commit has no separate verify run. Verify was green on the PR #108 head `1059f8237a1b4d5881529095c79a910d73056c35` (push and pull_request).  
**State:** HUMAN_FRONTIER. PR #100 is merged (`4001a628a347c0588fcc402d03fadb40302b8b6a`, migration `0097`, D182–D187): several opportunities per hotel when the previous row is closed or the trip or the dates differ, per-creator `OP-` display ids, creator-set trip nights with Gmail suggestions that do not auto-apply, outreach campaigns, `revision_requested`, and the V12.1 stage words. Contract Review stays out of MVP (D185). D02 is not finished: the Hunter adapter is merged, PR #98 is merged (`dc04d09369c5d2574755c970b3a3e3b7b95c3cc1`, migration `0096`, D180 amendment: verifier 451, `unknown`, `webmail`, and `disposable`, and the D181 email cascade), and provenance and freshness are not on the unlock screen. PR #102 is merged (`ebf4681a214be89b0246f45f709b98c4b7b00432`, V12.2 Midnight shell and theme, dark only, accent `#D1FF02`, no migration). PR #109 is merged (`cc1b6cbfaed4457bf501113687c58e9f32921ebb`, scheduled job failures are caught instead of a bare 502, no migration). PR #104 is merged (`a70c143f9bdc80ba39ce8e3974c84bbd237ac32a`, V2-S6 Plans, Billing, Profile, Getting Started, and Collaborations, no migration). PR #108 is merged (`b0e0a732ec1b2069bbdde91c6ded51b1466da80e`, V2-S2 Trips and Outreach, no new migration). PR #105 is the open V2-S3 draft for Pipeline and Pitch Studio. Migration `0098` binds a pitch draft to one opportunity. `HUNTER_API_KEY` and `CONTACT_PROVIDER=hunter` are set only on the host that should call Hunter. Both stay unset in CI. D178 is Accepted (owner Brian, 16 Oct 2026). D05 follow-up scheduling is merged (PR #89, `2549b96836d90180b655a7d0893316e57e92a5f2`, migration `0092`). D171–D177 are Accepted (owner, 14 Oct 2026): opt-in per thread, at most two, only the original hotel contact, stop on reply, bounce, won or closed, or cancel, Free cannot schedule, and scheduling and sending spend no credits. Defaults are 3 days after the pitch, then 5 days after follow-up 1. Each delay is a whole number from 1 to 30 days. They leave through the existing send queue. The allowlist and the kill switch (D160) stay. UX02 design is merged (PR #91, `dbfd2472b00d49590c17f416a10f6dbef371781b`). UX02 screens are merged (PR #95, `3a39ceb394df7b00e6ad6b12ab5bc40c7e3bfc59`) and re-skinned onto Midnight. Open drafts #88 and #90 are UX01 mockups awaiting the owner. Do not merge them. `0088`–`0097` are not edited by the theme block. Migration `0097` is the V2 opportunity model. Migration `0098` is the V2-S3 pitch-draft binding. `expected_head` stays null. Live GitHub is the head to audit.  
**Current frontier:** CREDENTIAL REQUIRED for the Hunter key on the host that should call Hunter. Recorded main is PR #108 (`b0e0a732ec1b2069bbdde91c6ded51b1466da80e`), which includes PR #104 (`a70c143f9bdc80ba39ce8e3974c84bbd237ac32a`), PR #102 (`ebf4681a214be89b0246f45f709b98c4b7b00432`), and PR #109 (`cc1b6cbfaed4457bf501113687c58e9f32921ebb`). PR #100 is merged (V2-D1, D182–D187, Contract Review out of MVP). PR #105 is the open V2-S3 draft. PREPROD-1b is merged (PR #93, no new migration). PREPROD-1 is merged (PR #92). D05 is merged (PR #89). UX02 design is merged (PR #91). UX02 screens are merged (PR #95) and re-skinned onto Midnight. D04b is merged (PR #87). D04 is merged (PR #86). DEC-DEL is merged (PR #85). C02–C05 freshness is merged (PR #83). D03 is merged (PR #84). P03b is merged (PR #82). P03 is merged (PR #81). P02 is merged (PR #80). P01 is merged (PR #79). F03 is merged (PR #78). H01 is merged (PR #77). G03 is merged (PR #76). G02 is merged (PR #75). F04 is merged (PR #73). G01 is merged (PR #74). F02 is merged (PR #72). F05b is merged (PR #70). F01 is merged (PR #71). F05 is merged (PR #68). HB01 is merged (PR #69). C02–C05 network facts are merged (PR #67). DATA01 is merged. UX01 is merged. D100 supersedes contact gating. D180 supersedes only the D100 sentence that only the fake provider is wired. D101 amounts are superseded by D131. D102 keeps Pass and pauses Free Gmail sync. D106 stays Accepted. D107 is merged with F01. D108 is merged with F05b. D110 is merged with F02. D112 is merged with F04. D114 is merged with G01. D115 is merged with G02. D116 is unused. D120 is merged with H01. D121–D124 are unused. D125 is merged with G03. D130 is merged with F03. D131–D134 are merged with P01. D135–D139 are merged with P02. D140 is merged with P03. D141–D145 are merged with D03. D146–D150 are merged with PR #83. D151–D155 are merged with PR #85. D156–D161 are merged with PR #86. D162–D170 are merged with PR #87. D171–D177 are Accepted with D05. D178 is Accepted (owner Brian, 16 Oct 2026). D179 records the BASE-N9 bugfix. D182–D187 are Accepted with PR #100. D159 stays Accepted: a successful send costs no credits. D095–D098 stay Accepted except where D100 changes contacts. D089–D091 stay Accepted. D082 and D086–D088 stay Proposed and are superseded where D095–D097 say so. D092–D094 stay Proposed.

## Main history note (not rewritten)
- `0844874` (`docs: update autopilot state after PR #44 merge`) reached `main` by
  **direct push without a PR**. This violates the process in
  `docs/AUTONOMOUS_ENGINEERING_SYSTEM.md` (push to main requires owner approval).
  The content is docs-only (`docs/AUTOPILOT_STATE.md`) and CI passed on it. History is
  not rewritten; the violation is recorded here and the rule is made explicit in
  `AGENTS.md` / `docs/AUTONOMOUS_ENGINEERING_SYSTEM.md`.
- Since 2026-10-12, `main` is protected by repository ruleset **`main-protection` (id 24915605, active)**:
  PR required (0 approvals), required status check `verify`, no force push (non_fast_forward), no deletion, no bypass actors.

## Recent merges (baseline)
- PR #40 — B07 inference benchmark infrastructure (evaluation only; not production B07) — `519aaeeb9caa5f44fd96e3d3e04aeb9968259022`
- PR #41 — Pipeline private notes + tenant isolation documentation — `e91fc9845846b0c2a171c85b7cf0b1170938f604`
- PR #42 — Idempotent entitlement grant RPC + helpers — `44118874310d4b3369fe6d3892b0fbc9dc69e38e`
- PR #43 — Billing webhook stub (shared-secret, not final Rebill) — `0cc0f407a31a9bc62c97ad8be410abf4d0e2cebc`
- PR #44 — Autonomous engineering system bootstrap — `119aa691d540a1a5a58cfe44e678562ddb4a3a37`
- Direct push (no PR) — autopilot state update — `0844874c9304ce63e7393a22bf8951b5a5e93061`
- PR #47 — Baseline security corrections (0043, tenant/grant/webhook tests) — `f48a11364b10fd75972318f7e742a0d334d785f5`
- PR #46 — Autopilot state after PR #45 + ruleset — `60b674d142daa0e46dee298c61f573ac6e8f06`
- PR #45 — Governance reconciliation (0844874 note, D073 Rebill index, enforcement reality) — `186f4cdb98b79278a52258abe23ec96afb88483a`
- PR #48 — Baseline reconciliation — `d71e92a189e566af09d2d53a592f19e1384bbc50`
- PR #49 — Autonomous engineering system v1 — `0d176e42a7487c24c42f7d448f1fb3b3912535e3`
- PR #50 — B07 slice 1 rules engine — `161e4c0d7694b3e12b3b496c1393037b2d0e57a5`
- PR #51 — B07.1 commercial-meaning follow-ups — `187af6a3d4b4b5f6db1ec6d1f77ca975e791f852`
- PR #52 — D01 trips — `4062170212beb8b978a248ef219eb91ddbfb080b`
- PR #54 — C01 intelligence fact contract, docs only (D077 remains Proposed) — `989e7f020f07362113b3e9b00fd9950293808f10`
- PR #55 — E01 Discover + Hotel Detail, map deferred, no migration — `ab0507461b4b47b21112dd07589b4b8a88d3efb3`
- PR #56 — D07 deliverables and agreed compensation, migration `0050`, D078 Accepted — `61d0e385894670bc55a78675e64526c353c288d5`
- PR #53 — B08 incremental Gmail sync, D076, migrations `0047` and `0048` — `eb136190f676e9201b6b39de4b570d51e52da73d`
- PR #57 — MAP, Google Maps on Discover and Hotel Detail, D079, no migration — `023a354c8592411e1ac85c818324589993f358a6`
- PR #58 — D06 inbox ↔ pipeline unity, D080 Accepted, migration `0049` — `6b59318bbe33897a5204f42fa2292eccaf6d13a7`
- PR #59 — E02 product coherence, D081 Accepted, no migration — `edc326dc5a0f22956a0b6572a9486d56df15572f`
- PR #60 — E03 onboarding and empty/error states, D082 Proposed, no migration — `fc2dfbd32bf1063dec17d4db16ad84b6311f400c`
- PR #61 — D08 private profile and personal analytics, D086–D088 Proposed, migration `0052` — `d030cd0329c8b1e30afcdd14a72485174edcd9f5`
- PR #62 — E04 Pass/Pro entitlement inventory, migration `0051` — `dc5979eed799d1724eb36482eb0067d3e9f0fe55`
- PR #63 — D09 creator profile share link, D089–D091 Accepted, migration `0053` — `1fc15658fc69acaa799860f8340736e15e1f5728`
- PR #64 — E05 E2E, observability, launch checklist, migration `0054` — `621bc557762a70242b08a02afca94bca6c08f08d`
- PR #65 — UX01 Sunlit Creator OS, D095–D098 Accepted, migration `0055` — `9a449239df1ebd859d4876c35e83e35007cf41af`
- PR #66 — DATA01 hotel catalog importer — `502ae69ecb192dc3678a27619a557bb1012ff0e5`
- PR #67 — C02–C05 network intelligence, D099, migration `0056` — `9a747b217a8c560f08c87bed1b2542f4521ac25e`
- PR #69 — HB01 Hotelbeds provisional star rating, D106, migration `0059` — `28656f46dd71f9887e6305cf2e0349099e8f2a9e`
- PR #68 — F05 contact credits, D100–D105, migrations `0057`, `0058`, and `0060` — `85186fdc18f65db9233c5df9155a65674740e551`
- PR #71 — F01 Gmail collaboration detection, D107, migration `0061` — `12630bb9d616fdb63ad97d2e61fe5668723eac67`
- PR #70 — F05b unlock saves pipeline, D108, migration `0062` — `b8752e31ee4e51971390ebbf260062186f689a92`
- PR #72 — F02 pitch templates, D110, migration `0064` — `087419826bbac1c241f852d4ff32b868728a8b48`
- PR #74 — G01 contract templates, D114, migration `0068` — `f4f0bb7ebafa72ac46bfe78b29267016e6d85235`
- PR #73 — F04 home next actions, D112, migration `0066` — `0a69413beb338c7910d8b9473693a3db7136a6aa`
- PR #75 — G02 deliverable deadlines, D115, migration `0069` — `6c77347ce5cbc9e57c4d675f0a5bc636474a0c16`
- PR #76 — G03 portfolio, D125, migrations `0073` and `0074` — `2cb8b2d660b93963e9ad8ec319b843bcd4189832`
- PR #77 — H01 metric rankings, D120, migrations `0071` and `0072` — `b541343c7f7e87e3402d377d88bc5b23d67cbe5a`
- PR #78 — F03 hotel ranking rules, D130, no migration — `257123db9d830d146fc601a68bb2ccf250ecd49f`
- PR #79 — P01 plans and pricing, D131–D134, migrations `0075` and `0076` — `7d9e9815e33a25792f684d1e4f372f4cd36a8ed7`
- PR #80 — P02 Rebill billing, D135–D139, migrations `0077`, `0078`, and `0079` — `93573874a9ec90a8f246ed379bb3b9df23d8d95f`
- PR #81 — P03 refund policy, D140, migration `0080` — `bf756686bf359c22723b5628fa4446bee2af0302`
- PR #82 — P03b refund ledger fix, migration `0081` — `4c8eecde65cc537e71131914343751207d2d7f6d`
- PR #84 — D03 AI assistant and email composer, D141–D145, migrations `0082` and `0083` — `b2b4e49825a1dd212734e812a4fbb069ee7db0ea`
- PR #83 — C02–C05 freshness, aggregates, and creator fit, D146–D150, migrations `0084`–`0087` — `4b9f70aaa2d15d955e6633581eae8a2c5833f33a`
- PR #85 — DEC-DEL account deletion, D151–D155, migration `0088` — `414b9805497a2210dd0ddebb592991331e7221d2`
- PR #86 — D04 Gmail send, D156–D161, migration `0089` — `3e11ded390a2845603b207433af90bb846d4670e`
- PR #87 — D04b AI cost and anti-abuse, D162–D170, migrations `0090` and `0091` — `f892d6e37cd7b606e4b5c663dc002e0503d0145b`
- PR #89 — D05 follow-up scheduling, D171–D177, migration `0092` — `2549b96836d90180b655a7d0893316e57e92a5f2`
- PR #91 — UX02 Discover + Hotel Detail, design only, no migration — `dbfd2472b00d49590c17f416a10f6dbef371781b`
- PR #92 — PREPROD-1 scheduled jobs, migration `0093` — `697ca0946fcef24f32fe0da518512ec1c3c3b4cf`
- PR #93 — PREPROD-1b deletion-pending send tests, no new migration — `9c50400c104b6f5aa036eea3ea798f269aeffe5e`
- PR #94 — BASE-N9 null-reference entitlement grants, migration `0094`, D179 — `4b9226b9a1fd5bf11733e3fa0e4ce14efca262f3`
- PR #95 — UX02 Discover and Hotel Detail screens — `3a39ceb394df7b00e6ad6b12ab5bc40c7e3bfc59`
- PR #96 — docs accept D178 — `86a530bd6bdd59de20adb19173f96c27072bddcb`
- PR #97 — D02 Hunter contact provider, migration `0095`, D180 — `9658a451a09e2543a36184ae47562cb4dde59241`. Provenance and freshness are not on the unlock screen.
- PR #98 — D02 audit fix, migration `0096`, D181 email cascade — `dc04d09369c5d2574755c970b3a3e3b7b95c3cc1`. Provenance and freshness are still not on the unlock screen.
- PR #99 — Gmail callback error log, no migration — `7041104f7fce3e9a8e0916621daa39d0799b2b22`.
- PR #100 — V2-D1 opportunity data model, nights, and campaigns, migration `0097`, D182–D187 — `4001a628a347c0588fcc402d03fadb40302b8b6a`. Contract Review stays out of MVP (D185).
- PR #102 — V2-F1 V12.2 Midnight shell and theme, no migration — `ebf4681a214be89b0246f45f709b98c4b7b00432`.
- PR #103 — in-process scheduled jobs, no migration — `b3cd11a9afe70d14351a1f0abdc4a4ce4d387c50`.
- PR #104 — V2-S6 Midnight Plans, Billing, Profile, Getting Started, and Collaborations, no migration — `a70c143f9bdc80ba39ce8e3974c84bbd237ac32a`.
- PR #105 — V2-S3 Pipeline and Pitch Studio. Migration `0098` binds a pitch draft to one opportunity. Draft, not merged.
- PR #108 — V2-S2 Trips and Outreach, no new migration — `b0e0a732ec1b2069bbdde91c6ded51b1466da80e`.
- PR #109 — scheduled job failures are caught instead of a bare 502, no migration — `cc1b6cbfaed4457bf501113687c58e9f32921ebb`.

## Next action
- CREDENTIAL REQUIRED — set `HUNTER_API_KEY` and `CONTACT_PROVIDER=hunter` only on the host that should call Hunter. Leave both unset in CI. A manual smoke is at most three hotels with no contact cache row and three different website domains. Then unset `CONTACT_PROVIDER`.
- PR #100 is merged (`4001a628a347c0588fcc402d03fadb40302b8b6a`, migration `0097`, D182–D187). Contract Review stays out of MVP (D185).
- PR #103 is merged (`b3cd11a9afe70d14351a1f0abdc4a4ce4d387c50`, in-process scheduled jobs, no migration).
- PR #102 is merged (`ebf4681a214be89b0246f45f709b98c4b7b00432`). Midnight is the single theme.
- PR #109 is merged (`cc1b6cbfaed4457bf501113687c58e9f32921ebb`).
- PR #104 is merged (`a70c143f9bdc80ba39ce8e3974c84bbd237ac32a`). Plans, Billing, Profile, Getting Started, and Collaborations are on Midnight. Checkout, prices, and refund rules stay the existing Rebill and D140 behavior.
- PR #108 is merged (`b0e0a732ec1b2069bbdde91c6ded51b1466da80e`, V2-S2 Trips and Outreach, no new migration).
- PR #105 is the open V2-S3 draft. Migration `0098` binds a pitch draft to one opportunity. Do not merge it from this note.
- D178 is Accepted (owner Brian, 16 Oct 2026). The code in PR #92 matches it.
- Open drafts #88 (`design/ux01-mockups`) and #90 (`cursor/ux01-phase1-mockups-12bd`) are UX01 mockups awaiting the owner. Do not merge them.
- EXTERNAL ACTION APPROVAL REQUIRED — Add `gmail.send` (sensitive) to the Google Cloud OAuth consent screen. Set `GMAIL_SEND_ENV=production` only on the production site. Leave it unset on staging and previews. Do not do either from this repository.
- P01 is merged (PR #79, `7d9e9815e33a25792f684d1e4f372f4cd36a8ed7`). D131–D134. Migrations `0075` and `0076`. This PR does not edit those files.
- F03 is merged (PR #78, `257123db9d830d146fc601a68bb2ccf250ecd49f`). D130. No migration. This PR does not edit the F03 order files.
- H01 is merged (PR #77, `b541343c7f7e87e3402d377d88bc5b23d67cbe5a`). D120. Migrations `0071` and `0072`. This PR does not edit those files.
- G03 is merged (PR #76, `2cb8b2d660b93963e9ad8ec319b843bcd4189832`). D125. Migrations `0073` and `0074`. This PR does not edit those files.
- G02 is merged (PR #75, `6c77347ce5cbc9e57c4d675f0a5bc636474a0c16`). D115. Migration `0069`. In-app reminders only. D116 and migration `0070` are unused. This PR does not edit `0069`.
- F04 is merged (PR #73, `0a69413beb338c7910d8b9473693a3db7136a6aa`). D112. Migration `0066` lists the caller's pending Gmail suggestions. The cap of 100 keeps human reply, then pitch sent, then collaboration, then id. Free returns paused and no ids. No new table. No send and no model. This PR does not edit `src/lib/home`.
- G01 is merged (PR #74, `f4f0bb7ebafa72ac46bfe78b29267016e6d85235`). D114. Migration `0068`. A won deal can become a private agreement draft. No e-sign and no model vendor. This PR does not edit that file.
- F02 is merged (PR #72, `087419826bbac1c241f852d4ff32b868728a8b48`). D110. Migration `0064`. Copy or a mailto draft only. No model vendor. D03 and D04 stay open. This PR does not edit that file.
- F05b is merged (PR #70, `b8752e31ee4e51971390ebbf260062186f689a92`). D108. Migration `0062`. A revealed unlock saves the hotel in the same transaction. A refused unlock or a full Free allowance does not. This PR does not edit that file.
- F01 is merged (PR #71, `12630bb9d616fdb63ad97d2e61fe5668723eac67`). Migration `0061`. D107. Free detection stays paused. Disconnect does not delete suggestions. This PR does not edit that file.
- F05 is merged (PR #68, `85186fdc18f65db9233c5df9155a65674740e551`). Migrations `0057`, `0058`, and `0060`. Migration `0059` stays HB01. Open amounts stay pending config.
- HB01 is merged (PR #69, `28656f4`, migration `0059`). This PR does not edit that file.
- C02–C05 is merged (PR #67, `9a747b2`). DATA01 is merged (PR #66, `502ae69`). UX01 is merged (PR #65, `9a44923`, migration `0055`). This PR does not edit `0055` or `0056`.
- E05 is merged (PR #64, `621bc55`). This PR does not edit `0054`.
- D09 is merged (PR #63, `1fc1565`, migration `0053`). D089–D091 are unchanged.
- E04 is merged (PR #62, `dc5979e`, migration `0051`). This PR does not edit `0051`.
- D08 is merged (PR #61, `d030cd0`, migration `0052`). This PR does not edit `0052`.
- E03 is merged (PR #60, `fc2dfbd`, D082 Proposed). D095 supersedes the checklist.
- E02 is merged (PR #59, `edc326d`, D081 Accepted). Profile stays a primary item.
- D077 is Accepted (Brian, 13 Oct 2026). D099 closes the three C01 questions and is the C02–C05 implementation. Model-backed B07 inference stays out of this PR.
- D092–D094 stay Proposed. D106 stays Accepted.
- Non-blocking residuals are listed in `.grok/autopilot-state.json` → `unresolved_findings`. BASE-N5 is closed: the webhook no longer trusts a body user id. BASE-N9 is closed by migration `0094` (D179): a null `source_reference` is one logical grant, and `expires_at` before `starts_at` is refused. It is not an unresolved finding.
- **State updates ride in each block's closing PR** (no standalone state-only PRs).
- Owner interaction happens only via human-frontier labels.

## PLAY
Owner may send `PLAY` at any time. Orchestrator must resume from live GitHub + this file without asking for block selection.
