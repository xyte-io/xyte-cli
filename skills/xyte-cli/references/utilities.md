# Utility Prepare Flows (Preprocess-First)

`xyte-cli` utility preprocessing is auth-agnostic. It creates structured files only.

References:
1. `/Users/porton/Projects/xyte-cli/docs/ai-utility-preprocessing.md`
2. `/Users/porton/Projects/xyte-cli/scripts/templates/ai-utility-prepare-generic.prompt.md`
3. `/Users/porton/Projects/xyte-cli/scripts/templates/ai-space-import.prompt.md`

## Safety defaults

1. Always run preprocessing first.
2. After files are generated, ask user what to do next.
3. Never auto-run `--apply`.

## SOP A: Bulk claim preprocessing (`organization.devices.claimDevice`)

```bash
xyte-cli utility prepare \
  --action organization.devices.claimDevice \
  --input /path/to/raw-source.xlsx \
  --tenant <tenant-id> \
  --output-dir /Users/porton/Projects/xyte-cli/tmp
```

Expected files:
1. `/Users/porton/Projects/xyte-cli/tmp/organization-devices-claimdevice.csv`
2. `/Users/porton/Projects/xyte-cli/tmp/organization-devices-claimdevice.rejected.csv`
3. `/Users/porton/Projects/xyte-cli/tmp/organization-devices-claimdevice.notes.md`

Decision gate:
1. Ask user whether to execute this action via `xyte-cli call` loop or stop.

## SOP B: Space import preprocessing + execution (`space.import-tree`)

Prepare:

```bash
xyte-cli utility prepare \
  --action space.import-tree \
  --input /path/to/raw-hierarchy.pdf \
  --tenant <tenant-id> \
  --output-dir /Users/porton/Projects/xyte-cli/tmp
```

Dry-run:

```bash
xyte-cli space import-tree \
  --tenant <tenant-id> \
  --input /Users/porton/Projects/xyte-cli/tmp/space-import-tree.csv \
  --report /Users/porton/Projects/xyte-cli/tmp/space-import-tree.dryrun.ndjson
```

Apply:

```bash
xyte-cli space import-tree \
  --tenant <tenant-id> \
  --input /Users/porton/Projects/xyte-cli/tmp/space-import-tree.csv \
  --apply \
  --report /Users/porton/Projects/xyte-cli/tmp/space-import-tree.apply.ndjson
```

Verify:

```bash
xyte-cli call organization.spaces.getSpaces \
  --tenant <tenant-id> \
  --query-json '{"path_includes":"HQ/Floor 1/Office 1"}'
```

## SOP C: Generic endpoint preprocessing

List actions:

```bash
xyte-cli utility list-actions --format text
```

Prepare generic action:

```bash
xyte-cli utility prepare \
  --action organization.tickets.updateTicket \
  --input /path/to/raw-ticket-updates.csv \
  --tenant <tenant-id> \
  --output-dir /Users/porton/Projects/xyte-cli/tmp
```

Generic canonical headers:
1. `<path params in order>,query_json,body_json`

## Local utility sandbox

```bash
# terminal A
npm run mock:xyte:local -- --port 3001

# terminal B
npm run smoke:local:utilities -- --base-url http://127.0.0.1:3001 --tenant local
```
