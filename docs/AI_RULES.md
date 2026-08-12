# theugc.life — AI_RULES.md
Version: 1.0
Status: Applies when AI outreach is implemented (post-core MVP).

## 1. Purpose

AI assists creators with outreach and follow-up using creator-approved context.
It is not an autonomous sales agent in V1/V2.

## 2. Provider abstraction

AI calls go through an application service interface.
Do not bind domain tables or UI directly to one provider SDK.
Provider/model selection is configuration.

## 3. Allowed context

AI may use:
- creator profile fields explicitly supplied for outreach
- public portfolio assets/summary
- creator-selected trip context
- hotel editorial data
- entitled hotel contact role/name
- safe hotel intelligence
- creator's own prior relationship context where explicitly relevant

## 4. Disallowed/default-excluded context

Do not send:
- other creators' raw events
- other creators' private notes
- private financial data not required for task
- hidden admin notes
- unrelated inbox content
- bulk contact database dumps

## 5. Creator control

Generated outreach is a draft.
Creator reviews before use.
Connected-email phase still requires explicit send action unless a future PRD changes this.

No autonomous mass campaigns.

## 6. Claims

AI must not fabricate:
- prior stays
- brand relationships
- audience metrics
- deliverables
- travel dates
- hotel facts
- “creator-friendly” claims unsupported by available data

If a required personalization fact is missing, omit it or ask creator to supply it.

## 7. Tone

Creator may choose tone presets later, but output should default to professional, concise, personalized hospitality outreach.
Avoid generic flattery and obvious template language.

## 8. Data retention

Do not persist full prompt/output indefinitely unless needed for user feature/history and disclosed.
Never use AI logs as source-of-truth for domain outcomes.

## 9. Safety/anti-spam

Implement reasonable per-user usage limits.
Do not build bulk scraping + bulk-send flows.
Do not auto-contact hotels without creator action.

## 10. Future inbox connection

Use OAuth and minimum required scopes.
Provider message IDs may support deduplication/reply matching.
Do not ingest entire inbox when narrower query/scope is sufficient.
