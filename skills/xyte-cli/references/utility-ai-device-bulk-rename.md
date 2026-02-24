# Utility AI Node: Device Bulk Rename Decode

Use this node only when the target action is `device bulk-rename`.

## Objective

Decode a messy source file into canonical rename artifacts for `xyte-cli`.

## Canonical Output Artifacts

1. Primary CSV:
- `/Users/porton/Projects/xyte-cli/tmp/bulk-rename.csv`
- exact header: `device_id,new_name`

2. Rejected CSV:
- `/Users/porton/Projects/xyte-cli/tmp/bulk-rename.rejected.csv`
- include original row fields and `reject_reason`

3. Notes:
- `/Users/porton/Projects/xyte-cli/tmp/bulk-rename.mapping.md`
- include field mapping, assumptions, and duplicate handling notes

## Decode Rules

1. Never guess `device_id`.
2. Trim whitespace for mapped fields.
3. Deduplicate by `device_id` using keep-last.
4. Place ambiguous rows in rejected file with `reject_reason`.
5. Keep deterministic row ordering where possible.

## Execution Sequence

Decision gate (required):
- After files are structured, ask user: `Run dry-run, apply, or stop?`
- Never auto-run apply without explicit user choice.

Dry-run:

```bash
xyte-cli device bulk-rename \
  --tenant <tenant-id> \
  --input /Users/porton/Projects/xyte-cli/tmp/bulk-rename.csv \
  --report /Users/porton/Projects/xyte-cli/tmp/bulk-rename.dryrun.ndjson
```

Apply:

```bash
xyte-cli device bulk-rename \
  --tenant <tenant-id> \
  --input /Users/porton/Projects/xyte-cli/tmp/bulk-rename.csv \
  --apply \
  --report /Users/porton/Projects/xyte-cli/tmp/bulk-rename.apply.ndjson
```

Verify:

```bash
xyte-cli call organization.devices.getDevice \
  --tenant <tenant-id> \
  --path-json '{"device_id":"<sample-device-id>"}'
```
