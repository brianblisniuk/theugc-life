# Skill: hostile-pr-audit

Independent adversarial review of a PR.

Must:
- Read the real files at the exact head SHA (not the Builder’s summary).
- Check scope vs contract.
- Verify security, tenancy, and privacy claims against code.
- Produce concrete findings with file:line references.
- Return PASS or list of blocking defects.

Do not accept the implementer’s report as evidence.
