# AI-Assisted Utility Preprocessing (Prepare-First, CLI stays AI-free)

This runbook defines utility preprocessing with `xyte-cli util prepare`.

## Scope

1. Preprocess write-capable endpoint actions into canonical files.
2. Keep `util import-tree` as the only utility execution command in this surface.
3. Keep `xyte-cli` AI-free: no OCR/model calls inside the CLI.

## Core model

1. Run `xyte-cli util list-actions` to discover supported actions.
2. Run `xyte-cli util prepare --action <action-key> --input <source>`.
3. CLI emits `xyte.utility.prepare.v1` and scaffolds canonical files.
4. External AI fills primary/rejected/notes using the contract.
5. Ask the user what to do next. Never auto-apply.
6. For `space.import-tree`, run dry-run then apply with explicit user approval.
7. For other actions, use controlled `xyte-cli api call` loops outside utility execution.

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

## Contracts

1. Prepare contract:
- schema ID: `xyte.utility.prepare.v1`
- schema file: `schemas/utility-prepare.v1.schema.json`
2. Import-tree batch summary:
- schema ID: `xyte.utility.batch.v1`
- schema file: `schemas/utility-batch.v1.schema.json`
