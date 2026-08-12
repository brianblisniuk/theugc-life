# Local import workspace

Real hotel/contact research files are intentionally **not stored in Git**.

Use these local directories when running imports:

```text
data/imports/raw/      # source spreadsheets/CSVs/Markdown — gitignored
data/imports/reports/  # dry-run reports containing real data — gitignored
```

Future research should conform to `/docs/HOTEL_DATA_CONTRACT.md`.

Current historical spreadsheets are legacy migration inputs only and should be passed through the isolated legacy adapters described in `/docs/LEGACY_DATA_MIGRATION.md`.
