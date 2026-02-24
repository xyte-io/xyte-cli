# Utility Batch Flows (Non-Device Scope, AI-Assisted Preprocessing)

`xyte-cli` executes only. AI may preprocess source data into canonical files.

Contract and prompt templates:
- `/Users/porton/Projects/xyte-cli/docs/ai-utility-preprocessing.md`
- `/Users/porton/Projects/xyte-cli/scripts/templates/ai-bulk-rename.prompt.md`
- `/Users/porton/Projects/xyte-cli/scripts/templates/ai-space-import.prompt.md`
- `/Users/porton/Projects/xyte-cli/skills/xyte-cli/references/utility-ai-device-bulk-rename.md`
- `/Users/porton/Projects/xyte-cli/skills/xyte-cli/references/utility-ai-space-import-tree.md`

## Safety Defaults

- All utility commands are dry-run unless `--apply` is passed.
- Default behavior is fail-fast.
- Use `--continue-on-error` to process remaining rows.
- Add `--report <path>` for per-row NDJSON output.
- Agent behavior gate: after generating structured files, ask user whether to run dry-run, apply, or stop. Never auto-apply.

## SOP #1: Spreadsheet to Device Bulk Rename

Context scaffold:

```bash
xyte-cli utility ai-context \
  --input /path/to/raw-source \
  --entity devices \
  --tenant <tenant-id> \
  --output-dir /Users/porton/Projects/xyte-cli/tmp
```

AI output files:
- `/Users/porton/Projects/xyte-cli/tmp/bulk-rename.csv` (exact header: `device_id,new_name`)
- `/Users/porton/Projects/xyte-cli/tmp/bulk-rename.rejected.csv` (with `reject_reason`)
- `/Users/porton/Projects/xyte-cli/tmp/bulk-rename.mapping.md`

Decision gate:
- Ask: `What should I do with this structured file? (dry-run / apply / stop)`

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

Verification:

```bash
xyte-cli call organization.devices.getDevice \
  --tenant <tenant-id> \
  --path-json '{"device_id":"<sample-device-id>"}'
```

## SOP #2: Unstructured Hierarchy to Space Import Tree

Context scaffold:

```bash
xyte-cli utility ai-context \
  --input /path/to/raw-source \
  --entity spaces \
  --tenant <tenant-id> \
  --output-dir /Users/porton/Projects/xyte-cli/tmp
```

AI output files:
- `/Users/porton/Projects/xyte-cli/tmp/space-import.jsonl`
- `/Users/porton/Projects/xyte-cli/tmp/space-import.rejected.jsonl` (with `reject_reason`)
- `/Users/porton/Projects/xyte-cli/tmp/space-import.notes.md`

Decision gate:
- Ask: `What should I do with this structured file? (dry-run / apply / stop)`

Dry-run:

```bash
xyte-cli space import-tree \
  --tenant <tenant-id> \
  --input /Users/porton/Projects/xyte-cli/tmp/space-import.jsonl \
  --report /Users/porton/Projects/xyte-cli/tmp/space-import.dryrun.ndjson
```

Apply:

```bash
xyte-cli space import-tree \
  --tenant <tenant-id> \
  --input /Users/porton/Projects/xyte-cli/tmp/space-import.jsonl \
  --apply \
  --report /Users/porton/Projects/xyte-cli/tmp/space-import.apply.ndjson
```

Verification:

```bash
xyte-cli call organization.spaces.getSpaces \
  --tenant <tenant-id> \
  --query-json '{"path_includes":"HQ/Floor-1/Room-A"}'
```

Idempotency verification:

```bash
xyte-cli space import-tree \
  --tenant <tenant-id> \
  --input /Users/porton/Projects/xyte-cli/tmp/space-import.jsonl \
  --apply
```

## Local Utility Sandbox

```bash
# terminal A
npm run mock:xyte:local -- --port 3001

# terminal B
npm run smoke:local:utilities -- --base-url http://127.0.0.1:3001 --tenant local
```

Success condition:
- smoke command exits `0` and prints `Local utility smoke passed.`

MCP parity tools:
- `xyte_utility_ai_context`
- `xyte_device_bulk_rename`
- `xyte_space_import_tree`
