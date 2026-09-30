# AI-Assisted Utility Preprocessing (Prepare-First, CLI stays AI-free)

This runbook defines utility preprocessing with `xyte-cli util prepare`.

## Scope

1. Preprocess supported utility actions into canonical files.
2. Execute only the CLI-supported utility workflows from their dedicated commands: `util import-tree`, `util move-devices`, `edge claim-batch`, and `edge update-params-batch`.
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
9. For `edge.params.update`, run `edge update-params-batch --plan`, then `--apply` after explicit approval and use `--resume-artifact` for partial runs.
10. For generic endpoint actions, use controlled `xyte-cli api call` loops outside utility execution.

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
- `proxy_id,device_ip,device_model_id,space_id,display_name,mac,sn,custom_parameters,custom_partner_name,custom_model_name,skip_connectivity_check`
- downstream execution command: `xyte-cli edge claim-batch`
- use `edge models list` / `edge models describe` before filling rows so `device_model_id` and `custom_parameters` keys come from model docs; `mac` and `sn` are optional explicit source fields.
- batch validation can reject `unknown_custom_parameter`, `missing_required_custom_parameter`, and `masked_password_requires_value` after reading the model schema.
4. `edge.params.update`:
- `device_id,set_json,expected_model_id`
- outputs: `./prepared/edge-params-update.csv`, `./prepared/edge-params-update.rejected.csv`, `./prepared/edge-params-update.notes.md`
- reject taxonomy: `missing_device_id`, `missing_set_json`, `invalid_set_json`, `unknown_parameter`, `unsupported_current_parameter`, `missing_required_parameter`, `masked_password_requires_value`, `model_mismatch`, `duplicate_device_id`
- downstream execution command: `xyte-cli edge update-params-batch`
- safety: the batch runner reads the current device, reads the model schema, validates labels against `parameters[].name`, merges `set_json` into current values, sends the complete replacement `custom_parameters`, and verifies with `getDevice`.
5. `device.move`:
- `device_id,target_space_id,device_name,current_space_id,target_space_name`
- downstream execution command: `xyte-cli util move-devices`
6. `organization.connectors.prepareSetup`:
- `label,platform,connectorName,targetSpace,targetSpaceId,authorizationOwner,deviceNameSource,sourceRow,notes`
- outputs: `./prepared/organization-connectors-preparesetup.csv`, `./prepared/organization-connectors-preparesetup.rejected.csv`, `./prepared/organization-connectors-preparesetup.notes.md`
- prepare-only: no CLI execution command or public API endpoint is attached.
7. `organization.teamAccess.groups`:
- `label,groupName,iconName,sourceRow,notes`
- outputs: `./prepared/organization-teamaccess-groups.csv`, `./prepared/organization-teamaccess-groups.rejected.csv`, `./prepared/organization-teamaccess-groups.notes.md`
- prepare-only: no CLI execution command or public API endpoint is attached.
8. `organization.teamAccess.users`:
- `label,email,name,groupName,assignSupportSeat,sourceRow,notes`
- outputs: `./prepared/organization-teamaccess-users.csv`, `./prepared/organization-teamaccess-users.rejected.csv`, `./prepared/organization-teamaccess-users.notes.md`
- prepare-only: no CLI execution command or public API endpoint is attached.
9. `organization.teamAccess.memberships`:
- `label,email,groupName,sourceRow,notes`
- outputs: `./prepared/organization-teamaccess-memberships.csv`, `./prepared/organization-teamaccess-memberships.rejected.csv`, `./prepared/organization-teamaccess-memberships.notes.md`
- prepare-only: no CLI execution command or public API endpoint is attached.

Generic profiles:
1. `<path params...>,query_json,body_json`
2. Note write/delete endpoints such as `organization.notes.createDeviceNote`, `organization.notes.createSpaceNote`, `organization.notes.deleteDeviceNote`, and `organization.notes.deleteSpaceNote` are generic `call-loop-only` actions. Prepare rows, review generated notes/rejects, then run controlled `xyte-cli api call` loops only after explicit approval.

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
xyte-cli util list-actions --output text --mode friendly --execution-support edge.params-update-batch
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

Prepare already-claimed Edge custom parameter updates:

```bash
xyte-cli util prepare \
  --action edge.params.update \
  --input ./input/edge-params.xlsx \
  --tenant <tenant-id> \
  --output-dir ./prepared
```

Then drive the batch through `xyte-cli edge update-params-batch --plan`, explicit approval, and `--apply --report <path> --resume-artifact <path>`.

Prepare connector setup rows:

```bash
xyte-cli util prepare \
  --action organization.connectors.prepareSetup \
  --input ./input/connectors-rough.csv \
  --tenant <tenant-id> \
  --output-dir ./prepared
```

Prepare team access rows:

```bash
xyte-cli util prepare \
  --action organization.teamAccess.groups \
  --input ./input/team-rough.csv \
  --tenant <tenant-id> \
  --output-dir ./prepared

xyte-cli util prepare \
  --action organization.teamAccess.users \
  --input ./input/team-rough.csv \
  --tenant <tenant-id> \
  --output-dir ./prepared

xyte-cli util prepare \
  --action organization.teamAccess.memberships \
  --input ./input/team-rough.csv \
  --tenant <tenant-id> \
  --output-dir ./prepared
```

The team access utilities intentionally emit separate files so each prepared CSV has one primary artifact and one rejected artifact.

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
3. Edge claim batch summary:
- schema ID: `xyte.edge.claim-batch.v1`
- schema file: `schemas/edge-claim-batch.v1.schema.json`
4. Edge model list:
- schema ID: `xyte.edge.models.list.v1`
- schema file: `schemas/edge-models-list.v1.schema.json`
5. Edge model describe:
- schema ID: `xyte.edge.models.describe.v1`
- schema file: `schemas/edge-models-describe.v1.schema.json`
6. Edge custom-params single update:
- schema ID: `xyte.edge.params-update.v1`
- schema file: `schemas/edge-params-update.v1.schema.json`
7. Edge custom-params batch update:
- schema ID: `xyte.edge.params-update-batch.v1`
- schema file: `schemas/edge-params-update-batch.v1.schema.json`
