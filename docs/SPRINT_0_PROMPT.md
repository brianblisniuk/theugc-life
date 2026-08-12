# Claude Code — Sprint 0 Master Prompt

You are implementing Sprint 0 of **theugc.life**.

## Source of truth

Read these files in full before changing code:

1. `/docs/PRD.md`
2. `/docs/DATABASE.md`
3. `/docs/PERMISSIONS.md`
4. `/docs/EVENTS.md`
5. `/docs/ROUTES.md`
6. `/docs/ANALYTICS.md`
7. `/docs/DESIGN_SYSTEM.md`
8. `/docs/AI_RULES.md`
9. `/docs/DECISIONS.md`

The PRD is the master product specification. Derived docs may add implementation detail but may not contradict the PRD.

## Mandatory agent rule

Do not invent product behavior.

If implementation requires a decision that is not specified:
1. stop before implementing that decision;
2. state the unresolved decision;
3. explain why it blocks;
4. give 2–3 technically viable options;
5. recommend one.

Do not silently choose.

## Sprint 0 objective

Create a secure, reproducible foundation for theugc.life. Do NOT implement full hotel discovery, payments, CRM, intelligence, AI, community, or marketplace yet.

## Required deliverables

### Repository/application
- Next.js App Router
- TypeScript strict mode
- Tailwind
- sensible lint/format configuration
- environment validation
- clear server/client boundaries

### Supabase
- local/project configuration suitable for migrations
- versioned SQL migrations
- base schema required by the approved data architecture
- RLS enabled on private/sensitive tables
- initial RLS/helper-function foundation
- no service-role key exposed client-side

### Authentication
- signup
- login
- logout
- forgot/reset password flow foundation
- creation of application user/creator profile safely from authenticated identity
- protected `/app`
- protected `/admin` with role check

### Application shells
Create minimal, non-final shells only:
- public shell
- auth shell
- app shell with approved nav: Home, Discover, Pipeline, Trips, Profile
- admin shell
Do not invent additional primary navigation.

### Analytics foundation
- provider abstraction/init for PostHog or approved equivalent
- typed event helper
- no sensitive/private-note payloads

### Error/logging foundation
- server-safe structured logging approach
- error boundary / not-found foundations
- do not leak secrets/PII

### Deployment/readiness
- Vercel-compatible build
- `.env.example`
- README setup instructions
- scripts for lint, typecheck, test, build, migrations
- CI workflow if repository environment supports it

### Tests
At minimum:
- auth/protected route smoke tests where feasible
- initial RLS permission tests for creator ownership
- build/typecheck/lint must pass

## Database scope for Sprint 0

Create the approved base schema, but do not build product UI for all entities.

It is acceptable to create tables in dependency-safe migrations. Do not seed fabricated production hotel intelligence.

Use migrations only; no undocumented manual schema mutations.

## Explicit non-goals

Do NOT implement:
- Mapbox discovery UI
- Hotmart checkout/webhooks
- premium contact reveal
- full hotel admin
- CRM board
- trips product UI
- intelligence calculations
- share cards
- AI outreach
- Gmail/Outlook
- community
- marketplace

Those belong to later sprints.

## Security requirements

- RLS on creator-private tables.
- Client cannot assign own role.
- Client cannot create paid entitlement.
- `/admin` rejects non-admin/editor as specified.
- Secrets are server-only.
- Never rely on hidden UI for authorization.

## Working method

1. Inspect existing repository first. If empty, initialize cleanly.
2. Produce a short implementation plan mapped to Sprint 0 deliverables.
3. Identify blockers/unspecified decisions before coding.
4. Implement in small coherent changes.
5. Run migrations/tests/lint/typecheck/build.
6. Fix failures rather than suppressing checks.
7. Update docs only if implementation detail is approved and non-contradictory.
8. Finish with a report:
   - files changed
   - migrations created
   - security/RLS implemented
   - tests executed and results
   - unresolved decisions
   - exact commands for local run
   - what is intentionally deferred to Sprint 1

## Definition of Done

Sprint 0 is done only when:
- staging/local app boots
- auth works
- protected routes work
- migrations reproduce schema from empty DB
- private ownership policies have tests
- lint passes
- typecheck passes
- tests pass
- production build passes
- no client-exposed service secrets
- docs/setup are sufficient for another engineer/agent to reproduce environment

Do not proceed to Sprint 1 automatically. Stop and request review after Sprint 0 completion.
