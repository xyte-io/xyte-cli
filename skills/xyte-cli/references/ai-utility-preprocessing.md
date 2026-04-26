# AI-Assisted Utility Preprocessing (Prepare-First, CLI stays AI-free)

This runbook defines utility preprocessing with `xyte-cli util prepare`.

## Scope

1. Preprocess write-capable endpoint actions into canonical files.
2. Execute only the CLI-supported utility workflows from their dedicated commands: `util import-tree`, `util move-devices`, and `edge claim-batch`.
3. Keep `xyte-cli` AI-free: no OCR/model calls inside the CLI.

## Core model

1. Run `xyte-cli util list-actions` to discover supported actions.
2. Run `xyte-cli util prepare --action <action-key> --input <source>`.
3. CLI emits `xyte.utility.prepare.v1` and scaffolds canonical files.
4. Review the generated `.notes.md` file first; it is the human-facing column glossary, required/optional field guide, reject taxonomy, canonical JSON shape, and safe-command checklist.
5. External AI fills primary/rejected/notes using the contract.
6. Ask the user what to do next. Never auto-apply.
7. For `space.import-tree` and `device.move`, run dry-run then apply with explicit user approval. Dry-run summaries count validated rows under `totals.planned`, not `totals.succeeded`.
8. For `organization.edge.startClaim`, run `edge claim-batch --plan`, then `--apply` after explicit approval and use `--resume-artifact` for partial runs.
9. For other actions, use controlled `xyte-cli api call` loops outside utility execution.

## Canonical outputs

`util prepare` always creates:
1. primary artifact
2. rejected artifact with `reject_reason`
3. notes artifact

Friendly profiles:
1. `space.import-tree`:
- `path,space_type,config`
2. `organization.devices.claimDevice`:
- `name,space_id,sn,mac,cloud_id`
3. `organization.edge.startClaim`:
- `proxy_id,device_ip,device_model_id,space_id,display_name,custom_parameters,custom_partner_name,custom_model_name,skip_connectivity_check`
- downstream execution command: `xyte-cli edge claim-batch`
4. `device.move`:
- `device_id,target_space_id`
- downstream execution command: `xyte-cli util move-devices`

Generic profiles:
1. `<path params...>,query_json,body_json`

## Required AI rules

1. Never guess unknown identifiers.
2. Trim whitespace.
3. Keep deterministic row ordering.
4. Route ambiguous rows to rejected output with `reject_reason`.
5. For generic profiles, keep `query_json` and `body_json` valid JSON object strings or empty.

## Prompt templates

1. `templates/ai-utility-prepare-generic.prompt.md`
2. `templates/ai-space-import.prompt.md`

## Runbook

Discover actions:

```bash
xyte-cli util list-actions --output text
xyte-cli util list-actions --output text --mode friendly --execution-support edge.claim-batch
```

Prepare claim action:

```bash
xyte-cli util prepare \
  --action organization.devices.claimDevice \
  --input ./input/raw-source.xlsx \
  --tenant <tenant-id> \
  --output-dir ./prepared
```

Prepare space import action:

```bash
xyte-cli util prepare \
  --action space.import-tree \
  --input ./input/raw-hierarchy.pdf \
  --tenant <tenant-id> \
  --output-dir ./prepared
```

Prepare edge-claim action:

```bash
xyte-cli util prepare \
  --action organization.edge.startClaim \
  --input ./input/edge-devices.xlsx \
  --tenant <tenant-id> \
  --output-dir ./prepared
```

Then drive the batch through `xyte-cli edge claim-batch --plan`, explicit approval, and `--apply --resume-artifact`.

Execute prepared space import (dry-run then apply):

```bash
xyte-cli util import-tree \
  --tenant <tenant-id> \
  --input ./prepared/space-import-tree.csv

xyte-cli util import-tree \
  --tenant <tenant-id> \
  --input ./prepared/space-import-tree.csv \
  --apply
```

Execute prepared device moves (dry-run then apply):

```bash
xyte-cli util move-devices \
  --tenant <tenant-id> \
  --input ./prepared/device-move.csv \
  --report ./artifacts/device-moves.dry-run.ndjson

xyte-cli util move-devices \
  --tenant <tenant-id> \
  --input ./prepared/device-move.csv \
  --apply \
  --report ./artifacts/device-moves.apply.ndjson
```

## Contracts

1. Prepare contract:
- schema ID: `xyte.utility.prepare.v1`
- schema file: `schemas/utility-prepare.v1.schema.json`
2. Utility batch summary:
- schema ID: `xyte.utility.batch.v1`
- schema file: `schemas/utility-batch.v1.schema.json`
