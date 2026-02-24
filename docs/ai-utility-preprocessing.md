# AI-Assisted Utility Preprocessing (CLI Execution Only)

This runbook defines how AI may prepare utility batch files while `xyte-cli` remains the only execution path.

## Scope

Supported utility flows:
- `device bulk-rename`
- `space import-tree`

Out of scope:
- any embedded AI behavior inside `xyte-cli`
- `device bulk-move`

## Core Model

1. Operator runs `xyte-cli utility ai-context` with explicit entity (`devices|spaces`).
2. CLI emits decoding contract JSON and scaffolds canonical artifact files.
3. AI ingests messy operator input and fills scaffolded files.
4. Operator reviews AI outputs.
5. Agent asks operator what to do next (`dry-run`, `apply`, or stop).
6. Operator runs `xyte-cli` dry-run.
7. Operator runs `xyte-cli` apply (only with explicit intent).
8. Operator verifies via read endpoints and summary schemas.

## Allowed Source Inputs

Rename sources:
- `.xlsx`
- `.csv`
- `.json`
- pasted table/text

Space import sources:
- `.pdf`
- `.md`
- pasted hierarchy text
- `.csv`
- `.json`

## Required AI Output Contracts

### 1) Device Bulk Rename

Primary:
- `/Users/porton/Projects/xyte-cli/tmp/bulk-rename.csv`
- exact header: `device_id,new_name`

Rejects:
- `/Users/porton/Projects/xyte-cli/tmp/bulk-rename.rejected.csv`
- includes original row data and `reject_reason`

Notes:
- `/Users/porton/Projects/xyte-cli/tmp/bulk-rename.mapping.md`
- includes source-to-target mapping, normalization, and conflict decisions

### 2) Space Import Tree

Primary:
- `/Users/porton/Projects/xyte-cli/tmp/space-import.jsonl`
- JSONL objects where:
  - `path` is required
  - `space_type` is optional
  - `config` is optional object

Rejects:
- `/Users/porton/Projects/xyte-cli/tmp/space-import.rejected.jsonl`
- includes original row/object and `reject_reason`

Notes:
- `/Users/porton/Projects/xyte-cli/tmp/space-import.notes.md`
- includes hierarchy/path normalization assumptions

## Hard Validation Rules for AI

Global:
- do not guess unknown identifiers
- trim leading/trailing whitespace
- keep deterministic row ordering where possible

Rename:
- never invent `device_id`
- dedupe by `device_id` and keep the last occurrence
- write dropped/conflicting duplicates into notes and/or rejects

Space import:
- no empty `path`
- normalize separators to `/`
- remove repeated separators and extra whitespace around segments
- do not infer missing hierarchy segments
- keep ambiguous entries in rejects

## Execution SOP

### Build AI Context + Scaffold Artifacts

```bash
xyte-cli utility ai-context \
  --input /path/to/source-file \
  --entity devices \
  --tenant <tenant-id> \
  --output-dir /Users/porton/Projects/xyte-cli/tmp
```

Notes:
- CLI remains AI-free (no OCR/model inference).
- Entity selection is explicit (`devices` or `spaces`), no auto-inference.
- Use `--force` to overwrite existing scaffold files.

### Local Sandbox

Terminal A:

```bash
npm run mock:xyte:local -- --port 3001
```

Terminal B:

```bash
npm run smoke:local:utilities -- --base-url http://127.0.0.1:3001 --tenant local
```

### Production Sequence

Rename dry-run:

```bash
xyte-cli device bulk-rename \
  --tenant <tenant-id> \
  --input /Users/porton/Projects/xyte-cli/tmp/bulk-rename.csv \
  --report /Users/porton/Projects/xyte-cli/tmp/bulk-rename.dryrun.ndjson
```

Rename apply:

```bash
xyte-cli device bulk-rename \
  --tenant <tenant-id> \
  --input /Users/porton/Projects/xyte-cli/tmp/bulk-rename.csv \
  --apply \
  --report /Users/porton/Projects/xyte-cli/tmp/bulk-rename.apply.ndjson
```

Space import dry-run:

```bash
xyte-cli space import-tree \
  --tenant <tenant-id> \
  --input /Users/porton/Projects/xyte-cli/tmp/space-import.jsonl \
  --report /Users/porton/Projects/xyte-cli/tmp/space-import.dryrun.ndjson
```

Space import apply:

```bash
xyte-cli space import-tree \
  --tenant <tenant-id> \
  --input /Users/porton/Projects/xyte-cli/tmp/space-import.jsonl \
  --apply \
  --report /Users/porton/Projects/xyte-cli/tmp/space-import.apply.ndjson
```

## Manual Operator Validation Sequence

1. Prepare AI output files from a messy source file.
2. Run rename dry-run and confirm summary:
   - `schemaVersion: "xyte.utility.batch.v1"`
   - `mode: "dry-run"`
3. Run rename apply and confirm:
   - `mode: "apply"`
   - `totals.succeeded > 0`
4. Run space import dry-run then apply.
5. Re-run space import apply to confirm idempotency (no failures due to existing paths).
6. Verify server/device/space state:
   - local mock: `GET /_mock/state`
   - production read endpoints via `xyte-cli call`

## Summary Contract

All utility execution summaries must remain:
- schema ID: `xyte.utility.batch.v1`
- schema file: `/Users/porton/Projects/xyte-cli/docs/schemas/utility-batch.v1.schema.json`

AI context scaffold summaries use:
- schema ID: `xyte.utility.ai-context.v1`
- schema file: `/Users/porton/Projects/xyte-cli/docs/schemas/utility-ai-context.v1.schema.json`
