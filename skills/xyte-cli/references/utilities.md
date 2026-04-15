# Util Prepare Flows (Preprocess-First)

`xyte-cli` util preprocessing is auth-agnostic. It creates structured files only.

References:
1. `references/ai-utility-preprocessing.md`
2. `templates/ai-utility-prepare-generic.prompt.md`
3. `templates/ai-space-import.prompt.md`

## Safety Defaults

1. Always run preprocessing first.
2. After files are generated, ask the user what to do next.
3. Never auto-run `--apply`.

## SOP A: Bulk Claim Preprocessing (`organization.devices.claimDevice`)

```bash
xyte-cli util prepare \
  --action organization.devices.claimDevice \
  --input /path/to/raw-source.xlsx \
  --tenant <tenant-id> \
  --output-dir ./prepared \
  [--primary-format csv|jsonl] [--force]
```

Expected files:
1. `./prepared/organization-devices-claimdevice.csv`
2. `./prepared/organization-devices-claimdevice.rejected.csv`
3. `./prepared/organization-devices-claimdevice.notes.md`

Decision gate:
1. Validate each target `space_id` with `organization.spaces.getSpace` before write loops.
2. Run a single probe claim with `--output-mode envelope`; if upstream returns `No device found`, stop bulk claim writes.
3. Ask the user whether to execute this action via an `xyte-cli api call` loop or stop.

## SOP B: Space Import Preprocessing + Execution (`space.import-tree`)

Prepare:

```bash
xyte-cli util prepare \
  --action space.import-tree \
  --input /path/to/raw-hierarchy.pdf \
  --tenant <tenant-id> \
  --output-dir ./prepared
```

Dry-run:

```bash
xyte-cli util import-tree \
  --tenant <tenant-id> \
  --input ./prepared/space-import-tree.csv \
  [--input-format auto|csv|json|jsonl] [--path-field <name>] [--space-type-field <name>] [--config-field <name>] \
  [--continue-on-error] \
  --report ./artifacts/space-import-tree.dryrun.ndjson
```

Apply:

```bash
xyte-cli util import-tree \
  --tenant <tenant-id> \
  --input ./prepared/space-import-tree.csv \
  --apply \
  --report ./artifacts/space-import-tree.apply.ndjson
```

Verify:

```bash
xyte-cli api call organization.spaces.getSpaces \
  --tenant <tenant-id> \
  --query-json '{"path_includes":"HQ/Floor 1/Office 1"}'
```

## SOP C: Device-to-Space Matching (`util match`)

```bash
xyte-cli util match \
  --source ./artifacts/source-devices.json \
  --target ./artifacts/target-spaces.json \
  --source-field name \
  --target-field name \
  --out ./artifacts/device-moves.csv \
  --tenant <tenant-id>
```

Expected files:
1. `./artifacts/device-moves.csv` — deterministic move mapping (device_id, source_space_id, target_space_id).
2. `./artifacts/device-moves.csv.summary.json` — match statistics sidecar.

Decision gate:
1. Review the summary JSON for match/unmatched counts.
2. Inspect the CSV for correctness before proceeding to `util move-devices`.

## SOP D: Batch Device Move (`util move-devices`)

Dry-run:

```bash
xyte-cli util move-devices \
  --tenant <tenant-id> \
  --input ./artifacts/device-moves.csv \
  --report ./artifacts/device-migration.dry-run.ndjson
```

Apply:

```bash
xyte-cli util move-devices \
  --tenant <tenant-id> \
  --input ./artifacts/device-moves.csv \
  --apply \
  --report ./artifacts/device-migration.apply.ndjson
```

Additional options:
- `--input-format auto|csv|json|jsonl` — override input format detection.
- `--continue-on-error` — continue processing rows after individual failures.

Decision gate:
1. Always dry-run first without `--apply`.
2. Review the NDJSON row report for failed or skipped rows.
3. Ask the user whether to execute with `--apply` or stop.

## SOP E: Generic Endpoint Preprocessing

List actions:

```bash
xyte-cli util list-actions --output text
```

Prepare generic action:

```bash
xyte-cli util prepare \
  --action organization.tickets.updateTicket \
  --input /path/to/raw-ticket-updates.csv \
  --tenant <tenant-id> \
  --output-dir ./prepared
```

Generic canonical headers:
1. `<path params in order>,query_json,body_json`
