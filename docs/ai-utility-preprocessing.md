# AI-Assisted Utility Preprocessing (Prepare-First, CLI stays AI-free)

This runbook defines utility preprocessing with `xyte-cli util prepare`.

## Scope

1. Preprocess all write-capable endpoint actions into canonical files.
2. Execute only the CLI-supported utility workflows from their dedicated commands: `util import-tree`, `util move-devices`, and `edge claim-batch`.
3. Keep CLI AI-free: no OCR/model calls inside `xyte-cli`.

## Core model

1. Run `xyte-cli util list-actions` to discover supported actions.
2. Run `xyte-cli util prepare --action <action-key> --input <source>`.
3. CLI emits `xyte.utility.prepare.v1` and scaffolds canonical files.
4. Review the generated `.notes.md` file first; it is the human-facing column glossary, required/optional field guide, reject taxonomy, JSONL example, and safe-command checklist.
5. External AI fills primary/rejected/notes using the contract.
6. Ask user what to do next. Never auto-apply.
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
- outputs: `./prepared/organization-edge-startclaim.csv`, `./prepared/organization-edge-startclaim.rejected.csv`, `./prepared/organization-edge-startclaim.notes.md`
- reject taxonomy: `missing_proxy_id`, `missing_device_ip`, `invalid_device_ip`, `missing_device_model_id`, `missing_space_id`, `invalid_space_id` (non-integer), `invalid_skip_connectivity_check` (non-boolean), `invalid_custom_parameters` (not a JSON object string)
- `skip_connectivity_check` accepts `true` or `false`; blank means `edge claim-batch` will run a pre-claim ping before `startClaim`
- downstream execution command: [`xyte-cli edge claim-batch`](commands.md#edge-devices)
4. `device.move`:
- `device_id,target_space_id`
- outputs: `./prepared/device-move.csv`, `./prepared/device-move.rejected.csv`, `./prepared/device-move.notes.md`
- downstream execution command: [`xyte-cli util move-devices`](commands.md#utility-preprocessing-and-batch-helpers)

Generic profiles:
1. `<path params...>,query_json,body_json`

## Required AI rules

1. Never guess unknown identifiers.
2. Trim whitespace.
3. Keep deterministic row ordering.
4. Route ambiguous rows to rejected output with `reject_reason`.
5. For generic profiles, keep `query_json` and `body_json` valid JSON object strings or empty.

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

Prepare edge-claim action:

```bash
xyte-cli util prepare \
  --action organization.edge.startClaim \
  --input ./input/edge-devices.xlsx \
  --tenant <tenant-id> \
  --output-dir ./prepared
```

Then drive the bulk-claim workflow via [`xyte-cli edge claim-batch`](commands.md#edge-devices) (plan → gate → apply → resume). Batch runs pre-claim ping for blank or `false` `skip_connectivity_check` rows; use row `true` only when you intend to skip that check. Disambiguation against native / C2C paths lives in [`docs/claim-devices.md`](claim-devices.md).

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

Prepare space import action:

```bash
xyte-cli util prepare \
  --action space.import-tree \
  --input ./input/raw-hierarchy.pdf \
  --tenant <tenant-id> \
  --output-dir ./prepared
```

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

## Local sandbox

Terminal A:

```bash
npm run mock:xyte:local -- --port 3001
```

Terminal B:

```bash
npm run smoke:local:utilities -- --base-url http://127.0.0.1:3001 --tenant local
```

## Contracts

1. Prepare contract:
- schema ID: `xyte.utility.prepare.v1`
- schema file: `docs/schemas/utility-prepare.v1.schema.json`
2. Import-tree batch summary:
- schema ID: `xyte.utility.batch.v1`
- schema file: `docs/schemas/utility-batch.v1.schema.json`
