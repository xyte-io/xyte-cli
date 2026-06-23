# AI-Assisted Utility Preprocessing (Prepare-First, CLI stays AI-free)

This runbook defines utility preprocessing with `xyte-cli util prepare`.

## Scope

1. Preprocess supported utility actions into canonical files.
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
9. For generic endpoint actions, use controlled `xyte-cli api call` loops outside utility execution.

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
- For non-heartbeat Edge models, run `xyte-cli edge models` and `xyte-cli edge model <id>` before preparing rows. Fill `custom_parameters` with model `parameters[].name` keys and reject rows missing required values such as `{$DEVICE_ID}`.
- downstream execution command: `xyte-cli edge claim-batch`
4. `device.move`:
- `device_id,target_space_id,device_name,current_space_id,target_space_name`
- downstream execution command: `xyte-cli util move-devices`
5. `organization.connectors.prepareSetup`:
- `label,platform,connectorName,targetSpace,targetSpaceId,authorizationOwner,deviceNameSource,sourceRow,notes`
- outputs: `./prepared/organization-connectors-preparesetup.csv`, `./prepared/organization-connectors-preparesetup.rejected.csv`, `./prepared/organization-connectors-preparesetup.notes.md`
- prepare-only: no CLI execution command or public API endpoint is attached.
6. `organization.teamAccess.groups`:
- `label,groupName,iconName,sourceRow,notes`
- outputs: `./prepared/organization-teamaccess-groups.csv`, `./prepared/organization-teamaccess-groups.rejected.csv`, `./prepared/organization-teamaccess-groups.notes.md`
- prepare-only: no CLI execution command or public API endpoint is attached.
7. `organization.teamAccess.users`:
- `label,email,name,groupName,assignSupportSeat,sourceRow,notes`
- outputs: `./prepared/organization-teamaccess-users.csv`, `./prepared/organization-teamaccess-users.rejected.csv`, `./prepared/organization-teamaccess-users.notes.md`
- prepare-only: no CLI execution command or public API endpoint is attached.
8. `organization.teamAccess.memberships`:
- `label,email,groupName,sourceRow,notes`
- outputs: `./prepared/organization-teamaccess-memberships.csv`, `./prepared/organization-teamaccess-memberships.rejected.csv`, `./prepared/organization-teamaccess-memberships.notes.md`
- prepare-only: no CLI execution command or public API endpoint is attached.

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
